import { fileURLToPath } from 'node:url';
import { expected, simulate } from './core/engine.js';
import { simulateHurricane } from './core/protections.js';
import type { HurricaneParams } from './core/hurricane.js';
import { loadPlaces, readJson, readScenarios } from './io.js';
import { parseHurricaneParams, parseParams, parseProtectionConfig } from './validation.js';
import type { ProtectionConfig } from './core/types.js';

const HELP = `Refuge simulation CLI (Node 22)
Usage: node sim/dist/cli.js (--batch FILE.jsonl | --scenario FILE.json)
       --places DIR --params FILE.json --mode expected|simulate
       [--protections FILE.json] [--hurricane FILE.json]

Paths are relative to the current working directory unless absolute.
JSONL results go to stdout in input order; errors go to stderr (exit 1).
Expected: place_id, expected_deaths, by_class, people_exposed.
Simulate: the same analytic fields plus p05 and p95 from seeded runs.
Flood scenarios (hazard "flood", flood_height_m) also return no_flood_data,
read crossings.json, and need the flood and vehicle blocks in --params.
Hurricane scenarios (hazard "hurricane", track rows [lon, lat, vmax_kt, rmw_km, B,
time_h]) return residents, displaced, destroyed, expected_deaths and by_class
(expected values in both modes; per-cell results are left out). Hurricane
constants default to sim/params/hurricane.json (override with --hurricane).
Scenarios may list shelters in protections; pass --protections
sim/params/protections.json for their capacity, reach, and compliance.
`;

async function main(args: string[]): Promise<void> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    process.stdout.write(HELP); return;
  }
  const options = new Map<string, string>();
  const allowed = ['--batch', '--scenario', '--places', '--params', '--mode', '--protections', '--hurricane'];
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i]!;
    if (!allowed.includes(name)) throw new Error(`unknown argument ${name}; use --help`);
    if (options.has(name)) throw new Error(`duplicate argument ${name}`);
    const value = args[i + 1];
    if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
    options.set(name, value);
  }
  if (options.has('--batch') === options.has('--scenario')) throw new Error('provide exactly one of --batch or --scenario');
  for (const name of ['--places', '--params', '--mode']) if (!options.has(name)) throw new Error(`missing ${name}`);
  const mode = options.get('--mode');
  if (mode !== 'expected' && mode !== 'simulate') throw new Error('--mode must be expected or simulate');
  const paramsPath = options.get('--params')!;
  let params;
  try { params = parseParams(await readJson(paramsPath)); }
  catch (error) { throw new Error(`${paramsPath}: ${error instanceof Error ? error.message : String(error)}`); }
  const protectionsPath = options.get('--protections');
  let protections: ProtectionConfig | undefined;
  if (protectionsPath) {
    try { protections = parseProtectionConfig(await readJson(protectionsPath)); }
    catch (error) { throw new Error(`${protectionsPath}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  let hurricane: HurricaneParams | undefined;
  const loadHurricane = async () => {
    const path = options.get('--hurricane') ?? fileURLToPath(new URL('../params/hurricane.json', import.meta.url));
    try { return parseHurricaneParams(await readJson(path)); }
    catch (error) { throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`); }
  };
  const scenarios = await readScenarios(options.get('--batch') ?? options.get('--scenario')!, options.has('--batch'));
  const places = await loadPlaces(options.get('--places')!, scenarios);
  if (scenarios.some(s => s.hazard === 'hurricane')) hurricane = await loadHurricane();
  // Buffer results until every record succeeds: no truncated calibration dataset.
  const results = scenarios.map(s => {
    try {
      if (s.hazard === 'hurricane') {
        const { cells: _cells, shelter_assignments: _who, ...totals } = simulateHurricane(s, places.get(s.place_id)!, params, hurricane!, protections);
        return totals;
      }
      return (mode === 'expected' ? expected : simulate)(s, places.get(s.place_id)!, params, protections);
    }
    catch (error) { throw new Error(`${s.place_id}: ${error instanceof Error ? error.message : String(error)}`); }
  });
  process.stdout.write(results.map(r => JSON.stringify(r)).join('\n') + '\n');
}

main(process.argv.slice(2)).catch(error => {
  process.stderr.write(`refuge-sim: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
