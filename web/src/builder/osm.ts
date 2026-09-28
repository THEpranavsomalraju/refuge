// OpenStreetMap via Overpass: building outlines (with heights where mapped), roads and rivers.
// Mirrors fetch_roads / osm_building_outlines in places/ (roads.py, build_place.py).
import type { BBox, LonLat } from './geometry';

/** Public Overpass servers that answer browsers, then our own proxy (vercel.json) as a last resort. */
const endpoints = (base: string) => [
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  `${base}overpass-api/interpreter`,
];
/** Ask the next server too if the current one hasn't answered by then. */
const HEDGE_MS = 20_000;
const TIMEOUT_MS = 120_000;

export const ROAD_CLASS: Record<string, string> = {
  motorway: 'motorway', motorway_link: 'motorway', trunk: 'trunk', trunk_link: 'trunk',
  primary: 'primary', primary_link: 'primary', secondary: 'secondary', secondary_link: 'secondary',
  tertiary: 'tertiary', tertiary_link: 'tertiary', unclassified: 'unclassified',
  residential: 'residential', living_street: 'residential', service: 'service',
};

export interface Outline { ring: LonLat[]; heightM: number | null }
export interface OsmData { outlines: Outline[]; roads: { cls: string; line: LonLat[] }[]; rivers: LonLat[][] }

type Geom = { lat: number; lon: number }[];
interface Element {
  type: 'way' | 'relation'; tags?: Record<string, string>; geometry?: Geom;
  members?: { role: string; geometry?: Geom }[];
}

/**
 * Run a query against the servers, hedged: start with the first; whenever one fails, or HEDGE_MS
 * passes without an answer, start the next as well. The first good answer wins and the rest are cancelled.
 */
function overpass(base: string, query: string): Promise<Element[]> {
  const urls = endpoints(base);
  const controllers: AbortController[] = [];
  const errors: string[] = [];
  return new Promise((resolve, reject) => {
    let next = 0, running = 0, done = false;
    const finish = (els: Element[]) => { done = true; controllers.forEach(c => c.abort()); resolve(els); };
    const launch = () => {
      if (done || next >= urls.length) {
        if (!done && running === 0) reject(new Error(`OpenStreetMap is unavailable right now (${errors.join('; ')})`));
        return;
      }
      const url = urls[next++]!;
      const ctl = new AbortController();
      controllers.push(ctl);
      running++;
      const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
      const hedge = setTimeout(launch, HEDGE_MS);
      fetch(url, { method: 'POST', signal: ctl.signal, headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `data=${encodeURIComponent(query)}` })
        .then(async res => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const body = await res.json() as { elements?: Element[]; remark?: string };
          if (body.remark && /runtime error|timed out|out of memory/i.test(body.remark)) throw new Error(body.remark);
          if (!done) finish(body.elements ?? []);
        })
        .catch(e => {
          if (done) return;
          errors.push(`${new URL(url, location.href).host}: ${e instanceof Error ? e.message : String(e)}`);
          clearTimeout(hedge);
          running--;
          launch();
        })
        .finally(() => clearTimeout(timer));
    };
    launch();
  });
}

/** "12", "12 m", "12.5m" -> 12; "40'" or "40 ft" -> feet converted. Null when unreadable. */
function parseHeight(v: string | undefined): number | null {
  if (!v) return null;
  const m = /^\s*([\d.]+)\s*(m|meters?|ft|feet|')?\s*$/i.exec(v);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0 || n > 900) return null;
  return /ft|feet|'/i.test(m[2] ?? '') ? n * 0.3048 : n;
}

const STORY_M = 3.4;   // same as the scene's STORY_HEIGHT_M
const toRing = (g: Geom): LonLat[] => {
  const ring = g.map(p => [p.lon, p.lat] as LonLat);
  const [a, b] = [ring[0], ring[ring.length - 1]];
  if (a && b && a[0] === b[0] && a[1] === b[1]) ring.pop();
  return ring;
};

export async function fetchOsm(base: string, [w, s, e, n]: BBox): Promise<OsmData> {
  const box = `${s},${w},${n},${e}`;
  const roadRe = `^(${Object.keys(ROAD_CLASS).join('|')})$`;
  // One request (busy public servers queue each one). Tags are only sent for buildings that have a
  // height or level count; the rest come as bare outlines, which keeps dense cities small.
  const elements = await overpass(base, `[out:json][timeout:150];
(way["building"](${box});relation["building"]["type"="multipolygon"](${box});)->.b;
(way.b["height"];way.b["building:levels"];relation.b["height"];relation.b["building:levels"];)->.t;
(.b; - .t;)->.n;
.t out tags geom;
.n out geom;
(way["highway"~"${roadRe}"](${box});way["waterway"~"^(river|stream|canal)$"](${box}););
out tags geom;`);
  const buildings = elements.filter(el => !el.tags?.highway && !el.tags?.waterway);
  const lines = elements.filter(el => el.tags?.highway || el.tags?.waterway);

  const outlines: Outline[] = [];
  for (const el of buildings) {
    const t = el.tags ?? {};
    const levels = Number(t['building:levels']);
    const heightM = parseHeight(t.height) ?? (Number.isFinite(levels) && levels > 0 ? levels * STORY_M : null);
    const rings = el.type === 'way' ? (el.geometry ? [el.geometry] : [])
      : (el.members ?? []).filter(m => m.role === 'outer' && m.geometry).map(m => m.geometry!);
    for (const g of rings) { const ring = toRing(g); if (ring.length >= 3) outlines.push({ ring, heightM }); }
  }
  const roads: OsmData['roads'] = [], rivers: LonLat[][] = [];
  for (const el of lines) {
    if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) continue;
    const line = el.geometry.map(p => [p.lon, p.lat] as LonLat);
    const hw = el.tags?.highway;
    if (hw && ROAD_CLASS[hw]) roads.push({ cls: ROAD_CLASS[hw]!, line });
    else if (el.tags?.waterway) rivers.push(line);
  }
  return { outlines, roads, rivers };
}
