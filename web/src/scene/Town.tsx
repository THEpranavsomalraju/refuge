import { MapControls } from '@react-three/drei';
import { Canvas, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useState } from 'react';
import * as THREE from 'three';
import { Buildings } from './Buildings';
import { CameraRig } from './CameraRig';
import { CandidateSites } from './CandidateSites';
import { loadPlace } from './data';
import { GroundInput } from './GroundInput';
import { DifferenceMap } from './DifferenceMap';
import { makeFrame, type Frame } from './geo';
import { Lines } from './Lines';
import { PALETTE } from './palette';
import { Protections } from './Protections';
import { RiskMap } from './RiskMap';
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
      <Terrain place={place} frame={frame} />
      <Lines place={place} frame={frame} />
      <Buildings place={place} frame={frame} />
      <TornadoPath frame={frame} />
      <Protections frame={frame} />
      <RiskMap place={place} frame={frame} />
      <DifferenceMap place={place} frame={frame} />
      <CandidateSites frame={frame} />
      <CameraRig frame={frame} />
      <GroundInput frame={frame} />
    </>
  );
}

/** Oblique view from the south-southwest, whole town in frame. */
function StartCamera({ frame }: { frame: Frame }) {
  const { camera, controls } = useThree(s => ({ camera: s.camera, controls: s.controls as unknown as { target: THREE.Vector3; update(): void } | null }));
  useEffect(() => {
    const d = Math.max(frame.width, frame.depth);
    const target = new THREE.Vector3(0, frame.groundY(0, 0), 0);
    camera.position.set(-0.18 * d, target.y + 0.55 * d, 0.62 * d);
    camera.lookAt(target);
    if (controls) { controls.target.copy(target); controls.update(); }
  }, [frame, camera, controls]);
  return <MapControls makeDefault maxPolarAngle={Math.PI * 0.46} minDistance={150} maxDistance={Math.max(frame.width, frame.depth) * 2} />;
}
