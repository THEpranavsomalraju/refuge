import { Html } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { TrackRow } from '../shared/contract';
import { scene } from './api';
import type { Frame } from './geo';
import { useSceneStore } from './store';

const CLIP_M = 60_000;          // track drawn within this distance of the town center
const TRACK_LIFT_M = 60;
const CLOUD_ALT_M = 1800;       // cloud band altitude
const EYEWALL_ALT_M = 900;
const RAIN_COUNT = 2500;
const RAIN_RADIUS_MAX_M = 12_000;
const RAIN_TOP_M = 1500;
const KT_TO_MPH = 1.15078;

/** Saffir-Simpson category from 1-minute sustained wind (kt); 0 = tropical storm or weaker. */
export function categoryOf(vmaxKt: number): number {
  if (vmaxKt >= 137) return 5;
  if (vmaxKt >= 113) return 4;
  if (vmaxKt >= 96) return 3;
  if (vmaxKt >= 83) return 2;
  if (vmaxKt >= 64) return 1;
  return 0;
}

export interface EyeState { x: number; z: number; vmaxKt: number; rmwM: number; category: number }

/** Eye position and strength at progress t (0..1), interpolated by the track's time_h. */
export function trackSampler(track: TrackRow[], frame: Frame): (t: number) => EyeState {
  const rows = track.map(r => {
    const [x, z] = frame.toXZ(r[0], r[1]);
    return { x, z, vmax: r[2], rmwM: r[3] * 1000, time: r[5] };
  });
  const t0 = rows[0].time, t1 = rows[rows.length - 1].time;
  return (t: number) => {
    const time = t0 + Math.min(1, Math.max(0, t)) * (t1 - t0);
    let k = 0;
    while (k < rows.length - 2 && time > rows[k + 1].time) k++;
    const a = rows[k], b = rows[Math.min(k + 1, rows.length - 1)];
    const f = b.time > a.time ? (time - a.time) / (b.time - a.time) : 0;
    const vmaxKt = a.vmax + (b.vmax - a.vmax) * f;
    return { x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f, vmaxKt, rmwM: a.rmwM + (b.rmwM - a.rmwM) * f, category: categoryOf(vmaxKt) };
  };
}

/**
 * The stretch of the track (as progress 0..1) where the eye is within CLIP_M of the town.
 * playHurricane spends its whole duration on this stretch; the 150 km extensions the game
 * adds to drawn tracks are skipped. Falls back to the whole track if it never comes near.
 */
export function nearTownWindow(at: (t: number) => EyeState): [number, number] {
  let first = -1, last = -1;
  for (let i = 0; i <= 600; i++) {
    const e = at(i / 600);
    if (Math.hypot(e.x, e.z) <= CLIP_M) { if (first < 0) first = i; last = i; }
  }
  return first < 0 || last <= first ? [0, 1] : [first / 600, last / 600];
}

/** Progress (0..1) at which the eye passes closest to the town center. */
export function closestApproach(at: (t: number) => EyeState): number {
  let best = 0, bestD = Infinity;
  for (let i = 0; i <= 400; i++) {
    const e = at(i / 400), d = e.x * e.x + e.z * e.z;
    if (d < bestD) { bestD = d; best = i / 400; }
  }
  return best;
}

/** scene.showHurricaneTrack / playHurricane: track line, eye, eyewall ring, cloud band, rain, label. */
export function HurricaneTrack({ frame }: { frame: Frame }) {
  const hurricane = useSceneStore(s => s.hurricane);
  const built = useMemo(() => {
    if (!hurricane || hurricane.track.length < 2) return null;
    const at = trackSampler(hurricane.track, frame);
    const line = new THREE.Line(trackLine(at, frame), new THREE.LineBasicMaterial({ color: '#c9d3dc', transparent: true, opacity: 0.7 }));
    line.raycast = () => {};
    return { at, closest: closestApproach(at), window: nearTownWindow(at), line };
  }, [hurricane, frame]);
  useEffect(() => () => { built?.line.geometry.dispose(); (built?.line.material as THREE.Material | undefined)?.dispose(); }, [built]);
  if (!hurricane || !built) return null;
  return (
    <group>
      <primitive object={built.line} />
      <Eye at={built.at} closest={built.closest} window={built.window} frame={frame} category={hurricane.category} />
    </group>
  );
}

