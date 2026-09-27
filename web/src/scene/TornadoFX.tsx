import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { Frame } from './geo';
import { useSceneStore } from './store';

/**
 * Cosmetic tornado effect: custom GLSL funnel, wall cloud and particles on the existing storm timeline
 * (stormT). Nothing here reads or changes results, the camera or the game flow; everything is hidden
 * unless a storm is playing.
 */

const NOISE = /* glsl */ `
float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float noise(vec3 x) {
  vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x), mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x), mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
}
float fbm(vec3 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; } return v; }
`;

/** 0 -> 1 -> 0 envelope over a run, so effects fade in and out instead of popping. */
const envelope = (t: number) => Math.min(1, t / 0.08) * Math.min(1, (1 - t) / 0.08);

// ---------------------------------------------------------------- particles (debris, dust, rain)

const SWIRL_VERT = /* glsl */ `
uniform float uTime, uH, uR, uOpacity, uSpin, uRise, uLow;
attribute float aAng, aRad, aH, aSpd, aSize;
varying float vA;
void main() {
  float h = fract(aH + uTime * aSpd * uRise);
  float y = pow(h, uLow) * uH;
  float r = uR * (0.25 + aRad * 0.95) * (1.0 + h * 1.4);
  float ang = aAng + uTime * uSpin * (1.0 + (1.0 - aRad)) * (1.2 - h * 0.5);
  vec4 mv = modelViewMatrix * vec4(cos(ang) * r, y, sin(ang) * r, 1.0);
  gl_PointSize = aSize * (1400.0 / -mv.z);
  gl_Position = projectionMatrix * mv;
  vA = uOpacity * (1.0 - h) * (0.45 + 0.55 * aRad);
}`;
const RAIN_VERT = /* glsl */ `
uniform float uTime, uTop, uR, uOpacity, uFall, uLean, uInner;
attribute float aAng, aRad, aH, aSpd, aSize;
varying float vA;
void main() {
  float y = mod(aH * uTop - uTime * uFall * (0.8 + aSpd), uTop);
  float r = uR * mix(uInner, 1.0, sqrt(aRad));
  float ang = aAng + uTime * 0.12 + (uTop - y) / uTop * uLean;     // swept around with the wind as it falls
  vec4 mv = modelViewMatrix * vec4(cos(ang) * r, y, sin(ang) * r, 1.0);
  gl_PointSize = aSize * (900.0 / -mv.z);
  gl_Position = projectionMatrix * mv;
  vA = uOpacity * (0.5 + 0.5 * aSpd);
}`;
const SOFT_FRAG = /* glsl */ `
uniform vec3 uColor;
varying float vA;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c);
  if (d > 0.5) discard;
  gl_FragColor = vec4(uColor, vA * smoothstep(0.5, 0.05, d));
}`;

function particleGeometry(count: number, size: [number, number]) {
  const g = new THREE.BufferGeometry();
  const f = (k: number) => new THREE.BufferAttribute(new Float32Array(count).map(() => k === 4 ? size[0] + Math.random() * (size[1] - size[0]) : k === 0 ? Math.random() * Math.PI * 2 : Math.random()), 1);
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  g.setAttribute('aAng', f(0)); g.setAttribute('aRad', f(1)); g.setAttribute('aH', f(2)); g.setAttribute('aSpd', f(3)); g.setAttribute('aSize', f(4));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);   // shader moves points; never cull
  return g;
}

function particleMaterial(vert: string, color: string, uniforms: Record<string, number>) {
  return new THREE.ShaderMaterial({
    vertexShader: vert, fragmentShader: SOFT_FRAG, transparent: true, depthWrite: false,
    uniforms: { uColor: { value: new THREE.Color(color) }, uTime: { value: 0 }, uOpacity: { value: 0 }, ...Object.fromEntries(Object.entries(uniforms).map(([k, v]) => [k, { value: v }])) },
  });
}

// ---------------------------------------------------------------- lightning

