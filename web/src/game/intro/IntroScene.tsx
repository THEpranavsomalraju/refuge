import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef, type MutableRefObject } from 'react';
import * as THREE from 'three';

/**
 * Backdrop for the game intro: a field of hex blocks (a town seen from above) that a storm lights up
 * in the risk-map colors as it passes. Tornado = a tight funnel dragging a burn scar across the field;
 * hurricane = a spiral with an open eye. Purely decorative; no game data is read here.
 */

export type IntroHazard = 'tornado' | 'hurricane';
export interface IntroSceneState {
  /** 0 = tornado look, 1 = hurricane look (eased toward `hazard`). */
  hazard: IntroHazard;
  /** Where the camera sits: a wide establishing shot, a lower one for choices, a dive on exit. */
  shot: 'wide' | 'choose' | 'dive';
}

const BG = '#0e1422';
const COLS = 96, ROWS = 70, R = 1;               // pointy-top hexes, circumradius 1
const FIELD = 48;                                  // hexes fade out past this radius (well into the fog)
const HEADING = 0.5;                               // camera heading (radians); it only sways a little around this
const RIGHT = new THREE.Vector2(Math.cos(HEADING), -Math.sin(HEADING)), TOWARD = new THREE.Vector2(Math.sin(HEADING), Math.cos(HEADING));
/** A point `x` to the right and `z` toward the camera, in world xz. */
const view = (x: number, z: number) => RIGHT.clone().multiplyScalar(x).add(TOWARD.clone().multiplyScalar(z));
// The tornado crosses the foreground below the card; the hurricane eye tracks just behind it.
const TORNADO_A = view(-40, 21), TORNADO_B = view(36, 15);
const EYE_A = view(-34, 10), EYE_B = view(34, 4);
const TORNADO_S = 13, EYE_S = 38;                  // seconds per pass

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

// ---------------------------------------------------------------- hex field

const HEX_VERT = /* glsl */ `
uniform float uTime, uReveal, uExit, uMode, uPassT, uPassE;
uniform vec2 uStorm, uDir, uEye;
attribute vec2 aCenter;
attribute float aBase, aDist, aSeed;
varying vec3 vN;
varying vec2 vLocal;
varying float vHeat, vTop, vDepth, vRise, vDist;

float tornadoHeat(vec2 c) {
  vec2 rel = c - uStorm;
  float along = dot(rel, uDir);
  float perp = abs(dot(rel, vec2(-uDir.y, uDir.x)));
  float core = exp(-dot(rel, rel) / 5.0);
  float scar = exp(-perp * perp / 2.4) * step(along, 0.0) * exp(along / 16.0);
  return clamp(max(core, scar * 0.8) * uPassT, 0.0, 1.0);
}
float hurricaneHeat(vec2 c) {
  vec2 rel = c - uEye;
  float r = length(rel), th = atan(rel.y, rel.x);
  float arms = 0.5 + 0.5 * sin(3.0 * (th + log(r + 1.0) * 1.9) - uTime * 0.7);
  float wall = exp(-pow((r - 3.4) / 1.4, 2.0));
  float bands = arms * smoothstep(22.0, 4.0, r) * 0.7;
  return clamp((wall + bands) * smoothstep(1.3, 2.8, r) * uPassE, 0.0, 1.0);
}

void main() {
  float heat = mix(tornadoHeat(aCenter), hurricaneHeat(aCenter), uMode);
  float rise = smoothstep(aDist * 0.7, aDist * 0.7 + 0.3, uReveal);
  float breathe = 0.04 * sin(uTime * 0.8 + aSeed * 6.283);
  float h = 0.06 + (aBase + breathe) * rise + heat * heat * 3.2 * rise + uExit * aBase * 2.0;
  vec3 world = vec3(aCenter.x + position.x, position.y * h - (1.0 - rise) * 1.2, aCenter.y + position.z);
  vec4 mv = modelViewMatrix * vec4(world, 1.0);
  gl_Position = projectionMatrix * mv;
  vN = normal; vLocal = position.xz; vHeat = heat; vTop = step(0.5, normal.y);
  vDepth = -mv.z; vRise = rise; vDist = aDist;
}`

