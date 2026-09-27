import { Bvh } from '@react-three/drei';
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { buildBuildingGeometry, buildingAtVertex, buildingShape } from './buildingGeometry';
import type { Frame } from './geo';
import { PALETTE } from './palette';
import { RISK_FADE_MS } from './RiskMap';
import { useSceneStore } from './store';
import type { PlaceData } from './types';

/** Shelter candidates: one teal scale from dim (low value) to bright (high value). */
const CANDIDATE_LOW = new THREE.Color('#1f6f63');
const CANDIDATE_HIGH = new THREE.Color('#b8fff0');

/**
 * All buildings as one merged mesh. Handles click-to-select, glow, the fade to neutral gray
 * under the risk map, and shelter-candidate highlighting with a hover outline.
 */
export function Buildings({ place, frame }: { place: PlaceData; frame: Frame }) {
  const built = useMemo(() => buildBuildingGeometry(place.buildings, frame), [place, frame]);
  const indexById = useMemo(() => new Map(place.buildings.map((b, i) => [b.id, i])), [place]);
  const glowVersion = useSceneStore(s => s.glowVersion);
  const highlight = useSceneStore(s => s.highlight);
  const gl = useThree(s => s.gl);
  const neutral = useRef(0);   // 0 = class colors, 1 = neutral gray
  const lit = useRef<Set<number>>(new Set());

  useEffect(() => () => built.geometry.dispose(), [built]);

  /**
   * Paints buildings: class color -> glow -> neutral (under the risk map). While shelter
   * candidates are highlighted, candidates take the teal scale and everything else is neutral.
   * `all` repaints every building.
   */
  const paint = useCallback((all: boolean) => {
    const attr = built.geometry.getAttribute('color') as THREE.BufferAttribute;
    const arr = attr.array as Float32Array;
    const base = built.baseColors;
    const hot = new THREE.Color(PALETTE.glow), gray = new THREE.Color(PALETTE.neutral), c = new THREE.Color();
    const { glow, highlight: hl } = useSceneStore.getState();
    const n = hl ? 1 : neutral.current;
    const glowIdx = new Map<number, number>();
    for (const [id, v] of glow) { const i = indexById.get(id); if (i !== undefined) glowIdx.set(i, v); }
    const hlIdx = new Map<number, number>();
    if (hl) for (const [id, v] of hl) { const i = indexById.get(id); if (i !== undefined) hlIdx.set(i, v); }

    const paintOne = (i: number, g: number) => {
      const h = hlIdx.get(i);
      if (h !== undefined) c.copy(CANDIDATE_LOW).lerp(CANDIDATE_HIGH, Math.min(1, Math.max(0, h)));
      for (let k = built.starts[i] * 3; k < built.starts[i + 1] * 3; k += 3) {
        if (h !== undefined) { arr[k] = c.r; arr[k + 1] = c.g; arr[k + 2] = c.b; continue; }
        const r = base[k] + (hot.r - base[k]) * g, gg = base[k + 1] + (hot.g - base[k + 1]) * g, b = base[k + 2] + (hot.b - base[k + 2]) * g;
        arr[k] = r + (gray.r - r) * n; arr[k + 1] = gg + (gray.g - gg) * n; arr[k + 2] = b + (gray.b - b) * n;
      }
    };
    if (all || hl) {
      for (let i = 0; i < place.buildings.length; i++) paintOne(i, glowIdx.get(i) ?? 0);
    } else {
      for (const i of lit.current) if (!glowIdx.has(i)) paintOne(i, 0);
      for (const [i, v] of glowIdx) paintOne(i, v);
    }
    lit.current = new Set(glowIdx.keys());
    attr.needsUpdate = true;
  }, [built, indexById, place]);

  useEffect(() => { paint(false); }, [glowVersion, paint]);
  useEffect(() => { paint(true); }, [highlight, paint]);

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

  // <Bvh> gives the geometry an index buffer and reorders its triangles, so map the hit
  // triangle through the index to a real vertex before looking up its building (Mahil's fix).
  const buildingOf = (e: ThreeEvent<PointerEvent | MouseEvent>) => {
    if (e.faceIndex == null) return null;
    const index = built.geometry.index;
    const vertex = index ? index.getX(e.faceIndex * 3) : e.faceIndex * 3;
    return place.buildings[buildingAtVertex(built.starts, vertex)];
  };

  const onClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    const b = buildingOf(e);
    if (b) useSceneStore.getState().onBuildingClick?.(b);
  };

  // Hovering a highlighted candidate: pointer cursor and an outline.
  const setHover = (id: string | null) => {
    if (useSceneStore.getState().hoverId === id) return;
    useSceneStore.setState({ hoverId: id });
    if (!useSceneStore.getState().onGroundClick) gl.domElement.style.cursor = id ? 'pointer' : '';
  };
  const onMove = (e: ThreeEvent<PointerEvent>) => {
    const hl = useSceneStore.getState().highlight;
    if (!hl) return;
    const b = buildingOf(e);
    setHover(b && hl.has(b.id) ? b.id : null);
  };

  return (
    <>
      <Bvh firstHitOnly>
        <mesh geometry={built.geometry} onClick={onClick} onPointerMove={onMove} onPointerOut={() => setHover(null)}>
          <meshStandardMaterial vertexColors roughness={0.85} metalness={0} />
        </mesh>
      </Bvh>
      <HoverOutline place={place} frame={frame} indexById={indexById} />
    </>
  );
}

/** White outline (roof ring, base ring, corners) around the hovered shelter candidate. */
function HoverOutline({ place, frame, indexById }: { place: PlaceData; frame: Frame; indexById: Map<string, number> }) {
  const hoverId = useSceneStore(s => s.hoverId);
  const geometry = useMemo(() => {
    const i = hoverId ? indexById.get(hoverId) : undefined;
    if (i === undefined) return null;
    const { ring, y0, y1 } = buildingShape(place.buildings[i], frame);
    const pos: number[] = [];
    for (let k = 0; k < ring.length; k++) {
      const [ax, az] = ring[k], [bx, bz] = ring[(k + 1) % ring.length];
      pos.push(ax, y1 + 0.6, az, bx, y1 + 0.6, bz);        // roof
      pos.push(ax, y0 + 0.8, az, bx, y0 + 0.8, bz);        // base
      pos.push(ax, y0 + 0.8, az, ax, y1 + 0.6, az);        // corner
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    return g;
  }, [hoverId, indexById, place, frame]);
  useEffect(() => () => geometry?.dispose(), [geometry]);
  if (!geometry) return null;
  return (
    <lineSegments geometry={geometry} raycast={() => null} renderOrder={5}>
      <lineBasicMaterial color="#ffffff" depthTest={false} transparent opacity={0.95} />
    </lineSegments>
  );
}
