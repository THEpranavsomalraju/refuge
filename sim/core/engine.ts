import { BUILDING_CLASSES, CALIBRATION_GROUP, type Building, type BuildingClass, type ClassTotals, type Crossing,
  type DamageLevel, type DetailedResult, type ExpectedResult, type FloodParams, type FloodScenario, type Place,
  type Scenario, type SimParams, type SimulationResult, type TornadoScenario, type VehicleParams } from './types.js';
import { preparePath } from './geometry.js';
import { aggregateCells, buildingProbabilities } from './cells.js';
import { nearestRank, sampleDeaths, seededRandom } from './random.js';

export const isNight = (hour: number): boolean => hour >= 20 || hour < 6;
const warningFactor = (scenario: Scenario, params: SimParams): number =>
  Math.exp(-params.modifiers.warning_per_min * scenario.warning_min);

export function intensityAt(building: Building, scenario: TornadoScenario, params: SimParams): number {
  const distance = preparePath(scenario.path)(building.lon, building.lat);
  return windAt(distance, scenario, params);
}
export function windAt(distance: number, scenario: TornadoScenario, params: SimParams): number {
  return params.wind.peak_mph_by_ef[scenario.ef]! * Math.max(0, 1 - distance / (scenario.width_m / 2));
}

export function damageLevel(cls: BuildingClass, intensityMph: number, params: SimParams): DamageLevel {
  let damage = 0;
  for (const threshold of params.wind.damage_thresholds_mph[cls]) if (intensityMph >= threshold) damage++;
  return damage as DamageLevel;
}

/** Water depth above the first floor; null when the building has no flood data. */
export function floodDepthAt(building: Building, scenario: FloodScenario): number | null {
  const hand = building.hand_m;
  if (typeof hand !== 'number') return null;
  const floor = typeof building.first_floor_ht_m === 'number' ? building.first_floor_ht_m : 0;
  return scenario.flood_height_m - hand - floor;
}

/** Levels 3-4 (compromised, chance) rise one story height per extra story; MH never. */
export function floodDamageLevel(building: Building, depth: number, flood: FloodParams): DamageLevel {
  const stories = typeof building.stories === 'number' && building.stories > 1 ? building.stories : 1;
  const extra = building.cls === 'MH' ? 0 : (stories - 1) * flood.story_height_m;
  const t = flood.damage_thresholds_m[building.cls];
  let damage = 0;
  for (let i = 0; i < 4; i++) if (depth >= t[i]! + (i >= 2 ? extra : 0)) damage++;
  return damage as DamageLevel;
}

export type Exposure = { under65: number; over65: number; pUnder65: number; pOver65: number };
const clampExposure = (under65: number, over65: number, probability: number, over65Factor: number): Exposure =>
  ({ under65, over65, pUnder65: Math.min(1, probability), pOver65: Math.min(1, probability * over65Factor) });

function occupants(building: Building, night: boolean): [number, number] {
  return night ? [building.pop_night_u65, building.pop_night_o65] : [building.pop_day_u65, building.pop_day_o65];
}

/** Tornado occupants: class multiplier and basement apply. Flood: flood table, no multiplier or basement. */
export function exposure(building: Building, damage: DamageLevel, scenario: Scenario, params: SimParams): Exposure {
  const night = isNight(scenario.hour);
  const [under65, over65] = occupants(building, night);
  const group = CALIBRATION_GROUP[building.cls];
  // Tornado factor order is kept exactly as calibrated, so CLI outputs stay bit-identical.
  const probability = scenario.hazard === 'flood'
    ? requireFlood(params).flood.lethality_by_damage[damage]! *
      (night ? params.modifiers.night : 1) * warningFactor(scenario, params)
    : params.lethality_by_damage[building.cls][damage]! *
      (group === null ? 1 : params.lethality_multiplier[group]) *
      (night ? params.modifiers.night : 1) * (building.basement ? params.modifiers.basement : 1) *
      warningFactor(scenario, params);
  return clampExposure(under65, over65, probability, params.modifiers.over65);
}
export const expectedExposure = (e: Exposure): number => e.under65 * e.pUnder65 + e.over65 * e.pOver65;

