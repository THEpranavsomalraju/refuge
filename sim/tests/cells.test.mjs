import test from 'node:test';
import assert from 'node:assert/strict';
import { building, scenario, params } from './helpers.mjs';

let core;
try { core = await import('../dist/core/index.js'); } catch { core = {}; }
const near = (actual, want, epsilon = 1e-10) => assert.ok(Math.abs(actual - want) < epsilon, `${actual} != ${want}`);

const CENTER = '8a2661c94807fff';
const EDGE = '8a2661c94817fff';
const EMPTY = '8a2661c94827fff';
// About 190 m north of the path centerline, just inside the 200 m half-width.
const edgeLat = 38 + 190 / 111195;

function town() {
  return {
    buildings: [
      building({ id: 'mh_center', h3: CENTER, pop_night_u65: 6, pop_night_o65: 1 }),
      building({ id: 'mh_center_2', h3: CENTER, lon: -89.9995, pop_night_u65: 4, pop_night_o65: 0 }),
      building({ id: 'masonry_edge', h3: EDGE, lat: edgeLat, cls: 'RES_MASONRY', basement: true,
        pop_night_u65: 5, pop_night_o65: 1 }),
    ],
    cells: [{ h3: CENTER }, { h3: EDGE }, { h3: EMPTY }],
  };
}

test('simulateDetailed matches simulate totals and adds cells and building_prob', () => {
  assert.equal(typeof core.simulateDetailed, 'function', 'simulateDetailed() is implemented');
  const s = scenario(); const p = params(); const place = town();
  const plain = core.simulate(s, place, p);
  const detailed = core.simulateDetailed(s, place, p);
  for (const key of ['expected_deaths', 'p05', 'p95', 'people_exposed']) assert.equal(detailed[key], plain[key]);
  // Unaffected cells (zero expected deaths) are omitted from tornado results.
  assert.deepEqual(Object.keys(detailed.cells), [CENTER]);
  assert.ok(detailed.building_prob.mh_center > 0);
  assert.equal(detailed.building_prob.masonry_edge, undefined, 'undamaged buildings are omitted');
});

test('mobile homes at the center of an EF3 at night are high risk', () => {
  const cell = core.simulateDetailed(scenario(), town(), params()).cells[CENTER];
  assert.equal(cell.people, 11);
  assert.ok(cell.risk > 0.01, `risk ${cell.risk}`);
  assert.equal(cell.band, 'red');
  assert.deepEqual(cell.drivers, ['MH', 'no_basement', 'night']);
});

test('a masonry house with a basement at the path edge has no risk; its cell is omitted', () => {
  const r = core.simulateDetailed(scenario(), town(), params());
  assert.equal(r.cells[EDGE], undefined);
  assert.equal(r.building_prob.masonry_edge, undefined);
});

test('cells with nobody are omitted; affected cells under min_cell_people are sparse', () => {
  const place = town();
  place.buildings.push(building({ id: 'tiny', h3: '8a2661c94837fff', pop_night_u65: 2, pop_night_o65: 0 }));
  const cells = core.simulateDetailed(scenario(), place, params()).cells;
  assert.equal(cells[EMPTY], undefined);
  assert.equal(cells['8a2661c94837fff'].band, 'sparse');
});

test('day hour uses daytime population', () => {
  const cell = core.simulateDetailed(scenario({ hour: 14 }), town(), params()).cells[CENTER];
  assert.equal(cell.people, 2); // pop_day_u65 1 per MH, pop_day_o65 0
  assert.equal(cell.band, 'sparse');
});

test('cell expected deaths sum to the town total', () => {
  const place = town();
  for (let i = 0; i < 20; i++) {
    place.buildings.push(building({ id: `b${i}`, h3: `8a2661c948${(i % 4) + 4}7fff`,
      lon: -90 + i * 0.0001, lat: 38 + (i % 3) * 0.0005, cls: i % 2 ? 'RES_WOOD' : 'MH', basement: i % 3 === 0 }));
  }
  const r = core.simulateDetailed(scenario({ ef: 4 }), place, params());
  const sum = Object.values(r.cells).reduce((a, c) => a + c.expected_deaths, 0);
  near(sum, r.expected_deaths, 1e-9);
  for (const c of Object.values(r.cells)) assert.ok(c.p05 <= c.p95);
});

test('uncertain flags cells whose p05 and p95 risk fall in different bands', () => {
  const runs = new Map([[CENTER, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5]]]);
  const place = { buildings: [building({ h3: CENTER, pop_night_u65: 10, pop_night_o65: 0 })] };
  const s = scenario({ runs: 20 });
  const cells = core.aggregateCells(runs, place, s, params());
  assert.equal(cells[CENTER].p05, 0);
  assert.equal(cells[CENTER].p95, 0);
  assert.equal(cells[CENTER].uncertain, false);
  // p05 and p95 both 1 death / 10 people = deep_red at the lower edge: same band.
  runs.set(CENTER, [...Array(19).fill(1), 5]);
  const again = core.aggregateCells(runs, place, s, params());
  assert.equal(again[CENTER].p05, 1);
  assert.equal(again[CENTER].uncertain, false);
  // With 20 runs, p05 is the lowest run and p95 the 19th: 0 (green) vs 1 (deep_red).
  runs.set(CENTER, [0, ...Array(18).fill(1), 5]);
  const wide = core.aggregateCells(runs, place, s, params());
  assert.equal(wide[CENTER].p05, 0);
  assert.equal(wide[CENTER].p95, 1);
  assert.equal(wide[CENTER].uncertain, true);
});

test('drivers skip night by day and no_basement when most deaths have basements', () => {
  const place = { buildings: [building({ h3: CENTER, basement: true, pop_day_u65: 10, pop_day_o65: 0 })] };
  const cell = core.simulateDetailed(scenario({ hour: 14 }), place, params()).cells[CENTER];
  assert.deepEqual(cell.drivers, ['MH']);
});

test('diffCells reports after minus before for every cell in either result', () => {
  assert.equal(typeof core.diffCells, 'function', 'diffCells() is implemented');
  const before = { A: { people: 10, expected_deaths: 2, risk: 0.2 }, B: { people: 4, expected_deaths: 1, risk: 0.25 } };
  const after = { A: { people: 10, expected_deaths: 0.5, risk: 0.05 }, C: { people: 3, expected_deaths: 0, risk: 0 } };
  assert.deepEqual(core.diffCells(before, after), {
    A: { delta_expected_deaths: -1.5, delta_risk: -0.15000000000000002 },
    B: { delta_expected_deaths: -1, delta_risk: -0.25 },
    C: { delta_expected_deaths: 0, delta_risk: 0 },
  });
});

test('detailed mode requires an h3 cell on every building', () => {
  const place = { buildings: [building({ h3: undefined })] };
  assert.throws(() => core.simulateDetailed(scenario(), place, params()), /h3/);
});
