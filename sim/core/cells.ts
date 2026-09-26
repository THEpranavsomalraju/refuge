import { BUILDING_CLASSES, type Band, type BuildingClass, type CellDiff, type CellResult, type CellRuns,
  type Driver, type Place, type ProtectionConfig, type Scenario, type SimParams } from './types.js';
import { expectedExposure, forEachUnit, isNight } from './engine.js';
import { nearestRank } from './random.js';

type Cls = BuildingClass | 'VEHICLE';
const CLASSES: readonly Cls[] = [...BUILDING_CLASSES, 'VEHICLE'];
interface CellTally {
  people: number;
  expected: number;
  noBasement: number;
  deepWater: number;
  byClass: Record<Cls, number>;
}
const emptyTally = (): CellTally => ({ people: 0, expected: 0, noBasement: 0, deepWater: 0,
  byClass: Object.fromEntries(CLASSES.map(c => [c, 0])) as Record<Cls, number> });

/** Band by lower cutoff: a risk equal to a cutoff belongs to the higher band. */
export function riskBand(risk: number, params: SimParams): Band {
  const { yellow, red, deep_red } = params.risk_bands;
  return risk >= deep_red ? 'deep_red' : risk >= red ? 'red' : risk >= yellow ? 'yellow' : 'green';
}

/**
 * Per-cell people at the scenario hour, expected deaths, run quantiles, risk, band,
 * and drivers. Cells come from place.cells plus every building's h3 (and every
 * crossing's h3 for floods). Tornado cells count building occupants only; flood
 * cells add drivers passing crossings during the exposure window.
 */
export function aggregateCells(runs: CellRuns, place: Place, scenario: Scenario,
  params: SimParams, protections?: ProtectionConfig): Record<string, CellResult> {
  const tallies = new Map<string, CellTally>();
  for (const c of place.cells ?? []) tallies.set(c.h3, emptyTally());
  // Sheltered people stay counted in their home cell, with zero deaths.
  forEachUnit(scenario, place, params, protections, true, u => {
    let t = tallies.get(u.h3!);
    if (!t) tallies.set(u.h3!, t = emptyTally());
    const deaths = expectedExposure(u.e);
    t.people += u.e.under65 + u.e.over65 + u.sheltered;
    t.expected += deaths;
    t.byClass[u.cls] += deaths;
    if (u.kind === 'building' && !u.basement) t.noBasement += deaths;
    if (u.kind === 'building' && u.damage >= 3) t.deepWater += deaths;
  });

  const night = isNight(scenario.hour);
  const zeros = new Array<number>(scenario.runs).fill(0);
  const cells: Record<string, CellResult> = {};
  for (const [h3, t] of tallies) {
    const sorted = [...(runs.get(h3) ?? zeros)].sort((a, b) => a - b);
    const p05 = nearestRank(sorted, 0.05);
    const p95 = nearestRank(sorted, 0.95);
    const risk = t.people > 0 ? t.expected / t.people : 0;
    const banded = t.people >= params.min_cell_people;
    cells[h3] = {
      people: t.people, expected_deaths: t.expected, p05, p95, risk,
      band: t.people === 0 ? 'empty' : banded ? riskBand(risk, params) : 'sparse',
      uncertain: banded && riskBand(p05 / t.people, params) !== riskBand(p95 / t.people, params),
      drivers: drivers(t, scenario, night, params),
    };
  }
  return cells;
}

/**
 * Dominant class (VEHICLE included) first, then the other reasons ranked by the
 * deaths each accounts for:
 * - tornado no_basement: deaths in basementless buildings x (1 - basement modifier),
 *   when those buildings hold over half the cell's deaths;
 * - flood flood_depth: building deaths at damage level 3+ (compromised or chance);
 * - flood crossing_traffic: deaths of drivers at crossings;
 * - night (both hazards): deaths x (1 - 1/night modifier).
 */
function drivers(t: CellTally, scenario: Scenario, night: boolean, params: SimParams): Driver[] {
  if (t.expected <= 0) return [];
  let dominant: Cls = CLASSES[0]!;
  for (const cls of CLASSES) if (t.byClass[cls] > t.byClass[dominant]) dominant = cls;
  const extra: [Driver, number][] = [];
  if (scenario.hazard === 'tornado') {
    if (t.noBasement / t.expected > 0.5) extra.push(['no_basement', t.noBasement * (1 - params.modifiers.basement)]);
  } else {
    if (t.deepWater > 0) extra.push(['flood_depth', t.deepWater]);
    if (t.byClass.VEHICLE > 0) extra.push(['crossing_traffic', t.byClass.VEHICLE]);
  }
  if (night) extra.push(['night', t.expected * (1 - 1 / params.modifiers.night)]);
  extra.sort((a, b) => b[1] - a[1]);
  return [dominant, ...extra.map(([d]) => d)].slice(0, 3);
}

/** Occupant death probability for each damaged, occupied building (building data card). */
export function buildingProbabilities(scenario: Scenario, place: Place, params: SimParams,
  protections?: ProtectionConfig): Record<string, number> {
  const out: Record<string, number> = {};
  forEachUnit(scenario, place, params, protections, false, u => {
    if (u.kind !== 'building') return;
    const n = u.e.under65 + u.e.over65 + u.sheltered; // averaged over every occupant
    if (n > 0 && expectedExposure(u.e) > 0) out[u.id] = expectedExposure(u.e) / n;
  });
  return out;
}

type CellSummary = Pick<CellResult, 'expected_deaths' | 'risk'>;
/** After minus before for every cell in either result; a missing cell counts as zero. */
export function diffCells(before: Readonly<Record<string, CellSummary>>,
  after: Readonly<Record<string, CellSummary>>): Record<string, CellDiff> {
  const out: Record<string, CellDiff> = {};
  for (const h3 of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const b = before[h3]; const a = after[h3];
    out[h3] = { delta_expected_deaths: (a?.expected_deaths ?? 0) - (b?.expected_deaths ?? 0),
      delta_risk: (a?.risk ?? 0) - (b?.risk ?? 0) };
  }
  return out;
}
