import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

let core;
try { core = await import('../dist/core/index.js'); } catch { core = {}; }
const root = new URL('../../', import.meta.url);
const json = p => JSON.parse(readFileSync(new URL(p, root)));
const hp = json('sim/params/hurricane.json');
const params = json('sim/params/sim_params.json');
const windRef = json('ml/exports/hurricane_reference.json');
const damageRef = json('ml/exports/hurricane_damage_reference.json');
const mortality = json('ml/exports/hurricane_mortality.json');

test('hurricane constants match the ML exports', () => {
  assert.equal(hp.wind.land_factor, windRef.constants.LAND_FACTOR);
  assert.equal(hp.wind.gust_factor, windRef.constants.GUST_FACTOR);
  assert.equal(hp.wind.kt_to_mph, windRef.constants.KT_TO_MPH);
  assert.equal(hp.wind.step_h, windRef.constants.STEP_H);
  assert.equal(hp.wind.earth_radius_km, windRef.constants.earth_radius_km);
  assert.equal(hp.fragility_beta, damageRef.constants.BETA);
  assert.deepEqual(hp.residential_classes, damageRef.constants.residential_classes);
  assert.deepEqual(hp.cells.bands, damageRef.constants.bands);
  assert.equal(hp.cells.min_share, damageRef.constants.min_share_drawn);
  assert.equal(hp.cells.min_residents, damageRef.constants.min_residents);
  assert.deepEqual(hp.mortality, { a: mortality.engine.a, b_per_mph: mortality.engine.b_per_mph, class_factor: mortality.engine.class_factor });
  for (const [c, d] of Object.entries(windRef.category_defaults)) {
    assert.deepEqual(hp.category_defaults[c], { vmax_kt: d.vmax_kt, rmw_km: d.rmw_km, B: d.B });
  }
});

test('erf is accurate across its range', () => {
  for (const [x, want] of [[0, 0], [0.5, 0.5204998778130465], [1, 0.8427007929497149], [2.5, 0.9995930479825550],
    [3, 0.9999779095030014], [4, 0.9999999845827421], [-1, -0.8427007929497149]]) {
    assert.ok(Math.abs(core.erf(x) - want) < 1e-13, `erf(${x}) = ${core.erf(x)}`);
  }
});

test('max gust matches ml/hurricane_wind.py reference points to 0.01 mph', () => {
  for (const c of windRef.cases) {
    const g = core.maxGustMph(c.track, c.points.map(p => p[0]), c.points.map(p => p[1]), hp);
    c.max_gust_mph.forEach((want, i) => assert.ok(Math.abs(g[i] - want) < 0.01, `${c.name} point ${i}: ${g[i]} vs ${want}`));
  }
});

const lumberton = new URL('places/lumberton/buildings.json', root);
test('Lumberton hurricane cases match ml/hurricane_damage.py', { skip: !existsSync(lumberton) && 'places/lumberton missing' }, () => {
  const place = { buildings: JSON.parse(readFileSync(lumberton)) };
  const index = new Map(place.buildings.map((b, i) => [b.id, i]));
  for (const c of damageRef.cases.filter(x => x.name.startsWith('Lumberton'))) {
    const s = { place_id: 'lumberton', hazard: 'hurricane', track: c.track, hour: 7, protections: [] };
    const r = core.hurricaneBuildings(s, place, params, hp);
    for (const sb of c.sample_buildings) {
      const i = index.get(sb.id);
      assert.ok(Math.abs(r.gust[i] - sb.gust_mph) < 0.01, `${c.name} ${sb.id} gust ${r.gust[i]} vs ${sb.gust_mph}`);
      sb.p_level_ge.forEach((want, k) => assert.ok(Math.abs(r.p[i * 4 + k] - want) < 1e-4, `${c.name} ${sb.id} p${k} ${r.p[i * 4 + k]} vs ${want}`));
    }
    const out = core.hurricaneResult(s, place, params, hp);
    assert.equal(Math.round(out.residents), c.residents);
    assert.ok(Math.abs(out.displaced - c.displaced) < 0.1, `${c.name} displaced ${out.displaced} vs ${c.displaced}`);
    assert.ok(Math.abs(out.destroyed - c.destroyed) < 0.1, `${c.name} destroyed ${out.destroyed} vs ${c.destroyed}`);
    assert.ok(Math.abs(out.expected_deaths - c.expected_deaths) < 1e-4, `${c.name} deaths ${out.expected_deaths} vs ${c.expected_deaths}`);
    const counts = { low: 0, moderate: 0, severe: 0, extreme: 0, sparse: 0 };
    for (const cell of Object.values(out.cells)) counts[cell.band]++;
    assert.deepEqual(counts, c.band_counts);
    assert.equal(Object.keys(out.cells).length, c.cells_drawn);
  }
});

test('drawn tracks get category defaults and time from 20 km/h forward speed', () => {
  const t = core.trackFromDrawing([[-79, 34], [-79, 35]], 2, hp);
  assert.deepEqual(t[0], [-79, 34, 89, 37, 1.6, 0]);
  assert.ok(Math.abs(t[1][5] - 111.195 / 20) < 0.01);
});

test('a short drawn track is extended so the eyewall crosses the town', () => {
  const drawn = [[-79.06, 34.62], [-79.00, 34.67]];
  const calm = core.maxGustMph(core.trackFromDrawing(drawn, 2, hp), [-79.03], [34.645], hp)[0];
  const line = core.extendDrawnLine(drawn, hp.drawn_track_extension_km);
  assert.equal(line.length, 4);
  assert.deepEqual(line.slice(1, 3), drawn);
  const track = core.trackFromDrawing(line, 2, hp);
  assert.ok(Math.abs(track[1][5] - 150 / 20) < 0.05, `time at the drawn start ${track[1][5]}`);
  const gust = core.maxGustMph(track, [-79.03], [34.645], hp)[0];
  assert.ok(calm < 1 && gust > 90, `calm ${calm}, extended ${gust}`);
});
