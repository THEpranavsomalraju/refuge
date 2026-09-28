// USACE National Structure Inventory: fetch and convert to buildings.json records.
// A TypeScript port of places/fetch_nsi.py (fetch_buildings + to_building_records); keep the
// two in step so browser-built towns match towns built by the Python pipeline.
import { latLngToCell } from 'h3-js';
import { inBBox, round, type BBox, type LonLat } from './geometry';
import type { BuildingRecord } from '../scene/types';

/** Same-origin path; the dev server and vercel.json proxy it to nsi.sec.usace.army.mil/nsiapi. */
const NSI_PATH = 'nsi-api/structures';
// Requests are split into pieces sized from the density at the center (about PIECE_BUILDINGS each),
// so a dense city comes down in small pieces and a small town in a few big ones.
// (fetch_nsi.py uses a fixed 0.05 degree grid for its disk cache; the buildings returned are the same.)
const PROBE_DEG = 0.01;
const PIECE_BUILDINGS = 3000;
const CONCURRENCY = 5;
const MAX_TRIES = 4;
const H3_RES = 10;
const FT_TO_M = 0.3048;
const BIGROOF_MIN_FOOTPRINT_SQFT = 20_000;
const BIGROOF_MAX_STORIES = 2;

export interface NsiProps {
  fd_id: number; bid?: string | null; cbfips?: string | null; occtype?: string | null; bldgtype?: string | null;
  ftprntsqft?: number | null; found_type?: string | null; found_ht?: number | null; num_story?: number | null;
  grnd_elv_m?: number | null; firmzone?: string | null;
  pop2amu65?: number | null; pop2amo65?: number | null; pop2pmu65?: number | null; pop2pmo65?: number | null;
}
export interface NsiPoint { lon: number; lat: number; p: NsiProps }

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function fetchBox(base: string, [w, s, e, n]: BBox): Promise<NsiPoint[]> {
  // The NSI bbox parameter is a closed ring: lon,lat,lon,lat,...
  const ring = [[w, s], [e, s], [e, n], [w, n], [w, s]].map(([x, y]) => `${x!.toFixed(6)},${y!.toFixed(6)}`).join(',');
  const url = `${base}${NSI_PATH}?bbox=${ring}&fmt=fc`;
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url);
      if (res.status >= 500) throw new Error(`NSI returned ${res.status}`);
      if (!res.ok) throw new Error(`NSI request failed (HTTP ${res.status})`);
      const text = await res.text();
      const body = text.trim() ? JSON.parse(text) as { features?: { geometry: { coordinates: [number, number] }; properties: NsiProps }[] } : null;
      return (body?.features ?? []).map(f => ({ lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1], p: f.properties }));
    } catch (e) {
      if (attempt >= MAX_TRIES) throw e;
      await sleep(1000 * 2 ** attempt);
    }
  }
}

export interface FetchResult {
  points: NsiPoint[];
  /** Chebyshev radius (m) around `center` inside which every building was downloaded; Infinity if the whole box was. */
  coveredM: number;
}

/**
 * NSI structures inside `bbox`, one per fd_id, downloaded in pieces nearest `center` first. With
 * `stopAt`, stops once the fully downloaded square around `center` holds that many buildings, so a
 * dense city downloads about what it will keep. `onProgress(buildingsSoFar)` reports progress.
 */