const HEX_FRAG = /* glsl */ `
uniform vec3 uBg;
uniform float uFogNear, uFogFar;
varying vec3 vN;
varying vec2 vLocal;
varying float vHeat, vTop, vDepth, vRise, vDist;

vec3 heatColor(float x) {
  vec3 c = mix(vec3(0.17, 0.25, 0.38), vec3(0.95, 0.69, 0.20), smoothstep(0.08, 0.42, x));   // slate -> amber
  c = mix(c, vec3(1.0, 0.29, 0.27), smoothstep(0.42, 0.72, x));                                // -> coral
  return mix(c, vec3(0.78, 0.12, 0.20), smoothstep(0.82, 1.0, x));                             // -> deep red
}

void main() {
  vec3 L = normalize(vec3(0.35, 1.0, 0.45));
  float diff = 0.5 + 0.5 * max(dot(normalize(vN), L), 0.0);
  vec3 base = vec3(0.105, 0.14, 0.215) * diff * mix(0.72, 1.0, vTop);
  vec3 hc = heatColor(vHeat);
  vec3 col = mix(base, hc * (0.55 + 0.45 * diff), smoothstep(0.06, 0.45, vHeat));
  col += hc * smoothstep(0.55, 1.0, vHeat) * 0.45;
  // Thin rim on each block's top, cyan at rest and heat-colored when lit.
  float hd = max(abs(vLocal.x), max(abs(0.5 * vLocal.x + 0.866 * vLocal.y), abs(-0.5 * vLocal.x + 0.866 * vLocal.y)));
  float edge = vTop * smoothstep(0.72, 0.79, hd);
  col += edge * mix(vec3(0.52, 0.98, 1.0) * 0.16, hc * 0.7, smoothstep(0.1, 0.6, vHeat));
  float fade = max(smoothstep(uFogNear, uFogFar, vDepth), smoothstep(0.8, 0.98, vDist));
  col = mix(col, uBg, fade);
  gl_FragColor = vec4(col, 1.0);
}`;

function hexField() {
  const cyl = new THREE.CylinderGeometry(0.93 * R, 0.93 * R, 1, 6, 1).translate(0, 0.5, 0);
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = cyl.index;
  geo.setAttribute('position', cyl.getAttribute('position'));
  geo.setAttribute('normal', cyl.getAttribute('normal'));
  const rand = rng(20260927);
  const centers: number[] = [], base: number[] = [], dist: number[] = [], seed: number[] = [];
  const w = Math.sqrt(3) * R;
  for (let r = 0; r < ROWS; r++) {
    for (let q = 0; q < COLS; q++) {
      const x = (q - COLS / 2 + (r & 1) * 0.5) * w, z = (r - ROWS / 2) * 1.5 * R;
      const d = Math.hypot(x, z * 1.15);
      if (d > FIELD) continue;
      // Taller "downtown" blocks near the middle, scattered low blocks elsewhere, some empty lots.
      const downtown = Math.exp(-(d * d) / 110);
      const lot = rand();
      const h = lot < 0.12 ? 0.02 : 0.12 + rand() * 0.35 + downtown * (0.4 + rand() * 1.3);
      centers.push(x, z); base.push(h); dist.push(d / FIELD); seed.push(rand());
    }
  }
  geo.setAttribute('aCenter', new THREE.InstancedBufferAttribute(new Float32Array(centers), 2));
  geo.setAttribute('aBase', new THREE.InstancedBufferAttribute(new Float32Array(base), 1));
  geo.setAttribute('aDist', new THREE.InstancedBufferAttribute(new Float32Array(dist), 1));
  geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(new Float32Array(seed), 1));
  geo.instanceCount = base.length;
  return geo;
}

