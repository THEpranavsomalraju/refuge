import * as React from 'react';
import type { JSX } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import type { Frame } from './geo';
import { useSceneStore } from './store';

// Distances are meters; speeds are visual animation rates, independent of run progress.
const FADE_FRACTION = 0.08; // Smooth entrance/exit at either end of the simulation.
const TORNADO = {
  minWidth: 250, height: 1550, maxHeight: 1950, rotation: 1.25,
  opacity: 0.86, dust: 1800, debris: 420, rain: 4200, // 6,420 particles total.
  terrainSamples: 48, terrainInterval: 0.2, // One small, moving height-field cache.
} as const;
const HURRICANE = {
  eye: 0.35, outer: 4.7, rotation: 0.018, // RMW multiples; radians/second, CCW.
  opacity: 0.79, rain: 7200, // Instanced streaks; no per-particle CPU updates.
} as const;
const BOLT_SEGMENTS = 96;
const NO_RAYCAST = () => null;
const TAU = Math.PI * 2;

export interface HurricaneFXState { rmwM: number; playing: boolean; t: number }

type Uniform<T> = { value: T };
interface StormUniforms extends Record<string, THREE.IUniform> {
  uTime: Uniform<number>;
  uFade: Uniform<number>;
  uFlash: Uniform<number>;
  uRadius: Uniform<number>;
  uHeight: Uniform<number>;
  uCloudRadius: Uniform<number>;
  uCloudAlt: Uniform<number>;
  uLowAlt: Uniform<number>;
  uTravel: Uniform<THREE.Vector2>;
  uOrigin: Uniform<THREE.Vector3>;
  uFlashPos: Uniform<THREE.Vector3>;
  uTerrain: Uniform<THREE.DataTexture>;
  uTerrainInfo: Uniform<THREE.Vector3>;
  uTerrainRange: Uniform<THREE.Vector2>;
}

