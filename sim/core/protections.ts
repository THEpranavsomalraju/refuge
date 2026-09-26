import type { Building, Place, ProtectionConfig, Scenario, ShelterAssignment, SimParams,
  TornadoScenario } from './types.js';
import { distanceM, preparePath } from './geometry.js';
import { damageLevel, expectedExposure, exposure, isNight, occupants, windAt } from './engine.js';

/*
 * Shelters are existing public/commercial buildings converted into FEMA P-361
 * hardened cores. Tornado: the building's own occupants go first, then a compliant
 * share of mobile-home residents within walking reach; sheltered people have zero
 * death probability. Every path (engine, "alone" effectiveness, optimizer) fills
 * the same sorted (home, shelter) pairs, so their numbers always agree.
 */

/** Walking reach: speed x time left after hearing the warning and getting moving. */
export function tornadoReachM(scenario: Scenario, config: ProtectionConfig): number {
  const t = config.shelter.tornado;
  return t.walk_speed_mps * Math.max(0, scenario.warning_min - t.mobilize_min) * 60;
}

/** floor(hardened share x footprint / sq ft per person), clamped; null if not eligible. */
export function shelterCapacity(b: Building, config: ProtectionConfig, hazard: 'tornado' | 'hurricane'): number | null {
  const s = config.shelter;
  const f = b.footprint_sqft;
  if (!s.eligible_classes.includes(b.cls) || typeof f !== 'number' || !(f > 0)) return null;
  const h = s[hazard];
  return Math.min(h.capacity_max, Math.max(h.capacity_min, Math.floor(s.hardened_share * f / h.sqft_per_person)));
}
export const shelterCost = (capacity: number, config: ProtectionConfig, hazard: 'tornado' | 'hurricane'): number =>
  capacity * config.shelter[hazard].cost_per_person;

/** People who may go, and the value of sheltering one of them (deaths averted per person). */
interface Demand { home: number; goers: number; value: number }
/** [distance m, demand index, shelter slot] sorted nearest first. */
type Pair = [number, number, number];

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

