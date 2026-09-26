import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { building, fixture, params, simRoot, writeJson } from './helpers.mjs';

let core;
try { core = await import('../dist/core/index.js'); } catch { core = {}; }
let validation;
try { validation = await import('../dist/validation.js'); } catch { validation = {}; }
const near = (actual, want, epsilon = 1e-10) => assert.ok(Math.abs(actual - want) < epsilon, `${actual} != ${want}`);
const defaults = JSON.parse(readFileSync(new URL('../params/sim_params.default.json', import.meta.url)));

function floodParams() {
  const p = params();
  p.flood = structuredClone(defaults.flood);
  p.vehicle = structuredClone(defaults.vehicle);
  return p;
}
function flood(overrides = {}) {
  return { place_id: 'test', hazard: 'flood', ef: null, path: null, width_m: null,
    flood_height_m: 4, hour: 14, warning_min: 0, protections: [], runs: 500, seed: 42, ...overrides };
}
function crossing(overrides = {}) {
  return { id: 'x_1', lon: -90, lat: 38, h3: '8a2661c94807fff', road_class: 'residential',
    road_elev_m: 150, hand_m: 0.8, cars_per_hour: Array(24).fill(10), ...overrides };
}
// Daytime: 1 u65 occupant per building (helper default); first floor 0.6 m.
const house = (hand_m, overrides = {}) => building({ id: `h${hand_m}`, cls: 'RES_WOOD', hand_m, ...overrides });

test('a building on a hill has zero flood risk', () => {
  assert.equal(typeof core.expected, 'function');
  const r = core.expected(flood(), { buildings: [house(20)], crossings: [] }, floodParams());
  assert.equal(r.expected_deaths, 0);
  assert.equal(r.people_exposed, 0);
});

test('depth above first floor = flood height - hand_m - first floor height sets the level', () => {
  const p = floodParams();
  // RES_WOOD levels start at [0, 0.9, 1.5, 2.4] m above the first floor; lethality [0, 0, 0.0001, 0.10, 0.90].
  for (const [hand, want] of [[3.5, 0], [2.4, 0.0001], [1.8, 0.10], [0.9, 0.90]]) {
    const r = core.expected(flood(), { buildings: [house(hand)], crossings: [] }, p);
    near(r.expected_deaths, want);
  }
});

test('extra stories raise the compromised and chance levels; mobile homes do not', () => {
  const p = floodParams();
  // Depth above floor 2.8 m: chance for a one-story house, only level 2 for a two-story house.
  const one = core.expected(flood(), { buildings: [house(0.6)], crossings: [] }, p);
  const two = core.expected(flood(), { buildings: [house(0.6, { stories: 2 })], crossings: [] }, p);
  near(one.expected_deaths, 0.90);
  near(two.expected_deaths, 0.0001);
  // MH chance level starts at 0.3 m above the floor regardless of stories.
  const mh = core.expected(flood(), { buildings: [house(3.0, { cls: 'MH', stories: 2 })], crossings: [] }, p);
  near(mh.expected_deaths, 0.90);
});

test('flood ignores tornado class multipliers and basements but keeps night, warning, over65', () => {
  const p = floodParams();
  p.lethality_multiplier = { MH: 3, RES: 3, PUBLIC: 3, VEHICLE: 1 };
  const b = [house(1.8, { basement: true, pop_night_u65: 2, pop_night_o65: 1 })];
  near(core.expected(flood(), { buildings: b, crossings: [] }, p).expected_deaths, 0.10);
  const night = core.expected(flood({ hour: 2 }), { buildings: b, crossings: [] }, p);
  near(night.expected_deaths, 2 * 0.15 + 1 * 0.225);
  near(core.expected(flood({ warning_min: 10 }), { buildings: b, crossings: [] }, p).expected_deaths, 0.10 * Math.exp(-0.2));
});

test('null hand_m means no flood data, not zero height', () => {
  const r = core.expected(flood(), { buildings: [house(null)], crossings: [crossing({ hand_m: null })] }, floodParams());
  assert.equal(r.expected_deaths, 0);
  assert.deepEqual(r.no_flood_data, { buildings: 1, crossings: 1 });
});

test('drivers at a crossing: cars x hours x occupancy, attempt x lethality by depth over road', () => {
  const p = floodParams();
  const v = p.vehicle;
  const people = 10 * v.exposure_hours * v.occupancy;
  for (const [height, level] of [[0.9, 0], [1.0, 1], [1.2, 2], [1.5, 3]]) {
    const r = core.expected(flood({ flood_height_m: height }), { buildings: [], crossings: [crossing()] }, p);
    near(r.by_class.VEHICLE, people * v.attempt_prob * v.lethality_by_depth[level]);
    near(r.expected_deaths, r.by_class.VEHICLE);
  }
  p.lethality_multiplier.VEHICLE = 2;
  const doubled = core.expected(flood({ flood_height_m: 1.5 }), { buildings: [], crossings: [crossing()] }, p);
  near(doubled.by_class.VEHICLE, people * v.attempt_prob * v.lethality_by_depth[3] * 2);
});

test('flood simulate is seeded and cells count drivers', () => {
  const place = { buildings: [house(1.8, { pop_day_u65: 6 })], crossings: [crossing()], cells: [{ h3: '8a2661c94807fff' }] };
  const s = flood({ flood_height_m: 4 });
  const a = core.simulate(s, place, floodParams());
  assert.deepEqual(core.simulate(s, place, floodParams()), a);
  const d = core.simulateDetailed(s, place, floodParams());
  assert.equal(d.p05, a.p05); assert.equal(d.p95, a.p95);
  const cell = d.cells['8a2661c94807fff'];
  near(cell.people, 6 + 10 * floodParams().vehicle.occupancy);
  near(cell.expected_deaths, d.expected_deaths);
  assert.equal(cell.drivers[0], 'VEHICLE');
  assert.ok(cell.drivers.includes('crossing_traffic'));
  assert.ok(cell.drivers.includes('flood_depth'));
  assert.ok(!cell.drivers.includes('no_basement'));
});

test('flood scenarios need flood params; tornado params files without them still load', () => {
  const p = params();
  assert.doesNotThrow(() => validation.parseParams(p));
  assert.throws(() => core.expected(flood(), { buildings: [house(1)], crossings: [] }, p), /flood/);
  const bad = floodParams(); bad.vehicle.attempt_prob = 2;
  assert.throws(() => validation.parseParams(bad), /attempt_prob/);
});

test('flood scenario validation', () => {
  const ok = validation.parseScenario(flood());
  assert.equal(ok.hazard, 'flood'); assert.equal(ok.flood_height_m, 4);
  assert.throws(() => validation.parseScenario(flood({ flood_height_m: null })), /flood_height_m/);
  assert.throws(() => validation.parseScenario(flood({ path: [[0, 0], [1, 1]] })), /path/);
});

test('CLI runs a flood batch and reads crossings.json', () => {
  const f = fixture([house(1.8), house(null, { id: 'nodata' })]);
  writeJson(join(f.place, 'crossings.json'), [crossing()]);
  writeJson(f.candidate, floodParams());
  writeJson(f.input, flood());
  const r = spawnSync(process.execPath, [join(simRoot, 'dist/cli.js'), '--scenario', f.input,
    '--places', join(f.root, 'places'), '--params', f.candidate, '--mode', 'simulate'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.no_flood_data, { buildings: 1, crossings: 0 });
  assert.ok(out.by_class.VEHICLE > 0);
  assert.ok(out.p95 >= out.p05);
});
