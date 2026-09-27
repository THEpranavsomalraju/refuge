import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fixture, cli, batch, params, scenario, building, writeJson, classes, simRoot } from './helpers.mjs';

function setup(t, buildings) {
  const f = fixture(buildings);
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  return f;
}

test('expected CLI returns analytic totals and exposed occupants on a lightweight place', t => {
  const r = cli(setup(t));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  const out = JSON.parse(r.stdout);
  assert.equal(out.place_id, 'test');
  assert.ok(Math.abs(out.expected_deaths - 0.2625) < 1e-12);
  assert.equal(out.people_exposed, 3);
  assert.deepEqual(Object.keys(out.by_class).sort(), [...classes, 'VEHICLE'].sort());
  assert.equal(out.by_class.VEHICLE, 0);
  assert.deepEqual(Object.keys(out).sort(), ['by_class', 'expected_deaths', 'people_exposed', 'place_id']);
});

test('batch preserves input order and duplicates with CRLF and a terminal newline', t => {
  const r = batch(setup(t), [JSON.stringify(scenario({ hour: 12 })) + '\r', scenario(), scenario()]);
  assert.equal(r.status, 0, r.stderr);
  const rows = r.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map(r => r.people_exposed), [1, 3, 3]);
  assert.deepEqual(rows.map(r => r.place_id), ['test', 'test', 'test']);
  assert.equal(rows[0].expected_deaths, 0.05);
});

test('a later malformed record fails atomically with its line number', t => {
  const r = batch(setup(t), [scenario(), '{bad json']);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /line 2/i);
});

test('a later missing place fails atomically with place context', t => {
  const r = batch(setup(t), [scenario(), scenario({ place_id: 'missing' })]);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /missing.*buildings|buildings.*missing/i);
});

test('arbitrary absolute and relative params paths are loaded without editing defaults', t => {
  const f = setup(t);
  const defaultPath = join(simRoot, 'params/sim_params.default.json');
  const before = readFileSync(defaultPath, 'utf8');
  const p = params(); p.lethality_multiplier.MH = 2;
  writeJson(f.candidate, p);
  const r = cli(f);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(Math.abs(JSON.parse(r.stdout).expected_deaths - 0.525) < 1e-12);
  const relative = spawnSync(process.execPath, [join(simRoot, 'dist/cli.js'),
    '--scenario', 'scenario.json', '--places', 'places', '--params', 'candidate params.json', '--mode', 'expected'],
  { cwd: f.root, encoding: 'utf8' });
  assert.equal(relative.status, 0, relative.stderr);
  assert.equal(relative.stdout, r.stdout);
  assert.equal(readFileSync(defaultPath, 'utf8'), before);
});

test('simulate is reproducible and adds quantiles without changing analytic expectations', t => {
  const f = setup(t);
  const args = [join(simRoot, 'dist/cli.js'), '--scenario', f.input,
    '--places', join(f.root, 'places'), '--params', f.candidate, '--mode', 'simulate'];
  const a = spawnSync(process.execPath, args, { encoding: 'utf8' });
  const b = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(a.status, 0, a.stderr);
  assert.equal(a.stdout, b.stdout);
  const r = JSON.parse(a.stdout);
  assert.ok(Math.abs(r.expected_deaths - 0.2625) < 1e-12);
  assert.equal(r.p05, 0);
  assert.equal(r.p95, 1);
});

for (const [label, overrides, error] of [
  ['flood with tornado fields', { hazard: 'flood', flood_height_m: 3 }, /must be null for a flood/],
  ['protections', { protections: [{ type: 'shelter', building_id: 'synthetic_1' }] }, /protection/i],
  ['unknown hour', { hour: 24 }, /hour/],
  ['negative warning', { warning_min: -1 }, /warning_min/],
  ['invalid width', { width_m: 0 }, /width_m/],
  ['path traversal', { place_id: '../escape' }, /place_id/],
  ['one-point path', { path: [[-90, 38]] }, /path/],
  ['invalid coordinate', { path: [[-181, 38], [-90, 38]] }, /path/],
  ['zero runs', { runs: 0 }, /runs/],
]) {
  test(`CLI rejects ${label} without output`, t => {
    const f = setup(t); writeJson(f.input, scenario(overrides));
    const r = cli(f);
    assert.equal(r.status, 1); assert.equal(r.stdout, ''); assert.match(r.stderr, error);
  });
}

test('CLI rejects a multiplier outside agreed hard bounds with field context', t => {
  const f = setup(t); const p = params(); p.lethality_multiplier.MH = 20.01;
  writeJson(f.candidate, p);
  const r = cli(f);
  assert.equal(r.status, 1); assert.equal(r.stdout, '');
  assert.match(r.stderr, /lethality_multiplier.MH/);
});

test('missing, negative, or duplicate building data cannot quietly alter calibration', t => {
  const f = setup(t, [building(), building()]);
  let r = cli(f); assert.equal(r.status, 1); assert.match(r.stderr, /duplicate/i);
  writeJson(join(f.place, 'buildings.json'), [building({ pop_night_u65: -1 })]);
  r = cli(f); assert.equal(r.status, 1); assert.match(r.stderr, /pop_night_u65/);
  writeJson(join(f.place, 'buildings.json'), [building({ cls: 'RES4' })]);
  r = cli(f); assert.equal(r.status, 1); assert.match(r.stderr, /cls/);
});

test('empty buildings yield valid zero totals', t => {
  const r = cli(setup(t, [])); assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).expected_deaths, 0);
  assert.equal(JSON.parse(r.stdout).people_exposed, 0);
});

test('argument errors fail, while help succeeds', t => {
  const f = setup(t);
  for (const args of [['--unknown'], ['--mode', 'simulate'], ['--batch', 'x']]) {
    const r = cli(f, args); assert.equal(r.status, 1); assert.equal(r.stdout, '');
  }
  const help = spawnSync(process.execPath, [join(simRoot, 'dist/cli.js'), '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr); assert.match(help.stdout, /--params/);
});

test('CLI runs hurricane scenarios (totals only) and validates tracks', t => {
  const f = setup(t);
  const hurricane = { place_id: 'test', hazard: 'hurricane', hour: 13, protections: [],
    track: [[-90.3, 37.7, 125, 27, 1.9, 0], [-89.7, 38.3, 125, 27, 1.9, 4]] };
  writeJson(f.input, hurricane);
  for (const mode of ['expected', 'simulate']) {
    const r = spawnSync(process.execPath, [join(simRoot, 'dist/cli.js'), '--scenario', f.input,
      '--places', join(f.root, 'places'), '--params', f.candidate, '--mode', mode], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.hazard, 'hurricane'); assert.equal(out.place_id, 'test');
    assert.ok(out.displaced > 0 && out.destroyed > 0);
    assert.equal(out.cells, undefined);
  }
  writeJson(f.input, { ...hurricane, track: [[-90.3, 37.7, 125, 27, 1.9, 4], [-89.7, 38.3, 125, 27, 1.9, 0]] });
  const bad = cli(f);
  assert.equal(bad.status, 1); assert.equal(bad.stdout, ''); assert.match(bad.stderr, /time_h/);
});
