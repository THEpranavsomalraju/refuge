import { BUILDING_CLASSES, type Band, type BuildingClass, type CellDiff, type CellResult, type CellRuns,
  type Driver, type Place, type SimParams, type TornadoScenario } from './types.js';
import { preparePath } from './geometry.js';
import { damageLevel, deathProb, expectedExposure, exposure, isNight, windAt } from './engine.js';
import { nearestRank } from './random.js';

interface CellTally {
  people: number;
  expected: number;
  noBasement: number;
  byClass: Record<BuildingClass, number>;
}
const emptyTally = (): CellTally => ({ people: 0, expected: 0, noBasement: 0,
  byClass: Object.fromEntries(BUILDING_CLASSES.map(c => [c, 0])) as Record<BuildingClass, number> });

/** Band by lower cutoff: a risk equal to a cutoff belongs to the higher band. */
export function riskBand(risk: number, params: SimParams): Band {
  const { yellow, red, deep_red } = params.risk_bands;
  return risk >= deep_red ? 'deep_red' : risk >= red ? 'red' : risk >= yellow ? 'yellow' : 'green';
}

/**
 * Per-cell people at the scenario hour, expected deaths, run quantiles, risk, band,
 * and drivers. Cells come from place.cells plus every building's h3. Tornado cells
 * count building occupants only; crossing drivers join with the flood chunk.
 */
export function aggregateCells(runs: CellRuns, place: Place, scenario: TornadoScenario,
  params: SimParams): Record<string, CellResult> {
  const tallies = new Map<string, CellTally>();
  for (const c of place.cells ?? []) tallies.set(c.h3, emptyTally());
  const distance = preparePath(scenario.path);
  for (const building of place.buildings) {
    const h3 = building.h3!;
    let t = tallies.get(h3);
    if (!t) tallies.set(h3, t = emptyTally());
    const damage = damageLevel(building.cls, windAt(distance(building.lon, building.lat), scenario, params), params);
    const e = exposure(building, damage, scenario, params);
    const deaths = expectedExposure(e);
    t.people += e.under65 + e.over65;
    t.expected += deaths;
    t.byClass[building.cls] += deaths;
    if (!building.basement) t.noBasement += deaths;
  }

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
      drivers: drivers(t, night, params),
    };
  }
  return cells;
}

/**
 * Dominant class first, then no_basement / night ranked by the deaths each adds:
 * no_basement = deaths in basementless buildings x (1 - basement modifier), when
 * those buildings hold over half the cell's deaths; night = deaths x (1 - 1/night).
 */
function drivers(t: CellTally, night: boolean, params: SimParams): Driver[] {
  if (t.expected <= 0) return [];
  let dominant: BuildingClass = BUILDING_CLASSES[0];
  for (const cls of BUILDING_CLASSES) if (t.byClass[cls] > t.byClass[dominant]) dominant = cls;
  const extra: [Driver, number][] = [];
  if (t.noBasement / t.expected > 0.5) extra.push(['no_basement', t.noBasement * (1 - params.modifiers.basement)]);
  if (night) extra.push(['night', t.expected * (1 - 1 / params.modifiers.night)]);
  extra.sort((a, b) => b[1] - a[1]);
  return [dominant, ...extra.map(([d]) => d)].slice(0, 3);
}

/** Occupant death probability for each damaged, occupied building (building data card). */
export function buildingProbabilities(scenario: TornadoScenario, place: Place, params: SimParams): Record<string, number> {
  const distance = preparePath(scenario.path);
  const out: Record<string, number> = {};
  for (const building of place.buildings) {
    const damage = damageLevel(building.cls, windAt(distance(building.lon, building.lat), scenario, params), params);
    if (damage === 0) continue;
    const p = deathProb(building, damage, scenario, params);
    if (p > 0) out[building.id] = p;
  }
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
