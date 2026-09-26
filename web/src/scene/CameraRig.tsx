import { useFrame, useThree } from '@react-three/fiber';
import { useRef } from 'react';
import * as THREE from 'three';
import type { Frame } from './geo';
import { useSceneStore } from './store';

interface Move { seq: number; start: number; ms: number; p0: THREE.Vector3; t0: THREE.Vector3; p1: THREE.Vector3; t1: THREE.Vector3 }

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/**
 * Animates the camera to the goals set by scene.frameCoords / frameStormPath / focusCells.
 * Keeps the current viewing direction and only changes where it looks and how far away.
 */
export function CameraRig({ frame }: { frame: Frame }) {
  const { camera, controls, size } = useThree(s => ({ camera: s.camera as THREE.PerspectiveCamera, controls: s.controls as unknown as { target: THREE.Vector3; update(): void } | null, size: s.size }));
  const move = useRef<Move | null>(null);
  const lastSeq = useRef(0);

  useFrame(() => {
    const goal = useSceneStore.getState().camera;
    if (goal && goal.seq !== lastSeq.current && controls) {
      lastSeq.current = goal.seq;
      const [x, z] = frame.toXZ(goal.center[0], goal.center[1]);
      const t1 = new THREE.Vector3(x, frame.groundY(x, z), z);
      const dir = camera.position.clone().sub(controls.target).normalize();
      // Distance that fits a circle of radiusM in the narrower field of view.
      const vFov = THREE.MathUtils.degToRad(camera.fov);
      const hFov = 2 * Math.atan(Math.tan(vFov / 2) * (size.width / Math.max(1, size.height)));
      const dist = (goal.radiusM / Math.tan(Math.min(vFov, hFov) / 2)) * 1.1;
      move.current = {
        seq: goal.seq, start: performance.now(), ms: Math.max(1, goal.ms),
        p0: camera.position.clone(), t0: controls.target.clone(),
        p1: t1.clone().addScaledVector(dir, dist), t1,
      };
    }
    const m = move.current;
    if (!m || !controls) return;
    const k = ease(Math.min(1, (performance.now() - m.start) / m.ms));
    camera.position.lerpVectors(m.p0, m.p1, k);
    controls.target.lerpVectors(m.t0, m.t1, k);
    controls.update();
    if (k >= 1) move.current = null;
  });
  return null;
}
