import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { building, fixture, params, scenario, simRoot, writeJson } from './helpers.mjs';

let core;
try { core = await import('../dist/core/index.js'); } catch { core = {}; }
const near = (actual, want, epsilon = 1e-9) => assert.ok(Math.abs(actual - want) < epsilon, `${actual} != ${want}`);
const config = () => JSON.parse(readFileSync(new URL('../params/protections.json', import.meta.url)));
const M_PER_DEG_LAT = 111195;
const M_PER_DEG_LON = M_PER_DEG_LAT * Math.cos(38 * Math.PI / 180);
// A shop 111 m north of the path centerline (inside the 400 m path), 4,000 sq ft -> capacity 200.
const shop = (overrides = {}) => building({ id: 'shop', cls: 'COMMERCIAL', lat: 38 + 111 / M_PER_DEG_LAT,
  footprint_sqft: 4000, pop_night_u65: 4, pop_night_o65: 0, ...overrides });
const shelter = id => ({ type: 'shelter', building_id: id });
// Helper MH: 3 people at night on the centerline. Warning 10 min -> reach 321 m.
const storm = (protections, overrides = {}) => scenario({ warning_min: 10, protections, ...overrides });

test('capacity and cost follow the footprint, clamped', () => {
  const c = config();
  assert.equal(core.shelterCapacity(shop(), c, 'tornado'), 200);
  assert.equal(core.shelterCapacity(shop({ footprint_sqft: 100 }), c, 'tornado'), 50);
  assert.equal(core.shelterCapacity(shop({ footprint_sqft: 1e6 }), c, 'tornado'), 1000);
  assert.equal(core.shelterCapacity(shop(), c, 'hurricane'), 50);
  assert.equal(core.shelterCost(200, c, 'tornado'), 300000);
  assert.equal(core.shelterCapacity(shop({ cls: 'RES_WOOD' }), c, 'tornado'), null);
  assert.equal(core.shelterCapacity(shop({ footprint_sqft: null }), c, 'tornado'), null);
});

test('a shelter takes its own occupants, then 30% of mobile-home residents in reach', () => {
  const place = { buildings: [building(), shop()] };
  const base = core.expected(storm([]), place, params(), config());
  const r = core.expected(storm([shelter('shop')]), place, params(), config());
  near(r.sheltered, 4 + 0.9);
  near(r.by_class.COMMERCIAL, 0);
  near(r.by_class.MH, base.by_class.MH * 0.7);
});

test('capacity fills nearest first and nobody is sheltered twice', () => {
  const c = config(); c.shelter.tornado.capacity_min = 5; c.shelter.tornado.capacity_max = 5;
  const nearHome = building({ id: 'near', lon: -90 + 50 / M_PER_DEG_LON });
  const farHome = building({ id: 'far', lon: -90 + 250 / M_PER_DEG_LON });
  const place = { buildings: [farHome, nearHome, shop({ lon: -90 })] };
  const r = core.simulateDetailed(storm([shelter('shop')]), place, params(), c);
  // 4 own occupants, then 0.9 from the nearer home, then 0.1 from the farther one.
  near(r.sheltered, 5);
  const byHome = Object.fromEntries(r.shelter_assignments.map(a => [a.building_id, a.people]));
  near(byHome.shop, 4); near(byHome.near, 0.9); near(byHome.far, 0.1);
  const two = { buildings: [building(), shop(), shop({ id: 'shop2', lat: 38 - 111 / M_PER_DEG_LAT })] };
  const both = core.expected(storm([shelter('shop'), shelter('shop2')]), two, params(), config());
  near(both.sheltered, 4 + 4 + 0.9);
});

test('ineligible or unknown buildings are rejected', () => {
  const place = { buildings: [building(), shop({ footprint_sqft: null })] };
  assert.throws(() => core.expected(storm([shelter('shop')]), place, params(), config()), /cannot be a shelter/);
  assert.throws(() => core.expected(storm([shelter('nope')]), place, params(), config()), /unknown building/);
  assert.throws(() => core.expected(storm([shelter('shop')]), place, params()), /protections/);
});

