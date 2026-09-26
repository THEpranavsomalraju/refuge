import type { BuildingRecord, CellRecord, CrossingRecord, PlaceData, PlaceMeta } from './types';

const BASE = `${import.meta.env.BASE_URL}places`;

async function json<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

/** Loads places/<id>/ (buildings, cells, crossings, place.json, terrain.bin). */
export async function loadPlace(id: string): Promise<PlaceData> {
  const dir = `${BASE}/${id}`;
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
