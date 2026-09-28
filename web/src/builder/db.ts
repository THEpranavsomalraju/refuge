// Towns built in the browser are saved on this device (IndexedDB), so they reload instantly.
// If storage is unavailable (private window, blocked site data) they live only for the session.
import type { PlaceData } from '../scene/types';

export interface LocalTown {
  place_id: string;
  name: string;
  buildings: number;
  pop_night: number;
  trimmed: boolean;
  built: string;
}

const DB = 'refuge-towns', PLACES = 'places', INDEX = 'index';
const memory = { places: new Map<string, PlaceData>(), index: new Map<string, LocalTown>() };
let dbPromise: Promise<IDBDatabase | null> | null = null;

function open(): Promise<IDBDatabase | null> {
  dbPromise ??= new Promise(resolve => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => { req.result.createObjectStore(PLACES); req.result.createObjectStore(INDEX); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
  return dbPromise;
}

function run<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  return open().then(db => new Promise(resolve => {
    if (!db) return resolve(undefined);
    try {
      const req = fn(db.transaction(store, mode).objectStore(store));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(undefined);
    } catch { resolve(undefined); }
  }));
}

export async function saveTown(place: PlaceData, trimmed: boolean): Promise<LocalTown> {
  const entry: LocalTown = {
    place_id: place.meta.place_id, name: place.meta.name ?? place.meta.place_id, buildings: place.buildings.length,
    pop_night: place.buildings.reduce((s, b) => s + b.pop_night_u65 + b.pop_night_o65, 0), trimmed, built: new Date().toISOString(),
  };
  memory.places.set(entry.place_id, place);
  memory.index.set(entry.place_id, entry);
  await run(PLACES, 'readwrite', s => s.put(place, entry.place_id));
  await run(INDEX, 'readwrite', s => s.put(entry, entry.place_id));
  return entry;
}

export async function loadTown(id: string): Promise<PlaceData | null> {
  return memory.places.get(id) ?? (await run<PlaceData>(PLACES, 'readonly', s => s.get(id))) ?? null;
}

export async function listTowns(): Promise<LocalTown[]> {
  const stored = (await run<LocalTown[]>(INDEX, 'readonly', s => s.getAll())) ?? [];
  const all = new Map([...stored.map(t => [t.place_id, t] as const), ...memory.index]);
  return [...all.values()].sort((a, b) => b.built.localeCompare(a.built));
}

export async function deleteTown(id: string): Promise<void> {
  memory.places.delete(id);
  memory.index.delete(id);
  await run(PLACES, 'readwrite', s => s.delete(id));
  await run(INDEX, 'readwrite', s => s.delete(id));
}

/** Browser-built towns use ids starting with this, so the loader knows where to look. */
export const LOCAL_PREFIX = 'town_';
export const isLocalTown = (id: string) => id.startsWith(LOCAL_PREFIX);
