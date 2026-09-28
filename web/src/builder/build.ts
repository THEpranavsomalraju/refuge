// Build a town in the browser: the same files places/build_place.py writes (buildings, cells,
// place.json, terrain, no crossings), from public services the browser can reach.
//   1. NSI buildings in the box (nsi.ts)
//   2. over the cap: the square around the chosen point (or the town's center) holding the cap
//   3. OSM outlines for footprints, with OSM heights where mapped; NSI's UBID box otherwise
//   4. elevation (terrain.ts), 5. roads and rivers, 6. H3 cells
import { cellToBoundary, cellToLatLng, polygonToCells } from 'h3-js';
import type { BuildingRecord, CellRecord, LonLat as SceneLonLat, PlaceData, PlaceMeta } from '../scene/types';
import {
  bboxKm, clipLine, convexHull, localProjection, pointInRing, ringArea, round, simplifyLine, simplifyRing,
  type BBox, type LonLat, type XY,
} from './geometry';
import { fetchBuildings, toBuildingRecords, type NsiPoint } from './nsi';
import { decodeOlc } from './olc';
import { fetchOsm, type Outline } from './osm';
import { bake, loadDem } from './terrain';

export const MAX_BUILDINGS = 20_000;
export const MAX_SIDE_KM = 15;
const H3_RES = 10;
const SIMPLIFY_M = 2;
const LINE_SIMPLIFY_M = 5;
const FULL_CELLS_MAX_KM2 = 250;
const SQFT_TO_M2 = 0.09290304;

export interface TownSpec {
  placeId: string;
  /** Display name, e.g. "Asheville, North Carolina". */
  name: string;
  bbox: BBox;
  /** The point the player picked (big cities); the crop stays centered on it. */
  center?: LonLat;
  /** Where a dense town is sized around when it doesn't fit (the town's center); defaults to the box center. */
  focus?: LonLat;
}

export const BUILD_STEPS = ['Buildings', 'Outlines and heights', 'Elevation', 'Roads and rivers', 'Map cells'] as const;
export interface BuildProgress { step: number; progress: number; message: string }

export interface BuiltTown { place: PlaceData; trimmed: boolean }

