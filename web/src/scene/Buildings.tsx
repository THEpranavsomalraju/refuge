import { Bvh } from '@react-three/drei';
import type { ThreeEvent } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { buildBuildingGeometry, buildingAtVertex } from './buildingGeometry';
import type { Frame } from './geo';
import { PALETTE } from './palette';
import { useSceneStore } from './store';
import type { PlaceData } from './types';

/** All buildings as one merged mesh. Handles click-to-select and glow. */
export function Buildings({ place, frame }: { place: PlaceData; frame: Frame }) {
  const built = useMemo(() => buildBuildingGeometry(place.buildings, frame), [place, frame]);
  const indexById = useMemo(() => new Map(place.buildings.map((b, i) => [b.id, i])), [place]);
  const glow = useSceneStore(s => s.glow);
  const glowVersion = useSceneStore(s => s.glowVersion);
  const lit = useRef<Set<number>>(new Set());

  useEffect(() => () => built.geometry.dispose(), [built]);

  // Repaint only buildings whose glow changed: restore the ones that stopped glowing,
  // then blend glowing ones toward the glow color.
  useEffect(() => {
    const attr = built.geometry.getAttribute('color') as THREE.BufferAttribute;
    const arr = attr.array as Float32Array;
    const hot = new THREE.Color(PALETTE.glow);
    const next = new Set<number>();
    for (const [id, v] of glow) { const i = indexById.get(id); if (i !== undefined) next.add(i); }
    for (const i of lit.current) {
      if (next.has(i)) continue;
      const a = built.starts[i] * 3, e = built.starts[i + 1] * 3;
      arr.set(built.baseColors.subarray(a, e), a);
    }
    for (const [id, v] of glow) {
      const i = indexById.get(id);
      if (i === undefined) continue;
      for (let k = built.starts[i] * 3; k < built.starts[i + 1] * 3; k += 3) {
        arr[k] = built.baseColors[k] + (hot.r - built.baseColors[k]) * v;
        arr[k + 1] = built.baseColors[k + 1] + (hot.g - built.baseColors[k + 1]) * v;
        arr[k + 2] = built.baseColors[k + 2] + (hot.b - built.baseColors[k + 2]) * v;
      }
    }
    lit.current = next;
    attr.needsUpdate = true;
  }, [glowVersion, glow, built, indexById]);

  const onClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    if (e.faceIndex == null) return;
    const cb = useSceneStore.getState().onBuildingClick;
    cb?.(place.buildings[buildingAtVertex(built.starts, e.faceIndex * 3)]);
  };

  return (
    <Bvh firstHitOnly>
      <mesh geometry={built.geometry} onClick={onClick} castShadow receiveShadow>
        <meshStandardMaterial vertexColors roughness={0.85} metalness={0} />
      </mesh>
    </Bvh>
  );
}
