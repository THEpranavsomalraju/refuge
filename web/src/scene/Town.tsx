import { MapControls } from '@react-three/drei';
import { Canvas, useThree } from '@react-three/fiber';
import { latLngToCell } from 'h3-js';
import { useEffect, useMemo, useState } from 'react';
import * as THREE from 'three';
import { Buildings } from './Buildings';
import { loadPlace } from './data';
import { makeFrame, type Frame } from './geo';
import { Lines } from './Lines';
import { PALETTE } from './palette';
import { useSceneStore } from './store';
import { Terrain } from './Terrain';
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
      <CellHover frame={frame} />
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

/** Reports the H3 cell under the pointer to scene.onCellHover (ray hits the ground). */
function CellHover({ frame }: { frame: Frame }) {
  const { camera, gl } = useThree(s => ({ camera: s.camera, gl: s.gl }));
  useEffect(() => {
    const el = gl.domElement;
    const ray = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const hit = new THREE.Vector3();
    let last: string | null = null;
    const move = (e: PointerEvent) => {
      const cb = useSceneStore.getState().onCellHover;
      if (!cb) return;
      const r = el.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, camera);
      // Intersect a horizontal plane, then refine twice with the ground height there.
      let y = frame.groundY(0, 0);
      let cell: string | null = null;
      for (let k = 0; k < 3; k++) {
        if (!ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -y), hit)) break;
        y = frame.groundY(hit.x, hit.z);
      }
      if (Math.abs(hit.x) <= frame.width / 2 && Math.abs(hit.z) <= frame.depth / 2) {
        const [lon, lat] = frame.toLonLat(hit.x, hit.z);
        cell = latLngToCell(lat, lon, 10);
      }
      if (cell !== last) { last = cell; cb(cell); }
    };
    const leave = () => { const cb = useSceneStore.getState().onCellHover; if (last !== null) { last = null; cb?.(null); } };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerleave', leave);
    return () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerleave', leave); };
  }, [camera, gl, frame]);
  return null;
}
