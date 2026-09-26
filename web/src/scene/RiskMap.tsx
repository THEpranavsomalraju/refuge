import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { RISK_RISE_MS } from './api';
import type { Frame } from './geo';
import { RISK_COLOR } from './palette';
import { useSceneStore } from './store';
import type { CellResult, PlaceData } from './types';

/** Buildings fade to neutral first, then the bands rise one after another. */
export const RISK_FADE_MS = 600;
const RISE_ORDER = ['green', 'yellow', 'red', 'deep_red'] as const;
type RiseBand = typeof RISE_ORDER[number];
const BAND_MS = (RISK_RISE_MS - RISK_FADE_MS) / RISE_ORDER.length;

/** Prism height from expected deaths in the cell: scaled and capped (meters). */
export const cellHeightM = (expectedDeaths: number) => Math.min(320, 10 + 95 * Math.sqrt(Math.max(0, expectedDeaths)));

interface Group {
  prism: THREE.BufferGeometry;
  hatch: THREE.BufferGeometry | null;
  /** Per vertex: ground y and full lift, so the rise only rewrites y. */
  base: Float32Array[];
  lift: Float32Array[];
}

/** Post-storm risk layer for scene.showRiskMap. */
export function RiskMap({ place, frame }: { place: PlaceData; frame: Frame }) {
  const risk = useSceneStore(s => s.risk);
  const hatchTex = useMemo(makeHatchTexture, []);
  const built = useMemo(() => (risk ? buildLayer(place, frame, risk.cells) : null), [risk, place, frame]);
  const riseRef = useRef<Record<RiseBand, number>>({ green: -1, yellow: -1, red: -1, deep_red: -1 });

  useEffect(() => () => {
    if (!built) return;
    for (const g of Object.values(built.groups)) { g.prism.dispose(); g.hatch?.dispose(); }
    built.sparse.dispose(); built.unavailable.dispose();
  }, [built]);

  useFrame(() => {
    if (!risk || !built) return;
    const elapsed = performance.now() - risk.shownAt - RISK_FADE_MS;
    RISE_ORDER.forEach((band, i) => {
      const t = Math.min(1, Math.max(0, (elapsed - i * BAND_MS) / BAND_MS));
      const eased = 1 - Math.pow(1 - t, 3);
      if (Math.abs(eased - riseRef.current[band]) < 1e-4) return;
      riseRef.current[band] = eased;
      const g = built.groups[band];
      [g.prism, g.hatch].forEach((geo, j) => {
        if (!geo) return;
        const pos = geo.getAttribute('position') as THREE.BufferAttribute;
        const base = g.base[j], lift = g.lift[j];
        for (let v = 0; v < pos.count; v++) pos.setY(v, base[v] + lift[v] * eased);
        pos.needsUpdate = true;
        geo.computeBoundingSphere();
      });
    });
  });

  useEffect(() => { riseRef.current = { green: -1, yellow: -1, red: -1, deep_red: -1 }; }, [built]);

  if (!risk || !built) return null;
  return (
    <group>
      {RISE_ORDER.map(band => (
        <group key={band}>
          <mesh geometry={built.groups[band].prism} raycast={() => null}>
            <meshStandardMaterial color={RISK_COLOR[band]} roughness={0.7} metalness={0} emissive={RISK_COLOR[band]} emissiveIntensity={0.25} />
          </mesh>
          {built.groups[band].hatch && (
            <mesh geometry={built.groups[band].hatch!} raycast={() => null} renderOrder={3}>
              <meshBasicMaterial map={hatchTex} transparent depthWrite={false} polygonOffset polygonOffsetFactor={-2} />
            </mesh>
          )}
        </group>
      ))}
      <lineSegments geometry={built.sparse} raycast={() => null}>
        <lineBasicMaterial color={RISK_COLOR.sparse} transparent opacity={0.7} />
      </lineSegments>
      <mesh geometry={built.unavailable} raycast={() => null}>
        <meshBasicMaterial color={RISK_COLOR.unavailable} map={hatchTex} transparent opacity={0.9} depthWrite={false} />
      </mesh>
    </group>
  );
}

