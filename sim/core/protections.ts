import type { Building, Place, ProtectionConfig, Scenario, ShelterAssignment, SimParams,
  TornadoScenario } from './types.js';
import { distanceM, preparePath } from './geometry.js';
import { damageLevel, expectedExposure, exposure, isNight, occupants, windAt } from './engine.js';
import { hurricaneBuildings, hurricaneResult, type HurricaneParams, type HurricaneResult,
  type HurricaneScenario } from './hurricane.js';

/*
 * Shelters are existing public/commercial buildings converted into FEMA P-361
 * hardened cores.
 * - Tornado: the building's own occupants go first, then a compliant share of
 *   mobile-home residents within walking reach; value = deaths averted.
 * - Hurricane: displaced residents within driving reach; value = need served
 *   (1.0 per person from a destroyed home, 0.5 from major damage).
 * Every path (engine, "alone" effectiveness, optimizer) fills the same sorted
 * (home, shelter) pairs from one per-storm context, so their numbers always agree.
 */

type Hazard = 'tornado' | 'hurricane';
type AnyScenario = TornadoScenario | HurricaneScenario;

/**
 * The Structure Inventory sometimes lists one building as several records at the same point with
 * the same footprint (mixed use). They share one floor, so they are one shelter site: the first
 * eligible record stands for the site and the others map to it (duplicate id -> site id).
 */
const siteCache = new WeakMap<Place, Map<string, string>>();
export function shelterDuplicates(place: Place, eligibleClasses: readonly string[]): ReadonlyMap<string, string> {
  let dup = siteCache.get(place);
  if (dup) return dup;
  dup = new Map();
  const first = new Map<string, string>();
  for (const b of place.buildings) {
    if (!eligibleClasses.includes(b.cls) || typeof b.footprint_sqft !== 'number' || !(b.footprint_sqft > 0)) continue;
    const key = `${b.lon.toFixed(6)},${b.lat.toFixed(6)},${b.footprint_sqft}`;
    const site = first.get(key);
    if (site === undefined) first.set(key, b.id); else dup.set(b.id, site);
  }
  siteCache.set(place, dup);
  return dup;
}
/** The shelter site a building record belongs to (itself unless it duplicates another record). */
export const shelterSiteId = (place: Place, eligibleClasses: readonly string[], id: string): string =>
  shelterDuplicates(place, eligibleClasses).get(id) ?? id;

/** Walking reach: speed x time left after hearing the warning and getting moving. */
export function tornadoReachM(scenario: Scenario, config: ProtectionConfig): number {
  const t = config.shelter.tornado;
  return t.walk_speed_mps * Math.max(0, scenario.warning_min - t.mobilize_min) * 60;
}

/** floor(hardened share x footprint / sq ft per person), clamped; null if not eligible. */
export function shelterCapacity(b: Building, config: ProtectionConfig, hazard: Hazard): number | null {
  const s = config.shelter;
  const f = b.footprint_sqft;
  if (!s.eligible_classes.includes(b.cls) || typeof f !== 'number' || !(f > 0)) return null;
  const h = s[hazard];
  return Math.min(h.capacity_max, Math.max(h.capacity_min, Math.floor(s.hardened_share * f / h.sqft_per_person)));
}
export const shelterCost = (capacity: number, config: ProtectionConfig, hazard: Hazard): number =>
  capacity * config.shelter[hazard].cost_per_person;

/** Expected deaths and occupants per building for a tornado with no protections. */
export function tornadoBuildingDeaths(scenario: TornadoScenario, place: Place, params: SimParams) {
  const n = place.buildings.length;
  const deaths = new Float64Array(n);
  const people = new Float64Array(n);
  const distance = preparePath(scenario.path);
  const night = isNight(scenario.hour);
  for (let i = 0; i < n; i++) {
    const b = place.buildings[i]!;
    const [u, o] = occupants(b, night);
    people[i] = u + o;
    const damage = damageLevel(b.cls, windAt(distance(b.lon, b.lat), scenario, params), params);
    if (damage > 0) deaths[i] = expectedExposure(exposure(b, damage, scenario, params));
  }
  return { deaths, people };
}