function useLightning(maxPts = 14) {
  const geo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(maxPts * 3), 3));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
    return g;
  }, [maxPts]);
  const mat = useMemo(() => new THREE.LineBasicMaterial({ color: '#eaf2ff', transparent: true, opacity: 0 }), []);
  const light = useRef<THREE.PointLight>(null);
  const state = useRef({ next: 1.5, until: 0 });
  useEffect(() => () => { geo.dispose(); mat.dispose(); }, [geo, mat]);
  /** Call every frame; strikes from (x, top, z) toward the ground near (x, z) at random intervals. */
  const tick = (time: number, active: boolean, pick: () => [number, number, number]) => {
    const s = state.current;
    if (active && time > s.next) {
      const [x, top, z] = pick();
      const pos = geo.getAttribute('position') as THREE.BufferAttribute;
      let px = x, pz = z;
      for (let i = 0; i < maxPts; i++) {
        const k = i / (maxPts - 1);
        px += (Math.random() - 0.5) * top * 0.08; pz += (Math.random() - 0.5) * top * 0.08;
        pos.setXYZ(i, px, top * (1 - k), pz);
      }
      pos.needsUpdate = true;
      if (light.current) light.current.position.set(x, top * 0.6, z);
      s.until = time + 0.14 + Math.random() * 0.1;
      s.next = time + 1.2 + Math.random() * 3.2;
    }
    const on = active && time < s.until;
    const flicker = on ? 0.6 + 0.4 * Math.sin(time * 90) : 0;
    mat.opacity = flicker;
    if (light.current) light.current.intensity = flicker * 6;
  };
  const node = (
    <>
      <line>
        <primitive object={geo} attach="geometry" />
        <primitive object={mat} attach="material" />
      </line>
      <pointLight ref={light} color="#dfe8ff" intensity={0} distance={0} decay={0} />
    </>
  );
  return { tick, node };
}

// ---------------------------------------------------------------- tornado

