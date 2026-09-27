import * as THREE from 'three';
import type { Frame } from './geo';
import { STORY_HEIGHT_M } from './geo';
import { CLASS_COLOR } from './palette';
import type { BuildingRecord, LonLat } from './types';

const MH_HEIGHT_M = 3.0;
const SINK_M = 0.6;          // walls start slightly below ground so slopes show no gaps
const FALLBACK_SIDE_M = 8;   // footprint missing (never in featured places, but be safe)

export interface BuildingGeometry {
  geometry: THREE.BufferGeometry;
  /** First vertex of each building, ascending; building i owns [starts[i], starts[i+1]). */
  starts: Int32Array;
  /** Base (class) color per vertex, to restore after glow. */
  baseColors: Float32Array;
}

/** Extrudes every footprint to its story count and merges all buildings into one mesh. */
export function buildBuildingGeometry(buildings: BuildingRecord[], frame: Frame): BuildingGeometry {
  const pos: number[] = [];
  const col: number[] = [];
  const starts = new Int32Array(buildings.length + 1);
  const color = new THREE.Color();

  buildings.forEach((b, i) => {
    starts[i] = pos.length / 3;
    const { ring, y0, y1 } = buildingShape(b, frame);
    color.set(CLASS_COLOR[b.cls]);

    const push = (x: number, y: number, z: number) => { pos.push(x, y, z); col.push(color.r, color.g, color.b); };

    // Walls: ring is counter-clockwise in (x, z), so (a0, b1, b0) and (a0, a1, b1) face outward.
    for (let k = 0; k < ring.length; k++) {
      const [ax, az] = ring[k], [bx, bz] = ring[(k + 1) % ring.length];
      push(ax, y0, az); push(bx, y1, bz); push(bx, y0, bz);
      push(ax, y0, az); push(ax, y1, az); push(bx, y1, bz);
    }
    // Roof: triangulate, then make each triangle face up.
    const contour = ring.map(([x, z]) => new THREE.Vector2(x, z));
    for (const [p, q, r] of THREE.ShapeUtils.triangulateShape(contour, [])) {
      const P = ring[p], Q = ring[q], R = ring[r];
      const upY = (Q[1] - P[1]) * (R[0] - P[0]) - (Q[0] - P[0]) * (R[1] - P[1]);
      const tri = upY >= 0 ? [P, Q, R] : [P, R, Q];
      for (const [x, z] of tri) push(x, y1, z);
    }
  });
  starts[buildings.length] = pos.length / 3;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const baseColors = new Float32Array(col);
  geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(col), 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return { geometry, starts, baseColors };
}

/**
 * A building's footprint in scene x/z (counter-clockwise), base y (slightly below ground),
 * and roof y. Shared by the merged mesh and the hover outline so they always match.
 */
export function buildingShape(b: BuildingRecord, frame: Frame): { ring: [number, number][]; y0: number; y1: number } {
  let ring = (b.footprint ?? square(b.lon, b.lat)).map(([lon, lat]) => frame.toXZ(lon, lat));
  if (ring.length < 3) ring = square(b.lon, b.lat).map(([lon, lat]) => frame.toXZ(lon, lat));
  if (signedArea(ring) < 0) ring = ring.slice().reverse();
  let gMin = Infinity, gMax = -Infinity;
  for (const [x, z] of ring) { const g = frame.groundY(x, z); gMin = Math.min(gMin, g); gMax = Math.max(gMax, g); }
  const y0 = gMin - SINK_M;
  const y1 = gMax + (b.cls === 'MH' ? MH_HEIGHT_M : Math.max(1, b.stories ?? 1) * STORY_HEIGHT_M);
  return { ring, y0, y1 };
}

/** Building index owning a vertex (binary search over starts). */
export function buildingAtVertex(starts: Int32Array, vertex: number): number {
  let lo = 0, hi = starts.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= vertex) lo = mid; else hi = mid - 1;
  }
  return lo;
}

function signedArea(ring: [number, number][]): number {
  let a = 0;
  for (let k = 0; k < ring.length; k++) {
    const [x1, z1] = ring[k], [x2, z2] = ring[(k + 1) % ring.length];
    a += x1 * z2 - x2 * z1;
  }
  return a / 2;
}

function square(lon: number, lat: number): LonLat[] {
  const dLat = FALLBACK_SIDE_M / 2 / 110_900;
  const dLon = FALLBACK_SIDE_M / 2 / (111_320 * Math.cos((lat * Math.PI) / 180));
  return [[lon - dLon, lat - dLat], [lon + dLon, lat - dLat], [lon + dLon, lat + dLat], [lon - dLon, lat + dLat]];
}