export async function buildTown(spec: TownSpec, base: string, report: (p: BuildProgress) => void): Promise<BuiltTown> {
  const say = (step: number, frac: number, message: string) =>
    report({ step, progress: (step + Math.min(1, frac)) / BUILD_STEPS.length, message });

  // 1-2. Buildings, nearest the center first. A town that fits downloads completely (the same
  // buildings build_place.py gets); a dense city stops once the square around the center holds the cap.
  say(0, 0, 'Downloading buildings (USACE Structure Inventory)');
  const center: LonLat = spec.center ?? spec.focus ?? [(spec.bbox[0] + spec.bbox[2]) / 2, (spec.bbox[1] + spec.bbox[3]) / 2];
  const got = await fetchBuildings(base, spec.bbox, center, MAX_BUILDINGS,
    count => say(0, Math.min(0.95, count / MAX_BUILDINGS), `Downloading buildings: ${count.toLocaleString('en-US')} so far`));
  let raw = got.points;
  if (raw.length === 0) throw new Error('No buildings found in this area.');
  let rect = spec.bbox, trimmed = false;
  if (Number.isFinite(got.coveredM) || raw.length > MAX_BUILDINGS) {
    // Keep the square around the center holding at most the cap (all of it downloaded).
    rect = squareAroundCount(raw, center, Math.min(MAX_BUILDINGS, raw.length));
    raw = raw.filter(p => p.lon >= rect[0] && p.lon <= rect[2] && p.lat >= rect[1] && p.lat <= rect[3]);
    trimmed = true;
  }
  const records = toBuildingRecords(raw);
  say(0, 1, `${records.length.toLocaleString('en-US')} buildings`);

  const [cx, cy] = [(rect[0] + rect[2]) / 2, (rect[1] + rect[3]) / 2];
  const proj = localProjection(cx, cy);

  // 3 + 5. OSM (one download for outlines, roads and rivers).
  say(1, 0.1, 'Downloading outlines and roads (OpenStreetMap)');
  let osm: Awaited<ReturnType<typeof fetchOsm>> = { outlines: [], roads: [], rivers: [] };
  let osmNote = '';
  try { osm = await fetchOsm(base, rect); } catch (e) { osmNote = e instanceof Error ? e.message : String(e); }
  const matched = attachFootprints(records, raw, osm.outlines, proj);
  say(1, 1, osmNote ? `OpenStreetMap unavailable; using building boxes (${osmNote})` : `${matched.toLocaleString('en-US')} building outlines matched`);

  // 4. Elevation.
  say(2, 0.1, 'Downloading elevation');
  const dem = await loadDem(rect);
  for (const r of records) r.ground_elev_m = round(dem.sample(r.lon, r.lat), 2);
  const terrain = bake(dem, rect);
  say(2, 1, 'Elevation ready');

  say(3, 0.5, 'Roads and rivers');
  const lineOut = (line: LonLat[]) => clipLine(line, rect).map(part =>
    simplifyLine(part.map(proj.toXY), LINE_SIMPLIFY_M).map(xy => proj.toLonLat(xy).map(v => round(v, 5)) as SceneLonLat))
    .filter(l => l.length >= 2);
  const roads = osm.roads.flatMap(r => lineOut(r.line).map(line => ({ class: r.cls, line })));
  const streams = osm.rivers.flatMap(lineOut);
  say(3, 1, `${roads.length.toLocaleString('en-US')} road segments`);

  // 6. Cells: every cell in the box for normal-sized towns (the risk map needs empty cells too).
  say(4, 0.2, 'Building map cells');
  const [wKm, hKm] = bboxKm(rect);
  const extra = wKm * hKm <= FULL_CELLS_MAX_KM2
    ? polygonToCells([[rect[1], rect[0]], [rect[1], rect[2]], [rect[3], rect[2]], [rect[3], rect[0]]], H3_RES) : [];
  const cells = cellsFrom(records, extra, (lon, lat) => dem.sample(lon, lat));
  say(4, 1, `${cells.length.toLocaleString('en-US')} cells`);

  const counties = new Map<string, number>();
  for (const r of records) if (r.cbfips) counties.set(r.cbfips.slice(0, 5), (counties.get(r.cbfips.slice(0, 5)) ?? 0) + 1);
  const county = [...counties.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const meta: PlaceMeta = {
    place_id: spec.placeId, name: spec.name, county_fips: county,
    bbox: rect.map(v => round(v, 6)) as BBox, center: [round(cx, 6), round(cy, 6)],
    camera: null, terrain_source: terrain.source, streams, roads,
  };
  return { place: { meta, buildings: records, cells, crossings: [], terrain: terrain.data }, trimmed };
}

/** Square centered on `center` holding the `max` buildings nearest to it (Chebyshev distance). */
function squareAroundCount(raw: NsiPoint[], [lon0, lat0]: LonLat, max: number): BBox {
  const proj = localProjection(lon0, lat0);
  const d = raw.map(p => { const [x, y] = proj.toXY([p.lon, p.lat]); return Math.max(Math.abs(x), Math.abs(y)); }).sort((a, b) => a - b);
  const half = d[max - 1]!;
  const [w, s] = proj.toLonLat([-half, -half]), [e, n] = proj.toLonLat([half, half]);
  return [w, s, e, n];
}

/** Fill `footprint` (and `height_m` from OSM) on every record. Returns how many matched an OSM outline. */
function attachFootprints(records: BuildingRecord[], raw: NsiPoint[], outlines: Outline[],
  proj: ReturnType<typeof localProjection>): number {
  const CELL = 200;
  const polys = outlines.map(o => {
    const ring = o.ring.map(proj.toXY);
    const xs = ring.map(p => p[0]), ys = ring.map(p => p[1]);
    return { ring, area: Math.abs(ringArea(ring)), bb: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], h: o.heightM };
  });
  const grid = new Map<string, number[]>();
  polys.forEach((p, k) => {
    for (let gx = Math.floor(p.bb[0]! / CELL); gx <= Math.floor(p.bb[2]! / CELL); gx++)
      for (let gy = Math.floor(p.bb[1]! / CELL); gy <= Math.floor(p.bb[3]! / CELL); gy++) {
        const key = `${gx},${gy}`;
        (grid.get(key) ?? grid.set(key, []).get(key)!).push(k);
      }
  });

  let matched = 0;
  records.forEach((r, i) => {
    const pt = proj.toXY([r.lon, r.lat]);
    let best = -1;
    for (const k of grid.get(`${Math.floor(pt[0] / CELL)},${Math.floor(pt[1] / CELL)}`) ?? []) {
      const p = polys[k]!;
      if (pt[0] < p.bb[0]! || pt[0] > p.bb[2]! || pt[1] < p.bb[1]! || pt[1] > p.bb[3]!) continue;
      if (pointInRing(pt, p.ring) && (best < 0 || p.area > polys[best]!.area)) best = k;   // largest outline wins
    }
    const ring = best >= 0 ? usableRing(polys[best]!.ring, proj) : null;
    if (ring) {
      r.footprint = ring;
      r.height_m = polys[best]!.h === null ? null : round(polys[best]!.h!, 1);
      matched++;
      return;
    }
    // No outline: NSI's UBID box scaled to NSI's footprint area, or a square of that area.
    const sqft = raw[i]!.p.ftprntsqft;
    const areaM2 = (sqft && sqft > 0 ? sqft : 1) * SQFT_TO_M2;
    const ub = ubidBox(raw[i]!.p.bid);
    let [cx, cy, w, h] = [pt[0], pt[1], Math.sqrt(areaM2), Math.sqrt(areaM2)];
    if (ub) {
      const [a, b] = [proj.toXY([ub[0], ub[1]]), proj.toXY([ub[2], ub[3]])];
      [cx, cy, w, h] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, b[0] - a[0], b[1] - a[1]];
      const s = Math.sqrt(areaM2 / (w * h));
      w *= s; h *= s;
    }
    const box: XY[] = [[cx - w / 2, cy - h / 2], [cx + w / 2, cy - h / 2], [cx + w / 2, cy + h / 2], [cx - w / 2, cy + h / 2]];
    r.footprint = usableRing(box, proj, 0) ?? box.map(xy => proj.toLonLat(xy).map(v => round(v, 7)) as SceneLonLat);
    r.height_m = null;
  });
  return matched;
}

