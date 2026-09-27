import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUILDING_CLASSES } from '../dist/core/index.js';

/** Integration/performance fixture only; never historical building evidence. */
export function writeSyntheticPlace(placesRoot, scenario, count) {
  const dir = join(placesRoot, scenario.place_id);
  mkdirSync(dir, { recursive: true });
  const [start, end] = [scenario.path[0], scenario.path.at(-1)];
  const buildings = Array.from({ length: count }, (_, i) => {
    const t = (i % 100 + 0.5) / 100;
    const lon = start[0] + (end[0] - start[0]) * t;
    const lat = start[1] + (end[1] - start[1]) * t + ((Math.floor(i / 100) % 5) - 2) * 0.0002;
    return {
      id: `synthetic_${i}`, lon, lat,
      cls: BUILDING_CLASSES[i % BUILDING_CLASSES.length],
      // Deliberately an opaque fixture cell, not a real geographic H3 mapping.
      h3: 'synthetic_cell', cbfips: '000000000000000', footprint: [], occtype: 'SYNTHETIC',
      stories: 1 + i % 3, basement: i % 4 === 0,
      ground_elev_m: 150, first_floor_ht_m: 0.6, hand_m: 3, firmzone: 'X',
      pop_night_u65: 2 + i % 4, pop_night_o65: i % 2,
      pop_day_u65: 1 + i % 3, pop_day_o65: i % 2,
    };
  });
  for (const [name, value] of Object.entries({
    buildings, crossings: [],
    cells: [{ h3: 'synthetic_cell', note: 'Opaque test cell; not geographic scene data.' }],
    place: { place_id: scenario.place_id, name: 'Synthetic CLI fixture', streams: [], roads: [] },
  })) writeFileSync(join(dir, `${name}.json`), JSON.stringify(value));
  return dir;
}
