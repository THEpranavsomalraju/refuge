import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import type { Frame } from './geo';
import type { EyeState } from './HurricaneTrack';
import { useSceneStore } from './store';

/**
 * Map-wide weather that plays alongside the storm: wind streaks over the whole town during a tornado
 * (pulled into its circulation close in), rain over the whole town during a hurricane (heaviest near
 * the eyewall). Cosmetic only; hidden unless a storm is playing. Streaks are instanced quads widened
 * in screen space, so they stay visible at any zoom.
 */

const GRID = 96;          // terrain samples per side for the height lookup
const MARGIN = 0.45;      // how far past the town edge the weather reaches, as a share of the larger side

const envelope = (t: number) => Math.max(0, Math.min(1, t / 0.08, (1 - t) / 0.08));

const COMMON = /* glsl */ `
uniform sampler2D uGround;
uniform vec2 uHalf, uRes;
uniform float uTime, uFade, uWidthPx;
attribute vec2 aCorner;   // x: 0 head .. 1 tail, y: -1..1 across
attribute vec4 aSeed;
varying float vAlong, vSide, vA;

float groundAt(vec2 p) {
  vec2 g = clamp((p + uHalf) / (2.0 * uHalf), 0.0, 1.0) * ${GRID - 1}.0;
  ivec2 i = ivec2(floor(g)), j = min(i + 1, ivec2(${GRID - 1}));
  vec2 f = fract(g);
  float a = texelFetch(uGround, i, 0).r, b = texelFetch(uGround, ivec2(j.x, i.y), 0).r;
  float c = texelFetch(uGround, ivec2(i.x, j.y), 0).r, d = texelFetch(uGround, j, 0).r;
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
vec2 wrap(vec2 p) { return mod(p + uHalf, 2.0 * uHalf) - uHalf; }
float edgeFade(vec2 p) { vec2 q = abs(p) / uHalf; return 1.0 - smoothstep(0.85, 1.0, max(q.x, q.y)); }
// Streak from world point A (head) to B (tail), uWidthPx wide on screen.
void streak(vec3 A, vec3 B) {
  vec4 cA = projectionMatrix * modelViewMatrix * vec4(A, 1.0);
  vec4 cB = projectionMatrix * modelViewMatrix * vec4(B, 1.0);
  if (cA.w <= 0.0 || cB.w <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vA = 0.0; return; }
  vec2 d = (cB.xy / cB.w - cA.xy / cA.w) * uRes;
  d = length(d) > 1e-4 ? normalize(d) : vec2(1.0, 0.0);
  vec4 c = mix(cA, cB, aCorner.x);
  c.xy += vec2(-d.y, d.x) * aCorner.y * uWidthPx / uRes * c.w;
  gl_Position = c;
  vAlong = aCorner.x; vSide = aCorner.y;
}`;

const WIND_VERT = /* glsl */ `
${COMMON}
uniform vec2 uTor, uDir;
uniform float uTorR, uSpeed;
void main() {
  float spd = uSpeed * (0.7 + 0.6 * aSeed.w);
  vec2 p = wrap((aSeed.xy * 2.0 - 1.0) * uHalf + uDir * spd * uTime);
  vec2 d = p - uTor;
  float r = max(length(d), 1.0);
  vec2 swirl = vec2(d.y, -d.x) / r;                        // counterclockwise seen from above
  float k = smoothstep(uTorR * 8.0, uTorR * 1.5, r);       // drawn into the circulation close in
  vec2 v = normalize(mix(uDir, normalize(swirl - d / r * 0.6), k));
  float len = (70.0 + 130.0 * aSeed.z) * (1.0 + k);
  float y = groundAt(p) + 10.0 + aSeed.z * aSeed.z * 200.0;
  float gust = smoothstep(0.1, 0.9, sin(uTime * (0.5 + aSeed.w) + aSeed.x * 60.0));
  vA = uFade * edgeFade(p) * gust * (0.25 + 0.45 * k);
  vec3 A = vec3(p.x, y, p.y);
  streak(A, A - vec3(v.x, 0.0, v.y) * len);
}`;

const RAIN_VERT = /* glsl */ `
${COMMON}
uniform vec2 uEye;
uniform float uRmw, uTop, uFall;
void main() {
  vec2 p = (aSeed.xy * 2.0 - 1.0) * uHalf;
  vec2 d = p - uEye;
  float r = max(length(d), 1.0), rr = r / uRmw;
  vec2 wind = vec2(d.y, -d.x) / r * 0.85 - d / r * 0.3;   // counterclockwise with some inflow
  float band = (0.35 + 0.65 * exp(-pow((rr - 1.1) / 1.4, 2.0))) * smoothstep(0.25, 0.6, rr);
  float key = fract(aSeed.x * 37.0 + aSeed.y * 91.0);
  float h = mod(aSeed.z * uTop - uTime * uFall * (0.85 + 0.3 * aSeed.w), uTop);
  vA = uFade * edgeFade(p) * (1.0 - smoothstep(band - 0.1, band, key)) * 0.5
     * smoothstep(0.0, 30.0, h) * (1.0 - smoothstep(uTop * 0.8, uTop, h));
  vec3 dir = normalize(vec3(wind.x * 0.45, -1.0, wind.y * 0.45));
  vec3 A = vec3(p.x, groundAt(p) + h, p.y);
  streak(A, A - dir * (90.0 + 80.0 * aSeed.w));
}`;