/** Lon/lat bucket index for "who lives within r meters of this point". */
class Grid {
  private readonly cells = new Map<string, number[]>();
  constructor(private readonly place: Place, members: readonly number[], private readonly cellDeg: number) {
    for (const i of members) {
      const b = place.buildings[i]!;
      const k = this.key(Math.floor(b.lon / cellDeg), Math.floor(b.lat / cellDeg));
      let list = this.cells.get(k);
      if (!list) this.cells.set(k, list = []);
      list.push(i);
    }
  }
  private key(x: number, y: number) { return `${x},${y}`; }
  /** Members within r meters of (lon, lat), with their distances. */
  near(lon: number, lat: number, r: number): [number, number][] {
    const out: [number, number][] = [];
    const span = Math.ceil(r / (111_000 * this.cellDeg * Math.max(0.2, Math.cos(lat * Math.PI / 180)))) + 1;
    const x0 = Math.floor(lon / this.cellDeg), y0 = Math.floor(lat / this.cellDeg);
    for (let dx = -span; dx <= span; dx++) for (let dy = -span; dy <= span; dy++) {
      for (const i of this.cells.get(this.key(x0 + dx, y0 + dy)) ?? []) {
        const b = this.place.buildings[i]!;
        const d = distanceM(lon, lat, b.lon, b.lat);
        if (d <= r) out.push([i, d]);
      }
    }
    return out;
  }
}

/** People who may go to a shelter, and the value of sheltering one of them. */
interface Demand { home: number; goers: number; value: number }
/** [distance m, demand index, shelter slot] sorted nearest first. */
type Pair = [number, number, number];

/** Everything about one storm that shelter assignment needs, computed once. */
interface Context {
  hazard: Hazard;
  place: Place;
  config: ProtectionConfig;
  reach: number;
  grid: Grid;
  /** Per building: goers (tornado: compliant residents; hurricane: displaced) and value per person. */
  goers: Float64Array;
  value: Float64Array;
  /** Tornado only: occupants and per-person value of the shelter building itself (own occupants go first). */
  ownPeople?: Float64Array;
  /** Total value at stake with no shelters (tornado: expected deaths; hurricane: need). */
  baseline: number;
  /** Residents counted for "people in reach" (tornado: occupants of served homes; hurricane: displaced). */
  inReach: Float64Array;
  /** Buildings counted as mobile homes in reach. */
  mh: Uint8Array;
  hurricane?: ReturnType<typeof hurricaneBuildings>;
}

function tornadoContext(scenario: TornadoScenario, place: Place, params: SimParams, config: ProtectionConfig): Context {
  const t = config.shelter.tornado;
  const { deaths, people } = tornadoBuildingDeaths(scenario, place, params);
  const reach = tornadoReachM(scenario, config);
  const served = new Set<string>(t.served_classes);
  const n = place.buildings.length;
  const goers = new Float64Array(n), value = new Float64Array(n), inReach = new Float64Array(n), mh = new Uint8Array(n);
  const homes: number[] = [];
  place.buildings.forEach((b, i) => {
    if (people[i]! > 0) value[i] = deaths[i]! / people[i]!;
    if (!served.has(b.cls)) return;
    mh[i] = 1;
    inReach[i] = people[i]!;
    if (people[i]! > 0) { goers[i] = people[i]! * t.compliance; homes.push(i); }
  });
  return { hazard: 'tornado', place, config, reach, grid: new Grid(place, homes, Math.max(reach, 50) / 111_000),
    goers, value, ownPeople: people, baseline: deaths.reduce((a, b) => a + b, 0), inReach, mh };
}

function hurricaneContext(scenario: HurricaneScenario, place: Place, params: SimParams, config: ProtectionConfig,
  hp: HurricaneParams): Context {
  const h = config.shelter.hurricane;
  const r = hurricaneBuildings(scenario, place, params, hp);
  const n = place.buildings.length;
  const goers = new Float64Array(n), value = new Float64Array(n), mh = new Uint8Array(n);
  const homes: number[] = [];
  let baseline = 0;
  place.buildings.forEach((b, i) => {
    if (b.cls === 'MH') mh[i] = 1;
    const displaced = r.displaced[i]!;
    if (!(displaced > 0)) return;
    const need = r.destroyed[i]! + h.major_damage_weight * (displaced - r.destroyed[i]!);
    goers[i] = displaced; value[i] = need / displaced; baseline += need;
    homes.push(i);
  });
  const reach = h.reach_km * 1000;
  return { hazard: 'hurricane', place, config, reach, grid: new Grid(place, homes, reach / 111_000 / 4),
    goers, value, baseline, inReach: r.displaced, mh, hurricane: r };
}

