import type { PlaceData } from './types';

/** Terrain relief is exaggerated so flat towns still read as landscape. Buildings are not. */
export const VERTICAL_EXAGGERATION = 2.5;
export const STORY_HEIGHT_M = 3.4;

/**
 * Local scene frame for one place: 1 unit = 1 m, x = east, z = south (three.js),
 * y = up, origin at the place center, y = 0 at the lowest terrain point.
 */
export interface Frame {
  toXZ(lon: number, lat: number): [number, number];
  toLonLat(x: number, z: number): [number, number];
  /** Ground height (scene units) at a scene x/z, bilinear from terrain.bin. */
  groundY(x: number, z: number): number;
  width: number;
  depth: number;
}

export function makeFrame(place: PlaceData): Frame {
  const [minLon, minLat, maxLon, maxLat] = place.meta.bbox;
  const lon0 = (minLon + maxLon) / 2;
  const lat0 = (minLat + maxLat) / 2;
  const mx = 111_320 * Math.cos((lat0 * Math.PI) / 180);
  const my = 110_900;
  const width = (maxLon - minLon) * mx;
  const depth = (maxLat - minLat) * my;

  const ts = place.meta.terrain_source;
  const grid = place.terrain;
  const base = ts ? ts.min_m : 0;

  const groundY = (x: number, z: number): number => {
    if (!ts || !grid) return 0;
    // column 0 = west edge, row 0 = north edge; both edges included.
    const fx = ((x + width / 2) / width) * (ts.width - 1);
    const fy = ((z + depth / 2) / depth) * (ts.height - 1);
    const cx = Math.min(ts.width - 1, Math.max(0, fx));
    const cy = Math.min(ts.height - 1, Math.max(0, fy));
    const x0 = Math.floor(cx), y0 = Math.floor(cy);
    const x1 = Math.min(ts.width - 1, x0 + 1), y1 = Math.min(ts.height - 1, y0 + 1);
    const tx = cx - x0, ty = cy - y0;
    const at = (c: number, r: number) => grid[r * ts.width + c];
    const h = (at(x0, y0) * (1 - tx) + at(x1, y0) * tx) * (1 - ty) + (at(x0, y1) * (1 - tx) + at(x1, y1) * tx) * ty;
    return (h - base) * VERTICAL_EXAGGERATION;
  };

  return {
    toXZ: (lon, lat) => [(lon - lon0) * mx, -(lat - lat0) * my],
    toLonLat: (x, z) => [lon0 + x / mx, lat0 - z / my],
    groundY,
    width,
    depth,
  };
}