/** Simplified ring as rounded lon/lat; its convex hull if that went invalid; null if it collapses. */
function usableRing(ring: XY[], proj: ReturnType<typeof localProjection>, tol = SIMPLIFY_M): SceneLonLat[] | null {
  const toOut = (r: XY[]) => r.map(xy => proj.toLonLat(xy).map(v => round(v, 5)) as SceneLonLat);
  const ok = (r: SceneLonLat[]) => new Set(r.map(p => `${p[0]},${p[1]}`)).size >= 3 && Math.abs(ringArea(r.map(proj.toXY))) > 0.5;
  const simple = toOut(tol > 0 ? simplifyRing(ring, tol) : ring);
  if (ok(simple)) return simple;
  const hull = toOut(convexHull(ring));
  return ok(hull) ? hull : null;
}

function ubidBox(bid: string | null | undefined): BBox | null {
  if (typeof bid !== 'string' || bid.split('-').length < 5) return null;
  const parts = bid.split('-');
  const [n, e, s, w] = parts.slice(-4).map(Number);
  const a = decodeOlc(parts.slice(0, -4).join('-'));
  if (!a || [n, e, s, w].some(v => !Number.isFinite(v))) return null;
  const dh = a.latHi - a.latLo, dw = a.lngHi - a.lngLo;
  return [a.lngLo - w! * dw, a.latLo - s! * dh, a.lngHi + e! * dw, a.latHi + n! * dh];
}

/** One entry per cell with a building, plus `extra` cells (cells_from_records in fetch_nsi.py). */
function cellsFrom(records: BuildingRecord[], extra: string[], elev: (lon: number, lat: number) => number): CellRecord[] {
  const night = new Map<string, number>(), day = new Map<string, number>();
  for (const r of records) {
    night.set(r.h3, (night.get(r.h3) ?? 0) + r.pop_night_u65 + r.pop_night_o65);
    day.set(r.h3, (day.get(r.h3) ?? 0) + r.pop_day_u65 + r.pop_day_o65);
  }
  return [...new Set([...night.keys(), ...extra])].sort().map(h3 => {
    const [lat, lon] = cellToLatLng(h3);
    return {
      h3,
      center: [round(lon, 6), round(lat, 6)],
      boundary: cellToBoundary(h3).map(([la, lo]) => [round(lo, 6), round(la, 6)] as SceneLonLat),
      ground_elev_m: round(elev(lon, lat), 2),
      pop_night: night.get(h3) ?? 0,
      pop_day: day.get(h3) ?? 0,
    };
  });
}
