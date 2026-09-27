import { Html } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { Frame } from './geo';
import { PALETTE } from './palette';
import { useSceneStore, type Protection } from './store';

const BEAM_M = 600;
const REACH_SEGMENTS = 128;

/** Markers for placed protections, plus reach circles around selected shelters. */
export function Protections({ frame }: { frame: Frame }) {
  const protections = useSceneStore(s => s.protections);
  const reach = useSceneStore(s => s.reach);
  return (
    <group>
      {protections.map((p, i) => <Marker key={p.id} p={p} frame={frame} lift={liftFor(protections, i, frame)} />)}
      {Object.entries(reach).map(([id, r]) => <Reach key={id} lon={r.lon} lat={r.lat} radiusM={r.radiusM} frame={frame} />)}
    </group>
  );
}

/**
 * A safe room readable at town zoom: a glowing beam, a small shelter block, and a pin
 * that keeps the same size on screen however far the camera is.
 */
/**
 * Pins stand on their own building. When shelters are close together, their pins are raised to
 * different heights (not shifted sideways), so every beam still drops straight onto its own building.
 */
function liftFor(all: Protection[], i: number, frame: Frame): number {
  const [x, z] = frame.toXZ(all[i]!.lon, all[i]!.lat);
  const close = all.map((p, j) => { const [px, pz] = frame.toXZ(p.lon, p.lat); return { j, d: Math.hypot(px - x, pz - z) }; })
    .filter(g => g.d < 600).map(g => g.j).sort((a, b) => a - b);
  return close.indexOf(i) * 170;
}

function Marker({ p, frame, lift }: { p: Protection; frame: Frame; lift: number }) {
  const [x, z] = frame.toXZ(p.lon, p.lat);
  const y = frame.groundY(x, z);
  const beam = useRef<THREE.Mesh>(null);
  useFrame(({ clock }) => {
    const m = beam.current?.material as THREE.MeshBasicMaterial | undefined;
    if (m) m.opacity = 0.3 + 0.12 * Math.sin(clock.elapsedTime * 2);
  });
  return (
    <group position={[x, y, z]}>
      {p.type === 'safe_room' && (
        <mesh position={[0, 9, 0]} raycast={() => null}>
          <boxGeometry args={[34, 18, 22]} />
          <meshStandardMaterial color="#dfe8e4" emissive={PALETTE.shelter} emissiveIntensity={0.5} flatShading />
        </mesh>
      )}
      <mesh ref={beam} position={[0, (BEAM_M + lift) / 2, 0]} raycast={() => null}>
        <cylinderGeometry args={[16, 26, BEAM_M + lift, 16, 1, true]} />
        <meshBasicMaterial color={PALETTE.shelter} transparent opacity={0.35} depthWrite={false} side={THREE.DoubleSide} />
      </mesh>
      <Html position={[0, BEAM_M + lift + 20, 0]} center zIndexRange={[15, 0]} style={{ pointerEvents: 'none' }}>
        <div aria-label={p.type === 'safe_room' ? 'Shelter' : p.type} style={{ display: 'grid', justifyItems: 'center' }}>
          <div style={{
            width: 22, height: 22, borderRadius: '50% 50% 50% 0', transform: 'rotate(-45deg)',
            background: PALETTE.shelter, border: '2px solid #ffffff', boxShadow: '0 0 10px rgba(95, 224, 200, 0.8)',
            display: 'grid', placeItems: 'center',
          }}>
            <span style={{ transform: 'rotate(45deg)', color: '#0c1214', font: '700 12px system-ui, sans-serif' }}>S</span>
          </div>
          {p.label && (
            <div style={{
              marginTop: 6, padding: '2px 7px', borderRadius: 999, whiteSpace: 'nowrap', background: 'rgba(12,18,20,0.85)',
              border: `1px solid ${PALETTE.shelter}`, color: '#e3eae7', font: '600 11px "Public Sans", system-ui, sans-serif',
            }}>{p.label}</div>
          )}
        </div>
      </Html>
    </group>
  );
}

/** Translucent ground circle with an outline, following the terrain. */
export function Reach({ lon, lat, radiusM, frame }: { lon: number; lat: number; radiusM: number; frame: Frame }) {
  const { fill, ring } = useMemo(() => {
    const [cx, cz] = frame.toXZ(lon, lat);
    const ringPos: number[] = [];
    const fillPos: number[] = [];
    const cy = frame.groundY(cx, cz) + 2;
    for (let i = 0; i < REACH_SEGMENTS; i++) {
      const a0 = (i / REACH_SEGMENTS) * Math.PI * 2, a1 = ((i + 1) / REACH_SEGMENTS) * Math.PI * 2;
      const x0 = cx + Math.cos(a0) * radiusM, z0 = cz + Math.sin(a0) * radiusM;
      const x1 = cx + Math.cos(a1) * radiusM, z1 = cz + Math.sin(a1) * radiusM;
      const y0 = frame.groundY(x0, z0) + 2, y1 = frame.groundY(x1, z1) + 2;
      ringPos.push(x0, y0, z0, x1, y1, z1);
      fillPos.push(cx, cy, cz, x1, y1, z1, x0, y0, z0);   // wound to face up
    }
    const ringGeo = new THREE.BufferGeometry();
    ringGeo.setAttribute('position', new THREE.Float32BufferAttribute(ringPos, 3));
    const fillGeo = new THREE.BufferGeometry();
    fillGeo.setAttribute('position', new THREE.Float32BufferAttribute(fillPos, 3));
    return { fill: fillGeo, ring: ringGeo };
  }, [lon, lat, radiusM, frame]);
  useEffect(() => () => { fill.dispose(); ring.dispose(); }, [fill, ring]);
  return (
    <group>
      <mesh geometry={fill} raycast={() => null} renderOrder={1}>
        <meshBasicMaterial color={PALETTE.shelter} transparent opacity={0.12} depthWrite={false} side={THREE.DoubleSide} />
      </mesh>
      <lineSegments geometry={ring} raycast={() => null} renderOrder={2}>
        <lineBasicMaterial color={PALETTE.shelter} transparent opacity={0.9} />
      </lineSegments>
    </group>
  );
}
