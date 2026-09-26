import { BUILDING_CLASSES, type Building, type SimParams, type TornadoScenario, type Coordinate } from './core/types.js';

function fail(at: string, message: string): never { throw new Error(`${at}: ${message}`); }
function record(value: unknown, at: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(at, 'expected an object');
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: readonly string[], at: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${at}.${key}`, 'unknown parameter');
}
function number(value: unknown, at: string, min = 0, max = Number.MAX_VALUE): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    fail(at, `expected a finite number in [${min}, ${max}]`);
  }
  return value;
}
function integer(value: unknown, at: string, min: number, max: number): number {
  const n = number(value, at, min, max);
  if (!Number.isInteger(n)) fail(at, 'expected an integer');
  return n;
}
function sequence(value: unknown, at: string, length: number, min: number, max: number, strict: boolean): number[] {
  if (!Array.isArray(value) || value.length !== length) fail(at, `expected ${length} values`);
  const ns = value.map((v, i) => number(v, `${at}[${i}]`, min, max));
  for (let i = 1; i < ns.length; i++) {
    if (strict ? ns[i]! <= ns[i - 1]! : ns[i]! < ns[i - 1]!) fail(at, 'values must increase with severity');
  }
  return ns;
}
function coordinate(value: unknown, at: string): Coordinate {
  if (!Array.isArray(value) || value.length !== 2) fail(at, 'expected [longitude, latitude]');
  return [number(value[0], `${at}[0]`, -180, 180), number(value[1], `${at}[1]`, -90, 90)];
}

export function parseParams(value: unknown): SimParams {
  const p = record(value, 'params');
  keys(p, ['schema_version', 'night_hours', 'lethality_multiplier', 'modifiers', 'wind', 'lethality_by_damage', 'risk_bands', 'min_cell_people'], 'params');
  if (p.schema_version !== 1) fail('schema_version', 'expected 1');
  const night = p.night_hours;
  if (!Array.isArray(night) || night.length !== 10 || new Set(night).size !== 10 ||
      ![20, 21, 22, 23, 0, 1, 2, 3, 4, 5].every(h => night.includes(h))) {
    fail('night_hours', 'must contain exactly 20,21,22,23,0,1,2,3,4,5 (local clock hours)');
  }
  const multipliers = record(p.lethality_multiplier, 'lethality_multiplier');
  keys(multipliers, ['MH', 'RES', 'PUBLIC', 'VEHICLE'], 'lethality_multiplier');
  for (const group of ['MH', 'RES', 'PUBLIC', 'VEHICLE']) number(multipliers[group], `lethality_multiplier.${group}`, 0.05, 20);
  const m = record(p.modifiers, 'modifiers');
  keys(m, ['night', 'basement', 'warning_per_min', 'over65'], 'modifiers');
  number(m.night, 'modifiers.night', 1, 4);
  number(m.basement, 'modifiers.basement', 0.05, 1);
  number(m.warning_per_min, 'modifiers.warning_per_min', 0, 0.1);
  number(m.over65, 'modifiers.over65', 1, 3);
  const wind = record(p.wind, 'wind');
  keys(wind, ['profile', 'peak_mph_by_ef', 'damage_thresholds_mph'], 'wind');
  if (wind.profile !== 'linear') fail('wind.profile', 'only linear is supported');
  sequence(wind.peak_mph_by_ef, 'wind.peak_mph_by_ef', 6, Number.MIN_VALUE, Number.MAX_VALUE, true);
  const thresholds = record(wind.damage_thresholds_mph, 'wind.damage_thresholds_mph');
  const lethality = record(p.lethality_by_damage, 'lethality_by_damage');
  keys(thresholds, BUILDING_CLASSES, 'wind.damage_thresholds_mph');
  keys(lethality, BUILDING_CLASSES, 'lethality_by_damage');
  for (const cls of BUILDING_CLASSES) {
    sequence(thresholds[cls], `wind.damage_thresholds_mph.${cls}`, 4, Number.MIN_VALUE, Number.MAX_VALUE, true);
    const probabilities = sequence(lethality[cls], `lethality_by_damage.${cls}`, 5, 0, 1, false);
    if (probabilities[0] !== 0) fail(`lethality_by_damage.${cls}[0]`, 'damage level 0 must have zero probability');
  }
  const bands = record(p.risk_bands, 'risk_bands');
  keys(bands, ['yellow', 'red', 'deep_red'], 'risk_bands');
  sequence([bands.yellow, bands.red, bands.deep_red], 'risk_bands', 3, Number.MIN_VALUE, 1, true);
  integer(p.min_cell_people, 'min_cell_people', 1, Number.MAX_SAFE_INTEGER);
  return p as unknown as SimParams;
}

export function parseScenario(value: unknown): TornadoScenario {
  const s = record(value, 'scenario');
  if (typeof s.place_id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(s.place_id)) {
    fail('place_id', 'use a nonempty folder name with letters, digits, underscores or hyphens');
  }
  if (s.hazard !== 'tornado') fail('hazard', 'only tornado is implemented in the calibration CLI');
  if (s.flood_height_m !== undefined && s.flood_height_m !== null) fail('flood_height_m', 'must be null for a tornado');
  const protections = s.protections ?? [];
  if (!Array.isArray(protections) || protections.length !== 0) fail('protections', 'protections are not implemented in the calibration CLI');
  if (!Array.isArray(s.path) || s.path.length < 2) fail('path', 'expected at least two coordinates');
  const path = s.path.map((point, i) => coordinate(point, `path[${i}]`));
  if (path.every(p => p[0] === path[0]![0] && p[1] === path[0]![1])) fail('path', 'must contain at least two distinct points');
  return {
    place_id: s.place_id, hazard: 'tornado',
    ef: integer(s.ef, 'ef', 0, 5), path,
    width_m: number(s.width_m, 'width_m', Number.MIN_VALUE),
    hour: integer(s.hour, 'hour', 0, 23),
    warning_min: number(s.warning_min, 'warning_min'),
    protections: [],
    runs: integer(s.runs ?? 500, 'runs', 1, Number.MAX_SAFE_INTEGER),
    seed: integer(s.seed ?? 42, 'seed', 0, 0xffffffff),
  };
}

export function parseBuildings(value: unknown): Building[] {
  if (!Array.isArray(value)) fail('buildings', 'expected an array');
  const ids = new Set<string>();
  let populationTotal = 0;
  for (const [i, raw] of value.entries()) {
    const at = `buildings[${i}]`;
    const b = record(raw, at);
    if (typeof b.id !== 'string' || b.id.length === 0) fail(`${at}.id`, 'expected a nonempty string');
    if (ids.has(b.id)) fail(`${at}.id`, `duplicate building id ${b.id}`);
    ids.add(b.id);
    coordinate([b.lon, b.lat], `${at}.lon_lat`);
    if (!BUILDING_CLASSES.includes(b.cls as Building['cls'])) fail(`${at}.cls`, 'unknown building class');
    if (typeof b.basement !== 'boolean') fail(`${at}.basement`, 'expected boolean');
    for (const key of ['pop_night_u65', 'pop_night_o65', 'pop_day_u65', 'pop_day_o65']) {
      populationTotal += number(b[key], `${at}.${key}`, 0, Number.MAX_SAFE_INTEGER);
    }
    if (populationTotal > Number.MAX_SAFE_INTEGER) fail('buildings', 'population exceeds numeric precision');
  }
  return value as Building[];
}