const clamp01 = (x: number): number => THREE.MathUtils.clamp(x, 0, 1);
const finite = (x: number, fallback: number): number => Number.isFinite(x) ? x : fallback;
function fadeAt(t: number): number {
  return THREE.MathUtils.smoothstep(t, 0, FADE_FRACTION)
    * (1 - THREE.MathUtils.smoothstep(t, 1 - FADE_FRACTION, 1));
}
function randomSource(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// Seamless Cartesian noise: no UV seam, downloaded maps, or time-based reallocation.
const NOISE = /* glsl */ `
float hash3(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}
float valueNoise3(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash3(i), hash3(i + vec3(1,0,0)), f.x),
                 mix(hash3(i + vec3(0,1,0)), hash3(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(hash3(i + vec3(0,0,1)), hash3(i + vec3(1,0,1)), f.x),
                 mix(hash3(i + vec3(0,1,1)), hash3(i + vec3(1,1,1)), f.x), f.y), f.z);
}
float fbm(vec3 p) {
  float n = 0.0, a = 0.533333;
  for (int i = 0; i < 4; i++) {
    n += a * valueNoise3(p);
    p = p * 2.03 + vec3(7.1, 13.7, 3.9);
    a *= 0.5;
  }
  return n;
}
mat2 rotate2(float a) {
  float c = cos(a), s = sin(a);
  return mat2(c, -s, s, c);
}
`;
const UNIFORMS = /* glsl */ `
uniform float uTime, uFade, uFlash, uRadius, uHeight, uCloudRadius;
uniform float uCloudAlt, uLowAlt;
uniform vec2 uTravel;
uniform vec3 uOrigin, uFlashPos;
`;
const TERRAIN = /* glsl */ `
uniform sampler2D uTerrain;
uniform vec3 uTerrainInfo;
uniform vec2 uTerrainRange;
float groundAt(vec2 localXZ) {
  vec2 uv = (localXZ + uOrigin.xz - uTerrainInfo.xy) / uTerrainInfo.z + 0.5;
  vec2 rg = texture2D(uTerrain, clamp(uv, 0.0, 1.0)).rg;
  return uTerrainRange.x + dot(rg, vec2(65280.0, 255.0))
    / 65535.0 * uTerrainRange.y - uOrigin.y;
}
`;
const FUNNEL_SHAPE = /* glsl */ `
float ropeAmount() { return 0.5 + 0.5 * sin(uTime * 0.19 + 0.7); }
float funnelRadius(float h) {
  float foot = uRadius * mix(0.35, 0.17, ropeAmount());
  float top = max(380.0, uRadius * 1.25);
  return mix(foot, top, pow(h, 2.25));
}
vec2 funnelCenter(float h) {
  float s = sin(h * 3.14159265);
  return -uTravel * uHeight * 0.14 * h * h
    + uRadius * (0.12 + 0.17 * ropeAmount()) * s
    * vec2(sin(h * 5.2 - uTime * 0.41), cos(h * 4.1 + uTime * 0.33));
}
`;
const FUNNEL_VERTEX = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
${UNIFORMS}
${FUNNEL_SHAPE}
uniform float uLayer;
varying vec3 vLocal, vWorld;
varying vec2 vCylinder;
void main() {
  float h = uv.y, a = uv.x * 6.2831853;
  float twist = a - uTime * ${TORNADO.rotation.toFixed(3)} + h * 4.0;
  float turbulence = sin(twist * 5.0 + h * 27.0) * 0.035
    + sin(twist * 9.0 - h * 43.0 - uTime) * 0.022;
  float r = funnelRadius(h) * (1.0 + turbulence + uLayer * 0.12);
  vec2 xz = vec2(cos(a), -sin(a)) * r + funnelCenter(h);
  vec3 p = vec3(xz.x, h * uHeight + 9.0, xz.y);
  vLocal = p;
  vCylinder = vec2(a, h);
  vec4 world = modelMatrix * vec4(p, 1.0);
  vWorld = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
  #include <logdepthbuf_vertex>
}
`;
const FUNNEL_FRAGMENT = /* glsl */ `
#include <logdepthbuf_pars_fragment>
${UNIFORMS}
${NOISE}
uniform float uLayer;
varying vec3 vLocal, vWorld;
varying vec2 vCylinder;
void main() {
  #include <logdepthbuf_fragment>
  float a = vCylinder.x - uTime * ${TORNADO.rotation.toFixed(3)};
  float h = vCylinder.y;
  // Rotating helical filaments and rising condensation, continuous around the seam.
  vec3 q = vec3(cos(a + h * 3.0) * 3.8, h * 9.0 - uTime * 0.85,
                sin(a + h * 3.0) * 3.8);
  float n = fbm(q);
  float filament = 0.5 + 0.5 * sin(a * 19.0 + h * 18.0 - n * 7.0);
  vec3 normal = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
  vec3 viewDir = normalize(cameraPosition - vWorld);
  float facing = abs(dot(normal, viewDir));
  float light = 0.36 + 0.64 * max(0.0, dot(normal, normalize(vec3(-0.6, 0.7, 0.4))));
  float edge = smoothstep(0.0, 0.3, facing);
  float density = smoothstep(0.12, 0.79, n + filament * 0.10);
  float alpha = (0.30 + 0.64 * density) * edge;
  alpha *= smoothstep(0.0, 0.035, h) * (1.0 - smoothstep(0.91, 1.0, h));
  alpha *= mix(${TORNADO.opacity.toFixed(3)}, 0.19, uLayer) * uFade;
  vec3 color = mix(vec3(0.070, 0.076, 0.073), vec3(0.29, 0.33, 0.34), h);
  color *= (0.63 + n * 0.56) * light;
  color += vec3(0.47, 0.56, 0.65) * uFlash * (0.25 + h * 0.75);
  gl_FragColor = vec4(color, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// Polar grids contain a real hole; neither deck can cover the hurricane's eye.
const CLOUD_VERTEX = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
${UNIFORMS}
${NOISE}
uniform float uLayer;
varying vec3 vLocal;
varying vec2 vDomain;
void main() {
  vec2 domain = position.xz;
  float r = length(domain);
  float a = atan(-domain.y, domain.x);
  vec3 p;
#ifdef HURRICANE
  float turn = uTime * ${HURRICANE.rotation.toFixed(3)};
  vec2 advected = rotate2(-turn) * domain;
  float billow = valueNoise3(vec3(advected * 7.0, 1.0 + uTime * 0.027));
  float wall = exp(-pow((r - 0.94) / 0.29, 2.0));
  float deck = mix(uCloudAlt, uLowAlt, uLayer);
  float towers = min(uRadius * 0.038, 1200.0) * wall;
  float innerLip = smoothstep(${HURRICANE.eye.toFixed(3)}, 0.76, r);
  p = vec3(domain.x * uRadius,
    deck * mix(0.44, 1.0, innerLip) + towers * (0.50 + billow * 0.65)
      + (billow - 0.5) * mix(330.0, 160.0, uLayer), domain.y * uRadius);
#else
  vec2 advected = rotate2(-uTime * 0.12) * domain;
  float billow = valueNoise3(vec3(advected * 6.0, uTime * 0.06));
  float hanging = exp(-pow((r - 0.32) / 0.20, 2.0));
  vec2 offset = -uTravel * uHeight * 0.14;
  p = vec3(domain.x * uCloudRadius + offset.x,
    uHeight + 80.0 + 260.0 * r - 130.0 * hanging + (billow - 0.5) * 170.0,
    domain.y * uCloudRadius + offset.y);
#endif
  vDomain = domain;
  vLocal = p;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  #include <logdepthbuf_vertex>
}
`;
const CLOUD_FRAGMENT = /* glsl */ `
#include <logdepthbuf_pars_fragment>
${UNIFORMS}
${NOISE}
uniform float uLayer;
varying vec3 vLocal;
varying vec2 vDomain;
void main() {
  #include <logdepthbuf_fragment>
  float r = length(vDomain);
  float a = atan(-vDomain.y, vDomain.x);
  float density, alpha, wall, n;
  vec3 color;
#ifdef HURRICANE
  float turn = uTime * ${HURRICANE.rotation.toFixed(3)};
  vec2 advected = rotate2(-turn) * vDomain;
  // One four-octave evaluation for the entire large cloud surface.
  n = fbm(vec3(advected * 3.7, uTime * 0.025 + uLayer * 7.0));
  float phase = 3.0 * (a - turn + 2.6 * log(max(r, 0.2)));
  float arms = 0.5 + 0.5 * cos(phase + (n - 0.5) * 3.0);
  float bands = smoothstep(0.22, 0.85, arms);
  wall = exp(-pow((r - 0.96) / 0.28, 2.0));
  float shield = 1.0 - smoothstep(1.15, 3.25, r);
  density = smoothstep(0.20, 0.81, n + 0.30 * bands + 0.27 * wall);
  alpha = (0.16 * shield + density * (0.44 + 0.38 * bands) + wall * 0.24);
  alpha *= smoothstep(${HURRICANE.eye.toFixed(3)}, 0.50, r)
    * (1.0 - smoothstep(3.35, ${HURRICANE.outer.toFixed(3)}, r));
  alpha *= mix(${HURRICANE.opacity.toFixed(3)}, 0.42, uLayer) * uFade;
  float silver = pow(clamp(n * 1.20, 0.0, 1.0), 2.0);
  color = mix(vec3(0.065, 0.083, 0.091), vec3(0.29, 0.34, 0.36), silver);
  color += wall * vec3(0.095, 0.105, 0.108) * (0.6 + n);
  color *= mix(1.0, 0.30, uLayer);
  float flashMask = exp(-length(vLocal.xz - uFlashPos.xz) / (uRadius * 0.26));
  color += uFlash * flashMask * vec3(0.8, 0.91, 1.0);
#else
  vec2 advected = rotate2(-uTime * 0.12) * vDomain;
  n = fbm(vec3(advected * 5.2, uTime * 0.065));
  float spiral = 0.5 + 0.5 * cos(3.0 * a + r * 11.0 - uTime * 0.36 + n * 3.0);
  density = smoothstep(0.16, 0.82, n + spiral * 0.14);
  alpha = (0.32 + density * 0.57) * (1.0 - smoothstep(0.57, 1.0, r)) * uFade;
  color = mix(vec3(0.040, 0.052, 0.056), vec3(0.19, 0.23, 0.24), density);
  color *= 0.75 + 0.25 * smoothstep(-1.0, 1.0, vDomain.x);
  color += uFlash * vec3(0.32, 0.40, 0.49) * exp(-r * 0.8);
#endif
  if (alpha < 0.004) discard;
  gl_FragColor = vec4(color, min(alpha, 0.95));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const PARTICLE_VERTEX = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
${UNIFORMS}
${TERRAIN}
${FUNNEL_SHAPE}
attribute vec4 aSeed;
attribute float aKind;
varying vec2 vUv;
varying float vAlpha, vKind, vShade;
void main() {
  vUv = uv;
  vKind = aKind;
  vShade = aSeed.w;
  float life, angle, radius, width, lengthM;
  vec3 p, velocity;
#ifdef HURRICANE
  life = fract(aSeed.x + uTime * (0.12 + aSeed.z * 0.08));
  radius = uRadius * mix(0.57, 3.75, pow(aSeed.y, 1.65));
  float rn = radius / uRadius;
  angle = aSeed.z * 6.2831853 + uTime * (0.025 + 0.09 / (0.5 + rn));
  p = vec3(cos(angle) * radius, mix(uCloudAlt, 30.0, life), -sin(angle) * radius);
  velocity = vec3(-sin(angle) * 120.0, -90.0, -cos(angle) * 120.0);
  width = mix(2.0, 5.0, aSeed.w);
  lengthM = mix(85.0, 180.0, aSeed.w);
  float bands = 0.5 + 0.5 * cos(3.0 * (angle - uTime * ${HURRICANE.rotation.toFixed(3)}
    + 2.6 * log(rn)));
  vAlpha = (0.08 + 0.15 * bands) * smoothstep(0.0, 0.12, life)
    * (1.0 - smoothstep(0.87, 1.0, life));
#else
  if (aKind < 1.5) {
    life = fract(aSeed.x + uTime * mix(0.13, 0.23, aSeed.z));
    angle = aSeed.y * 6.2831853 + uTime * (0.65 + aSeed.z * 1.6) - life * 3.0;
    float thrown = step(0.70, aSeed.w);
    float height = mix(life * life * uHeight * 0.46,
      sin(life * 3.14159265) * uHeight * 0.24, thrown);
    float h = height / uHeight;
    radius = funnelRadius(h) * (0.85 + aSeed.z * 1.0)
      + uRadius * (life * life * mix(0.4, 2.6, thrown));
    vec2 xz = vec2(cos(angle), -sin(angle)) * radius + funnelCenter(h)
      - uTravel * uRadius * life * life * (1.0 + aSeed.z);
    p = vec3(xz.x, groundAt(xz) + 12.0 + height, xz.y);
    velocity = vec3(-sin(angle), 0.3, -cos(angle));
    width = aKind < 0.5 ? mix(32.0, 92.0, aSeed.z) * sqrt(uRadius / 125.0)
      : mix(2.5, 8.0, aSeed.z) * pow(uRadius / 125.0, 0.25);
    lengthM = width;
    vAlpha = sin(life * 3.14159265) * (aKind < 0.5 ? 0.12 : 0.80);
  } else {
    life = fract(aSeed.x + uTime * (0.35 + aSeed.z * 0.3));
    angle = aSeed.y * 6.2831853 + uTime * 0.15;
    radius = mix(max(uRadius * 1.4, 400.0), uCloudRadius * 0.94, sqrt(aSeed.z));
    vec2 xz = vec2(cos(angle), -sin(angle)) * radius
      - uTravel * (1.0 - life) * uRadius * 0.6;
    p = vec3(xz.x, groundAt(xz) + 15.0 + (1.0 - life) * uHeight * 0.91, xz.y);
    velocity = vec3(-sin(angle) * 75.0 - uTravel.x * 30.0, -115.0,
                    -cos(angle) * 75.0 - uTravel.y * 30.0);
    width = mix(1.1, 2.5, aSeed.w);
    lengthM = mix(36.0, 85.0, aSeed.w);
    vAlpha = 0.21 * sin(life * 3.14159265);
  }
#endif
  vAlpha *= uFade;
  // World-sized camera-facing quads avoid hardware point-size limits.
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vec2 axis = vec2(0.0, 1.0);
  if (aKind > 1.5) {
    vec3 v = mat3(modelViewMatrix) * velocity;
    axis = v.xy / max(length(v.xy), 0.001);
  } else if (aKind > 0.5) {
    float tumble = aSeed.y * 40.0 + uTime * (2.0 + aSeed.z * 5.0);
    axis = vec2(cos(tumble), sin(tumble));
    width *= 0.45 + 0.55 * abs(sin(tumble * 0.7));
  }
  vec2 side = vec2(axis.y, -axis.x);
  mv.xy += side * position.x * width + axis * position.y * lengthM;
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
}
`;
const PARTICLE_FRAGMENT = /* glsl */ `
#include <logdepthbuf_pars_fragment>
${UNIFORMS}
varying vec2 vUv;
varying float vAlpha, vKind, vShade;
void main() {
  #include <logdepthbuf_fragment>
  vec2 p = vUv * 2.0 - 1.0;
  float alpha;
  vec3 color;
  if (vKind < 0.5) {
    float r2 = dot(p, p);
    if (r2 > 1.0) discard;
    alpha = pow(1.0 - r2, 2.5) * vAlpha;
    color = mix(vec3(0.075, 0.069, 0.056), vec3(0.18, 0.17, 0.14), vShade);
  } else if (vKind < 1.5) {
    if (abs(p.x) + abs(p.y) * 0.4 > 0.92) discard;
    alpha = vAlpha;
    color = mix(vec3(0.06, 0.057, 0.046), vec3(0.29, 0.27, 0.22), vShade);
  } else {
    alpha = pow(1.0 - abs(p.x), 1.8) * (1.0 - p.y * p.y) * vAlpha;
    color = vec3(0.29, 0.37, 0.41);
  }
  color += vec3(0.24, 0.29, 0.34) * uFlash;
  if (alpha < 0.003) discard;
  gl_FragColor = vec4(color, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const BOLT_VERTEX = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec3 aStart, aEnd;
attribute float aStrength;
uniform float uWidth;
varying vec2 vUv;
varying float vStrength;
void main() {
  vUv = uv;
  vStrength = aStrength;
  vec4 start = modelViewMatrix * vec4(aStart, 1.0);
  vec4 end = modelViewMatrix * vec4(aEnd, 1.0);
  vec2 d = end.xy - start.xy;
  vec2 side = vec2(-d.y, d.x) / max(length(d), 0.001);
  vec4 p = mix(start, end, uv.y);
  p.xy += side * position.x * uWidth * aStrength;
  gl_Position = projectionMatrix * p;
  #include <logdepthbuf_vertex>
}
`;
const BOLT_FRAGMENT = /* glsl */ `
#include <logdepthbuf_pars_fragment>
${UNIFORMS}
uniform float uGlow;
varying vec2 vUv;
varying float vStrength;
void main() {
  #include <logdepthbuf_fragment>
  float edge = 1.0 - abs(vUv.x * 2.0 - 1.0);
  float alpha = pow(edge, mix(0.65, 2.3, uGlow)) * vStrength * uFlash * uFade;
  gl_FragColor = vec4(mix(vec3(2.2, 2.6, 3.0), vec3(0.30, 0.46, 0.62), uGlow), alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

function polarGeometry(inner: number, outer: number, rings: number, slices: number): THREE.BufferGeometry {
  const positions: number[] = [], uvs: number[] = [], indices: number[] = [];
  for (let y = 0; y <= rings; y++) {
    const r = THREE.MathUtils.lerp(inner, outer, y / rings);
    for (let x = 0; x <= slices; x++) {
      const a = x / slices * TAU;
      positions.push(Math.cos(a) * r, 0, -Math.sin(a) * r);
      uvs.push(x / slices, y / rings);
      if (x < slices && y < rings) {
        const k = y * (slices + 1) + x;
        indices.push(k, k + slices + 1, k + 1, k + 1, k + slices + 1, k + slices + 2);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(indices);
  return g;
}
function quadGeometry(): THREE.InstancedBufferGeometry {
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([
    -0.5, -0.5, 0, 0.5, -0.5, 0, -0.5, 0.5, 0, 0.5, 0.5, 0,
  ], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 1, 1], 2));
  g.setIndex([0, 1, 2, 2, 1, 3]);
  return g;
}
function particles(hurricane: boolean): THREE.InstancedBufferGeometry {
  const g = quadGeometry();
  const count = hurricane ? HURRICANE.rain : TORNADO.dust + TORNADO.debris + TORNADO.rain;
  const seed = new Float32Array(count * 4), kind = new Float32Array(count);
  const rng = randomSource(hurricane ? 41021 : 7321);
  for (let i = 0; i < count; i++) {
    for (let k = 0; k < 4; k++) seed[i * 4 + k] = rng();
    kind[i] = hurricane ? 2 : i < TORNADO.dust ? 0 : i < TORNADO.dust + TORNADO.debris ? 1 : 2;
  }
  g.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seed, 4));
  g.setAttribute('aKind', new THREE.InstancedBufferAttribute(kind, 1));
  g.instanceCount = count;
  return g;
}
function shader(
  uniforms: StormUniforms, vertexShader: string, fragmentShader: string,
  extra: Record<string, THREE.IUniform> = {}, hurricane = false,
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { ...uniforms, ...extra }, vertexShader, fragmentShader,
    defines: hurricane ? { HURRICANE: 1 } : {},
    transparent: true, depthWrite: false, depthTest: true,
    side: THREE.DoubleSide, forceSinglePass: true, toneMapped: true,
  });
}

function makeResources(hurricane: boolean) {
  const terrainSize = hurricane ? 1 : TORNADO.terrainSamples;
  const terrainData = new Uint8Array(terrainSize * terrainSize * 4);
  const terrain = new THREE.DataTexture(terrainData, terrainSize, terrainSize, THREE.RGBAFormat);
  terrain.minFilter = terrain.magFilter = THREE.LinearFilter;
  terrain.wrapS = terrain.wrapT = THREE.ClampToEdgeWrapping;
  terrain.generateMipmaps = false;
  terrain.colorSpace = THREE.NoColorSpace;
  terrain.needsUpdate = true;
  const uniforms: StormUniforms = {
    uTime: { value: 0 }, uFade: { value: 0 }, uFlash: { value: 0 },
    uRadius: { value: 125 }, uHeight: { value: TORNADO.height }, uCloudRadius: { value: 1500 },
    uCloudAlt: { value: 1800 }, uLowAlt: { value: 900 },
    uTravel: { value: new THREE.Vector2(1, 0) }, uOrigin: { value: new THREE.Vector3() },
    uFlashPos: { value: new THREE.Vector3() }, uTerrain: { value: terrain },
    uTerrainInfo: { value: new THREE.Vector3(0, 0, 1) },
    uTerrainRange: { value: new THREE.Vector2(0, 1) },
  };
  const funnel = hurricane ? null : polarGeometry(0, 1, 64, 80);
  const deck = hurricane
    ? polarGeometry(HURRICANE.eye, HURRICANE.outer, 96, 192)
    : polarGeometry(0, 1, 40, 112);
  const particleGeometry = particles(hurricane);
  const bolt = quadGeometry();
  for (const name of ['aStart', 'aEnd']) {
    bolt.setAttribute(name, new THREE.InstancedBufferAttribute(new Float32Array(BOLT_SEGMENTS * 3), 3)
      .setUsage(THREE.DynamicDrawUsage));
  }
  bolt.setAttribute('aStrength', new THREE.InstancedBufferAttribute(new Float32Array(BOLT_SEGMENTS), 1)
    .setUsage(THREE.DynamicDrawUsage));
  bolt.instanceCount = 0;
  const cloudMaterial = shader(uniforms, CLOUD_VERTEX, CLOUD_FRAGMENT, { uLayer: { value: 0 } }, hurricane);
  const lowerMaterial = hurricane
    ? shader(uniforms, CLOUD_VERTEX, CLOUD_FRAGMENT, { uLayer: { value: 1 } }, true) : null;
  const funnelMaterial = hurricane ? null
    : shader(uniforms, FUNNEL_VERTEX, FUNNEL_FRAGMENT, { uLayer: { value: 0 } });
  const veilMaterial = hurricane ? null
    : shader(uniforms, FUNNEL_VERTEX, FUNNEL_FRAGMENT, { uLayer: { value: 1 } });
  // The polar grid winds inward when extruded into the funnel; render its outside once.
  if (funnelMaterial) funnelMaterial.side = THREE.BackSide;
  if (veilMaterial) veilMaterial.side = THREE.BackSide;
  const particleMaterial = shader(uniforms, PARTICLE_VERTEX, PARTICLE_FRAGMENT, {}, hurricane);
  const boltMaterial = shader(uniforms, BOLT_VERTEX, BOLT_FRAGMENT,
    { uWidth: { value: hurricane ? 8 : 3 }, uGlow: { value: 0 } });
  const glowMaterial = shader(uniforms, BOLT_VERTEX, BOLT_FRAGMENT,
    { uWidth: { value: hurricane ? 45 : 20 }, uGlow: { value: 1 } });
  boltMaterial.blending = glowMaterial.blending = THREE.AdditiveBlending;
  const materials = [cloudMaterial, lowerMaterial, funnelMaterial, veilMaterial,
    particleMaterial, boltMaterial, glowMaterial];
  return {
    uniforms, terrain, terrainData, terrainHeights: new Float32Array(terrainSize * terrainSize),
    funnel, deck, particleGeometry, bolt, cloudMaterial, lowerMaterial,
    funnelMaterial, veilMaterial, particleMaterial, boltMaterial, glowMaterial,
    dispose() {
      terrain.dispose();
      funnel?.dispose();
      deck.dispose();
      particleGeometry.dispose();
      bolt.dispose();
      for (const material of materials) material?.dispose();
    },
  };
}
type Resources = ReturnType<typeof makeResources>;
function useResources(hurricane: boolean): Resources {
  const resources = React.useMemo(() => makeResources(hurricane), [hurricane]);
  React.useEffect(() => {
    // React StrictMode may replay this effect after disposal; re-upload its texture.
    resources.terrain.needsUpdate = true;
    return () => resources.dispose();
  }, [resources]);
  return resources;
}

function sampleTerrain(r: Resources, frame: Frame, x: number, z: number, extent: number): void {
  const size = TORNADO.terrainSamples;
  let min = Infinity, max = -Infinity;
  // Sample texel centers to match hardware bilinear filtering exactly.
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const h = finite(frame.groundY(x + ((i + 0.5) / size - 0.5) * extent,
        z + ((j + 0.5) / size - 0.5) * extent), r.uniforms.uOrigin.value.y);
      r.terrainHeights[j * size + i] = h;
      min = Math.min(min, h);
      max = Math.max(max, h);
    }
  }
  const range = Math.max(1, max - min);
  for (let i = 0; i < size * size; i++) {
    const packed = Math.round(clamp01((r.terrainHeights[i]! - min) / range) * 65535);
    r.terrainData[i * 4] = packed >>> 8;
    r.terrainData[i * 4 + 1] = packed & 255;
    r.terrainData[i * 4 + 3] = 255;
  }
  r.uniforms.uTerrainInfo.value.set(x, z, extent);
  r.uniforms.uTerrainRange.value.set(min, range);
  r.terrain.needsUpdate = true;
}

interface Playback {
  active: boolean; time: number; previousT: number; nextFlash: number; flashStart: number;
  terrainTime: number; terrainFrame: Frame | null; rng: () => number;
}
function playback(seed: number): Playback {
  return { active: false, time: 0, previousT: 0, nextFlash: 1.2, flashStart: -100,
    terrainTime: -100, terrainFrame: null, rng: randomSource(seed) };
}
function advance(p: Playback, t: number, delta: number): void {
  if (!p.active || t < p.previousT - 0.05) {
    p.time = 0;
    p.nextFlash = 0.9 + p.rng() * 1.4;
    p.flashStart = -100;
    p.terrainTime = -100;
  }
  p.active = true;
  p.previousT = t;
  p.time += Math.min(Math.max(delta, 0), 0.05);
}

// Segmented ribbons, with a new silhouette and branches on every discharge.
function generateBolt(r: Resources, p: Playback, hurricane: boolean, frame?: Frame): void {
  const u = r.uniforms;
  const angle = p.rng() * TAU;
  const radius = hurricane ? u.uRadius.value * (0.82 + p.rng() * 0.24)
    : Math.max(300, u.uRadius.value * (1.2 + p.rng()));
  const start = new THREE.Vector3(Math.cos(angle) * radius,
    hurricane ? u.uCloudAlt.value + 450 : u.uHeight.value, -Math.sin(angle) * radius);
  const end = start.clone();
  if (hurricane) {
    end.x += -Math.sin(angle) * u.uRadius.value * 0.24;
    end.z += -Math.cos(angle) * u.uRadius.value * 0.24;
    end.y = u.uLowAlt.value * 0.65;
  } else {
    end.x += (p.rng() - 0.5) * 450;
    end.z += (p.rng() - 0.5) * 450;
    end.y = frame ? finite(frame.groundY(end.x + u.uOrigin.value.x,
      end.z + u.uOrigin.value.z), u.uOrigin.value.y) - u.uOrigin.value.y + 8 : 8;
  }
  u.uFlashPos.value.copy(start).lerp(end, 0.25);
  const starts = r.bolt.getAttribute('aStart') as THREE.InstancedBufferAttribute;
  const ends = r.bolt.getAttribute('aEnd') as THREE.InstancedBufferAttribute;
  const strengths = r.bolt.getAttribute('aStrength') as THREE.InstancedBufferAttribute;
  let count = 0;
  const add = (a: THREE.Vector3, b: THREE.Vector3, strength: number) => {
    if (count >= BOLT_SEGMENTS) return;
    starts.setXYZ(count, a.x, a.y, a.z);
    ends.setXYZ(count, b.x, b.y, b.z);
    strengths.setX(count++, strength);
  };
  let previous = start.clone();
  const segments = 23, jitter = hurricane ? 170 : 70;
  for (let i = 1; i <= segments; i++) {
    const q = i / segments;
    const next = start.clone().lerp(end, q);
    const envelope = Math.sin(q * Math.PI);
    next.x += (p.rng() - 0.5) * jitter * envelope;
    next.z += (p.rng() - 0.5) * jitter * envelope;
    next.y += (p.rng() - 0.5) * jitter * 0.5 * envelope;
    add(previous, next, 1);
    if (i % 5 === 0 && i < 20) {
      let branch = next.clone();
      const dx = (p.rng() - 0.5) * jitter * 2.6;
      const dz = (p.rng() - 0.5) * jitter * 2.6;
      for (let j = 0; j < 5; j++) {
        const tip = branch.clone().add(new THREE.Vector3(dx * 0.22 + (p.rng() - 0.5) * 35,
          -35 - p.rng() * 65, dz * 0.22));
        // Never send a ground-strike branch through the terrain.
        if (!hurricane && frame) {
          tip.y = Math.max(tip.y, finite(frame.groundY(tip.x + u.uOrigin.value.x,
            tip.z + u.uOrigin.value.z), u.uOrigin.value.y) - u.uOrigin.value.y + 8);
        }
        add(branch, tip, 0.55 - j * 0.075);
        branch = tip;
      }
    }
    previous = next;
  }
  r.bolt.instanceCount = count;
  starts.needsUpdate = ends.needsUpdate = strengths.needsUpdate = true;
}
function lightning(r: Resources, p: Playback, hurricane: boolean, frame?: Frame): number {
  if (p.time >= p.nextFlash && r.uniforms.uFade.value > 0.25) {
    generateBolt(r, p, hurricane, frame);
    p.flashStart = p.time;
    p.nextFlash = p.time + (hurricane ? 5 : 3.8) + p.rng() * 6;
  }
  const age = p.time - p.flashStart;
  const pulse = age >= 0 && age < 0.5
    ? Math.exp(-age * 24) + 0.68 * Math.exp(-Math.pow((age - 0.115) / 0.026, 2))
      + 0.26 * Math.exp(-Math.pow((age - 0.23) / 0.038, 2)) : 0;
  r.uniforms.uFlash.value = pulse;
  return pulse;
}

// All shader-displaced meshes disable frustum culling: their CPU bounds are unit-sized.
// Manual disposal owns every geometry/material/texture, including shared attachments.
function StormMeshes({ r }: { r: Resources }): JSX.Element {
  const upper = React.useRef<THREE.Mesh>(null);
  const lower = React.useRef<THREE.Mesh>(null);
  const localCamera = React.useMemo(() => new THREE.Vector3(), []);
  useFrame(({ camera }) => {
    if (!upper.current || !lower.current || r.uniforms.uFade.value <= 0) return;
    camera.getWorldPosition(localCamera);
    upper.current.worldToLocal(localCamera);
    // Blend the nearer deck last, including views from beneath the storm.
    const below = localCamera.y < (r.uniforms.uCloudAlt.value + r.uniforms.uLowAlt.value) * 0.5;
    lower.current.renderOrder = below ? 2 : 1;
    upper.current.renderOrder = below ? 1 : 2;
  });
  return <>
    {r.lowerMaterial && <mesh ref={lower} geometry={r.deck} material={r.lowerMaterial}
      raycast={NO_RAYCAST} frustumCulled={false} renderOrder={1} dispose={null} />}
    <mesh ref={upper} geometry={r.deck} material={r.cloudMaterial}
      raycast={NO_RAYCAST} frustumCulled={false} renderOrder={2} dispose={null} />
    {r.funnel && r.funnelMaterial && <mesh geometry={r.funnel} material={r.funnelMaterial}
      raycast={NO_RAYCAST} frustumCulled={false} renderOrder={3} dispose={null} />}
    {r.funnel && r.veilMaterial && <mesh geometry={r.funnel} material={r.veilMaterial}
      raycast={NO_RAYCAST} frustumCulled={false} renderOrder={4} dispose={null} />}
    <mesh geometry={r.particleGeometry} material={r.particleMaterial}
      raycast={NO_RAYCAST} frustumCulled={false} renderOrder={5} dispose={null} />
    <mesh geometry={r.bolt} material={r.glowMaterial}
      raycast={NO_RAYCAST} frustumCulled={false} renderOrder={6} dispose={null} />
    <mesh geometry={r.bolt} material={r.boltMaterial}
      raycast={NO_RAYCAST} frustumCulled={false} renderOrder={7} dispose={null} />
  </>;
}

export function TornadoFX(props: {
  center: THREE.CurvePath<THREE.Vector3>; widthM: number; frame: Frame;
}): JSX.Element {
  const { center, widthM, frame } = props;
  const root = React.useRef<THREE.Group>(null);
  const light = React.useRef<THREE.PointLight>(null);
  const runtime = React.useRef<Playback>(playback(613));
  const r = useResources(false);
  const point = React.useMemo(() => new THREE.Vector3(), []);
  const tangent = React.useMemo(() => new THREE.Vector3(), []);

  useFrame((_, delta) => {
    const group = root.current;
    if (!group) return;
    const rawT = useSceneStore.getState().stormT;
    const p = runtime.current;
    if (rawT == null || !Number.isFinite(rawT) || center.curves.length === 0) {
      group.visible = false;
      p.active = false;
      if (light.current) light.current.intensity = 0;
      return;
    }
    const t = clamp01(rawT);
    advance(p, t, delta);
    const u = r.uniforms;
    u.uFade.value = fadeAt(t);
    group.visible = u.uFade.value > 0;
    center.getPointAt(t, point);
    const ground = finite(frame.groundY(point.x, point.z), 0);
    group.position.set(point.x, ground, point.z);
    u.uOrigin.value.copy(group.position);
    center.getTangentAt(t, tangent);
    if (Number.isFinite(tangent.x) && Number.isFinite(tangent.z)
      && tangent.x * tangent.x + tangent.z * tangent.z > 1e-8) {
      u.uTravel.value.set(tangent.x, tangent.z).normalize();
    }
    const width = THREE.MathUtils.clamp(finite(widthM, TORNADO.minWidth), TORNADO.minWidth, 3500);
    u.uRadius.value = width * 0.5;
    u.uHeight.value = Math.min(TORNADO.maxHeight, TORNADO.height + width * 0.12);
    u.uCloudRadius.value = Math.max(1250, width * 1.5);
    u.uTime.value = p.time;
    const extent = Math.max(u.uCloudRadius.value * 2.6, u.uRadius.value * 12);
    const tile = u.uTerrainInfo.value;
    const moved = Math.hypot(point.x - tile.x, point.z - tile.y);
    if (p.terrainFrame !== frame || Math.abs(tile.z - extent) > 1
      || p.terrainTime < 0 || moved > extent * 0.12
      || (p.time - p.terrainTime >= TORNADO.terrainInterval && moved > extent / TORNADO.terrainSamples)) {
      sampleTerrain(r, frame, point.x, point.z, extent);
      p.terrainTime = p.time;
      p.terrainFrame = frame;
    }
    const flash = lightning(r, p, false, frame);
    if (light.current) {
      light.current.position.copy(u.uFlashPos.value);
      light.current.distance = u.uCloudRadius.value * 4;
      light.current.intensity = flash * u.uFade.value * 2.8e7;
    }
  });

  return <group ref={root} visible={false} dispose={null}>
    <StormMeshes r={r} />
    <pointLight ref={light} color="#c4d8eb" intensity={0} distance={7000} decay={2} castShadow={false} />
  </group>;
}

export function HurricaneFX(props: {
  state: React.MutableRefObject<HurricaneFXState>; cloudAltM: number; lowAltM: number;
}): JSX.Element {
  const { state, cloudAltM, lowAltM } = props;
  const root = React.useRef<THREE.Group>(null);
  const light = React.useRef<THREE.PointLight>(null);
  const runtime = React.useRef<Playback>(playback(9127));
  const r = useResources(true);

  useFrame((_, delta) => {
    const group = root.current;
    if (!group) return;
    const current = state.current;
    const p = runtime.current;
    if (!current.playing || !Number.isFinite(current.t)) {
      group.visible = false;
      p.active = false;
      if (light.current) light.current.intensity = 0;
      return;
    }
    const t = clamp01(current.t);
    advance(p, t, delta);
    const u = r.uniforms;
    u.uFade.value = fadeAt(t);
    group.visible = u.uFade.value > 0;
    u.uTime.value = p.time;
    u.uRadius.value = Math.max(1000, finite(current.rmwM, 20000));
    u.uCloudAlt.value = Math.max(100, finite(cloudAltM, 1800));
    u.uLowAlt.value = Math.max(30, finite(lowAltM, 900));
    const flash = lightning(r, p, true);
    if (light.current) {
      light.current.position.copy(u.uFlashPos.value);
      light.current.distance = u.uRadius.value * 0.75;
      light.current.intensity = flash * u.uFade.value * 5.5e7;
    }
  });

  return <group ref={root} visible={false} dispose={null}>
    <StormMeshes r={r} />
    <pointLight ref={light} color="#c6dcf0" intensity={0} distance={16000} decay={2} castShadow={false} />
  </group>;
}
