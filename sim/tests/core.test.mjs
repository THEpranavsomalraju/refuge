import test from 'node:test';
import assert from 'node:assert/strict';
import { building, scenario, params, classes } from './helpers.mjs';

// Dynamic loading keeps an absent implementation an explicit test assertion.
let core;
try { core = await import('../dist/core/index.js'); } catch { core = {}; }
let validation;
try { validation = await import('../dist/validation.js'); } catch { validation = {}; }
const near = (actual, want, epsilon = 1e-10) => assert.ok(Math.abs(actual - want) < epsilon, `${actual} != ${want}`);
const place = (...buildings) => ({ buildings });

test('night boundaries change both population and probability', () => {
  assert.equal(typeof core.expected, 'function', 'expected() is implemented');
  for (const [hour, deaths, people] of [[19, 0.05, 1], [20, 0.2625, 3], [5, 0.2625, 3], [6, 0.05, 1]]) {
    const r = core.expected(scenario({ hour }), place(building()), params());
    near(r.expected_deaths, deaths); assert.equal(r.people_exposed, people);
  }
});

test('warning and basement affect lethality, not exposed population', () => {
  const base = core.expected(scenario(), place(building()), params());
  const basement = core.expected(scenario(), place(building({ basement: true })), params());
  const warning = core.expected(scenario({ warning_min: 10 }), place(building()), params());
  near(basement.expected_deaths, 0.065625);
  near(warning.expected_deaths, 0.21491682268297025);
  assert.equal(warning.people_exposed, base.people_exposed);
  assert.equal(basement.people_exposed, base.people_exposed);
});

test('calibration multipliers affect only their class group; OTHER stays fixed', () => {
  const b = classes.map(cls => building({ id: cls, cls }));
  const p = params();
  const before = core.expected(scenario({ ef: 5 }), place(...b), p);
  p.lethality_multiplier.RES = 2;
  p.lethality_multiplier.PUBLIC = 3;
  p.lethality_multiplier.VEHICLE = 20;
  const after = core.expected(scenario({ ef: 5 }), place(...b), p);
  for (const cls of ['RES_WOOD', 'RES_MASONRY', 'MULTI']) near(after.by_class[cls], before.by_class[cls] * 2);
  for (const cls of ['SCHOOL', 'WORSHIP', 'COMMERCIAL', 'BIGROOF']) near(after.by_class[cls], before.by_class[cls] * 3);
  near(after.by_class.OTHER, before.by_class.OTHER);
  near(after.by_class.MH, before.by_class.MH);
  assert.equal(after.by_class.VEHICLE, 0);
  near(Object.values(after.by_class).reduce((a, b) => a + b, 0), after.expected_deaths);
});

test('age-group probabilities clamp separately before expected deaths are summed', () => {
  const p = params(); p.lethality_multiplier.MH = 10;
  p.modifiers.night = 1; p.modifiers.over65 = 3;
  const r = core.expected(scenario(), place(building({ pop_night_u65: 1, pop_night_o65: 1 })), p);
  near(r.expected_deaths, 1.5); // under65 = 0.5; over65 = clamp(1.5) = 1
});

test('damage-positive exposure excludes buildings outside the finite path', () => {
  const s = scenario({ path: [[0, 0], [0.01, 0]], width_m: 400 });
  const on = building({ lon: 0.005, lat: 0 });
  const far = building({ id: 'far', lon: 0.02, lat: 0 });
  const edge = building({ id: 'edge', lon: 0.005, lat: 0.002 });
  const r = core.expected(s, place(on, far, edge), params());
  near(r.expected_deaths, 0.2625); assert.equal(r.people_exposed, 3);
});

test('intensity follows every polyline segment and uses half the total width', () => {
  const p = params();
  const s = scenario({ path: [[0, 0], [0.01, 0], [0.01, 0.01]], width_m: 400 });
  near(core.intensityAt(building({ lon: 0.01, lat: 0.005 }), s, p), 150.5, 1e-6);
  const hundredMeters = 100 / 6371008.8 * 180 / Math.PI;
  near(core.intensityAt(building({ lon: 0.005, lat: hundredMeters }), s, p), 75.25, 1e-5);
  assert.equal(core.damageLevel('MH', 61, p), 1);
  assert.equal(core.damageLevel('MH', 60.999, p), 0);
  assert.equal(core.damageLevel('MH', 127, p), 4);
});

test('geometry handles dateline crossings, duplicate vertices, and reversed paths', () => {
  const b = building({ lon: 180, lat: 0 }); const p = params();
  const s = scenario({ path: [[179.99, 0], [179.99, 0], [-179.99, 0]] });
  near(core.intensityAt(b, s, p), 150.5, 1e-6);
  near(core.intensityAt(b, { ...s, path: [...s.path].reverse() }, p), 150.5, 1e-6);
});

test('simulate returns exact zero for an empty place and preserves deterministic expectation', () => {
  const r = core.simulate(scenario(), place(), params());
  assert.equal(r.expected_deaths, 0); assert.equal(r.p05, 0); assert.equal(r.p95, 0);
  assert.equal(r.people_exposed, 0);
  const a = core.simulate(scenario(), place(building()), params());
  assert.deepEqual(a, core.simulate(scenario(), place(building()), params()));
  near(a.expected_deaths, core.expected(scenario(), place(building()), params()).expected_deaths);
});

test('fractional sampling has integer outcomes and the intended expectation', () => {
  const random = core.seededRandom(42);
  let sum = 0;
  for (let i = 0; i < 20000; i++) {
    const n = core.sampleDeaths(2.5, 0.2, random);
    assert.ok(Number.isInteger(n) && n >= 0 && n <= 3);
    sum += n;
  }
  near(sum / 20000, 0.5, 0.015);
  assert.equal(core.sampleDeaths(5, 0, random), 0);
  assert.equal(core.sampleDeaths(5, 1, random), 5);
  assert.equal(core.nearestRank([0, 1, 2, 3], 0.05), 0);
  assert.equal(core.nearestRank([0, 1, 2, 3], 0.95), 3);
});

test('validation enforces all hard bounds inclusively', () => {
  for (const [section, key, low, high] of [
    ...['MH', 'RES', 'PUBLIC', 'VEHICLE'].map(c => ['lethality_multiplier', c, 0.05, 20]),
    ['modifiers', 'night', 1, 4], ['modifiers', 'basement', 0.05, 1],
    ['modifiers', 'warning_per_min', 0, 0.1], ['modifiers', 'over65', 1, 3],
  ]) {
    for (const v of [low, high]) { const p = params(); p[section][key] = v; validation.parseParams(p); }
    for (const v of [low - 0.001, high + 0.001, NaN, Infinity, '1']) {
      const p = params(); p[section][key] = v;
      assert.throws(() => validation.parseParams(p), new RegExp(key));
    }
  }
});

test('validation rejects wrong night hours, nonmonotone curves, and malformed population', () => {
  let p = params(); p.night_hours = [18, 19, 20];
  assert.throws(() => validation.parseParams(p), /night_hours/);
  p = params(); p.wind.damage_thresholds_mph.MH = [61, 60, 100, 127];
  assert.throws(() => validation.parseParams(p), /MH/);
  p = params(); p.lethality_by_damage.MH = [0.1, 0.2, 0.3, 0.4, 0.5];
  assert.throws(() => validation.parseParams(p), /MH/);
  p = params(); p.lethality_by_damage.MH = [0, 0.2, 0.1, 0.4, 0.5];
  assert.throws(() => validation.parseParams(p), /MH/);
  assert.throws(() => validation.parseBuildings([building({ pop_day_o65: undefined })]), /pop_day_o65/);
});
