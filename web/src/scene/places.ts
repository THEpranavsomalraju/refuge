// City list and on-demand city builds (plan section 3). Featured towns and cities built
// by the local build server (places/build_server.py, port 8765) all live in places/<id>/.
// The demo never depends on the server: when it isn't running, the city list falls back
// to the featured towns and the game hides "Build a new city".

import type { CityEntry } from '../shared/contract';

const BASE = import.meta.env.BASE_URL;
/** Dev server proxies this to http://127.0.0.1:8765 (web/vite.config.ts). */
const SERVER = `${BASE}build-api`;

export interface BuildStatus {
  state: 'queued' | 'running' | 'done' | 'error';
  progress: number;
  place_id: string | null;
  message: string;
}

/** Folder URL for a place's files. */
export const placeUrl = (id: string) => `${BASE}places/${id}`;

async function server<T>(path: string, init?: RequestInit, timeoutMs = 8000): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${SERVER}${path}`, { ...init, signal: ctl.signal });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.message ?? `Build server error (HTTP ${res.status})`);
    return body as T;
  } finally {
    clearTimeout(timer);
  }
}

/** True when the local build server answers (quick check; false on the published site). */
export async function buildServerAvailable(): Promise<boolean> {
  try { return (await server<{ ok: boolean }>('/health', undefined, 1500)).ok === true; } catch { return false; }
}

/**
 * Cities for "Future storm": featured towns plus cities built on this machine (and ones
 * building now). Past-event towns are not listed; they belong to past mode.
 */
export async function listCities(): Promise<CityEntry[]> {
  try {
    // Anything but a list (e.g. the site's own page when no build server exists) means no server.
    const cities = await server<CityEntry[]>('/cities', undefined, 2500);
    if (!Array.isArray(cities)) throw new Error('no build server');
    return cities;
  } catch {
    const res = await fetch(`${BASE}places/index.json`);
    const index = res.ok ? ((await res.json()) as { place_id: string; name: string | null; kind?: string }[]) : [];
    return index
      .filter(e => (e.kind ?? 'featured') !== 'past_event')
      .map(e => ({ place_id: e.place_id, name: (e.name ?? e.place_id).replace(', USA', ''), status: 'ready' as const }));
  }
}

/** Starts a build and polls until it finishes; `onUpdate` gets every status. Resolves with the place id. */
export async function buildCity(city: string, state: string, onUpdate?: (s: BuildStatus) => void): Promise<string> {
  const { job_id } = await server<{ job_id: string }>('/build', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ city, state }),
  });
  for (;;) {
    const s = await server<BuildStatus>(`/status/${job_id}`);
    onUpdate?.(s);
    if (s.state === 'done') return s.place_id!;
    if (s.state === 'error') throw new Error(s.message);
    await new Promise(r => setTimeout(r, 1500));
  }
}