export function buildLayer(place: PlaceData, frame: Frame, cells: Record<string, CellResult>) {
  const acc: Record<RiseBand, { pos: number[]; base: number[]; lift: number[]; hPos: number[]; hBase: number[]; hLift: number[]; hUv: number[] }> =
    Object.fromEntries(RISE_ORDER.map(b => [b, { pos: [], base: [], lift: [], hPos: [], hBase: [], hLift: [], hUv: [] }])) as never;
  const sparse: number[] = [];
  const unavail: number[] = [];
  const unavailUv: number[] = [];

  for (const cell of place.cells) {
    const ring = cell.boundary.map(([lon, lat]) => frame.toXZ(lon, lat));
    let ground = Infinity;
    for (const [x, z] of ring) ground = Math.min(ground, frame.groundY(x, z));
    const r = cells[cell.h3];

    if (!r) {
      // No result for a cell with people: data unavailable. Never drawn as safe.
      if (cell.pop_night + cell.pop_day > 0) flatTile(ring, ground + 1.5, unavail, unavailUv);
      continue;
    }
    if (r.band === 'empty') continue;
    if (r.band === 'sparse') {
      for (let k = 0; k < ring.length; k++) {
        const [ax, az] = ring[k], [bx, bz] = ring[(k + 1) % ring.length];
        sparse.push(ax, ground + 1.5, az, bx, ground + 1.5, bz);
      }
      continue;
    }
    const a = acc[r.band as RiseBand];
    if (!a) continue;
    const h = cellHeightM(r.expected_deaths);
    prism(ring, ground - 1, h + 1, a.pos, a.base, a.lift);
    if (r.band === 'deep_red' || r.uncertain) {
      const start = a.hPos.length / 3;
      flatTile(ring, 0, a.hPos, a.hUv);
      for (let v = start; v < a.hPos.length / 3; v++) { a.hBase.push(ground - 1 + 0.4); a.hLift.push(h + 1); }
    }
  }

  const groups = Object.fromEntries(RISE_ORDER.map(b => {
    const a = acc[b];
    const prismGeo = new THREE.BufferGeometry();
    prismGeo.setAttribute('position', new THREE.Float32BufferAttribute(a.pos, 3));
    prismGeo.computeVertexNormals();
    // start collapsed: y = base
    const base = new Float32Array(a.base), lift = new Float32Array(a.lift);
    const p = prismGeo.getAttribute('position') as THREE.BufferAttribute;
    for (let v = 0; v < p.count; v++) p.setY(v, base[v]);
    let hatch: THREE.BufferGeometry | null = null;
    const hb = new Float32Array(a.hBase), hl = new Float32Array(a.hLift);
    if (a.hPos.length) {
      hatch = new THREE.BufferGeometry();
      hatch.setAttribute('position', new THREE.Float32BufferAttribute(a.hPos, 3));
      hatch.setAttribute('uv', new THREE.Float32BufferAttribute(a.hUv, 2));
      const hp = hatch.getAttribute('position') as THREE.BufferAttribute;
      for (let v = 0; v < hp.count; v++) hp.setY(v, hb[v]);
    }
    return [b, { prism: prismGeo, hatch, base: [base, hb], lift: [lift, hl] } satisfies Group];
  })) as Record<RiseBand, Group>;

  const sparseGeo = new THREE.BufferGeometry();
  sparseGeo.setAttribute('position', new THREE.Float32BufferAttribute(sparse, 3));
  const unavailable = new THREE.BufferGeometry();
  unavailable.setAttribute('position', new THREE.Float32BufferAttribute(unavail, 3));
  unavailable.setAttribute('uv', new THREE.Float32BufferAttribute(unavailUv, 2));
  return { groups, sparse: sparseGeo, unavailable };
}

/** Hexagonal prism (walls + top) as triangles; records base y and lift per vertex. */
export function prism(ring: [number, number][], y0: number, h: number, pos: number[], base: number[], lift: number[]) {
  const ccw = signedArea(ring) > 0 ? ring : ring.slice().reverse();
  const push = (x: number, z: number, top: boolean) => { pos.push(x, y0 + (top ? h : 0), z); base.push(y0); lift.push(top ? h : 0); };
  for (let k = 0; k < ccw.length; k++) {
    const [ax, az] = ccw[k], [bx, bz] = ccw[(k + 1) % ccw.length];
    push(ax, az, false); push(bx, bz, true); push(bx, bz, false);
    push(ax, az, false); push(ax, az, true); push(bx, bz, true);
  }
  // top: fan from vertex 0, wound to face up
  for (let k = 1; k + 1 < ccw.length; k++) {
    push(ccw[0][0], ccw[0][1], true); push(ccw[k + 1][0], ccw[k + 1][1], true); push(ccw[k][0], ccw[k][1], true);
  }
}

/** Flat hexagon (fan) at height y, with world-space UVs for the hatch texture. */
export function flatTile(ring: [number, number][], y: number, pos: number[], uv: number[]) {
  const ccw = signedArea(ring) > 0 ? ring : ring.slice().reverse();
  const add = ([x, z]: [number, number]) => { pos.push(x, y, z); uv.push(x / 24, z / 24); };
  for (let k = 1; k + 1 < ccw.length; k++) { add(ccw[0]); add(ccw[k + 1]); add(ccw[k]); }
}

export function signedArea(ring: [number, number][]) {
  let a = 0;
  for (let k = 0; k < ring.length; k++) { const [x1, z1] = ring[k], [x2, z2] = ring[(k + 1) % ring.length]; a += x1 * z2 - x2 * z1; }
  return a;
}

export function makeHatchTexture(): THREE.Texture {
  const size = 64;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  ctx.clearRect(0, 0, size, size);
  ctx.strokeStyle = 'rgba(12, 16, 18, 0.75)';
  ctx.lineWidth = 7;
  for (let d = -size; d <= size * 2; d += 22) { ctx.beginPath(); ctx.moveTo(d, 0); ctx.lineTo(d - size, size); ctx.stroke(); }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