function trackLine(at: (t: number) => EyeState, frame: Frame): THREE.BufferGeometry {
  const pts: number[] = [];
  for (let i = 0; i <= 600; i++) {
    const e = at(i / 600);
    if (Math.hypot(e.x, e.z) > CLIP_M) continue;
    pts.push(e.x, frame.groundY(e.x, e.z) + TRACK_LIFT_M, e.z);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  return g;
}

function Eye({ at, closest, window, frame, category }: { at: (t: number) => EyeState; closest: number; window: [number, number]; frame: Frame; category: number }) {
  const group = useRef<THREE.Group>(null);
  const cloud = useRef<THREE.Mesh>(null);
  const eyewall = useRef<THREE.Mesh>(null);
  const rain = useRef<THREE.Points>(null);
  const label = useRef<HTMLDivElement>(null);
  const cloudTex = useMemo(makeCloudTexture, []);
  const cloudGeo = useMemo(() => polarRing(0.35, 3, 96, 8), []);
  const rainGeo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    const p = new Float32Array(RAIN_COUNT * 3);
    for (let i = 0; i < RAIN_COUNT; i++) {
      const r = Math.sqrt(Math.random()), a = Math.random() * Math.PI * 2;
      p.set([Math.cos(a) * r, Math.random() * RAIN_TOP_M, Math.sin(a) * r], i * 3);
    }
    g.setAttribute('position', new THREE.BufferAttribute(p, 3));
    return g;
  }, []);
  const camStage = useRef<'idle' | 'wide' | 'settled'>('idle');
  useEffect(() => () => { cloudTex.dispose(); cloudGeo.dispose(); rainGeo.dispose(); }, [cloudTex, cloudGeo, rainGeo]);

  useFrame((_, dt) => {
    const g = group.current;
    if (!g) return;
    const raw = useSceneStore.getState().hurricaneT;
    const playing = raw !== null;
    // Playback covers only the stretch near town.
    const t = playing ? window[0] + raw * (window[1] - window[0]) : closest;
    const e = at(t);
    g.position.set(e.x, frame.groundY(e.x, e.z), e.z);

    // Cloud band out to about 3 x RMW, clear eye inside ~0.35 x RMW, turning counterclockwise.
    if (cloud.current) {
      cloud.current.scale.setScalar(e.rmwM);
      cloud.current.rotation.z += dt * 0.25;
      (cloud.current.material as THREE.MeshBasicMaterial).opacity = playing ? 0.55 : 0.25;
    }
    if (eyewall.current) eyewall.current.scale.setScalar(e.rmwM);
    if (rain.current) {
      rain.current.visible = playing;
      const r = Math.min(RAIN_RADIUS_MAX_M, 2 * e.rmwM);
      rain.current.scale.set(r, 1, r);
      const pos = rainGeo.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i < RAIN_COUNT; i++) {
        let y = pos.getY(i) - dt * 900;
        if (y < 0) y += RAIN_TOP_M;
        pos.setY(i, y);
      }
      pos.needsUpdate = true;
    }
    if (label.current) {
      const cat = playing ? e.category : category;
      label.current.textContent = `${cat > 0 ? `Category ${cat}` : 'Tropical storm'} · ${Math.round(e.vmaxKt * KT_TO_MPH)} mph`;
    }

    // Camera: stays where the player put it; the game frames the hardest-hit blocks after the storm.
    if (!playing) camStage.current = 'idle';
  });

  return (
    <group ref={group}>
      <mesh ref={cloud} geometry={cloudGeo} position={[0, CLOUD_ALT_M, 0]} rotation={[-Math.PI / 2, 0, 0]} raycast={() => null} renderOrder={4}>
        <meshBasicMaterial map={cloudTex} transparent opacity={0.55} depthWrite={false} side={THREE.DoubleSide} />
      </mesh>
      <mesh ref={eyewall} position={[0, EYEWALL_ALT_M, 0]} rotation={[Math.PI / 2, 0, 0]} raycast={() => null}>
        <torusGeometry args={[1, 0.02, 8, 96]} />
        <meshBasicMaterial color="#e6eef5" transparent opacity={0.6} depthWrite={false} />
      </mesh>
      <points ref={rain} geometry={rainGeo} raycast={() => null} visible={false}>
        <pointsMaterial color="#9fb3c4" size={40} sizeAttenuation transparent opacity={0.45} depthWrite={false} />
      </points>
      <Html position={[0, CLOUD_ALT_M + 800, 0]} center zIndexRange={[20, 0]}>
        <div ref={label} style={{
          font: '600 13px "Public Sans", "Segoe UI", system-ui, sans-serif', whiteSpace: 'nowrap', color: '#e3eae7',
          background: 'rgba(12, 18, 20, 0.8)', border: '1px solid #3a4a47', borderRadius: 999, padding: '3px 10px',
        }} />
      </Html>
    </group>
  );
}

/** Flat ring (inner..outer radius) with polar UVs: u = angle around, v = inner to outer edge. */
function polarRing(inner: number, outer: number, around: number, rings: number): THREE.BufferGeometry {
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  for (let j = 0; j <= rings; j++) {
    const v = j / rings, r = inner + (outer - inner) * v;
    for (let i = 0; i <= around; i++) {
      const u = i / around, a = u * Math.PI * 2;
      pos.push(Math.cos(a) * r, Math.sin(a) * r, 0);
      uv.push(u, v);
    }
  }
  for (let j = 0; j < rings; j++) {
    for (let i = 0; i < around; i++) {
      const a = j * (around + 1) + i, b = a + around + 1;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

/** Soft spiral cloud bands on a ring (texture u = around, v = inner to outer edge). */
function makeCloudTexture(): THREE.Texture {
  const W = 512, H = 128;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(W, H);
  for (let y = 0; y < H; y++) {
    const radial = y / (H - 1);                                   // 0 = inner edge (eye), 1 = outer edge
    const fade = Math.min(1, radial * 4) * Math.pow(1 - radial, 0.8);
    for (let x = 0; x < W; x++) {
      const around = (x / W) * Math.PI * 2;
      const arms = 0.5 + 0.5 * Math.sin(around * 3 + radial * 9);   // three spiral arms
      const a = Math.max(0, Math.min(1, fade * (0.35 + 0.65 * arms)));
      const i = (y * W + x) * 4;
      img.data[i] = 214; img.data[i + 1] = 222; img.data[i + 2] = 230; img.data[i + 3] = Math.round(a * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