/** Demands and nearest-first pairs for a set of shelter buildings (indices into place.buildings). */
function pairsFor(ctx: Context, shelters: readonly number[]) {
  const demands: Demand[] = [];
  const homeDemand = new Map<number, number>();
  const pairs: Pair[] = [];
  shelters.forEach((k, slot) => {
    const b = ctx.place.buildings[k]!;
    // Tornado: the building's own occupants shelter first (distance 0, everyone goes).
    if (ctx.ownPeople && ctx.ownPeople[k]! > 0) {
      demands.push({ home: k, goers: ctx.ownPeople[k]!, value: ctx.value[k]! });
      pairs.push([0, demands.length - 1, slot]);
    }
    if (ctx.reach <= 0) return;
    for (const [i, d] of ctx.grid.near(b.lon, b.lat, ctx.reach)) {
      if (i === k) continue;
      let di = homeDemand.get(i);
      if (di === undefined) {
        demands.push({ home: i, goers: ctx.goers[i]!, value: ctx.value[i]! });
        homeDemand.set(i, di = demands.length - 1);
      }
      pairs.push([d, di, slot]);
    }
  });
  const byHome = (p: Pair) => demands[p[1]]!.home;
  pairs.sort((a, b) => a[0] - b[0] || byHome(a) - byHome(b) || a[2] - b[2]);
  return { demands, pairs };
}

/**
 * Fill pairs nearest-first for the shelters whose slot is in `active` (all when
 * omitted). Each person is assigned at most once; each shelter stops at capacity.
 */
function fill(demands: readonly Demand[], pairs: readonly Pair[], capacity: readonly number[], active?: ReadonlySet<number>) {
  const left = demands.map(d => d.goers);
  const cap = [...capacity];
  const taken: [demand: number, slot: number, people: number][] = [];
  let value = 0;
  for (const [, di, slot] of pairs) {
    if (active && !active.has(slot)) continue;
    const take = Math.min(left[di]!, cap[slot]!);
    if (take <= 0) continue;
    left[di]! -= take; cap[slot]! -= take;
    value += take * demands[di]!.value;
    taken.push([di, slot, take]);
  }
  return { taken, value };
}

function shelterIndices(scenario: AnyScenario, place: Place, config: ProtectionConfig, hazard: Hazard): number[] {
  const index = new Map(place.buildings.map((b, i) => [b.id, i]));
  // Duplicate records count as their site, once.
  const ids = [...new Set(scenario.protections.map(p => shelterSiteId(place, config.shelter.eligible_classes, p.building_id)))];
  return ids.map(id => {
    const k = index.get(id);
    if (k === undefined) throw new Error(`protections: unknown building ${id}`);
    if (shelterCapacity(place.buildings[k]!, config, hazard) === null) {
      throw new Error(`protections: ${id} cannot be a shelter (needs ${config.shelter.eligible_classes.join('/')} and footprint_sqft)`);
    }
    return k;
  });
}

/** People sheltered per building (by origin), plus who went where. */
function assign(ctx: Context, shelters: readonly number[]) {
  const people = new Float64Array(ctx.place.buildings.length);
  const assignments: ShelterAssignment[] = [];
  let total = 0;
  if (shelters.length === 0) return { people, total, assignments };
  const { demands, pairs } = pairsFor(ctx, shelters);
  const capacity = shelters.map(k => shelterCapacity(ctx.place.buildings[k]!, ctx.config, ctx.hazard)!);
  for (const [di, slot, take] of fill(demands, pairs, capacity).taken) {
    const home = demands[di]!.home;
    people[home]! += take;
    total += take;
    assignments.push({ building_id: ctx.place.buildings[home]!.id, shelter_id: ctx.place.buildings[shelters[slot]!]!.id, people: take });
  }
  return { people, total, assignments };
}

