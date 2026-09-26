import type { Building, BuildingClass, Place, SimParams } from './types.js';

/*
 * Hurricane mode: damage and displacement. A port of ml/hurricane_wind.py (max
 * 3-second gust over the storm's passage) and ml/hurricane_damage.py (lognormal
 * fragility, displacement, deaths, cells). NumPy semantics are reproduced exactly
 * (arange steps, interp, gradient) so results match ML's reference to rounding.
 */

/** [lon, lat, vmax_kt, rmw_km, B, time_h] */
export type TrackRow = [number, number, number, number, number, number];

export interface HurricaneScenario {
  place_id: string;
  hazard: 'hurricane';
  track: TrackRow[];
  hour: number;
  protections: readonly { type: 'shelter'; building_id: string }[];
}

/** sim/params/hurricane.json (constants from the ML lead's exports). */
export interface HurricaneParams {
  schema_version: 1;
  wind: { land_factor: number; gust_factor: number; kt_to_mph: number; step_h: number; earth_radius_km: number; nm_to_km: number };
  fragility_beta: number;
  residential_classes: BuildingClass[];
  mortality: { a: number; b_per_mph: number; class_factor: { MH: number; other: number } };
  cells: { min_share: number; min_residents: number; bands: { moderate: number; severe: number; extreme: number } };
  category_defaults: Record<string, { vmax_kt: number; rmw_km: number; B: number }>;
  forward_speed_kmh: number;
}

/** numpy.interp for increasing xp (clamped at both ends). */
function interp(x: number, xp: readonly number[], fp: readonly number[]): number {
  const n = xp.length;
  if (x <= xp[0]!) return fp[0]!;
  if (x >= xp[n - 1]!) return fp[n - 1]!;
  let j = 0;
  while (j < n - 2 && x >= xp[j + 1]!) j++;
  return (fp[j + 1]! - fp[j]!) / (xp[j + 1]! - xp[j]!) * (x - xp[j]!) + fp[j]!;
}

/** numpy.gradient(f, x) with edge_order=1 (second order inside, first order at the ends). */
function gradient(f: readonly number[], x: readonly number[]): number[] {
  const n = f.length;
  if (n < 2) return new Array(n).fill(0);
  const out = new Array<number>(n);
  out[0] = (f[1]! - f[0]!) / (x[1]! - x[0]!);
  out[n - 1] = (f[n - 1]! - f[n - 2]!) / (x[n - 1]! - x[n - 2]!);
  for (let i = 1; i < n - 1; i++) {
    const d1 = x[i]! - x[i - 1]!, d2 = x[i + 1]! - x[i]!;
    out[i] = -d2 / (d1 * (d1 + d2)) * f[i - 1]! + (d2 - d1) / (d1 * d2) * f[i]! + d1 / (d2 * (d1 + d2)) * f[i + 1]!;
  }
  return out;
}