/** Tornado demand and pairs for a set of shelter buildings (indices into place.buildings). */
function tornadoPairs(scenario: TornadoScenario, place: Place, params: SimParams, config: ProtectionConfig,
  shelters: readonly number[], precomputed?: ReturnType<typeof tornadoBuildingDeaths>) {
  const t = config.shelter.tornado;
  const { deaths, people } = precomputed ?? tornadoBuildingDeaths(scenario, place, params);
  const reach = tornadoReachM(scenario, config);
  const served = new Set<string>(t.served_classes);
  const homes: number[] = [];
  place.buildings.forEach((b, i) => { if (served.has(b.cls) && people[i]! > 0) homes.push(i); });
  const demands: Demand[] = [];
  const homeDemand = new Map<number, number>();
  const pairs: Pair[] = [];
  const grid = new Grid(place, homes, Math.max(reach, 50) / 111_000);
  shelters.forEach((k, slot) => {
    const b = place.buildings[k]!;
    // The building's own occupants shelter first (distance 0, everyone goes).
    if (people[k]! > 0) {
      demands.push({ home: k, goers: people[k]!, value: deaths[k]! / people[k]! });
      pairs.push([0, demands.length - 1, slot]);
    }
    if (reach <= 0) return;
    for (const [i, d] of grid.near(b.lon, b.lat, reach)) {
      if (i === k) continue;
      let di = homeDemand.get(i);
      if (di === undefined) {
        demands.push({ home: i, goers: people[i]! * t.compliance, value: deaths[i]! / people[i]! });
        homeDemand.set(i, di = demands.length - 1);
      }
      pairs.push([d, di, slot]);
    }
  });
  const byHome = (p: Pair) => demands[p[1]]!.home;
  pairs.sort((a, b) => a[0] - b[0] || byHome(a) - byHome(b) || a[2] - b[2]);
  return { demands, pairs, deaths, people };
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

function shelterIndices(scenario: Scenario, place: Place, config: ProtectionConfig): number[] {
  const index = new Map(place.buildings.map((b, i) => [b.id, i]));
  return scenario.protections.map(p => {
    const k = index.get(p.building_id);
    if (k === undefined) throw new Error(`protections: unknown building ${p.building_id}`);
    if (shelterCapacity(place.buildings[k]!, config, 'tornado') === null) {
      throw new Error(`protections: ${p.building_id} cannot be a shelter (needs ${config.shelter.eligible_classes.join('/')} and footprint_sqft)`);
    }
    return k;
  });
}

/** Share of each building's occupants inside a shelter, plus who went where. */
export function assignShelters(scenario: TornadoScenario, place: Place, params: SimParams, config: ProtectionConfig):
  { share: Float64Array; total: number; assignments: ShelterAssignment[] } {
  const share = new Float64Array(place.buildings.length);
  const shelters = shelterIndices(scenario, place, config);
  if (shelters.length === 0) return { share, total: 0, assignments: [] };
  const { demands, pairs, people } = tornadoPairs(scenario, place, params, config, shelters);
  const capacity = shelters.map(k => shelterCapacity(place.buildings[k]!, config, 'tornado')!);
  let total = 0;
  const assignments: ShelterAssignment[] = [];
  for (const [di, slot, take] of fill(demands, pairs, capacity).taken) {
    const home = demands[di]!.home;
    share[home]! += take / people[home]!;
    total += take;
    assignments.push({ building_id: place.buildings[home]!.id, shelter_id: place.buildings[shelters[slot]!]!.id, people: take });
  }
  return { share, total, assignments };
}

export interface ShelterCandidate {
  building_id: string;
  cls: string;
  lon: number;
  lat: number;
  footprint_sqft: number;
  capacity: number;
  cost_usd: number;
  /** Tornado: mobile-home residents within walking reach at the scenario hour. */
  people_in_reach: number;
  mh_homes_in_reach: number;
  /** Tornado: lives saved if this building alone becomes a shelter. */
  effectiveness: number;
}

/** Every eligible building for the current storm, most effective first (ties by id). */
export function shelterCandidates(scenario: Scenario, place: Place, params: SimParams,
  config: ProtectionConfig): ShelterCandidate[] {
  if (scenario.hazard !== 'tornado') throw new Error('shelterCandidates: only tornado is implemented so far');
  const pre = tornadoBuildingDeaths(scenario, place, params);
  const reach = tornadoReachM(scenario, config);
  const served = new Set<string>(config.shelter.tornado.served_classes);
  const mh: number[] = [];
  place.buildings.forEach((b, i) => { if (served.has(b.cls)) mh.push(i); });
  const grid = new Grid(place, mh, Math.max(reach, 50) / 111_000);
  const out: ShelterCandidate[] = [];
  place.buildings.forEach((b, k) => {
    const capacity = shelterCapacity(b, config, 'tornado');
    if (capacity === null) return;
    const near = reach > 0 ? grid.near(b.lon, b.lat, reach).filter(([i]) => i !== k) : [];
    const { demands, pairs } = tornadoPairs(scenario, place, params, config, [k], pre);
    out.push({ building_id: b.id, cls: b.cls, lon: b.lon, lat: b.lat, footprint_sqft: b.footprint_sqft!, capacity,
      cost_usd: shelterCost(capacity, config, 'tornado'),
      people_in_reach: near.reduce((s, [i]) => s + pre.people[i]!, 0), mh_homes_in_reach: near.length,
      effectiveness: fill(demands, pairs, [capacity]).value });
  });
  return out.sort((a, b) => b.effectiveness - a.effectiveness || (a.building_id < b.building_id ? -1 : 1));
}

export interface ShelterPlan {
  building_ids: string[];
  cost_usd: number;
  /** Tornado: lives saved (expected deaths averted) by the whole plan. */
  value: number;
  baseline_deaths: number;
  expected_deaths: number;
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
export function optimizeShelters(scenario: TornadoScenario, place: Place, params: SimParams, config: ProtectionConfig,
  budgetUsd: number, selected: readonly string[] = []): ShelterPlan {
  const ranked = shelterCandidates(scenario, place, params, config);
  const byId = new Map(ranked.map(c => [c.building_id, c]));
  for (const id of selected) if (!byId.has(id)) throw new Error(`optimizer: ${id} cannot be a shelter`);
  const ids = [...new Set([...ranked.slice(0, config.optimizer.top_candidates).map(c => c.building_id), ...selected])];
  const index = new Map(place.buildings.map((b, i) => [b.id, i]));
  const shelters = ids.map(id => index.get(id)!);
  const pre = tornadoBuildingDeaths(scenario, place, params);
  const { demands, pairs } = tornadoPairs(scenario, place, params, config, shelters, pre);
  const capacity = ids.map(id => byId.get(id)!.capacity);
  const cost = ids.map(id => byId.get(id)!.cost_usd);
  const baseline = pre.deaths.reduce((a, b) => a + b, 0);
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
  return { building_ids: best.map(i => ids[i]!), cost_usd: costOf(best), value: bestValue, baseline_deaths: baseline,
    expected_deaths: baseline - bestValue, evaluated, method: exhaustive ? 'exhaustive' : 'greedy',
    label: exhaustive ? 'best' : 'best found', candidates: ids };
}