/** Tornado: share of each building's occupants inside a shelter, plus who went where. */
export function assignShelters(scenario: TornadoScenario, place: Place, params: SimParams, config: ProtectionConfig):
  { share: Float64Array; total: number; assignments: ShelterAssignment[] } {
  const shelters = shelterIndices(scenario, place, config, 'tornado');
  if (shelters.length === 0) return { share: new Float64Array(place.buildings.length), total: 0, assignments: [] };
  const ctx = tornadoContext(scenario, place, params, config);
  const { people, total, assignments } = assign(ctx, shelters);
  const share = people.map((p, i) => p > 0 ? p / ctx.ownPeople![i]! : 0);
  return { share, total, assignments };
}

/** Hurricane result with shelters applied: sheltered people are no longer "displaced without shelter". */
export function simulateHurricane(scenario: HurricaneScenario, place: Place, params: SimParams, hp: HurricaneParams,
  config?: ProtectionConfig): HurricaneResult & { shelter_assignments?: ShelterAssignment[]; need_served?: number } {
  if (scenario.protections.length === 0) return hurricaneResult(scenario, place, params, hp);
  if (!config) throw new Error('protections config (sim/params/protections.json) is required for scenarios with protections');
  const shelters = shelterIndices(scenario, place, config, 'hurricane');
  const ctx = hurricaneContext(scenario, place, params, config, hp);
  const { people, assignments } = assign(ctx, shelters);
  const need = people.reduce((s, p, i) => s + p * ctx.value[i]!, 0);
  return { ...hurricaneResult(scenario, place, params, hp, people), shelter_assignments: assignments, need_served: need };
}

export interface ShelterCandidate {
  building_id: string;
  cls: string;
  lon: number;
  lat: number;
  footprint_sqft: number;
  capacity: number;
  cost_usd: number;
  /** Tornado: mobile-home residents within walking reach. Hurricane: displaced people within 3 km. */
  people_in_reach: number;
  mh_homes_in_reach: number;
  /** Tornado: lives saved by this building alone. Hurricane: need served by this building alone. */
  effectiveness: number;
}

function context(scenario: AnyScenario, place: Place, params: SimParams, config: ProtectionConfig, hp?: HurricaneParams): Context {
  if (scenario.hazard === 'hurricane') {
    if (!hp) throw new Error('hurricane shelters need sim/params/hurricane.json');
    return hurricaneContext(scenario, place, params, config, hp);
  }
  return tornadoContext(scenario, place, params, config);
}

function candidatesFrom(ctx: Context): ShelterCandidate[] {
  const out: ShelterCandidate[] = [];
  const duplicates = shelterDuplicates(ctx.place, ctx.config.shelter.eligible_classes);
  ctx.place.buildings.forEach((b, k) => {
    const capacity = shelterCapacity(b, ctx.config, ctx.hazard);
    if (capacity === null || duplicates.has(b.id)) return;
    // Tornado counts served-class homes in reach; hurricane counts displaced people and mobile homes in reach.
    const near = ctx.reach > 0 ? ctx.grid.near(b.lon, b.lat, ctx.reach).filter(([i]) => i !== k) : [];
    const { demands, pairs } = pairsFor(ctx, [k]);
    out.push({ building_id: b.id, cls: b.cls, lon: b.lon, lat: b.lat, footprint_sqft: b.footprint_sqft!, capacity,
      cost_usd: shelterCost(capacity, ctx.config, ctx.hazard),
      people_in_reach: near.reduce((s, [i]) => s + ctx.inReach[i]!, 0),
      mh_homes_in_reach: near.reduce((s, [i]) => s + ctx.mh[i]!, 0),
      effectiveness: fill(demands, pairs, [capacity]).value });
  });
  return out.sort((a, b) => b.effectiveness - a.effectiveness || (a.building_id < b.building_id ? -1 : 1));
}

/** Every eligible building for the current storm, most effective first (ties by id). */
export function shelterCandidates(scenario: AnyScenario, place: Place, params: SimParams, config: ProtectionConfig,
  hp?: HurricaneParams): ShelterCandidate[] {
  return candidatesFrom(context(scenario, place, params, config, hp));
}

