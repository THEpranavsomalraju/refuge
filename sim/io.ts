import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseBuildings, parseCrossings, parseScenario } from './validation.js';
import type { Place, Scenario } from './core/types.js';
import type { HurricaneScenario } from './core/hurricane.js';

type AnyScenario = Scenario | HurricaneScenario;

export async function readJson(file: string): Promise<unknown> {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)}`); }
}

export async function readScenarios(file: string, batch: boolean): Promise<AnyScenario[]> {
  if (!batch) {
    try { return [parseScenario(await readJson(file))]; }
    catch (error) { throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  const text = await readFile(file, 'utf8');
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop(); // one ordinary terminal newline
  if (lines.length === 0) throw new Error(`${file}: empty batch`);
  return lines.map((line, i) => {
    try { return parseScenario(JSON.parse(line)); }
    catch (error) { throw new Error(`${file} line ${i + 1}: ${error instanceof Error ? error.message : String(error)}`); }
  });
}

export async function loadPlaces(root: string, scenarios: readonly AnyScenario[]): Promise<Map<string, Place>> {
  const places = new Map<string, Place>();
  const flooded = new Set(scenarios.filter(s => s.hazard === 'flood').map(s => s.place_id));
  for (const id of new Set(scenarios.map(s => s.place_id))) {
    let file = join(root, id, 'buildings.json');
    try {
      const place: Place = { buildings: parseBuildings(await readJson(file)) };
      // Crossings only matter to floods; tornado batches never read the file.
      if (flooded.has(id)) place.crossings = parseCrossings(await readJson(file = join(root, id, 'crossings.json')));
      places.set(id, place);
    } catch (error) { throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  return places;
}