/** Max 3-second gust (mph) at each point over the storm's passage (ml/hurricane_wind.py max_gust_mph). */
export function maxGustMph(track: readonly TrackRow[], lon: readonly number[], lat: readonly number[], hp: HurricaneParams): Float64Array {
  const w = hp.wind;
  const R = w.earth_radius_km, RAD = Math.PI / 180;
  const lat0 = track.reduce((s, r) => s + r[1], 0) / track.length;
  const cos0 = Math.cos(lat0 * RAD);
  const t0 = track[0]![5], t1 = track[track.length - 1]![5];
  const count = Math.max(0, Math.ceil((t1 + 1e-9 - t0) / w.step_h));
  const steps = Array.from({ length: count }, (_, i) => t0 + i * w.step_h);
  const times = track.map(r => r[5]);
  const col = (k: number) => steps.map(t => interp(t, times, track.map(r => r[k]!)));
  const [clon, clat, vmax, rmw, B] = [0, 1, 2, 3, 4].map(col) as number[][];
  const cx = clon!.map(v => v * RAD * cos0 * R), cy = clat!.map(v => v * RAD * R);
  const vx = gradient(cx, steps), vy = gradient(cy, steps);
  const vt = vx.map((v, i) => Math.hypot(v, vy[i]!) / w.nm_to_km);
  const heading = vx.map((v, i) => Math.atan2(vy[i]!, v));
  const best = new Float64Array(lon.length);
  for (let p = 0; p < lon.length; p++) {
    const px = lon[p]! * RAD * cos0 * R, py = lat[p]! * RAD * R;
    let m = 0;
    for (let k = 0; k < steps.length; k++) {
      const dx = px - cx[k]!, dy = py - cy[k]!;
      const r = Math.hypot(dx, dy);
      const vpeak = Math.max(vmax![k]! - 0.5 * vt[k]!, 0);
      const x = (rmw![k]! / Math.max(r, 0.1)) ** B![k]!;
      let v = vpeak * Math.sqrt(x * Math.exp(1 - x));
      const right = heading[k]! - Math.PI / 2;
      v += 0.5 * vt[k]! * Math.cos(Math.atan2(dy, dx) - right) * Math.min(1, v / Math.max(vpeak, 1e-6));
      if (v > m) m = v;
    }
    best[p] = m * w.land_factor * w.gust_factor * w.kt_to_mph;
  }
  return best;
}

/** erf to ~1e-15: Maclaurin series near zero, continued fraction for erfc in the tails. */
export function erf(x: number): number {
  if (x < 0) return -erf(-x);
  if (x < 3) {
    let term = x, sum = x;
    for (let n = 1; n < 200; n++) {
      term *= -x * x / n;
      const add = term / (2 * n + 1);
      sum += add;
      if (Math.abs(add) < 1e-17 * Math.abs(sum)) break;
    }
    return 2 / Math.sqrt(Math.PI) * sum;
  }
  // erfc(x) = exp(-x^2)/sqrt(pi) * 1/(x + 1/2/(x + 1/(x + 3/2/(x + ...)))) (Lentz)
  let f = x, C = x, D = 0;
  for (let n = 1; n < 200; n++) {
    const a = n / 2;
    D = x + a * D; D = 1 / D;
    C = x + a / C;
    const delta = C * D;
    f *= delta;
    if (Math.abs(delta - 1) < 1e-16) break;
  }
  return 1 - Math.exp(-x * x) / Math.sqrt(Math.PI) / f;
}
const phi = (z: number) => 0.5 * (1 + erf(z / Math.SQRT2));

export interface HurricaneBuildings {
  gust: Float64Array;
  /** P(level >= k+1) for k = 0..3, row-major [building][k]. */
  p: Float64Array;
  residents: Float64Array;
  displaced: Float64Array;
  destroyed: Float64Array;
  deaths: Float64Array;
}

/** Per-building gust, fragility, displacement and deaths (ml/hurricane_damage.py building_results). */
export function hurricaneBuildings(scenario: HurricaneScenario, place: Place, params: SimParams, hp: HurricaneParams): HurricaneBuildings {
  const b = place.buildings;
  const gust = maxGustMph(scenario.track, b.map(x => x.lon), b.map(x => x.lat), hp);
  const n = b.length;
  const p = new Float64Array(n * 4);
  const residents = new Float64Array(n), displaced = new Float64Array(n), destroyed = new Float64Array(n), deaths = new Float64Array(n);
  const res = new Set<string>(hp.residential_classes);
  const m = hp.mortality;
  for (let i = 0; i < n; i++) {
    const x: Building = b[i]!;
    const T = params.wind.damage_thresholds_mph[x.cls];
    for (let k = 0; k < 4; k++) p[i * 4 + k] = phi(Math.log(gust[i]! / T[k]!) / hp.fragility_beta);
    if (!res.has(x.cls)) continue;
    residents[i] = x.pop_night_u65 + x.pop_night_o65;
    displaced[i] = residents[i]! * p[i * 4 + 1]!;
    destroyed[i] = residents[i]! * p[i * 4 + 2]!;
    deaths[i] = residents[i]! * Math.exp(m.a + m.b_per_mph * gust[i]!) * (x.cls === 'MH' ? m.class_factor.MH : m.class_factor.other);
  }
  return { gust, p, residents, displaced, destroyed, deaths };
}

