// Place list and on-demand city builds. Featured towns ship with the app (places/);
// any other U.S. city is built by the local build service (places/server.py) into
// data/places/ and served at /generated/. Game UI (web/src/game) can reuse these helpers.

export type PlaceSource = 'featured' | 'generated';

export interface PlaceEntry {
  place_id: string;
  name: string | null;
  source: PlaceSource;
  bbox: [number, number, number, number];
  center: [number, number];
  buildings: number;
  crossings: number;
  pop_night: number;
  area: 'rural' | 'urban' | null;
  trimmed: boolean;
  built: string;
}

export interface Suggestion {
  query: string;
  place_id: string;
  display_name: string | null;
  area_km2: number;
  buildings: number;
  pop_night: number;
  density_per_km2: number;
  suggested_area: 'rural' | 'urban';
  will_trim_to: number | null;
}

export interface BuildJob {
  job_id: string | null;
  place_id: string;
  status: 'queued' | 'running' | 'done' | 'error';
  source?: PlaceSource;
  step?: string | null;
  step_index?: number;
  steps?: string[];
  error?: string | null;
  elapsed_s?: number;
}

const BASE = import.meta.env.BASE_URL;

/** Folder URL for a place's files. */
export const placeUrl = (id: string, source: PlaceSource) =>
  `${BASE}${source === 'featured' ? 'places' : 'generated'}/${id}`;

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}api/${path}`, init);
  } catch {
    throw new Error('The build service is not running. Start it with: places/.venv/Scripts/python -m places.server');
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Build service error (HTTP ${res.status})`);
  return body as T;
}

/**
 * Every loadable place. Uses the build service when it runs (featured + generated);
 * otherwise falls back to the featured towns that ship with the app.
 */
export async function listPlaces(): Promise<{ places: PlaceEntry[]; service: boolean }> {
  try {
    return { places: await api<PlaceEntry[]>('places'), service: true };
  } catch {
    const res = await fetch(`${BASE}places/index.json`);
    const featured = res.ok ? ((await res.json()) as Omit<PlaceEntry, 'source'>[]) : [];
    return { places: featured.map(p => ({ ...p, source: 'featured' as const })), service: false };
  }
}

export const suggestPlace = (query: string) => api<Suggestion>(`suggest?query=${encodeURIComponent(query)}`);

export const startBuild = (query: string, area: 'rural' | 'urban', maxBuildings?: number) =>
  api<BuildJob>('build', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, area, max_buildings: maxBuildings }),
  });

export const buildStatus = (jobId: string) => api<BuildJob>(`build/${jobId}`);

/** Starts a build and polls until it finishes; `onUpdate` gets every status. */
export async function buildPlace(query: string, area: 'rural' | 'urban', onUpdate?: (j: BuildJob) => void): Promise<BuildJob> {
  let job = await startBuild(query, area);
  onUpdate?.(job);
  while (job.status === 'queued' || job.status === 'running') {
    await new Promise(r => setTimeout(r, 1500));
    job = await buildStatus(job.job_id!);
    onUpdate?.(job);
  }
  if (job.status === 'error') throw new Error(job.error ?? 'Build failed');
  return job;
}
