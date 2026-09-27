import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, cpus, platform, arch } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { writeSyntheticPlace } from './synthetic-place.mjs';

const sim = fileURLToPath(new URL('../', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'refuge-benchmark-'));
try {
  const scenario = JSON.parse(readFileSync(join(sim, 'tests/fixtures/bt_2021_996712.scenario.json'), 'utf8'));
  const scenarios = Array.from({ length: 50 }, (_, i) => ({ ...scenario, place_id: `bench_${i}`, hour: i % 24 }));
  const places = join(root, 'places');
  for (const s of scenarios) writeSyntheticPlace(places, s, 3000);
  const batch = join(root, 'scenarios.jsonl');
  writeFileSync(batch, scenarios.map(s => JSON.stringify(s)).join('\n') + '\n');
  const start = performance.now();
  const result = spawnSync(process.execPath, [join(sim, 'dist/cli.js'), '--batch', batch,
    '--places', places, '--params', join(sim, 'params/sim_params.default.json'), '--mode', 'expected'],
  { encoding: 'utf8' });
  const elapsed = performance.now() - start;
  assert.equal(result.status, 0, result.stderr);
  const rows = result.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 50);
  assert.deepEqual(rows.map(r => r.place_id), scenarios.map(s => s.place_id));
  assert.ok(rows.every(r => r.people_exposed > 0 && r.expected_deaths > 0 && !('p05' in r)));
  console.log(JSON.stringify({ node: process.version, platform: platform(), arch: arch(),
    cpu: cpus()[0]?.model, scenarios: 50, distinct_places: 50, buildings_per_place: 3000,
    elapsed_ms: Math.round(elapsed), target_ms: 3000, met_target: elapsed < 3000,
    includes: 'new process, parameter/place reads, validation, computation, stdout; excludes fixture generation; OS cache not cleared',
  }, null, 2));
  if (elapsed >= 3000) process.exitCode = 1;
} finally {
  // Only this script's fresh, private temporary fixture directory is removed.
  rmSync(root, { recursive: true, force: true });
}