/** Population-weighted occupant probability, with age-specific clamping. */
export function deathProb(building: Building, damage: DamageLevel, scenario: Scenario, params: SimParams): number {
  const e = exposure(building, damage, scenario, params);
  return e.under65 + e.over65 === 0 ? 0 : expectedExposure(e) / (e.under65 + e.over65);
}

/** Drivers passing a crossing during the exposure window, and the level from depth over the road. */
export function vehicleExposure(crossing: Crossing, depth: number, scenario: Scenario, params: SimParams,
  vehicle: VehicleParams): { level: number; e: Exposure } {
  let level = 0;
  for (const t of vehicle.depth_thresholds_m) if (depth >= t) level++;
  const people = crossing.cars_per_hour![scenario.hour]! * vehicle.exposure_hours * vehicle.occupancy;
  const probability = vehicle.attempt_prob * vehicle.lethality_by_depth[level]! * params.lethality_multiplier.VEHICLE *
    (isNight(scenario.hour) ? params.modifiers.night : 1) * warningFactor(scenario, params);
  return { level, e: clampExposure(people, 0, probability, 1) };
}
export function vehicleDeathProb(crossing: Crossing, scenario: FloodScenario, params: SimParams): number {
  if (typeof crossing.hand_m !== 'number' || !crossing.cars_per_hour) return 0;
  const { vehicle } = requireFlood(params);
  return vehicleExposure(crossing, scenario.flood_height_m - crossing.hand_m, scenario, params, vehicle).e.pUnder65;
}

function requireFlood(params: SimParams): { flood: FloodParams; vehicle: VehicleParams } {
  if (!params.flood || !params.vehicle) {
    throw new Error('params.flood and params.vehicle are required for flood scenarios (see sim_params.default.json)');
  }
  return { flood: params.flood, vehicle: params.vehicle };
}

/** One building or crossing with its damage level and exposure. */
export interface Unit {
  kind: 'building' | 'crossing';
  id: string;
  cls: BuildingClass | 'VEHICLE';
  h3: string | undefined;
  basement: boolean;
  damage: number;
  e: Exposure;
}

/**
 * Visit every unit. With `all` false only damaged units are visited (the fast CLI
 * path); with `all` true undamaged units are visited too, for cell head counts.
 * Tornadoes ignore crossings (tornado cells count building occupants only).
 */
export function forEachUnit(scenario: Scenario, place: Place, params: SimParams, all: boolean,
  visit: (u: Unit) => void): { buildings: number; crossings: number } {
  const missing = { buildings: 0, crossings: 0 };
  if (scenario.hazard === 'tornado') {
    const distance = preparePath(scenario.path);
    for (const b of place.buildings) {
      const damage = damageLevel(b.cls, windAt(distance(b.lon, b.lat), scenario, params), params);
      if (damage === 0 && !all) continue;
      visit({ kind: 'building', id: b.id, cls: b.cls, h3: b.h3, basement: b.basement, damage,
        e: exposure(b, damage, scenario, params) });
    }
    return missing;
  }
  const { flood, vehicle } = requireFlood(params);
  for (const b of place.buildings) {
    const depth = floodDepthAt(b, scenario);
    if (depth === null) missing.buildings++;
    const damage = depth === null ? 0 : floodDamageLevel(b, depth, flood);
    if (damage === 0 && !all) continue;
    visit({ kind: 'building', id: b.id, cls: b.cls, h3: b.h3, basement: b.basement, damage,
      e: exposure(b, damage, scenario, params) });
  }
  for (const c of place.crossings ?? []) {
    if (typeof c.hand_m !== 'number' || !c.cars_per_hour) { missing.crossings++; continue; }
    const { level, e } = vehicleExposure(c, scenario.flood_height_m - c.hand_m, scenario, params, vehicle);
    if (level === 0 && !all) continue;
    visit({ kind: 'crossing', id: c.id, cls: 'VEHICLE', h3: c.h3, basement: false, damage: level, e });
  }
  return missing;
}

