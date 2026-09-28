import { isLocalTown, loadTown } from '../builder/db';
import { placeUrl } from './places';
import type { BuildingRecord, CellRecord, CrossingRecord, PlaceData, PlaceMeta } from './types';

async function json<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

/** Loads a place folder (buildings, cells, crossings, place.json, terrain.bin), or a town built in this browser. */
export async function loadPlace(id: string): Promise<PlaceData> {
  if (isLocalTown(id)) {
    const town = await loadTown(id);
    if (!town) throw new Error('This town was built in another browser or its saved data was cleared. Build it again.');
    return town;
  }
  const dir = placeUrl(id);
  const [meta, buildings, cells, crossings] = await Promise.all([
    json<PlaceMeta>(`${dir}/place.json`),
    json<BuildingRecord[]>(`${dir}/buildings.json`),
    json<CellRecord[]>(`${dir}/cells.json`),
    json<CrossingRecord[]>(`${dir}/crossings.json`),
  ]);
  let terrain: Float32Array | null = null;
  if (meta.terrain_source) {
    const res = await fetch(`${dir}/${meta.terrain_source.file}`);
    if (res.ok) terrain = new Float32Array(await res.arrayBuffer());
  }
  return { meta, buildings, cells, crossings, terrain };
}
