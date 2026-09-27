import { useThree } from '@react-three/fiber';
import { latLngToCell } from 'h3-js';
import { useEffect } from 'react';
import * as THREE from 'three';
import type { Frame } from './geo';
import { PALETTE } from './palette';
import { useSceneStore } from './store';

/** A press that moves less than this (px) is a click; more is a drag (pan/rotate). */
const CLICK_SLOP_PX = 5;

/**
 * Pointer input on the ground: reports the hovered H3 cell to scene.onCellHover and,
 * while scene.onGroundClick is set, reports ground clicks (not drags) as lon/lat.
 */
export function GroundInput({ frame }: { frame: Frame }) {
  const { camera, gl } = useThree(s => ({ camera: s.camera, gl: s.gl }));
  const drawing = useSceneStore(s => s.onGroundClick !== null);

  useEffect(() => {
    gl.domElement.style.cursor = drawing ? 'crosshair' : '';
  }, [drawing, gl]);

  useEffect(() => {
    const el = gl.domElement;
    const ray = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const hit = new THREE.Vector3();
    let lastCell: string | null = null;
    let down: { x: number; y: number; id: number } | null = null;

    /** Ground point (lon, lat) under the pointer, or null outside the town. */
    const groundAt = (clientX: number, clientY: number): [number, number] | null => {
      const r = el.getBoundingClientRect();
      ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, camera);
      // Intersect a horizontal plane, then refine twice with the ground height there.
      let y = frame.groundY(0, 0);
      let found = false;
      for (let k = 0; k < 3; k++) {
        if (!ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -y), hit)) break;
        found = true;
        y = frame.groundY(hit.x, hit.z);
      }
      if (!found || Math.abs(hit.x) > frame.width / 2 || Math.abs(hit.z) > frame.depth / 2) return null;
      return frame.toLonLat(hit.x, hit.z);
    };

    const move = (e: PointerEvent) => {
      const cb = useSceneStore.getState().onCellHover;
      if (!cb) return;
      const p = groundAt(e.clientX, e.clientY);
      const cell = p ? latLngToCell(p[1], p[0], 10) : null;
      if (cell !== lastCell) { lastCell = cell; cb(cell); }
    };
    const leave = () => {
      const cb = useSceneStore.getState().onCellHover;
      if (lastCell !== null) { lastCell = null; cb?.(null); }
    };
    const press = (e: PointerEvent) => { if (e.button === 0) down = { x: e.clientX, y: e.clientY, id: e.pointerId }; };
    const release = (e: PointerEvent) => {
      const start = down;
      down = null;
      const cb = useSceneStore.getState().onGroundClick;
      if (!cb || !start || start.id !== e.pointerId) return;
      if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > CLICK_SLOP_PX) return;   // a drag, not a click
      const p = groundAt(e.clientX, e.clientY);
      if (!p) return;
      useSceneStore.setState(s => ({ groundClicks: [...s.groundClicks, p] }));
      cb(p[0], p[1]);
    };

    el.addEventListener('pointermove', move);
    el.addEventListener('pointerleave', leave);
    el.addEventListener('pointerdown', press);
    el.addEventListener('pointerup', release);
    return () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerleave', leave);
      el.removeEventListener('pointerdown', press);
      el.removeEventListener('pointerup', release);
    };
  }, [camera, gl, frame]);

  return <ClickMarkers frame={frame} />;
}

/** Numbered-order dots at each ground click while drawing, so the first point shows too. */
function ClickMarkers({ frame }: { frame: Frame }) {
  const clicks = useSceneStore(s => s.groundClicks);
  const drawing = useSceneStore(s => s.onGroundClick !== null);
  if (!drawing || clicks.length === 0) return null;
  return (
    <group>
      {clicks.map(([lon, lat], i) => {
        const [x, z] = frame.toXZ(lon, lat);
        const y = frame.groundY(x, z);
        return (
          <group key={i} position={[x, y, z]}>
            <mesh position={[0, 18, 0]} raycast={() => null}>
              <sphereGeometry args={[14, 16, 12]} />
              <meshBasicMaterial color={PALETTE.path} />
            </mesh>
            <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 1.5, 0]} raycast={() => null}>
              <ringGeometry args={[20, 28, 24]} />
              <meshBasicMaterial color={PALETTE.path} transparent opacity={0.8} />
            </mesh>
          </group>
        );
      })}
    </group>
  );
}