test('sheltered people stay counted in their home cell; its deaths drop', () => {
  const place = { buildings: [building({ pop_night_u65: 10, pop_night_o65: 0 }), shop({ h3: 'shopcell' })] };
  const before = core.simulateDetailed(storm([]), place, params(), config()).cells['8a2661c94807fff'];
  const after = core.simulateDetailed(storm([shelter('shop')]), place, params(), config()).cells['8a2661c94807fff'];
  assert.equal(after.people, before.people);
  near(after.expected_deaths, before.expected_deaths * 0.7);
});

function parkTown() {
  // Mobile homes along the path, plus shops of different sizes and distances.
  const buildings = [];
  for (let i = 0; i < 40; i++) buildings.push(building({ id: `mh${i}`, lon: -90 + i * 0.0003, pop_night_u65: 3, pop_night_o65: 0 }));
  const shops = [[-89.998, 900], [-89.994, 400], [-89.990, 12000], [-89.97, 5000], [-89.9895, 300]];
  shops.forEach(([lon, f], i) => buildings.push(shop({ id: `s${i}`, lon, footprint_sqft: f, pop_night_u65: 0 })));
  return { buildings };
}

test('effectiveness is exactly the lives saved by that building alone', () => {
  const town = parkTown(); const s = storm([]);
  const base = core.expected(s, town, params(), config()).expected_deaths;
  const cands = core.shelterCandidates(s, town, params(), config());
  assert.equal(cands.length, 5);
  for (let i = 1; i < cands.length; i++) assert.ok(cands[i - 1].effectiveness >= cands[i].effectiveness);
  for (const c of cands) {
    const alone = core.expected(storm([shelter(c.building_id)]), town, params(), config()).expected_deaths;
    near(c.effectiveness, base - alone);
    assert.equal(c.cost_usd, c.capacity * 1500);
  }
  assert.ok(cands[0].mh_homes_in_reach > 0 && cands[0].people_in_reach > 0);
});

test('optimizer searches every affordable subset and its value matches the engine', () => {
  const town = parkTown(); const s = storm([]);
  const plan = core.optimizeShelters(s, town, params(), config(), 200000);
  assert.equal(plan.method, 'exhaustive'); assert.equal(plan.label, 'best');
  assert.ok(plan.cost_usd <= 200000);
  const check = core.expected(storm(plan.building_ids.map(shelter)), town, params(), config());
  near(plan.expected_deaths, check.expected_deaths);
  near(plan.value, plan.baseline_deaths - check.expected_deaths);
  // Brute force over all affordable plans agrees.
  const cands = core.shelterCandidates(s, town, params(), config());
  let bestV = 0;
  for (let m = 0; m < 1 << cands.length; m++) {
    const pick = cands.filter((_, i) => m & (1 << i));
    if (pick.reduce((a, c) => a + c.cost_usd, 0) > 200000) continue;
    const v = plan.baseline_deaths - core.expected(storm(pick.map(c => shelter(c.building_id))), town, params(), config()).expected_deaths;
    bestV = Math.max(bestV, v);
  }
  near(plan.value, bestV, 1e-9);
  assert.equal(core.optimizeShelters(s, town, params(), config(), 0).building_ids.length, 0);
});

test('user selections join the candidates; large sets use greedy and say "best found"', () => {
  const town = parkTown(); const c = config();
  c.optimizer.top_candidates = 2;
  const plan = core.optimizeShelters(storm([]), town, params(), c, 1e7, ['s3']);
  assert.ok(plan.candidates.includes('s3'));
  assert.equal(plan.candidates.length, 3);
  c.optimizer.exhaustive_max = 1;
  const greedy = core.optimizeShelters(storm([]), town, params(), c, 1e7);
  assert.equal(greedy.method, 'greedy'); assert.equal(greedy.label, 'best found');
  assert.ok(greedy.value > 0);
});

test('CLI accepts --protections for scenarios with shelters', () => {
  const f = fixture([building(), shop()]);
  writeJson(f.input, storm([shelter('shop')]));
  const r = spawnSync(process.execPath, [join(simRoot, 'dist/cli.js'), '--scenario', f.input,
    '--places', join(f.root, 'places'), '--params', f.candidate, '--mode', 'expected',
    '--protections', join(simRoot, 'params/protections.json')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  near(JSON.parse(r.stdout).sheltered, 4.9);
});
