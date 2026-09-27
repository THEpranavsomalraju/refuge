import { MapControls } from '@react-three/drei';
import { Canvas, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { Buildings } from './Buildings';
import { CameraRig } from './CameraRig';
import { CandidateSites } from './CandidateSites';
import { loadPlace } from './data';
import { GroundInput } from './GroundInput';
import { HurricaneTrack } from './HurricaneTrack';
import { DifferenceMap } from './DifferenceMap';
import { makeFrame, type Frame } from './geo';
import { Lines } from './Lines';
import { PALETTE } from './palette';
import { Protections } from './Protections';
import { RiskMap } from './RiskMap';
import { HeatDiff, HeatVoxels } from './HeatVoxels';
import { useSceneStore } from './store';
import { Terrain } from './Terrain';
import { TornadoPath } from './TornadoPath';
import type { PlaceData } from './types';

export type LoadState = { state: 'loading' } | { state: 'ready'; place: PlaceData } | { state: 'error'; message: string };

/** Loads a featured place and renders it. `onLoad` reports progress to the game UI. */
export function Town({ placeId, onLoad }: { placeId: string; onLoad?: (s: LoadState) => void }) {
  const [load, setLoad] = useState<LoadState>({ state: 'loading' });
  useEffect(() => {
    let alive = true;
    setLoad({ state: 'loading' });
    loadPlace(placeId)
      .then(place => alive && setLoad({ state: 'ready', place }))
      .catch(err => alive && setLoad({ state: 'error', message: String(err?.message ?? err) }));
    return () => { alive = false; };
  }, [placeId]);
  useEffect(() => { onLoad?.(load); }, [load, onLoad]);

  return (
    <Canvas shadows={false} dpr={[1, 2]} camera={{ fov: 38, near: 5, far: 60_000, position: [0, 4000, 6000] }}>
      <color attach="background" args={[PALETTE.sky]} />
      <fog attach="fog" args={[PALETTE.fog, 9000, 30000]} />
      <hemisphereLight args={[PALETTE.moon, '#1a2320', 0.55]} />
      <directionalLight position={[-3000, 5000, 2000]} intensity={1.1} color={PALETTE.moon} />
      {load.state === 'ready' && <Place place={load.place} />}
    </Canvas>
  );
}

function Place({ place }: { place: PlaceData }) {
  const frame = useMemo(() => makeFrame(place), [place]);
  return (
    <>
      <StartCamera frame={frame} />
      <FillerGround frame={frame} />
      <Terrain place={place} frame={frame} />
      <Lines place={place} frame={frame} />
      <Buildings place={place} frame={frame} />
      <TornadoPath frame={frame} />
      <HurricaneTrack frame={frame} />
      <Protections frame={frame} />
      <RiskMap place={place} frame={frame} />
      <HeatVoxels frame={frame} />
      <HeatDiff frame={frame} />
      <DifferenceMap place={place} frame={frame} />
      <CandidateSites frame={frame} />
      <CameraRig frame={frame} />
      <GroundInput frame={frame} />
    </>
  );
}

/** A wide plane in the ground color around the town, fading into the fog, so the plot never floats in a void. */
function FillerGround({ frame }: { frame: Frame }) {
  const y = useMemo(() => {
    let lo = Infinity;
    for (let i = 0; i <= 20; i++) for (let k = 0; k <= 20; k++) {
      lo = Math.min(lo, frame.groundY((i / 20 - 0.5) * frame.width, (k / 20 - 0.5) * frame.depth));
    }
    return lo - 3;
  }, [frame]);
  const size = Math.max(frame.width, frame.depth) * 8;
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, y, 0]} raycast={() => null}>
      <planeGeometry args={[size, size]} />
      <meshStandardMaterial color={PALETTE.ground} roughness={1} metalness={0} />
    </mesh>
  );
}

/** Oblique view from the south-southwest, whole town in frame. */
function StartCamera({ frame }: { frame: Frame }) {
  const { camera, controls } = useThree(s => ({ camera: s.camera, controls: s.controls as unknown as { target: THREE.Vector3; update(): void } | null }));
  // Place the camera once per town (when the controls exist), never again on clicks or re-renders.
  const placedFor = useRef<Frame | null>(null);
  useEffect(() => {
    if (!controls || placedFor.current === frame) return;
    placedFor.current = frame;
    const d = Math.max(frame.width, frame.depth);
    const target = new THREE.Vector3(0, frame.groundY(0, 0), 0);
    camera.position.set(-0.18 * d, target.y + 0.55 * d, 0.62 * d);
    camera.lookAt(target);
    controls.target.copy(target); controls.update();
  }, [frame, camera, controls]);
  // Keep the view on the city: the point the camera looks at can't leave the town rectangle.
  const clamp = () => {
    const c = controls as unknown as { target: THREE.Vector3; object: THREE.Camera } | null;
    if (!c) return;
    const hx = frame.width / 2, hz = frame.depth / 2;
    const nx = Math.min(hx, Math.max(-hx, c.target.x)), nz = Math.min(hz, Math.max(-hz, c.target.z));
    const dx = nx - c.target.x, dz = nz - c.target.z;
    if (dx !== 0 || dz !== 0) { c.target.x = nx; c.target.z = nz; c.object.position.x += dx; c.object.position.z += dz; }
  };
  return <MapControls makeDefault onChange={clamp} maxPolarAngle={Math.PI * 0.46} minDistance={150} maxDistance={Math.max(frame.width, frame.depth) * 1.1} />;
}