export type HurricaneBand = 'low' | 'moderate' | 'severe' | 'extreme' | 'sparse';
export interface HurricaneCell { residents: number; displaced: number; share: number; band: HurricaneBand }
export interface HurricaneResult {
  place_id: string;
  hazard: 'hurricane';
  residents: number;
  displaced: number;
  destroyed: number;
  expected_deaths: number;
  by_class: Record<string, { residents: number; displaced: number; destroyed: number }>;
  cells: Record<string, HurricaneCell>;
  sheltered: number;
  displaced_unsheltered: number;
}

export function hurricaneBand(share: number, hp: HurricaneParams): Exclude<HurricaneBand, 'sparse'> {
  const b = hp.cells.bands;
  return share >= b.extreme ? 'extreme' : share >= b.severe ? 'severe' : share >= b.moderate ? 'moderate' : 'low';
}

/**
 * Expected damage and displacement (no runs). `shelteredBy` gives displaced people
 * sheltered per building (step 6); a cell's share then counts only the unsheltered.
 */
export function hurricaneResult(scenario: HurricaneScenario, place: Place, params: SimParams, hp: HurricaneParams,
  shelteredBy?: Float64Array): HurricaneResult {
  const r = hurricaneBuildings(scenario, place, params, hp);
  const by_class: HurricaneResult['by_class'] = {};
  for (const cls of hp.residential_classes) by_class[cls] = { residents: 0, displaced: 0, destroyed: 0 };
  const agg = new Map<string, [number, number]>();
  let residents = 0, displaced = 0, destroyed = 0, deaths = 0, sheltered = 0;
  place.buildings.forEach((b, i) => {
    const s = shelteredBy?.[i] ?? 0;
    residents += r.residents[i]!; displaced += r.displaced[i]!; destroyed += r.destroyed[i]!; deaths += r.deaths[i]!; sheltered += s;
    const c = by_class[b.cls];
    if (c) { c.residents += r.residents[i]!; c.displaced += r.displaced[i]!; c.destroyed += r.destroyed[i]!; }
    if (!b.h3) return;
    const a = agg.get(b.h3) ?? [0, 0];
    a[0] += r.residents[i]!; a[1] += r.displaced[i]! - s;
    agg.set(b.h3, a);
  });
  const cells: Record<string, HurricaneCell> = {};
  for (const [h3, [res, dis]] of agg) {
    if (res <= 0 || dis / res < hp.cells.min_share) continue;
    cells[h3] = { residents: res, displaced: dis, share: dis / res,
      band: res < hp.cells.min_residents ? 'sparse' : hurricaneBand(dis / res, hp) };
  }
  return { place_id: scenario.place_id, hazard: 'hurricane', residents, displaced, destroyed, expected_deaths: deaths,
    by_class, cells, sheltered, displaced_unsheltered: displaced - sheltered };
}

/** Future mode: drawn points -> track rows with the category's defaults, at 20 km/h forward speed. */
export function trackFromDrawing(points: readonly [number, number][], category: number, hp: HurricaneParams): TrackRow[] {
  const d = hp.category_defaults[String(category)];
  if (!d) throw new Error(`hurricane: no defaults for category ${category}`);
  const RAD = Math.PI / 180, R = hp.wind.earth_radius_km;
  let km = 0;
  return points.map((pt, i) => {
    if (i > 0) {
      const [lon1, lat1] = points[i - 1]!, [lon2, lat2] = pt;
      const h = Math.sin((lat2 - lat1) * RAD / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin((lon2 - lon1) * RAD / 2) ** 2;
      km += 2 * R * Math.asin(Math.sqrt(Math.min(1, h)));
    }
    return [pt[0], pt[1], d.vmax_kt, d.rmw_km, d.B, km / hp.forward_speed_kmh];
  });
}
