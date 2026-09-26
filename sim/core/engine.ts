import { BUILDING_CLASSES, CALIBRATION_GROUP, type Building, type BuildingClass, type ClassTotals,
  type DamageLevel, type DetailedResult, type ExpectedResult, type Place, type SimParams, type SimulationResult, type TornadoScenario } from './types.js';
import { preparePath } from './geometry.js';
import { aggregateCells, buildingProbabilities } from './cells.js';
import { nearestRank, sampleDeaths, seededRandom } from './random.js';

export const isNight = (hour: number): boolean => hour >= 20 || hour < 6;

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

export type Exposure = { under65: number; over65: number; pUnder65: number; pOver65: number };
export function exposure(building: Building, damage: DamageLevel, scenario: TornadoScenario, params: SimParams): Exposure {
  const night = isNight(scenario.hour);
  const under65 = night ? building.pop_night_u65 : building.pop_day_u65;
  const over65 = night ? building.pop_night_o65 : building.pop_day_o65;
  const group = CALIBRATION_GROUP[building.cls];
  const probability = params.lethality_by_damage[building.cls][damage]! *
    (group === null ? 1 : params.lethality_multiplier[group]) *
    (night ? params.modifiers.night : 1) * (building.basement ? params.modifiers.basement : 1) *
    Math.exp(-params.modifiers.warning_per_min * scenario.warning_min);
  return { under65, over65, pUnder65: Math.min(1, probability),
    pOver65: Math.min(1, probability * params.modifiers.over65) };
}
export const expectedExposure = (e: Exposure): number => e.under65 * e.pUnder65 + e.over65 * e.pOver65;

/** Population-weighted occupant probability, with age-specific clamping. */
export function deathProb(building: Building, damage: DamageLevel, scenario: TornadoScenario, params: SimParams): number {
  const e = exposure(building, damage, scenario, params);
  return e.under65 + e.over65 === 0 ? 0 : expectedExposure(e) / (e.under65 + e.over65);
}

function evaluate(scenario: TornadoScenario, place: Place, params: SimParams,
  exposures?: Exposure[], cellOf?: string[]): ExpectedResult {
  const by_class = Object.fromEntries([...BUILDING_CLASSES, 'VEHICLE'].map(c => [c, 0])) as ClassTotals;
  const distance = preparePath(scenario.path);
  let people_exposed = 0;
  for (const building of place.buildings) {
    const damage = damageLevel(building.cls, windAt(distance(building.lon, building.lat), scenario, params), params);
    if (damage === 0) continue;
    const e = exposure(building, damage, scenario, params);
    people_exposed += e.under65 + e.over65;
    by_class[building.cls] += expectedExposure(e);
    if (exposures && (e.pUnder65 > 0 || e.pOver65 > 0)) {
      exposures.push(e);
      cellOf?.push(building.h3!);
    }
  }
  return { place_id: scenario.place_id,
    expected_deaths: Object.values(by_class).reduce((a, b) => a + b, 0), by_class, people_exposed };
}

/** Fast deterministic mode: one building pass, no RNG, cells, or per-run arrays. */
export function expected(scenario: TornadoScenario, place: Place, params: SimParams): ExpectedResult {
  return evaluate(scenario, place, params);
}

/**
 * Seeded runs. With `cellOf` (the h3 of each exposure), per-cell deaths are also
 * recorded; RNG consumption is identical either way, so totals always match.
 */
function sampleRuns(scenario: TornadoScenario, exposures: readonly Exposure[], cellOf?: readonly string[]) {
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

export function simulate(scenario: TornadoScenario, place: Place, params: SimParams): SimulationResult {
  const exposures: Exposure[] = [];
  const result = evaluate(scenario, place, params, exposures);
  const { p05, p95 } = sampleRuns(scenario, exposures);
  return { ...result, p05, p95 };
}

/** Game mode: simulate() plus per-building probabilities and per-cell results. */
export function simulateDetailed(scenario: TornadoScenario, place: Place, params: SimParams): DetailedResult {
  place.buildings.forEach((b, i) => {
    if (typeof b.h3 !== 'string' || b.h3.length === 0) throw new Error(`buildings[${i}].h3: required for cell results`);
  });
  const exposures: Exposure[] = [];
  const cellOf: string[] = [];
  const result = evaluate(scenario, place, params, exposures, cellOf);
  const { p05, p95, cellRuns } = sampleRuns(scenario, exposures, cellOf);
  return { ...result, p05, p95, building_prob: buildingProbabilities(scenario, place, params),
    cells: aggregateCells(cellRuns, place, scenario, params) };
}