export async function fetchBuildings(base: string, bbox: BBox, center: LonLat, stopAt = Infinity,
  onProgress?: (count: number) => void): Promise<FetchResult> {
  const [w, s, e, n] = bbox;
  const kx = 111_320 * Math.cos((center[1] * Math.PI) / 180), ky = 110_574;
  const cheb = (lon: number, lat: number) => Math.max(Math.abs(lon - center[0]) * kx, Math.abs(lat - center[1]) * ky);
  const out = new Map<number, NsiPoint>();
  const add = (pts: NsiPoint[]) => { for (const pt of pts) if (inBBox([pt.lon, pt.lat], bbox) && !out.has(pt.p.fd_id)) out.set(pt.p.fd_id, pt); };

  // Size the pieces from a small piece at the center.
  const probe: BBox = [Math.max(w, center[0] - PROBE_DEG / 2), Math.max(s, center[1] - PROBE_DEG / 2),
    Math.min(e, center[0] + PROBE_DEG / 2), Math.min(n, center[1] + PROBE_DEG / 2)];
  const probePts = await fetchBox(base, probe);
  add(probePts);
  onProgress?.(out.size);
  const perDeg2 = probePts.length / Math.max(1e-9, (probe[2] - probe[0]) * (probe[3] - probe[1]));
  const piece = Math.min(0.05, Math.max(PROBE_DEG, Math.sqrt(PIECE_BUILDINGS / Math.max(perDeg2, 1))));
  const nx = Math.max(1, Math.ceil((e - w) / piece)), ny = Math.max(1, Math.ceil((n - s) / piece));
  const chunks: { box: BBox; d: number }[] = [];
  for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
    const box: BBox = [w + ((e - w) * i) / nx, s + ((n - s) * j) / ny, w + ((e - w) * (i + 1)) / nx, s + ((n - s) * (j + 1)) / ny];
    // Distance from the center to the nearest point of this piece.
    const dx = Math.max(0, box[0] - center[0], center[0] - box[2]) * kx, dy = Math.max(0, box[1] - center[1], center[1] - box[3]) * ky;
    chunks.push({ box, d: Math.max(dx, dy) });
  }
  chunks.sort((a, b) => a.d - b.d);

  const pendingD = new Set<number>(chunks.map((_, k) => k));   // not downloaded yet (queued or in flight)
  const covered = () => Math.min(Infinity, ...[...pendingD].map(k => chunks[k]!.d));
  let next = 0, stop = false;
  const worker = async () => {
    while (!stop && next < chunks.length) {
      const k = next++;
      add(await fetchBox(base, chunks[k]!.box));
      pendingD.delete(k);
      onProgress?.(out.size);
      if (stopAt < Infinity) {
        const r = covered();
        let inside = 0;
        for (const p of out.values()) if (cheb(p.lon, p.lat) <= r) inside++;
        if (inside >= stopAt) stop = true;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, worker));
  const coveredM = covered();
  const points = [...out.values()].filter(p => cheb(p.lon, p.lat) <= coveredM);
  return { points, coveredM };
}

const missing = (v: unknown) => v === null || v === undefined || (typeof v === 'number' && Number.isNaN(v));
const strOrNull = (v: unknown) => (missing(v) || v === '' ? null : String(v));
const numOrNull = (v: unknown) => (missing(v) ? null : Number(v));
const intOrNull = (v: unknown) => (missing(v) ? null : Math.round(Number(v)));
const intOrZero = (v: unknown) => (missing(v) ? 0 : Math.trunc(Number(v)));

/** NSI occupancy type -> Refuge building class (same rules as classify() in fetch_nsi.py). */
export function classify(occtype: string | null | undefined, bldgtype: string | null, ftprntsqft: number | null,
  stories: number | null, popNight: number): BuildingRecord['cls'] {
  const occ = (occtype ?? '').toUpperCase();
  if (occ.startsWith('RES2')) return 'MH';
  if (occ.startsWith('RES1')) return ['M', 'C'].includes((bldgtype ?? '').toUpperCase()) ? 'RES_MASONRY' : 'RES_WOOD';
  if (['RES3', 'RES4', 'RES5', 'RES6'].some(p => occ.startsWith(p))) return 'MULTI';
  if (occ.startsWith('EDU')) return 'SCHOOL';
  if (occ.startsWith('REL')) return 'WORSHIP';
  if (['COM', 'IND', 'GOV'].some(p => occ.startsWith(p))) {
    return ftprntsqft !== null && stories !== null && ftprntsqft >= BIGROOF_MIN_FOOTPRINT_SQFT && stories <= BIGROOF_MAX_STORIES
      ? 'BIGROOF' : 'COMMERCIAL';
  }
  if (occ.startsWith('AGR1') && popNight > 0) return 'RES_WOOD';
  return 'OTHER';
}

/** Raw NSI points -> buildings.json records (same fields and rounding as to_building_records). */
export function toBuildingRecords(raw: NsiPoint[]): BuildingRecord[] {
  return raw.map(({ lon, lat, p }) => ({
    id: `nsi_${Math.trunc(p.fd_id)}`,
    lon: round(lon, 6),
    lat: round(lat, 6),
    h3: latLngToCell(lat, lon, H3_RES),
    cbfips: strOrNull(p.cbfips),
    footprint: null,
    footprint_sqft: intOrNull(p.ftprntsqft),
    occtype: p.occtype ?? '',
    cls: classify(p.occtype, strOrNull(p.bldgtype), numOrNull(p.ftprntsqft), numOrNull(p.num_story),
      intOrZero(p.pop2amu65) + intOrZero(p.pop2amo65)),
    stories: intOrNull(p.num_story),
    basement: strOrNull(p.found_type) === 'B',
    ground_elev_m: missing(p.grnd_elv_m) ? null : round(Number(p.grnd_elv_m), 2),
    first_floor_ht_m: missing(p.found_ht) ? null : round(Number(p.found_ht) * FT_TO_M, 2),
    hand_m: null,
    firmzone: strOrNull(p.firmzone),
    pop_night_u65: intOrZero(p.pop2amu65),
    pop_night_o65: intOrZero(p.pop2amo65),
    pop_day_u65: intOrZero(p.pop2pmu65),
    pop_day_o65: intOrZero(p.pop2pmo65),
  }));
}