// ---------------------------------------------------------------- particles

const FUNNEL_VERT = /* glsl */ `
uniform float uTime, uAlpha;
uniform vec2 uStorm;
uniform float uPx;
attribute float aAng, aH, aR, aSpd;
varying float vA;
varying float vWarm;
void main() {
  float h = fract(aH + uTime * 0.07 * aSpd);
  float r = mix(0.28, 3.4, pow(h, 1.7)) * (0.55 + 0.45 * aR);
  float ang = aAng + uTime * (3.4 - h * 1.8);
  vec3 p = vec3(uStorm.x + cos(ang) * r, h * 10.0, uStorm.y + sin(ang) * r);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = uPx * (1.4 + aR * 2.2) * 40.0 / -mv.z;
  vA = uAlpha * (1.0 - h * 0.8) * smoothstep(0.0, 0.06, h);
  vWarm = 0.0;
}`;
const DEBRIS_VERT = /* glsl */ `
uniform float uTime, uAlpha;
uniform vec2 uStorm;
uniform float uPx;
attribute float aAng, aH, aR, aSpd;
varying float vA;
varying float vWarm;
void main() {
  float r = 1.2 + aR * 3.2;
  float ang = aAng + uTime * (2.6 / (0.6 + aR)) * aSpd;
  float y = 0.2 + aH * 1.6 + 0.3 * sin(uTime * 3.0 + aAng * 5.0);
  vec3 p = vec3(uStorm.x + cos(ang) * r, y, uStorm.y + sin(ang) * r);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = uPx * (0.8 + aH) * 26.0 / -mv.z;
  vA = uAlpha * (1.0 - aR * 0.6);
  vWarm = 1.0;
}`;
const SPIRAL_VERT = /* glsl */ `
uniform float uTime, uAlpha;
uniform vec2 uEye;
uniform float uPx;
attribute float aAng, aH, aR, aSpd;
varying float vA;
varying float vWarm;
void main() {
  float r = 1.6 + aR * aR * 22.0;
  float ang = aAng + uTime * 0.55 * 6.0 / (r + 4.0);
  float arm = 0.5 + 0.5 * sin(3.0 * (ang + log(r + 1.0) * 1.9));
  vec3 p = vec3(uEye.x + cos(ang) * r, 3.2 + aH * 1.4 + r * 0.04, uEye.y + sin(ang) * r);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = uPx * (1.8 + aSpd * 2.6) * 40.0 / -mv.z;
  vA = uAlpha * pow(arm, 1.8) * smoothstep(1.4, 3.2, r) * smoothstep(23.0, 12.0, r);
  vWarm = 0.0;
}`;
const DOT_FRAG = /* glsl */ `
varying float vA;
varying float vWarm;
void main() {
  float d = length(gl_PointCoord - 0.5);
  if (d > 0.5) discard;
  vec3 cool = mix(vec3(0.93, 0.89, 0.84), vec3(0.52, 0.98, 1.0), 0.35);
  vec3 col = mix(cool, vec3(1.0, 0.42, 0.34), vWarm);
  gl_FragColor = vec4(col, vA * smoothstep(0.5, 0.0, d));
}`;

function particles(count: number, seed: number) {
  const rand = rng(seed);
  const g = new THREE.BufferGeometry();
  const f = (fn: () => number) => new THREE.BufferAttribute(Float32Array.from({ length: count }, fn), 1);
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  g.setAttribute('aAng', f(() => rand() * Math.PI * 2));
  g.setAttribute('aH', f(rand));
  g.setAttribute('aR', f(rand));
  g.setAttribute('aSpd', f(() => 0.6 + rand() * 0.8));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
  return g;
}

// ---------------------------------------------------------------- wind streaks and radar ring