function evaluate(scenario: Scenario, place: Place, params: SimParams,
  exposures?: Exposure[], cellOf?: string[]): ExpectedResult {
  const by_class = Object.fromEntries([...BUILDING_CLASSES, 'VEHICLE'].map(c => [c, 0])) as ClassTotals;
  let people_exposed = 0;
  const missing = forEachUnit(scenario, place, params, false, u => {
    people_exposed += u.e.under65 + u.e.over65;
    by_class[u.cls] += expectedExposure(u.e);
    if (exposures && (u.e.pUnder65 > 0 || u.e.pOver65 > 0)) {
      exposures.push(u.e);
      cellOf?.push(u.h3!);
    }
  });
  const result: ExpectedResult = { place_id: scenario.place_id,
    expected_deaths: Object.values(by_class).reduce((a, b) => a + b, 0), by_class, people_exposed };
  if (scenario.hazard === 'flood') result.no_flood_data = missing;
  return result;
}

/** Fast deterministic mode: one pass, no RNG, cells, or per-run arrays. */
export function expected(scenario: Scenario, place: Place, params: SimParams): ExpectedResult {
  return evaluate(scenario, place, params);
}

/**
 * Seeded runs. With `cellOf` (the h3 of each exposure), per-cell deaths are also
 * recorded; RNG consumption is identical either way, so totals always match.
 */
function sampleRuns(scenario: Scenario, exposures: readonly Exposure[], cellOf?: readonly string[]) {
  const random = seededRandom(scenario.seed);
  const totals: number[] = [];
  const cellRuns = new Map<string, number[]>();
  const rows = cellOf?.map(h3 => {
    let row = cellRuns.get(h3);
    if (!row) cellRuns.set(h3, row = new Array<number>(scenario.runs).fill(0));
    return row;
  });
  for (let run = 0; run < scenario.runs; run++) {
    let deaths = 0;
    for (let i = 0; i < exposures.length; i++) {
      const e = exposures[i]!;
      const d = sampleDeaths(e.under65, e.pUnder65, random) + sampleDeaths(e.over65, e.pOver65, random);
      deaths += d;
      if (rows && d > 0) rows[i]![run]! += d;
    }
    totals.push(deaths);
  }
  totals.sort((a, b) => a - b);
  return { p05: nearestRank(totals, 0.05), p95: nearestRank(totals, 0.95), cellRuns };
}

export function simulate(scenario: Scenario, place: Place, params: SimParams): SimulationResult {
  const exposures: Exposure[] = [];
  const result = evaluate(scenario, place, params, exposures);
  const { p05, p95 } = sampleRuns(scenario, exposures);
  return { ...result, p05, p95 };
}

/** Game mode: simulate() plus per-building probabilities and per-cell results. */
export function simulateDetailed(scenario: Scenario, place: Place, params: SimParams): DetailedResult {
  place.buildings.forEach((b, i) => {
    if (typeof b.h3 !== 'string' || b.h3.length === 0) throw new Error(`buildings[${i}].h3: required for cell results`);
  });
  if (scenario.hazard === 'flood') (place.crossings ?? []).forEach((c, i) => {
    if (typeof c.h3 !== 'string' || c.h3.length === 0) throw new Error(`crossings[${i}].h3: required for cell results`);
  });
  const exposures: Exposure[] = [];
  const cellOf: string[] = [];
  const result = evaluate(scenario, place, params, exposures, cellOf);
  const { p05, p95, cellRuns } = sampleRuns(scenario, exposures, cellOf);
  return { ...result, p05, p95, building_prob: buildingProbabilities(scenario, place, params),
    cells: aggregateCells(cellRuns, place, scenario, params) };
}
