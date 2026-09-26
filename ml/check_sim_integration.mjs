/** Check ML parameters against the built Simulation engine and Structures outputs.
 * node ml/check_sim_integration.mjs --sim-root /path/to/sim --places /path/to/places
 * Missing real flood exposure is reported as blocked, not a successful accuracy check.
 */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({ options: {
  'sim-root': { type: 'string', default: join(root, 'sim') },
  places: { type: 'string', default: join(root, 'places') },
} });
const sim = resolve(values['sim-root']);
const placesRoot = resolve(values.places);
const read = p => JSON.parse(readFileSync(p, 'utf8'));
const { expected, simulate, simulateDetailed } = await import(pathToFileURL(join(sim, 'dist/core/index.js')));
const { parseParams, parseScenario, parseBuildings, parseCrossings } = await import(pathToFileURL(join(sim, 'dist/validation.js')));
const paramsPath = join(root, 'sim/params/sim_params.json');
const params = parseParams(read(paramsPath));
const defaults = read(join(sim, 'params/sim_params.default.json'));
for (const k of ['flood', 'vehicle']) assert.deepEqual(params[k], defaults[k], `${k}: uncalibrated blocks must match agreed defaults`);
const near = (a, b, message) => assert.ok(Math.abs(a - b) < 1e-8, `${message}: ${a} != ${b}`);
const report = { checked_at: new Date().toISOString(), sim_root: sim, places_root: placesRoot,
  historical: { train: 0, test: 0, mismatches: [] }, featured: [], synthetic_flood: null };

const catalog = read(join(root, 'ml/backtest/tornadoes.json')).tornadoes.filter(s => !s.excluded);
const saved = read(join(root, 'ml/exports/backtest.json'));
for (const s of catalog) {
  const scenario = parseScenario(read(join(root, 'data/backtest/scenarios', `${s.place_id}.json`)));
  const place = { buildings: parseBuildings(read(join(root, 'data/backtest/places', s.place_id, 'buildings.json'))) };
  assert.ok(Number.isFinite(expected(scenario, place, params).expected_deaths));
  report.historical[s.split]++;
  if (s.split === 'test') {
    const result = simulate(scenario, place, params);
    const stored = saved.storms.find(x => x.place_id === s.place_id).calibrated;
    if (Math.abs(result.expected_deaths - stored.expected) > 0.00051 || result.p05 !== stored.p05 || result.p95 !== stored.p95) {
      report.historical.mismatches.push(s.place_id);
    }
  }
}
assert.deepEqual(report.historical.mismatches, [], 'Tornado results changed beyond export rounding');

const flood = id => parseScenario({ place_id: id, hazard: 'flood', ef: null, path: null, width_m: null,
  flood_height_m: 4.5, hour: 2, warning_min: 30, protections: [], runs: 500, seed: 42 });