const WIND_VERT = /* glsl */ `
uniform float uTime, uAlpha;
uniform vec2 uDir;
attribute float aEnd;
attribute vec3 aSeed;
varying float vA;
void main() {
  vec2 span = vec2(76.0, 56.0);
  vec2 p = mod(aSeed.xy * span + uDir * uTime * (7.0 + aSeed.z * 6.0), span) - span * 0.5;
  float len = 2.5 + aSeed.z * 4.0;
  vec3 w = vec3(p.x - uDir.x * len * aEnd, 0.9 + aSeed.z * 3.5, p.y - uDir.y * len * aEnd);
  vec4 mv = modelViewMatrix * vec4(w, 1.0);
  gl_Position = projectionMatrix * mv;
  float edge = 1.0 - smoothstep(0.6, 1.0, max(abs(p.x) / (span.x * 0.5), abs(p.y) / (span.y * 0.5)));
  vA = uAlpha * (1.0 - aEnd) * edge * (0.5 + 0.5 * sin(uTime * 0.9 + aSeed.x * 40.0));
}`;
const WIND_FRAG = /* glsl */ `
varying float vA;
void main() { gl_FragColor = vec4(0.62, 0.95, 1.0, vA); }`;

const GLOW_FRAG = /* glsl */ `
uniform float uAlpha;
uniform vec3 uColor;
varying vec2 vUv;
void main() { float r = length(vUv); gl_FragColor = vec4(uColor, uAlpha * pow(max(0.0, 1.0 - r), 2.2)); }`;

const RING_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv * 2.0 - 1.0; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const RING_FRAG = /* glsl */ `
uniform float uTime, uAlpha;
varying vec2 vUv;
void main() {
  float r = length(vUv) * 40.0;
  float a = 0.0;
  for (int i = 0; i < 2; i++) {
    float t = fract(uTime / 6.0 + float(i) * 0.5);
    float R = t * 40.0;
    a += exp(-pow((r - R) / 0.35, 2.0)) * (1.0 - t) * (1.0 - t);
  }
  gl_FragColor = vec4(0.52, 0.98, 1.0, a * uAlpha * 0.5);
}`;

function windGeometry(count: number) {
  const rand = rng(77);
  const end = new Float32Array(count * 2), seed = new Float32Array(count * 6);
  for (let i = 0; i < count; i++) {
    const s = [rand(), rand(), rand()];
    end[i * 2] = 0; end[i * 2 + 1] = 1;
    seed.set([...s, ...s], i * 6);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 6), 3));
  g.setAttribute('aEnd', new THREE.BufferAttribute(end, 1));
  g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 3));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
  return g;
}

// ---------------------------------------------------------------- scene

const ease = (x: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, x)), 3);
const pass = (t: number) => Math.min(1, t / 0.08, (1 - t) / 0.1);