const STREAK_FRAG = /* glsl */ `
uniform vec3 uColor;
varying float vAlong, vSide, vA;
void main() {
  float a = vA * (1.0 - vSide * vSide) * smoothstep(0.0, 0.12, vAlong) * (1.0 - vAlong);
  if (a < 0.004) discard;
  gl_FragColor = vec4(uColor, a);
}`;

/** Instanced streak field over the town plus a margin, with a terrain height lookup. */
function useStreaks(frame: Frame, perKm2: number, max: number, vertexShader: string, color: string, widthPx: number, extra: Record<string, THREE.IUniform>) {
  const res = useMemo(() => {
    const side = Math.max(frame.width, frame.depth);
    const hx = frame.width / 2 + MARGIN * side, hz = frame.depth / 2 + MARGIN * side;

    // Heights: real terrain inside the town, the stand-in ground (lowest point) outside it.
    let lo = Infinity;
    for (let i = 0; i <= 20; i++) for (let k = 0; k <= 20; k++) lo = Math.min(lo, frame.groundY((i / 20 - 0.5) * frame.width, (k / 20 - 0.5) * frame.depth));
    const h = new Float32Array(GRID * GRID);
    for (let j = 0; j < GRID; j++) for (let i = 0; i < GRID; i++) {
      const x = -hx + (2 * hx * i) / (GRID - 1), z = -hz + (2 * hz * j) / (GRID - 1);
      h[j * GRID + i] = Math.abs(x) <= frame.width / 2 && Math.abs(z) <= frame.depth / 2 ? frame.groundY(x, z) : lo - 3;
    }
    const ground = new THREE.DataTexture(h, GRID, GRID, THREE.RedFormat, THREE.FloatType);
    ground.needsUpdate = true;

    const count = Math.round(Math.min(max, Math.max(max / 4, ((4 * hx * hz) / 1e6) * perKm2)));
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(12), 3));
    geo.setAttribute('aCorner', new THREE.Float32BufferAttribute([0, -1, 1, -1, 1, 1, 0, 1], 2));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(new Float32Array(count * 4).map(() => Math.random()), 4));
    geo.instanceCount = count;

    const mat = new THREE.ShaderMaterial({
      vertexShader, fragmentShader: STREAK_FRAG, transparent: true, depthWrite: false,
      uniforms: {
        uGround: { value: ground }, uHalf: { value: new THREE.Vector2(hx, hz) }, uRes: { value: new THREE.Vector2(1, 1) },
        uTime: { value: 0 }, uFade: { value: 0 }, uWidthPx: { value: widthPx }, uColor: { value: new THREE.Color(color) },
        ...extra,
      },
    });
    return { geo, mat, ground, time: 0 };
  }, [frame]);
  useEffect(() => () => { res.geo.dispose(); res.mat.dispose(); res.ground.dispose(); }, [res]);
  return res;
}

/** Wind streaks across the whole map while the tornado plays. */
export function TornadoWind({ center, widthM, frame }: { center: THREE.CurvePath<THREE.Vector3>; widthM: number; frame: Frame }) {
  const s = useStreaks(frame, 30, 12_000, WIND_VERT, '#e4ecf0', 1.8, {
    uTor: { value: new THREE.Vector2() }, uDir: { value: new THREE.Vector2(1, 0) }, uTorR: { value: 200 }, uSpeed: { value: 110 },
  });
  const mesh = useMemo(() => new THREE.Mesh(s.geo, s.mat), [s]);

  useFrame(({ size }, dt) => {
    const t = useSceneStore.getState().stormT;
    mesh.visible = t !== null;
    if (t === null) { s.time = 0; return; }
    const u = s.mat.uniforms, v = Math.min(1, Math.max(0, t));
    s.time += dt;
    const p = center.getPointAt(v), tan = center.getTangentAt(v);
    u.uTime!.value = s.time; u.uFade!.value = envelope(t);
    (u.uRes!.value as THREE.Vector2).set(size.width, size.height);
    (u.uTor!.value as THREE.Vector2).set(p.x, p.z);
    if (tan.x * tan.x + tan.z * tan.z > 1e-8) (u.uDir!.value as THREE.Vector2).set(tan.x, tan.z).normalize();
    u.uTorR!.value = Math.max(150, widthM / 2);
  });

  return <primitive object={mesh} frustumCulled={false} raycast={() => null} renderOrder={8} />;
}

/** Rain across the whole map while the hurricane plays, turning around the eye. */
export function HurricaneRain({ frame, at, window }: { frame: Frame; at: (t: number) => EyeState; window: [number, number] }) {
  const s = useStreaks(frame, 220, 80_000, RAIN_VERT, '#c3d2de', 1.5, {
    uEye: { value: new THREE.Vector2() }, uRmw: { value: 20_000 }, uTop: { value: 900 }, uFall: { value: 520 },
  });
  const mesh = useMemo(() => new THREE.Mesh(s.geo, s.mat), [s]);

  useFrame(({ size }, dt) => {
    const raw = useSceneStore.getState().hurricaneT;
    mesh.visible = raw !== null;
    if (raw === null) { s.time = 0; return; }
    const e = at(window[0] + raw * (window[1] - window[0]));
    const u = s.mat.uniforms;
    s.time += dt;
    u.uTime!.value = s.time; u.uFade!.value = envelope(raw);
    (u.uRes!.value as THREE.Vector2).set(size.width, size.height);
    (u.uEye!.value as THREE.Vector2).set(e.x, e.z);
    u.uRmw!.value = Math.max(1000, e.rmwM);
  });

  return <primitive object={mesh} frustumCulled={false} raycast={() => null} renderOrder={8} />;
}
