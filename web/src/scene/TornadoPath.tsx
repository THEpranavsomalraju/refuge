import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { Frame } from './geo';
import { PALETTE } from './palette';
import { useSceneStore } from './store';
import { TornadoFX } from './StormFX';
import type { LonLat } from './types';

const LIFT_M = 2;
const STEP_M = 40;          // ribbon sampled every 40 m so it follows the ground
const FUNNEL_HEIGHT_M = 900;

/** Path ribbon for showTornadoPath and a funnel that moves along it during playStorm. */
export function TornadoPath({ frame }: { frame: Frame }) {
  const tornado = useSceneStore(s => s.tornado);
  const built = useMemo(() => (tornado ? buildRibbon(tornado.coords, tornado.widthM, frame) : null), [tornado, frame]);
  if (!tornado || !built) return null;
  return (
    <group>
      <mesh geometry={built.ribbon} raycast={() => null} renderOrder={2}>
        <meshBasicMaterial color={PALETTE.path} transparent opacity={0.16} depthWrite={false} side={THREE.DoubleSide} />
      </mesh>
      <lineSegments geometry={built.edges} raycast={() => null}>
        <lineBasicMaterial color={PALETTE.path} transparent opacity={0.55} />
      </lineSegments>
      <TornadoFX center={built.center} widthM={tornado.widthM} frame={frame} />
    </group>
  );
}

function Funnel({ center, widthM, frame }: { center: THREE.CurvePath<THREE.Vector3>; widthM: number; frame: Frame }) {
  const group = useRef<THREE.Group>(null);
  const geometry = useMemo(() => {
    // Open cone, wide at the top, narrow at the ground.
    const g = new THREE.CylinderGeometry(widthM * 0.9, widthM * 0.18, FUNNEL_HEIGHT_M, 24, 8, true);
    g.translate(0, FUNNEL_HEIGHT_M / 2, 0);
    return g;
  }, [widthM]);
  useFrame((_, dt) => {
    const g = group.current;
    if (!g) return;
    const t = useSceneStore.getState().stormT;
    g.visible = t !== null;
    if (t === null) return;
    const p = center.getPointAt(Math.min(1, Math.max(0, t)));
    g.position.set(p.x, frame.groundY(p.x, p.z), p.z);
    g.rotation.y += dt * 2.5;
  });
  return (
    <group ref={group} visible={false}>
      <mesh geometry={geometry} raycast={() => null}>
        <meshBasicMaterial color={PALETTE.funnel} transparent opacity={0.22} depthWrite={false} side={THREE.DoubleSide} />
      </mesh>
    </group>
  );
}

export function buildRibbon(coords: LonLat[], widthM: number, frame: Frame) {
  if (coords.length < 2) return null;
  const pts = coords.map(([lon, lat]) => { const [x, z] = frame.toXZ(lon, lat); return new THREE.Vector3(x, 0, z); });
  const center = new THREE.CurvePath<THREE.Vector3>();
  for (let k = 0; k + 1 < pts.length; k++) center.add(new THREE.LineCurve3(pts[k], pts[k + 1]));
  const length = center.getLength();
  const n = Math.max(2, Math.ceil(length / STEP_M));
  const half = widthM / 2;
  const pos: number[] = [];
  const edge: number[] = [];
  let prevL: THREE.Vector3 | null = null, prevR: THREE.Vector3 | null = null;
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    const p = center.getPointAt(u);
    const tan = center.getTangentAt(u);
    const nx = -tan.z, nz = tan.x; // left normal in x/z
    const L = new THREE.Vector3(p.x + nx * half, 0, p.z + nz * half);
    const R = new THREE.Vector3(p.x - nx * half, 0, p.z - nz * half);
    L.y = frame.groundY(L.x, L.z) + LIFT_M;
    R.y = frame.groundY(R.x, R.z) + LIFT_M;
    if (prevL && prevR) {
      pos.push(prevL.x, prevL.y, prevL.z, L.x, L.y, L.z, prevR.x, prevR.y, prevR.z);
      pos.push(prevR.x, prevR.y, prevR.z, L.x, L.y, L.z, R.x, R.y, R.z);
      edge.push(prevL.x, prevL.y, prevL.z, L.x, L.y, L.z, prevR.x, prevR.y, prevR.z, R.x, R.y, R.z);
    }
    prevL = L; prevR = R;
  }
  const ribbon = new THREE.BufferGeometry();
  ribbon.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const edges = new THREE.BufferGeometry();
  edges.setAttribute('position', new THREE.Float32BufferAttribute(edge, 3));
  return { ribbon, edges, center };
}
