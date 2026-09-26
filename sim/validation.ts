import { BUILDING_CLASSES, type Building, type Crossing, type ProtectionConfig, type SafeRoom, type Scenario, type SimParams, type Coordinate } from './core/types.js';

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
  keys(p, ['schema_version', 'night_hours', 'lethality_multiplier', 'modifiers', 'wind', 'lethality_by_damage',
    'flood', 'vehicle', 'risk_bands', 'min_cell_people'], 'params');
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
  if (p.flood !== undefined) {
    const f = record(p.flood, 'flood');
    keys(f, ['damage_thresholds_m', 'story_height_m', 'lethality_by_damage'], 'flood');
    const depth = record(f.damage_thresholds_m, 'flood.damage_thresholds_m');
    keys(depth, BUILDING_CLASSES, 'flood.damage_thresholds_m');
    for (const cls of BUILDING_CLASSES) sequence(depth[cls], `flood.damage_thresholds_m.${cls}`, 4, 0, 100, true);
    number(f.story_height_m, 'flood.story_height_m', 0, 10);
    const fl = sequence(f.lethality_by_damage, 'flood.lethality_by_damage', 5, 0, 1, false);
    if (fl[0] !== 0) fail('flood.lethality_by_damage[0]', 'damage level 0 must have zero probability');
  }
  if (p.vehicle !== undefined) {
    const v = record(p.vehicle, 'vehicle');
    keys(v, ['exposure_hours', 'occupancy', 'attempt_prob', 'depth_thresholds_m', 'lethality_by_depth'], 'vehicle');
    number(v.exposure_hours, 'vehicle.exposure_hours', 0, 24);
    number(v.occupancy, 'vehicle.occupancy', 1, 10);
    number(v.attempt_prob, 'vehicle.attempt_prob', 0, 1);
    sequence(v.depth_thresholds_m, 'vehicle.depth_thresholds_m', 3, 0, 100, true);
    const vl = sequence(v.lethality_by_depth, 'vehicle.lethality_by_depth', 4, 0, 1, false);
    if (vl[0] !== 0) fail('vehicle.lethality_by_depth[0]', 'dry roads must have zero probability');
  }
  const bands = record(p.risk_bands, 'risk_bands');
  keys(bands, ['yellow', 'red', 'deep_red'], 'risk_bands');
  sequence([bands.yellow, bands.red, bands.deep_red], 'risk_bands', 3, Number.MIN_VALUE, 1, true);
  integer(p.min_cell_people, 'min_cell_people', 1, Number.MAX_SAFE_INTEGER);
  return p as unknown as SimParams;
}

export function parseScenario(value: unknown): Scenario {
  const s = record(value, 'scenario');
  if (typeof s.place_id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(s.place_id)) {
    fail('place_id', 'use a nonempty folder name with letters, digits, underscores or hyphens');
  }
  if (s.hazard !== 'tornado' && s.hazard !== 'flood') fail('hazard', 'expected "tornado" or "flood"');
  const raw = s.protections ?? [];
  if (!Array.isArray(raw)) fail('protections', 'expected an array');
  if (s.hazard === 'flood' && raw.length > 0) fail('protections', 'flood protections are not implemented yet');
  const protections: SafeRoom[] = raw.map((p, i) => {
    const r = record(p, `protections[${i}]`);
    if (r.type !== 'safe_room') fail(`protections[${i}].type`, 'only safe_room is implemented');
    const [lon, lat] = coordinate([r.lon, r.lat], `protections[${i}].lon_lat`);
    return { type: 'safe_room', lon, lat };
  });
  const common = {
    place_id: s.place_id,
    hour: integer(s.hour, 'hour', 0, 23),
    warning_min: number(s.warning_min, 'warning_min'),
    protections,
    runs: integer(s.runs ?? 500, 'runs', 1, Number.MAX_SAFE_INTEGER),
    seed: integer(s.seed ?? 42, 'seed', 0, 0xffffffff),
  };
  if (s.hazard === 'flood') {
    for (const key of ['ef', 'path', 'width_m']) {
      if (s[key] !== undefined && s[key] !== null) fail(key, 'must be null for a flood');
    }
    return { ...common, hazard: 'flood', flood_height_m: number(s.flood_height_m, 'flood_height_m', 0, 100) };
  }
  if (s.flood_height_m !== undefined && s.flood_height_m !== null) fail('flood_height_m', 'must be null for a tornado');
  if (!Array.isArray(s.path) || s.path.length < 2) fail('path', 'expected at least two coordinates');
  const path = s.path.map((point, i) => coordinate(point, `path[${i}]`));
  if (path.every(p => p[0] === path[0]![0] && p[1] === path[0]![1])) fail('path', 'must contain at least two distinct points');
  return { ...common, hazard: 'tornado', ef: integer(s.ef, 'ef', 0, 5), path,
    width_m: number(s.width_m, 'width_m', Number.MIN_VALUE) };
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

export function parseCrossings(value: unknown): Crossing[] {
  if (!Array.isArray(value)) fail('crossings', 'expected an array');
  for (const [i, raw] of value.entries()) {
    const at = `crossings[${i}]`;
    const c = record(raw, at);
    if (typeof c.id !== 'string' || c.id.length === 0) fail(`${at}.id`, 'expected a nonempty string');
    coordinate([c.lon, c.lat], `${at}.lon_lat`);
    if (c.hand_m !== null) number(c.hand_m, `${at}.hand_m`, -1000, 10000);
    if (c.cars_per_hour !== null) {
      if (!Array.isArray(c.cars_per_hour) || c.cars_per_hour.length !== 24) fail(`${at}.cars_per_hour`, 'expected 24 hourly values or null');
      c.cars_per_hour.forEach((n, h) => number(n, `${at}.cars_per_hour[${h}]`));
    }
  }
  return value as Crossing[];
}

export function parseProtectionConfig(value: unknown): ProtectionConfig {
  const c = record(value, 'protections');
  keys(c, ['schema_version', 'default_budget_usd', 'safe_room'], 'protections');
  if (c.schema_version !== 1) fail('protections.schema_version', 'expected 1');
  number(c.default_budget_usd, 'protections.default_budget_usd');
  const r = record(c.safe_room, 'protections.safe_room');
  keys(r, ['name', 'cost_usd', 'capacity', 'walk_speed_mps', 'mobilize_min', 'compliance', 'eligible_classes',
    'candidate_sites', 'site_spacing_reach'], 'protections.safe_room');
  if (typeof r.name !== 'string') fail('protections.safe_room.name', 'expected a string');
  number(r.cost_usd, 'protections.safe_room.cost_usd', Number.MIN_VALUE);
  number(r.capacity, 'protections.safe_room.capacity', 0);
  number(r.walk_speed_mps, 'protections.safe_room.walk_speed_mps', 0, 5);
  number(r.mobilize_min, 'protections.safe_room.mobilize_min', 0, 120);
  number(r.compliance, 'protections.safe_room.compliance', 0, 1);
  if (!Array.isArray(r.eligible_classes) || r.eligible_classes.some(x => !BUILDING_CLASSES.includes(x))) {
    fail('protections.safe_room.eligible_classes', 'expected building classes');
  }
  integer(r.candidate_sites, 'protections.safe_room.candidate_sites', 0, 16);
  number(r.site_spacing_reach, 'protections.safe_room.site_spacing_reach', 0, 100);
  return c as unknown as ProtectionConfig;
}
