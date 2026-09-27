import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export const simRoot = fileURLToPath(new URL('../', import.meta.url));
export const classes = ['MH', 'RES_WOOD', 'RES_MASONRY', 'MULTI', 'SCHOOL', 'WORSHIP', 'COMMERCIAL', 'BIGROOF', 'OTHER'];

export function params() {
  return {
    schema_version: 1,
    night_hours: [20, 21, 22, 23, 0, 1, 2, 3, 4, 5],
    lethality_multiplier: { MH: 1, RES: 1, PUBLIC: 1, VEHICLE: 1 },
    modifiers: { night: 1.5, basement: 0.25, warning_per_min: 0.02, over65: 1.5 },
    wind: {
      peak_mph_by_ef: [75, 98, 123, 150.5, 183, 225],
      profile: 'linear',
      damage_thresholds_mph: {
        MH: [61, 89, 105, 127], RES_WOOD: [65, 97, 170, 200],
        RES_MASONRY: [65, 121, 156, 180], MULTI: [76, 124, 158, 180],
        SCHOOL: [65, 125, 153, 176], WORSHIP: [65, 124, 144, 157],
        COMMERCIAL: [65, 124, 144, 157], BIGROOF: [68, 117, 137, 158],
        OTHER: [65, 97, 170, 200],
      },
    },
    lethality_by_damage: Object.fromEntries(classes.map(c => [c, [0, 0.00001, 0.0001, 0.005, 0.05]])),
    risk_bands: { yellow: 0.0001, red: 0.01, deep_red: 0.1 },
    min_cell_people: 5,
  };
}

export function scenario(overrides = {}) {
  return { place_id: 'test', hazard: 'tornado', ef: 3,
    path: [[-90.01, 38], [-89.99, 38]], width_m: 400,
    flood_height_m: null, hour: 20, warning_min: 0,
    protections: [], runs: 500, seed: 42, ...overrides };
}

export function building(overrides = {}) {
  return { id: 'synthetic_1', lon: -90, lat: 38, h3: '8a2661c94807fff',
    cbfips: '171190001001001', footprint: [[-90, 38], [-89.9999, 38], [-90, 38.0001]],
    occtype: 'RES2', cls: 'MH', stories: 1, basement: false,
    ground_elev_m: 150, first_floor_ht_m: 0.6, hand_m: 3, firmzone: 'X',
    pop_night_u65: 2, pop_night_o65: 1, pop_day_u65: 1, pop_day_o65: 0,
    ...overrides };
}

export function writeJson(path, value) { writeFileSync(path, JSON.stringify(value)); }

export function fixture(buildings = [building()]) {
  const root = mkdtempSync(join(tmpdir(), 'refuge-cli-test-'));
  const place = join(root, 'places', 'test');
  mkdirSync(place, { recursive: true });
  writeJson(join(place, 'buildings.json'), buildings);
  writeJson(join(place, 'crossings.json'), []);
  writeJson(join(place, 'cells.json'), [{ h3: '8a2661c94807fff' }]);
  writeJson(join(place, 'place.json'), { place_id: 'test', streams: [], roads: [] });
  const candidate = join(root, 'candidate params.json');
  writeJson(candidate, params());
  const input = join(root, 'scenario.json');
  writeJson(input, scenario());
  return { root, place, candidate, input };
}

export function cli(f, args = [], options = {}) {
  return spawnSync(process.execPath, [join(simRoot, 'dist/cli.js'),
    '--scenario', f.input, '--places', join(f.root, 'places'),
    '--params', f.candidate, '--mode', 'expected', ...args],
  { encoding: 'utf8', ...options });
}

export function batch(f, rows, extra = []) {
  const file = join(f.root, 'scenarios.jsonl');
  writeFileSync(file, rows.map(r => typeof r === 'string' ? r : JSON.stringify(r)).join('\n') + '\n');
  return spawnSync(process.execPath, [join(simRoot, 'dist/cli.js'),
    '--batch', file, '--places', join(f.root, 'places'),
    '--params', f.candidate, '--mode', 'expected', ...extra], { encoding: 'utf8' });
}
