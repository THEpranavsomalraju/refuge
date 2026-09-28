// U.S. place search and boundaries from Census TIGERweb (current incorporated places and
// census-designated places; answers browsers directly). Same source as places/build_server.py.
import type { BBox, LonLat } from './geometry';

const SERVICE = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Places_CouSub_ConCity_SubMCD/MapServer';
const LAYERS = [4, 5];   // 4 = Incorporated Places, 5 = Census Designated Places

const STATES: Record<string, [string, string]> = {
  '01': ['AL', 'Alabama'], '02': ['AK', 'Alaska'], '04': ['AZ', 'Arizona'], '05': ['AR', 'Arkansas'], '06': ['CA', 'California'],
  '08': ['CO', 'Colorado'], '09': ['CT', 'Connecticut'], '10': ['DE', 'Delaware'], '11': ['DC', 'District of Columbia'],
  '12': ['FL', 'Florida'], '13': ['GA', 'Georgia'], '15': ['HI', 'Hawaii'], '16': ['ID', 'Idaho'], '17': ['IL', 'Illinois'],
  '18': ['IN', 'Indiana'], '19': ['IA', 'Iowa'], '20': ['KS', 'Kansas'], '21': ['KY', 'Kentucky'], '22': ['LA', 'Louisiana'],
  '23': ['ME', 'Maine'], '24': ['MD', 'Maryland'], '25': ['MA', 'Massachusetts'], '26': ['MI', 'Michigan'], '27': ['MN', 'Minnesota'],
  '28': ['MS', 'Mississippi'], '29': ['MO', 'Missouri'], '30': ['MT', 'Montana'], '31': ['NE', 'Nebraska'], '32': ['NV', 'Nevada'],
  '33': ['NH', 'New Hampshire'], '34': ['NJ', 'New Jersey'], '35': ['NM', 'New Mexico'], '36': ['NY', 'New York'],
  '37': ['NC', 'North Carolina'], '38': ['ND', 'North Dakota'], '39': ['OH', 'Ohio'], '40': ['OK', 'Oklahoma'], '41': ['OR', 'Oregon'],
  '42': ['PA', 'Pennsylvania'], '44': ['RI', 'Rhode Island'], '45': ['SC', 'South Carolina'], '46': ['SD', 'South Dakota'],
  '47': ['TN', 'Tennessee'], '48': ['TX', 'Texas'], '49': ['UT', 'Utah'], '50': ['VT', 'Vermont'], '51': ['VA', 'Virginia'],
  '53': ['WA', 'Washington'], '54': ['WV', 'West Virginia'], '55': ['WI', 'Wisconsin'], '56': ['WY', 'Wyoming'],
};
const FIPS_BY_ABBR = Object.fromEntries(Object.entries(STATES).map(([f, [a]]) => [a, f]));

export interface PlaceHit {
  geoid: string;
  layer: number;
  name: string;         // "Asheville"
  state: string;        // "NC"
  stateName: string;    // "North Carolina"
  center: LonLat;
  areaKm2: number;
}
export interface PlaceBoundary { bbox: BBox; rings: LonLat[][] }

const esc = (s: string) => s.replace(/'/g, "''");

async function query<T>(layer: number, params: Record<string, string>, signal?: AbortSignal): Promise<T> {
  const url = `${SERVICE}/${layer}/query?${new URLSearchParams({ ...params, f: params.f ?? 'json' })}`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Census place search failed (HTTP ${res.status})`);
  return res.json() as Promise<T>;
}

/** Places whose name starts with the query ("ashev", "Asheville, NC", "new york"), largest first. */
export async function searchPlaces(text: string, signal?: AbortSignal): Promise<PlaceHit[]> {
  const [namePart, statePart] = text.split(',').map(s => s.trim());
  if (!namePart || namePart.length < 2) return [];
  const st = statePart ? FIPS_BY_ABBR[statePart.toUpperCase().slice(0, 2)]
    ?? Object.entries(STATES).find(([, [, n]]) => n.toLowerCase().startsWith(statePart.toLowerCase()))?.[0] : undefined;
  const where = `UPPER(BASENAME) LIKE '${esc(namePart.toUpperCase())}%'${st ? ` AND STATE='${st}'` : ''}`;
  const params = { where, outFields: 'GEOID,BASENAME,STATE,CENTLAT,CENTLON,AREALAND', returnGeometry: 'false',
    orderByFields: 'AREALAND DESC', resultRecordCount: '8' };
  const results = await Promise.all(LAYERS.map(layer =>
    query<{ features?: { attributes: Record<string, string | number> }[] }>(layer, params, signal)
      .then(r => (r.features ?? []).map(f => ({ layer, a: f.attributes })))));
  return results.flat()
    .filter(({ a }) => STATES[String(a.STATE)])
    .map(({ layer, a }) => ({
      geoid: String(a.GEOID), layer, name: String(a.BASENAME),
      state: STATES[String(a.STATE)]![0], stateName: STATES[String(a.STATE)]![1],
      center: [Number(a.CENTLON), Number(a.CENTLAT)] as LonLat, areaKm2: Number(a.AREALAND) / 1e6,
    }))
    .sort((x, y) => y.areaKm2 - x.areaKm2)
    .slice(0, 8);
}

/** The place's boundary (simplified) and its bounding box. */
export async function placeBoundary(hit: PlaceHit): Promise<PlaceBoundary> {
  const gj = await query<{ features?: { geometry: { type: string; coordinates: unknown } }[] }>(hit.layer, {
    where: `GEOID='${esc(hit.geoid)}'`, outFields: 'GEOID', returnGeometry: 'true', outSR: '4326',
    maxAllowableOffset: '0.0005', f: 'geojson',
  });
  const rings: LonLat[][] = [];
  for (const f of gj.features ?? []) {
    const g = f.geometry;
    if (g.type === 'Polygon') for (const r of g.coordinates as LonLat[][]) rings.push(r);
    if (g.type === 'MultiPolygon') for (const p of g.coordinates as LonLat[][][]) for (const r of p) rings.push(r);
  }
  if (!rings.length) throw new Error(`No boundary found for ${hit.name}, ${hit.state}.`);
  const all = rings.flat();
  const bbox: BBox = [Math.min(...all.map(p => p[0])), Math.min(...all.map(p => p[1])), Math.max(...all.map(p => p[0])), Math.max(...all.map(p => p[1]))];
  return { bbox, rings };
}
