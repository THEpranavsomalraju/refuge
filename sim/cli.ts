import { expected, simulate } from './core/engine.js';
import { loadPlaces, readJson, readScenarios } from './io.js';
import { parseParams } from './validation.js';

const HELP = `Refuge tornado calibration CLI (Node 22)
Usage: node sim/dist/cli.js (--batch FILE.jsonl | --scenario FILE.json)
       --places DIR --params FILE.json --mode expected|simulate

Paths are relative to the current working directory unless absolute.
JSONL results go to stdout in input order; errors go to stderr (exit 1).
Expected: place_id, expected_deaths, by_class, people_exposed.
Simulate: the same analytic fields plus p05 and p95 from seeded runs.
Only tornado scenarios with no protections are supported in this chunk.
`;

async function main(args: string[]): Promise<void> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    process.stdout.write(HELP); return;
  }
  const options = new Map<string, string>();
  const allowed = ['--batch', '--scenario', '--places', '--params', '--mode'];
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
  const scenarios = await readScenarios(options.get('--batch') ?? options.get('--scenario')!, options.has('--batch'));
  const places = await loadPlaces(options.get('--places')!, scenarios);
  // Buffer results until every record succeeds: no truncated calibration dataset.
  const results = scenarios.map(s => {
    try { return (mode === 'expected' ? expected : simulate)(s, places.get(s.place_id)!, params); }
    catch (error) { throw new Error(`${s.place_id}: ${error instanceof Error ? error.message : String(error)}`); }
  });
  process.stdout.write(results.map(r => JSON.stringify(r)).join('\n') + '\n');
}

main(process.argv.slice(2)).catch(error => {
  process.stderr.write(`refuge-sim: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
