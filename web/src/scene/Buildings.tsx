import { Bvh } from '@react-three/drei';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { buildBuildingGeometry, buildingAtVertex } from './buildingGeometry';
import type { Frame } from './geo';
import { PALETTE } from './palette';
import { RISK_FADE_MS } from './RiskMap';
import { useSceneStore } from './store';
import type { PlaceData } from './types';

/**
 * All buildings as one merged mesh. Handles click-to-select, glow, and the fade to
 * neutral gray while the risk map is shown.
 */
export function Buildings({ place, frame }: { place: PlaceData; frame: Frame }) {
  const built = useMemo(() => buildBuildingGeometry(place.buildings, frame), [place, frame]);
  const indexById = useMemo(() => new Map(place.buildings.map((b, i) => [b.id, i])), [place]);
  const glowVersion = useSceneStore(s => s.glowVersion);
  const neutral = useRef(0);   // 0 = class colors, 1 = neutral gray
  const lit = useRef<Set<number>>(new Set());

  useEffect(() => () => built.geometry.dispose(), [built]);

  /** Paints buildings: class color -> glow -> neutral. `all` repaints every building. */
  const paint = useCallback((all: boolean) => {
    const attr = built.geometry.getAttribute('color') as THREE.BufferAttribute;
    const arr = attr.array as Float32Array;
    const base = built.baseColors;
    const hot = new THREE.Color(PALETTE.glow), gray = new THREE.Color(PALETTE.neutral);
    const n = neutral.current;
    const glow = useSceneStore.getState().glow;
    const glowIdx = new Map<number, number>();
    for (const [id, v] of glow) { const i = indexById.get(id); if (i !== undefined) glowIdx.set(i, v); }

    const paintOne = (i: number, g: number) => {
      for (let k = built.starts[i] * 3; k < built.starts[i + 1] * 3; k += 3) {
        const r = base[k] + (hot.r - base[k]) * g, gg = base[k + 1] + (hot.g - base[k + 1]) * g, b = base[k + 2] + (hot.b - base[k + 2]) * g;
        arr[k] = r + (gray.r - r) * n; arr[k + 1] = gg + (gray.g - gg) * n; arr[k + 2] = b + (gray.b - b) * n;
      }
    };
    if (all) {
      for (let i = 0; i < place.buildings.length; i++) paintOne(i, glowIdx.get(i) ?? 0);
    } else {
      for (const i of lit.current) if (!glowIdx.has(i)) paintOne(i, 0);
      for (const [i, v] of glowIdx) paintOne(i, v);
    }
    lit.current = new Set(glowIdx.keys());
    attr.needsUpdate = true;
  }, [built, indexById, place]);

  useEffect(() => { paint(false); }, [glowVersion, paint]);

  // Fade to neutral under the risk map or difference view, back to class colors after.
  useFrame(() => {
    const { risk, diff } = useSceneStore.getState();
    const shown = risk ?? diff;   // risk map or difference view
    const target = shown ? Math.min(1, (performance.now() - shown.shownAt) / RISK_FADE_MS) : 0;
    const next = shown ? target : Math.max(0, neutral.current - 0.08);
    if (Math.abs(next - neutral.current) < 0.005 && !(next === 0 && neutral.current !== 0)) return;
    neutral.current = next;
    paint(true);
  });

  const onClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    if (e.faceIndex == null) return;
    const cb = useSceneStore.getState().onBuildingClick;
    // <Bvh> gives the geometry an index buffer and reorders its triangles, so map the hit
    // triangle through the index to a real vertex before looking up its building.
    const index = built.geometry.index;
    const vertex = index ? index.getX(e.faceIndex * 3) : e.faceIndex * 3;
    cb?.(place.buildings[buildingAtVertex(built.starts, vertex)]);
  };

  return (
    <Bvh firstHitOnly>
      <mesh geometry={built.geometry} onClick={onClick}>
        <meshStandardMaterial vertexColors roughness={0.85} metalness={0} />
      </mesh>
    </Bvh>
  );
}
