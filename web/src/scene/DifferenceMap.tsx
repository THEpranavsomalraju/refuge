import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { RISK_RISE_MS } from './api';
import type { Frame } from './geo';
import { DIFF_COLOR, RISK_COLOR } from './palette';
import { cellHeightM, flatTile, makeHatchTexture, prism, RISK_FADE_MS } from './RiskMap';
import { useSceneStore } from './store';
import type { CellResult, PlaceData } from './types';

/** Changes smaller than this (expected deaths) count as unchanged. */
const EPS = 0.001;

/**
 * Difference view for scene.showDifference: cells whose expected deaths dropped rise in
 * blue (height = lives saved, shade = share of the cell's deaths prevented); unchanged
 * cells with people are flat gray; cells missing from either result are unavailable.
 */
export function DifferenceMap({ place, frame }: { place: PlaceData; frame: Frame }) {
  const diff = useSceneStore(s => s.diff);
  const hatchTex = useMemo(makeHatchTexture, []);
  const built = useMemo(() => (diff ? buildDiff(place, frame, diff.before, diff.after) : null), [diff, place, frame]);
  const riseRef = useRef(-1);

  useEffect(() => { riseRef.current = -1; }, [built]);
  useEffect(() => () => { if (built) { built.bars.dispose(); built.flat.dispose(); built.unavailable.dispose(); } }, [built]);

  useFrame(() => {
    if (!diff || !built) return;
    const t = Math.min(1, Math.max(0, (performance.now() - diff.shownAt - RISK_FADE_MS) / (RISK_RISE_MS - RISK_FADE_MS)));
    const eased = 1 - Math.pow(1 - t, 3);
    if (Math.abs(eased - riseRef.current) < 1e-4) return;
    riseRef.current = eased;
    const pos = built.bars.getAttribute('position') as THREE.BufferAttribute;
    for (let v = 0; v < pos.count; v++) pos.setY(v, built.base[v] + built.lift[v] * eased);
    pos.needsUpdate = true;
    built.bars.computeBoundingSphere();
  });

  if (!diff || !built) return null;
  return (
    <group>
      <mesh geometry={built.bars} raycast={() => null}>
        <meshStandardMaterial vertexColors roughness={0.7} metalness={0} emissive="#0d2a4d" emissiveIntensity={0.35} />
      </mesh>
      <mesh geometry={built.flat} raycast={() => null}>
        <meshBasicMaterial color={DIFF_COLOR.unchanged} transparent opacity={0.75} depthWrite={false} />
      </mesh>
      <mesh geometry={built.unavailable} raycast={() => null}>
        <meshBasicMaterial color={RISK_COLOR.unavailable} map={hatchTex} transparent opacity={0.9} depthWrite={false} />
      </mesh>
    </group>
  );
}

export function buildDiff(place: PlaceData, frame: Frame, before: Record<string, CellResult>, after: Record<string, CellResult>) {
  const pos: number[] = [], base: number[] = [], lift: number[] = [], col: number[] = [];
  const flat: number[] = [], flatUv: number[] = [];
  const unavail: number[] = [], unavailUv: number[] = [];
  const lo = new THREE.Color(DIFF_COLOR.savedLow), hi = new THREE.Color(DIFF_COLOR.savedHigh), worse = new THREE.Color(DIFF_COLOR.worse);
  const c = new THREE.Color();
  let saved = 0, improved = 0, unchanged = 0, worsened = 0, missing = 0;

  for (const cell of place.cells) {
    const b = before[cell.h3], a = after[cell.h3];
    const ring = cell.boundary.map(([lon, lat]) => frame.toXZ(lon, lat));
    let ground = Infinity;
    for (const [x, z] of ring) ground = Math.min(ground, frame.groundY(x, z));
    if (!b || !a) {
      if (cell.pop_night + cell.pop_day > 0) { flatTile(ring, ground + 1.5, unavail, unavailUv); missing++; }
      continue;
    }
    if (Math.max(b.people, a.people) <= 0) continue;
    const d = b.expected_deaths - a.expected_deaths;
    if (Math.abs(d) <= EPS) { flatTile(ring, ground + 1.2, flat, flatUv); unchanged++; continue; }
    const start = pos.length / 3;
    prism(ring, ground - 1, cellHeightM(Math.abs(d)) + 1, pos, base, lift);
    if (d > 0) {
      c.copy(lo).lerp(hi, Math.min(1, d / Math.max(EPS, b.expected_deaths)));
      saved += d; improved++;
    } else {
      c.copy(worse); worsened++;
    }
    for (let v = start; v < pos.length / 3; v++) col.push(c.r, c.g, c.b);
  }

  const bars = new THREE.BufferGeometry();
  bars.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  bars.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  bars.computeVertexNormals();
  const b0 = new Float32Array(base), l0 = new Float32Array(lift);
  const p = bars.getAttribute('position') as THREE.BufferAttribute;
  for (let v = 0; v < p.count; v++) p.setY(v, b0[v]);
  const flatGeo = new THREE.BufferGeometry();
  flatGeo.setAttribute('position', new THREE.Float32BufferAttribute(flat, 3));
  const unavailable = new THREE.BufferGeometry();
  unavailable.setAttribute('position', new THREE.Float32BufferAttribute(unavail, 3));
  unavailable.setAttribute('uv', new THREE.Float32BufferAttribute(unavailUv, 2));
  return { bars, base: b0, lift: l0, flat: flatGeo, unavailable, stats: { saved, improved, unchanged, worsened, missing } };
}
