import { useFrame } from '@react-three/fiber';
import { useRef } from 'react';
import * as THREE from 'three';
import type { Frame } from './geo';
import { PALETTE } from './palette';
import { useSceneStore, type Protection } from './store';

/** Markers for placed protections. Safe rooms: a squat shelter with a soft light beam. */
export function Protections({ frame }: { frame: Frame }) {
  const protections = useSceneStore(s => s.protections);
  return (
    <group>
      {protections.map(p => <Marker key={p.id} p={p} frame={frame} />)}
    </group>
  );
}

function Marker({ p, frame }: { p: Protection; frame: Frame }) {
  const [x, z] = frame.toXZ(p.lon, p.lat);
  const y = frame.groundY(x, z);
  const beam = useRef<THREE.Mesh>(null);
  useFrame(({ clock }) => {
    const m = beam.current?.material as THREE.MeshBasicMaterial | undefined;
    if (m) m.opacity = 0.18 + 0.08 * Math.sin(clock.elapsedTime * 2);
  });
  if (p.type !== 'safe_room') {
    // Gates, bridges and elevations get a simple pin until their visuals are designed.
    return (
      <mesh position={[x, y + 30, z]} raycast={() => null}>
        <octahedronGeometry args={[22, 0]} />
        <meshStandardMaterial color={PALETTE.shelter} emissive={PALETTE.shelter} emissiveIntensity={0.6} flatShading />
      </mesh>
    );
  }
  return (
    <group position={[x, y, z]}>
      <mesh position={[0, 9, 0]} raycast={() => null}>
        <boxGeometry args={[34, 18, 22]} />
        <meshStandardMaterial color="#dfe8e4" emissive={PALETTE.shelter} emissiveIntensity={0.35} flatShading />
      </mesh>
      <mesh ref={beam} position={[0, 160, 0]} raycast={() => null}>
        <cylinderGeometry args={[10, 16, 300, 12, 1, true]} />
        <meshBasicMaterial color={PALETTE.shelter} transparent opacity={0.2} depthWrite={false} side={THREE.DoubleSide} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 1.5, 0]} raycast={() => null}>
        <ringGeometry args={[40, 48, 32]} />
        <meshBasicMaterial color={PALETTE.shelter} transparent opacity={0.8} />
      </mesh>
    </group>
  );
}