export interface ShelterPlan {
  building_ids: string[];
  cost_usd: number;
  objective: 'lives_saved' | 'need_served';
  /** Lives saved (tornado) or need served (hurricane) by the whole plan. */
  value: number;
  /** Value at stake with no shelters: expected deaths (tornado) or total need (hurricane). */
  baseline: number;
  remaining: number;
  /** Plans scored (every affordable subset when exhaustive). */
  evaluated: number;
  method: 'exhaustive' | 'greedy';
  /** "best" for an exhaustive search over the candidates; "best found" for greedy. */
  label: 'best' | 'best found';
  candidates: string[];
}

/**
 * Candidates = the top N by effectiveness plus every building the user selected.
 * Up to `exhaustive_max` candidates: every affordable subset. Otherwise greedy by
 * value per dollar, then single swaps until nothing improves. Ties go to the cheaper plan.
 */
export function optimizeShelters(scenario: AnyScenario, place: Place, params: SimParams, config: ProtectionConfig,
  budgetUsd: number, selected: readonly string[] = [], hp?: HurricaneParams): ShelterPlan {
  const ctx = context(scenario, place, params, config, hp);
  const ranked = candidatesFrom(ctx);
  const byId = new Map(ranked.map(c => [c.building_id, c]));
  const picked = selected.map(id => shelterSiteId(place, config.shelter.eligible_classes, id));
  for (const id of picked) if (!byId.has(id)) throw new Error(`optimizer: ${id} cannot be a shelter`);
  const ids = [...new Set([...ranked.slice(0, config.optimizer.top_candidates).map(c => c.building_id), ...picked])];
  const index = new Map(place.buildings.map((b, i) => [b.id, i]));
  const { demands, pairs } = pairsFor(ctx, ids.map(id => index.get(id)!));
  const capacity = ids.map(id => byId.get(id)!.capacity);
  const cost = ids.map(id => byId.get(id)!.cost_usd);
  const score = (slots: readonly number[]) => fill(demands, pairs, capacity, new Set(slots)).value;
  const costOf = (slots: readonly number[]) => slots.reduce((s, i) => s + cost[i]!, 0);
  const better = (v: number, c: number, bv: number, bc: number) => v > bv + 1e-12 || (Math.abs(v - bv) <= 1e-12 && c < bc);

  let best: number[] = [];
  let bestValue = 0;
  let evaluated = 0;
  const exhaustive = ids.length <= config.optimizer.exhaustive_max;
  if (exhaustive) {
    for (let mask = 0; mask < 1 << ids.length; mask++) {
      const slots = ids.map((_, i) => i).filter(i => mask & (1 << i));
      const c = costOf(slots);
      if (c > budgetUsd) continue;
      evaluated++;
      const v = slots.length ? score(slots) : 0;
      if (better(v, c, bestValue, costOf(best))) { best = slots; bestValue = v; }
    }
  } else {
    const alone = ids.map(id => byId.get(id)!.effectiveness);
    const order = ids.map((_, i) => i).sort((a, b) => alone[b]! / cost[b]! - alone[a]! / cost[a]! || a - b);
    for (const i of order) {
      const trial = [...best, i];
      if (costOf(trial) > budgetUsd) continue;
      evaluated++;
      const v = score(trial);
      if (v > bestValue + 1e-12) { best = trial; bestValue = v; }
    }
    for (let improved = true; improved;) {
      improved = false;
      for (const out of [...best]) {
        for (const into of order) {
          if (best.includes(into)) continue;
          const trial = best.filter(i => i !== out).concat(into);
          const c = costOf(trial);
          if (c > budgetUsd) continue;
          evaluated++;
          const v = score(trial);
          if (better(v, c, bestValue, costOf(best))) { best = trial; bestValue = v; improved = true; break; }
        }
        if (improved) break;
      }
    }
  }
  best.sort((a, b) => a - b);
  return { building_ids: best.map(i => ids[i]!), cost_usd: costOf(best),
    objective: ctx.hazard === 'tornado' ? 'lives_saved' : 'need_served', value: bestValue,
    baseline: ctx.baseline, remaining: ctx.baseline - bestValue, evaluated,
    method: exhaustive ? 'exhaustive' : 'greedy', label: exhaustive ? 'best' : 'best found', candidates: ids };
}
