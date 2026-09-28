// Town builder: search for a U.S. place, build it in a worker, save it on this device.
import type { BuildProgress, TownSpec } from './build';
import { saveTown, type LocalTown } from './db';
import type { WorkerIn, WorkerOut } from './worker';

export { BUILD_STEPS, MAX_BUILDINGS, MAX_SIDE_KM, type BuildProgress, type TownSpec } from './build';
export { deleteTown, isLocalTown, listTowns, loadTown, LOCAL_PREFIX, type LocalTown } from './db';
export { searchPlaces, placeBoundary, type PlaceHit, type PlaceBoundary } from './search';

/** Absolute URL of the site root (the worker resolves same-origin proxy paths against it). */
const siteBase = () => new URL(import.meta.env.BASE_URL, location.origin).href;

/** Build and save a town. Resolves with its index entry once it's stored. */
export function build(spec: TownSpec, onProgress: (p: BuildProgress) => void, signal?: AbortSignal): Promise<LocalTown> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    signal?.addEventListener('abort', () => { worker.terminate(); reject(new Error('Cancelled')); });
    worker.onmessage = async (e: MessageEvent<WorkerOut>) => {
      const m = e.data;
      if (m.kind === 'progress') onProgress(m.progress);
      else if (m.kind === 'error') { worker.terminate(); reject(new Error(m.message)); }
      else { worker.terminate(); try { resolve(await saveTown(m.place, m.trimmed)); } catch (err) { reject(err); } }
    };
    worker.onerror = e => { worker.terminate(); reject(new Error(e.message || 'Town builder crashed')); };
    worker.postMessage({ spec, base: siteBase() } satisfies WorkerIn);
  });
}