const FUNNEL_VERT = /* glsl */ `
${NOISE}
uniform float uTime, uWob;
varying float vH, vAng, vN;
void main() {
  vec3 p = position;
  float h = uv.y;
  float ang = atan(p.z, p.x) + uTime * (2.2 + 3.5 * (1.0 - h));
  float n = noise(vec3(ang * 1.5, h * 7.0 - uTime * 1.6, uTime * 0.4));
  float rad = length(p.xz) * (0.82 + 0.36 * n);
  vec2 off = vec2(sin(h * 3.1 + uTime * 0.9), cos(h * 2.4 + uTime * 0.7)) * uWob * pow(1.0 - h, 1.6);
  p = vec3(cos(ang) * rad + off.x, p.y, sin(ang) * rad + off.y);
  vH = h; vAng = ang; vN = n;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;
const FUNNEL_FRAG = /* glsl */ `
${NOISE}
uniform float uTime, uOpacity;
varying float vH, vAng, vN;
void main() {
  float n = fbm(vec3(cos(vAng) * 1.7, vH * 5.0 - uTime * 1.2, sin(vAng) * 1.7));
  float bands = 0.5 + 0.5 * sin(vAng * 5.0 + vH * 18.0 - uTime * 7.0);
  vec3 col = mix(vec3(0.15, 0.16, 0.17), vec3(0.55, 0.56, 0.58), clamp(n * 0.9 + bands * 0.25, 0.0, 1.0));
  float a = smoothstep(0.0, 0.05, vH) * (1.0 - smoothstep(0.86, 1.0, vH)) * (0.45 + 0.5 * n) * uOpacity;
  gl_FragColor = vec4(col, a);
}`;
const CLOUD_VERT = /* glsl */ `
varying vec2 vP;
void main() { vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const WALLCLOUD_FRAG = /* glsl */ `
${NOISE}
uniform float uTime, uOpacity, uRad;
varying vec2 vP;
void main() {
  float r = length(vP) / uRad, th = atan(vP.y, vP.x);
  float s = th + uTime * 0.35 / (r + 0.25);
  float n = fbm(vec3(cos(s) * r * 3.0, sin(s) * r * 3.0, uTime * 0.05));
  vec3 col = mix(vec3(0.10, 0.11, 0.13), vec3(0.36, 0.38, 0.42), n * (0.4 + r));
  float a = smoothstep(1.0, 0.35, r) * (0.35 + 0.6 * n) * uOpacity;
  gl_FragColor = vec4(col, a);
}`;

const FUNNEL_H = 1500;

/** Realistic-looking tornado riding the path during playStorm (cosmetic only). */
export function TornadoFX({ center, widthM, frame }: { center: THREE.CurvePath<THREE.Vector3>; widthM: number; frame: Frame }) {
  const w = Math.max(widthM, 250);
  const group = useRef<THREE.Group>(null);
  const funnelGeo = useMemo(() => {
    const prof: THREE.Vector2[] = [];
    for (let i = 0; i <= 48; i++) {
      const v = i / 48;
      prof.push(new THREE.Vector2(w * 0.12 + (w * 1.15 - w * 0.12) * Math.pow(v, 2.6), v * FUNNEL_H));
    }
    return new THREE.LatheGeometry(prof, 72);
  }, [w]);
  const funnelMat = useMemo(() => new THREE.ShaderMaterial({
    vertexShader: FUNNEL_VERT, fragmentShader: FUNNEL_FRAG, transparent: true, depthWrite: false, side: THREE.DoubleSide,
    uniforms: { uTime: { value: 0 }, uOpacity: { value: 0 }, uWob: { value: w * 0.35 } },
  }), [w]);
  const wallRad = w * 6;
  const wallGeo = useMemo(() => new THREE.CircleGeometry(wallRad, 96), [wallRad]);
  const wallMat = useMemo(() => new THREE.ShaderMaterial({
    vertexShader: CLOUD_VERT, fragmentShader: WALLCLOUD_FRAG, transparent: true, depthWrite: false, side: THREE.DoubleSide,
    uniforms: { uTime: { value: 0 }, uOpacity: { value: 0 }, uRad: { value: wallRad } },
  }), [wallRad]);
  const debris = useMemo(() => ({ geo: particleGeometry(7000, [5, 16]), mat: particleMaterial(SWIRL_VERT, '#5d5246', { uH: FUNNEL_H * 0.55, uR: w * 0.45, uSpin: 2.6, uRise: 0.09, uLow: 2.0 }) }), [w]);
  const dust = useMemo(() => ({ geo: particleGeometry(5000, [14, 34]), mat: particleMaterial(SWIRL_VERT, '#8a7a64', { uH: 180, uR: w * 1.1, uSpin: 1.7, uRise: 0.05, uLow: 1.0 }) }), [w]);
  const rain = useMemo(() => ({ geo: particleGeometry(6000, [3, 6]), mat: particleMaterial(RAIN_VERT, '#9fb3c4', { uTop: FUNNEL_H, uR: w * 5, uFall: 700, uLean: 0.35, uInner: 0.25 }) }), [w]);
  const bolt = useLightning();
  useEffect(() => () => {
    funnelGeo.dispose(); funnelMat.dispose(); wallGeo.dispose(); wallMat.dispose();
    for (const p of [debris, dust, rain]) { p.geo.dispose(); p.mat.dispose(); }
  }, [funnelGeo, funnelMat, wallGeo, wallMat, debris, dust, rain]);

  useFrame(({ clock }) => {
    const g = group.current;
    if (!g) return;
    const t = useSceneStore.getState().stormT;
    g.visible = t !== null;
    const time = clock.elapsedTime;
    const op = t === null ? 0 : envelope(t);
    for (const m of [funnelMat, wallMat, debris.mat, dust.mat, rain.mat]) { m.uniforms.uTime!.value = time; m.uniforms.uOpacity!.value = op; }
    bolt.tick(time, t !== null && op > 0.5, () => {
      const a = Math.random() * Math.PI * 2, r = w * (1.5 + Math.random() * 3);
      return [Math.cos(a) * r, FUNNEL_H, Math.sin(a) * r];
    });
    if (t === null) return;
    const u = Math.min(1, Math.max(0, t));
    const p = center.getPointAt(u), tan = center.getTangentAt(u);
    g.position.set(p.x, frame.groundY(p.x, p.z), p.z);
    // Lean slightly into the direction of travel.
    g.rotation.set(tan.z * 0.08, 0, -tan.x * 0.08);
  });

  return (
    <group ref={group} visible={false}>
      <mesh geometry={funnelGeo} material={funnelMat} raycast={() => null} renderOrder={6} />
      <mesh geometry={wallGeo} material={wallMat} position={[0, FUNNEL_H, 0]} rotation={[-Math.PI / 2, 0, 0]} raycast={() => null} renderOrder={5} />
      <points geometry={debris.geo} material={debris.mat} raycast={() => null} renderOrder={7} />
      <points geometry={dust.geo} material={dust.mat} raycast={() => null} renderOrder={7} />
      <points geometry={rain.geo} material={rain.mat} raycast={() => null} renderOrder={7} />
      {bolt.node}
    </group>
  );
}