function Storm({ state, pointer }: { state: MutableRefObject<IntroSceneState>; pointer: MutableRefObject<[number, number]> }) {
  const { camera, gl } = useThree();
  const hexGeo = useMemo(hexField, []);
  const common = () => ({ uTime: { value: 0 }, uAlpha: { value: 0 }, uPx: { value: 1 } });
  const hexMat = useMemo(() => new THREE.ShaderMaterial({
    vertexShader: HEX_VERT, fragmentShader: HEX_FRAG,
    uniforms: {
      uTime: { value: 0 }, uReveal: { value: 0 }, uExit: { value: 0 }, uMode: { value: 0 }, uPassT: { value: 0 }, uPassE: { value: 0 },
      uStorm: { value: new THREE.Vector2() }, uDir: { value: TORNADO_B.clone().sub(TORNADO_A).normalize() }, uEye: { value: new THREE.Vector2() },
      uBg: { value: new THREE.Color(BG) }, uFogNear: { value: 28 }, uFogFar: { value: 82 },
    },
  }), []);
  const dots = (vert: string, extra: Record<string, THREE.IUniform>) => new THREE.ShaderMaterial({
    vertexShader: vert, fragmentShader: DOT_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { ...common(), ...extra },
  });
  const funnel = useMemo(() => ({ geo: particles(4200, 1), mat: dots(FUNNEL_VERT, { uStorm: { value: new THREE.Vector2() } }) }), []);
  const debris = useMemo(() => ({ geo: particles(1100, 2), mat: dots(DEBRIS_VERT, { uStorm: { value: new THREE.Vector2() } }) }), []);
  const spiral = useMemo(() => ({ geo: particles(9000, 3), mat: dots(SPIRAL_VERT, { uEye: { value: new THREE.Vector2() } }) }), []);
  const wind = useMemo(() => ({
    geo: windGeometry(260),
    mat: new THREE.ShaderMaterial({ vertexShader: WIND_VERT, fragmentShader: WIND_FRAG, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, uniforms: { ...common(), uDir: { value: new THREE.Vector2(1, -0.4).normalize() } } }),
  }), []);
  const ring = useMemo(() => new THREE.ShaderMaterial({
    vertexShader: RING_VERT, fragmentShader: RING_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uTime: { value: 0 }, uAlpha: { value: 0 } },
  }), []);
  const glow = useMemo(() => new THREE.ShaderMaterial({
    vertexShader: RING_VERT, fragmentShader: GLOW_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uAlpha: { value: 0 }, uColor: { value: new THREE.Color('#ff4944') } },
  }), []);
  const glowMesh = useRef<THREE.Mesh>(null);
  useEffect(() => () => {
    hexGeo.dispose(); hexMat.dispose(); ring.dispose(); glow.dispose();
    for (const p of [funnel, debris, spiral, wind]) { p.geo.dispose(); p.mat.dispose(); }
  }, [hexGeo, hexMat, funnel, debris, spiral, wind, ring, glow]);

  const anim = useRef({ t: 0, reveal: 0, exit: 0, mode: 0, camDist: 46, camH: 30, look: new THREE.Vector3() });
  useFrame((_, dtRaw) => {
    const dt = Math.min(dtRaw, 0.05);
    const a = anim.current, s = state.current;
    a.t += dt;
    a.reveal = Math.min(1, a.reveal + dt / 2.4);
    a.exit = s.shot === 'dive' ? Math.min(1, a.exit + dt / 1.2) : Math.max(0, a.exit - dt);
    a.mode += ((s.hazard === 'hurricane' ? 1 : 0) - a.mode) * Math.min(1, dt * 2.2);

    const pt = (a.t % TORNADO_S) / TORNADO_S, pe = (a.t % EYE_S) / EYE_S;
    const storm = TORNADO_A.clone().lerp(TORNADO_B, pt), eye = EYE_A.clone().lerp(EYE_B, pe);
    const u = hexMat.uniforms;
    u.uTime!.value = a.t; u.uReveal!.value = ease(a.reveal); u.uExit!.value = ease(a.exit); u.uMode!.value = a.mode;
    u.uPassT!.value = pass(pt); u.uPassE!.value = pass(pe);
    (u.uStorm!.value as THREE.Vector2).copy(storm); (u.uEye!.value as THREE.Vector2).copy(eye);

    const px = gl.getPixelRatio();
    const tornadoA = (1 - a.mode) * ease(a.reveal) * pass(pt) * (1 - a.exit);
    const hurricaneA = a.mode * ease(a.reveal) * pass(pe) * (1 - a.exit);
    for (const [m, alpha] of [[funnel.mat, 0.8 * tornadoA], [debris.mat, 0.9 * tornadoA], [spiral.mat, 0.55 * hurricaneA]] as const) {
      m.uniforms.uTime!.value = a.t; m.uniforms.uAlpha!.value = alpha; m.uniforms.uPx!.value = px;
    }
    (funnel.mat.uniforms.uStorm!.value as THREE.Vector2).copy(storm);
    (debris.mat.uniforms.uStorm!.value as THREE.Vector2).copy(storm);
    (spiral.mat.uniforms.uEye!.value as THREE.Vector2).copy(eye);
    wind.mat.uniforms.uTime!.value = a.t;
    wind.mat.uniforms.uAlpha!.value = 0.28 * ease(a.reveal) * (1 - a.exit);
    ring.uniforms.uTime!.value = a.t; ring.uniforms.uAlpha!.value = ease(a.reveal) * (1 - a.exit);
    // Warm glow on the ground under the funnel, cool glow around the hurricane's eyewall.
    const g = glowMesh.current;
    if (g) {
      const hur = a.mode > 0.5;
      g.position.set(hur ? eye.x : storm.x, 0.08, hur ? eye.y : storm.y);
      g.scale.setScalar(hur ? 9 : 5);
      (glow.uniforms.uColor!.value as THREE.Color).set(hur ? '#84f9fe' : '#ff4944');
      glow.uniforms.uAlpha!.value = (hur ? 0.16 * hurricaneA / Math.max(a.mode, 1e-3) : 0.42 * tornadoA / Math.max(1 - a.mode, 1e-3)) * Math.abs(a.mode - 0.5) * 2;
    }

    // Camera: a slow orbit, lower for the choices, a dive into the town on exit, with a little mouse parallax.
    const goal = s.shot === 'wide' ? { d: 44, h: 27 } : s.shot === 'choose' ? { d: 39, h: 21 } : { d: 15, h: 6 };
    const k = Math.min(1, dt * (s.shot === 'dive' ? 2.4 : 0.9));
    a.camDist += (goal.d - a.camDist) * k;
    a.camH += (goal.h - a.camH) * k;
    const [mx, my] = pointer.current;
    const ang = HEADING + 0.1 * Math.sin(a.t * 0.06) + mx * 0.07;
    camera.position.set(Math.sin(ang) * a.camDist, a.camH - my * 2.2, Math.cos(ang) * a.camDist);
    a.look.lerp(new THREE.Vector3(mx * 2.5, 0, -my * 1.5), Math.min(1, dt * 2));
    camera.lookAt(a.look);
  });

  return (
    <>
      <mesh geometry={hexGeo} material={hexMat} frustumCulled={false} />
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.03, 0]} material={ring} renderOrder={2}>
        <planeGeometry args={[80, 80]} />
      </mesh>
      <mesh ref={glowMesh} rotation={[-Math.PI / 2, 0, 0]} material={glow} renderOrder={2}>
        <planeGeometry args={[2, 2]} />
      </mesh>
      <lineSegments geometry={wind.geo} material={wind.mat} frustumCulled={false} renderOrder={3} />
      <points geometry={spiral.geo} material={spiral.mat} frustumCulled={false} renderOrder={4} />
      <points geometry={funnel.geo} material={funnel.mat} frustumCulled={false} renderOrder={4} />
      <points geometry={debris.geo} material={debris.mat} frustumCulled={false} renderOrder={4} />
    </>
  );
}

export function IntroScene({ state }: { state: MutableRefObject<IntroSceneState> }) {
  // Pointer across the whole intro (the card sits on top of the canvas), -1..1 each way.
  const pointer = useRef<[number, number]>([0, 0]);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const move = (e: PointerEvent) => {
      const r = box.current?.getBoundingClientRect();
      if (!r || r.width === 0) return;
      pointer.current = [((e.clientX - r.left) / r.width) * 2 - 1, ((e.clientY - r.top) / r.height) * 2 - 1];
    };
    window.addEventListener('pointermove', move);
    return () => window.removeEventListener('pointermove', move);
  }, []);
  return (
    <div ref={box} className="rf-canvas" aria-hidden>
      <Canvas dpr={[1, 1.75]} gl={{ antialias: true, powerPreference: 'high-performance' }}
        camera={{ fov: 38, near: 0.5, far: 200, position: [20, 30, 40] }}>
        <color attach="background" args={[BG]} />
        <Storm state={state} pointer={pointer} />
      </Canvas>
    </div>
  );
}
