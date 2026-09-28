// Ground elevation from AWS Terrain Tiles (Terrarium PNGs, public, no key). Stands in for the
// USGS 3DEP DEM that places/terrain.py uses; it only shapes the 3D ground, not any risk number.
// bake() writes the same terrain.bin layout as terrain.py's bake_terrain.
import type { BBox } from './geometry';

const TILE_URL = (z: number, x: number, y: number) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
const MAX_TILES = 36;
const TERRAIN_MAX_SIDE = 512;
const MARGIN_DEG = 0.01;

const lon2x = (lon: number, z: number) => ((lon + 180) / 360) * 2 ** z;
const lat2y = (lat: number, z: number) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
};

export interface Dem { sample(lon: number, lat: number): number; zoom: number }

/** Download and decode the tiles covering `bbox`; returns a bilinear sampler (meters). */
export async function loadDem(bbox: BBox): Promise<Dem> {
  const [w, s, e, n] = [bbox[0] - MARGIN_DEG, bbox[1] - MARGIN_DEG, bbox[2] + MARGIN_DEG, bbox[3] + MARGIN_DEG];
  let z = 14;
  const span = (zz: number) => [Math.floor(lon2x(w, zz)), Math.floor(lon2x(e, zz)), Math.floor(lat2y(n, zz)), Math.floor(lat2y(s, zz))] as const;
  while (z > 8) { const [x0, x1, y0, y1] = span(z); if ((x1 - x0 + 1) * (y1 - y0 + 1) <= MAX_TILES) break; z--; }
  const [x0, x1, y0, y1] = span(z);
  const cols = x1 - x0 + 1, rows = y1 - y0 + 1, W = cols * 256, H = rows * 256;
  const grid = new Float32Array(W * H);

  const jobs: Promise<void>[] = [];
  for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) {
    jobs.push((async () => {
      const res = await fetch(TILE_URL(z, tx, ty));
      if (!res.ok) throw new Error(`elevation tile ${z}/${tx}/${ty}: HTTP ${res.status}`);
      const bmp = await createImageBitmap(await res.blob());
      const canvas = new OffscreenCanvas(256, 256);
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(bmp, 0, 0);
      const px = ctx.getImageData(0, 0, 256, 256).data;
      const ox = (tx - x0) * 256, oy = (ty - y0) * 256;
      for (let j = 0; j < 256; j++) for (let i = 0; i < 256; i++) {
        const k = (j * 256 + i) * 4;
        grid[(oy + j) * W + ox + i] = px[k]! * 256 + px[k + 1]! + px[k + 2]! / 256 - 32768;
      }
    })());
  }
  await Promise.all(jobs);

  const at = (i: number, j: number) => grid[Math.min(H - 1, Math.max(0, j)) * W + Math.min(W - 1, Math.max(0, i))]!;
  return {
    zoom: z,
    sample(lon, lat) {
      const fx = (lon2x(lon, z) - x0) * 256 - 0.5, fy = (lat2y(lat, z) - y0) * 256 - 0.5;
      const i = Math.floor(fx), j = Math.floor(fy), dx = fx - i, dy = fy - j;
      return (at(i, j) * (1 - dx) + at(i + 1, j) * dx) * (1 - dy) + (at(i, j + 1) * (1 - dx) + at(i + 1, j + 1) * dx) * dy;
    },
  };
}

/** Lon/lat elevation grid over `bbox`: float32, row-major, first row north, first column west. */
export function bake(dem: Dem, [w, s, e, n]: BBox) {
  const mid = ((s + n) / 2) * (Math.PI / 180);
  const wM = (e - w) * 111_320 * Math.cos(mid), hM = (n - s) * 110_900;
  const [width, height] = wM >= hM
    ? [TERRAIN_MAX_SIDE, Math.max(2, Math.round((TERRAIN_MAX_SIDE * hM) / wM))]
    : [Math.max(2, Math.round((TERRAIN_MAX_SIDE * wM) / hM)), TERRAIN_MAX_SIDE];
  const data = new Float32Array(width * height);
  let min = Infinity, max = -Infinity;
  for (let r = 0; r < height; r++) {
    const lat = n - ((n - s) * r) / (height - 1);
    for (let c = 0; c < width; c++) {
      const v = dem.sample(w + ((e - w) * c) / (width - 1), lat);
      data[r * width + c] = v;
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  const round2 = (v: number) => Math.round(v * 100) / 100;
  return {
    data,
    source: {
      file: 'terrain.bin', format: 'float32-le, row-major, first row north, first column west', width, height,
      bbox: [w, s, e, n].map(v => Math.round(v * 1e6) / 1e6) as BBox,
      min_m: round2(min), max_m: round2(max), source: `AWS Terrain Tiles (Terrarium), zoom ${dem.zoom}`,
    },
  };
}
