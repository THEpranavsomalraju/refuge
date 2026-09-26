import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { building, fixture, params, scenario, simRoot, writeJson } from './helpers.mjs';
import { spawnSync } from 'node:child_process';

let core;
try { core = await import('../dist/core/index.js'); } catch { core = {}; }
const near = (actual, want, epsilon = 1e-9) => assert.ok(Math.abs(actual - want) < epsilon, `${actual} != ${want}`);
const config = () => JSON.parse(readFileSync(new URL('../params/protections.json', import.meta.url)));
const M_PER_DEG_LAT = 111195;
const room = (metersNorth, lon = -90) => ({ type: 'safe_room', lon, lat: 38 + metersNorth / M_PER_DEG_LAT });
// Helper MH: 3 people at night (2 under 65, 1 over), on the path centerline. Warning 10 min -> reach 321 m.
const storm = (protections, overrides = {}) => scenario({ warning_min: 10, protections, ...overrides });

test('a safe room in reach shelters the compliant share of mobile-home occupants', () => {
  assert.equal(typeof core.expected, 'function');
  const place = { buildings: [building()] };
  const base = core.expected(storm([]), place, params(), config());
  const with1 = core.expected(storm([room(111)]), place, params(), config());
  near(with1.expected_deaths, base.expected_deaths * 0.7);
  near(with1.sheltered, 0.9);
});

test('reach = walking speed x (warning - mobilization); rooms out of reach do nothing', () => {
  const place = { buildings: [building()] };
  const base = core.expected(storm([]), place, params(), config()).expected_deaths;
  near(core.expected(storm([room(445)]), place, params(), config()).expected_deaths, base);
  const short = storm([room(111)], { warning_min: 5 });
  near(core.expected(short, place, params(), config()).sheltered, 0);
  const long = storm([room(445)], { warning_min: 20 });
  near(core.expected(long, place, params(), config()).sheltered, 0.9);
});

test('capacity fills nearest homes first', () => {
  const c = config(); c.safe_room.capacity = 1;
  // Both on the path centerline (east of the room), so both are destroyed.
  const M_PER_DEG_LON = M_PER_DEG_LAT * Math.cos(38 * Math.PI / 180);
  const nearHome = building({ id: 'near', lon: -90 + 50 / M_PER_DEG_LON });
  const farHome = building({ id: 'far', lon: -90 + 250 / M_PER_DEG_LON });
  const r = core.simulateDetailed(storm([room(0)]), { buildings: [farHome, nearHome] }, params(), c);
  near(r.sheltered, 1);
  // near: 0.9 of 3 sheltered; far: the remaining 0.1.
  const baseNear = core.deathProb(nearHome, 4, storm([]), params());
  near(r.building_prob.near, baseNear * (1 - 0.3));
  near(r.building_prob.far, baseNear * (1 - 0.1 / 3));
});

test('two rooms never shelter the same person twice', () => {
  const r = core.expected(storm([room(100), room(-100)]), { buildings: [building()] }, params(), config());
  near(r.sheltered, 0.9);
});

test('only eligible classes use safe rooms', () => {
  const house = building({ cls: 'RES_WOOD' });
  const r = core.expected(storm([room(111)]), { buildings: [house] }, params(), config());
  near(r.sheltered, 0);
});

test('sheltered people stay counted in their home cell; its deaths drop', () => {
  const place = { buildings: [building({ pop_night_u65: 10, pop_night_o65: 0 })] };
  const before = core.simulateDetailed(storm([]), place, params(), config()).cells['8a2661c94807fff'];
  const after = core.simulateDetailed(storm([room(111)]), place, params(), config()).cells['8a2661c94807fff'];
  assert.equal(after.people, before.people);
  near(after.expected_deaths, before.expected_deaths * 0.7);
});

test('protections require the protections config', () => {
  assert.throws(() => core.expected(storm([room(111)]), { buildings: [building()] }, params()), /protections/);
});

function parkTown() {
  // Two mobile-home parks 2 km apart plus empty cells near and between them.
  const buildings = [];
  for (let i = 0; i < 20; i++) buildings.push(building({ id: `a${i}`, h3: 'A', lon: -90 + i * 0.0002, pop_night_u65: 3, pop_night_o65: 0 }));
  for (let i = 0; i < 10; i++) buildings.push(building({ id: `b${i}`, h3: 'B', lon: -89.977 + i * 0.0002, pop_night_u65: 3, pop_night_o65: 0 }));
  const cells = [
    { h3: 'A', center: [-89.998, 38] }, { h3: 'B', center: [-89.976, 38] },
    { h3: 'nearA', center: [-89.998, 38.001] }, { h3: 'nearA2', center: [-89.998, 38.0015] },
    { h3: 'nearB', center: [-89.976, 38.001] }, { h3: 'far', center: [-89.9, 38.2] },
  ];
  return { buildings, cells };
}

test('candidate sites are empty cells ranked by reachable eligible people, spaced apart', () => {
  const sites = core.safeRoomSites(parkTown(), storm([]), config());
  assert.deepEqual(sites.map(s => s.h3), ['nearA', 'nearB']);
  assert.ok(sites[0].reachable > sites[1].reachable);
});

test('optimizer tries every affordable plan and returns the best', () => {
  const town = parkTown();
  const s = scenario({ warning_min: 10, path: [[-90.01, 38], [-89.96, 38]] });
  const sites = core.safeRoomSites(town, s, config());
  const best = core.optimizeSafeRooms(s, town, params(), config(), sites, 225000);
  assert.equal(best.evaluated, 3); // {}, {nearA}, {nearB}
  assert.deepEqual(best.sites.map(x => x.h3), ['nearA']);
  const both = core.optimizeSafeRooms(s, town, params(), config(), sites, 450000);
  assert.equal(both.sites.length, 2);
  assert.ok(both.expected_deaths < best.expected_deaths);
  assert.ok(best.lives_saved > 0);
  near(best.lives_saved, best.baseline_deaths - best.expected_deaths);
  assert.equal(core.optimizeSafeRooms(s, town, params(), config(), sites, 0).sites.length, 0);
});

test('CLI accepts --protections for scenarios with safe rooms', () => {
  const f = fixture();
  writeJson(f.input, storm([room(111)]));
  const r = spawnSync(process.execPath, [join(simRoot, 'dist/cli.js'), '--scenario', f.input,
    '--places', join(f.root, 'places'), '--params', f.candidate, '--mode', 'expected',
    '--protections', join(simRoot, 'params/protections.json')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  near(JSON.parse(r.stdout).sheltered, 0.9);
});
