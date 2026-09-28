// Runs buildTown off the main thread (the geometry work would otherwise stall the page).
import { buildTown, type BuildProgress, type TownSpec } from './build';

export type WorkerIn = { spec: TownSpec; base: string };
export type WorkerOut =
  | { kind: 'progress'; progress: BuildProgress }
  | { kind: 'done'; place: import('../scene/types').PlaceData; trimmed: boolean }
  | { kind: 'error'; message: string };

self.onmessage = async (e: MessageEvent<WorkerIn>) => {
  const post = (m: WorkerOut, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer);
  try {
    const { place, trimmed } = await buildTown(e.data.spec, e.data.base, progress => post({ kind: 'progress', progress }));
    post({ kind: 'done', place, trimmed }, place.terrain ? [place.terrain.buffer] : []);
  } catch (err) {
    post({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
