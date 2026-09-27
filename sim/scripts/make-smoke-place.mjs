import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { writeSyntheticPlace } from './synthetic-place.mjs';

const sim = fileURLToPath(new URL('../', import.meta.url));
const file = join(sim, 'tests/fixtures/bt_2021_996712.scenario.json');
const scenario = JSON.parse(readFileSync(file, 'utf8'));
const root = mkdtempSync(join(tmpdir(), 'refuge-smoke-'));
const places = join(root, 'places');
writeSyntheticPlace(places, scenario, 200);
const args = [join(sim, 'dist/cli.js'), '--scenario', file, '--places', places,
  '--params', join(sim, 'params/sim_params.default.json'), '--mode', 'simulate'];
const result = spawnSync(process.execPath, args, { encoding: 'utf8' });
assert.equal(result.status, 0, result.stderr);
const output = JSON.parse(result.stdout);
assert.equal(output.place_id, 'bt_2021_996712');
assert.ok(output.expected_deaths > 0 && output.people_exposed > 0);
assert.ok(output.p05 >= 0 && output.p05 <= output.p95);
console.log(`Historical training scenario; 200 SYNTHETIC buildings (not a backtest result).`);
console.log(`Place files retained for inspection: ${places}`);
console.log(`Rerun: node ${args.map(a => JSON.stringify(a)).join(' ')}`);
console.log(result.stdout.trim());