let exampleBuilding;
for (const id of ['morganton', 'lumberton', 'chapel_hill']) {
  const folder = join(placesRoot, id);
  const buildings = parseBuildings(read(join(folder, 'buildings.json')));
  const crossings = parseCrossings(read(join(folder, 'crossings.json')));
  const cells = read(join(folder, 'cells.json'));
  const metadata = read(join(folder, 'place.json'));
  const place = { buildings, crossings, cells };
  exampleBuilding ??= buildings[0];
  const [x0, y0, x1, y1] = metadata.bbox;
  // Lumberton uses Simulation's agreed demonstration path, not a historical track.
  const scenario = id === 'lumberton'
    ? parseScenario(read(join(sim, 'scenarios/lumberton_tornado.json')))
    : parseScenario({ place_id: id, hazard: 'tornado', ef: 3,
      path: [[x0, (y0 + y1) / 2], [x1, (y0 + y1) / 2]], width_m: 640.1,
      hour: 2, warning_min: 10, protections: [], runs: 500, seed: 42 });
  const tornado = simulateDetailed(scenario, place, params);
  near(Object.values(tornado.cells).reduce((sum, c) => sum + c.expected_deaths, 0), tornado.expected_deaths, `${id} tornado cell sum`);
  const f = simulateDetailed(flood(id), place, params);
  near(Object.values(f.cells).reduce((sum, c) => sum + c.expected_deaths, 0), f.expected_deaths, `${id} flood cell sum`);
  const missingBuildings = buildings.filter(b => b.hand_m == null).length;
  const missingCrossings = crossings.filter(c => c.hand_m == null || c.cars_per_hour == null).length;
  assert.deepEqual(f.no_flood_data, { buildings: missingBuildings, crossings: missingCrossings });
  const blockers = [];
  if (missingBuildings) blockers.push(`${missingBuildings} buildings missing HAND`);
  if (missingCrossings) blockers.push(`${missingCrossings} crossings missing HAND/traffic`);
  if (!crossings.length) blockers.push('no crossing exposure supplied; absence has not been validated');
  if (!metadata.streams?.length) blockers.push('no stream geometry supplied');
  report.featured.push({ place_id: id, buildings: buildings.length, crossings: crossings.length,
    tornado: { expected: tornado.expected_deaths, p05: tornado.p05, p95: tornado.p95 },
    flood: { expected: f.expected_deaths, no_flood_data: f.no_flood_data,
      vehicle_share: f.expected_deaths > 0 ? f.by_class.VEHICLE / f.expected_deaths : null,
      status: blockers.length ? 'blocked_on_exposure_data' : 'ready_for_geographic_review', blockers } });
}

// Exercise the public CLI with explicit synthetic exposure: verifies the ML file can drive
// both building and vehicle flooding. This fixture is not evidence about any real town.
const scratch = mkdtempSync(join(tmpdir(), 'refuge-ml-flood-'));
try {
  const folder = join(scratch, 'places/synthetic');
  mkdirSync(folder, { recursive: true });
  const house = { ...exampleBuilding, id: 'synthetic_house', cls: 'RES_WOOD', stories: 1,
    hand_m: 2, first_floor_ht_m: 0.6, basement: false, pop_night_u65: 6, pop_night_o65: 2 };
  const crossing = { id: 'synthetic_crossing', lon: house.lon, lat: house.lat, h3: house.h3,
    road_class: 'residential', road_elev_m: 0, hand_m: 0.8, cars_per_hour: Array(24).fill(10) };
  writeFileSync(join(folder, 'buildings.json'), JSON.stringify([house, { ...house, id: 'missing', hand_m: null }]));
  writeFileSync(join(folder, 'crossings.json'), JSON.stringify([crossing]));
  const scenarioPath = join(scratch, 'scenario.json');
  writeFileSync(scenarioPath, JSON.stringify(flood('synthetic')));
  const result = spawnSync(process.execPath, [join(sim, 'dist/cli.js'), '--scenario', scenarioPath,
    '--places', join(scratch, 'places'), '--params', paramsPath, '--mode', 'simulate'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const r = JSON.parse(result.stdout);
  assert.ok(r.by_class.RES_WOOD > 0 && r.by_class.VEHICLE > 0);
  assert.deepEqual(r.no_flood_data, { buildings: 1, crossings: 0 });
  const warning = Math.exp(-params.modifiers.warning_per_min * 30);
  const houseExpected = (6 + 2 * params.modifiers.over65) * 0.1 * params.modifiers.night * warning;
  const vehicleExpected = 10 * params.vehicle.exposure_hours * params.vehicle.occupancy
    * params.vehicle.attempt_prob * 0.3 * params.lethality_multiplier.VEHICLE * params.modifiers.night * warning;
  near(r.expected_deaths, houseExpected + vehicleExpected, 'Synthetic flood expectation');
  report.synthetic_flood = { status: 'passed', expected: r.expected_deaths, no_flood_data: r.no_flood_data };
} finally {
  rmSync(scratch, { recursive: true, force: true }); // only this run's private fixture
}
mkdirSync(join(root, 'ml/work'), { recursive: true });
writeFileSync(join(root, 'ml/work/sim_integration_check.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
