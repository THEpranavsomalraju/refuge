// Game <-> scene contract (Simulation proposal for Structures, 2026-09-26; plan section 8).
// Status: PROPOSED. The game feature-detects every optional method below, so the scene can
// add them one at a time. Result shapes mirror sim/core/types.ts.

import type { LonLat } from '../scene';

export type Hazard = 'tornado' | 'hurricane';

/** Tornado cells: sim DetailedResult.cells. Cells with zero expected deaths are absent. */
export type TornadoCells = Record<string, {
  people: number; expected_deaths: number; p05: number; p95: number; risk: number;
  band: 'green' | 'yellow' | 'red' | 'deep_red' | 'sparse'; uncertain: boolean; drivers: string[];
}>;

/** Hurricane cells (plan section 5). Cells with no residents or share < 1% are absent. Height = displaced. */
export type HurricaneCells = Record<string, {
  residents: number; displaced: number; share: number;
  band: 'low' | 'moderate' | 'severe' | 'extreme' | 'sparse';
}>;

/** Hurricane track rows: [lon, lat, vmax_kt, rmw_km, B, time_h]. */
export type TrackRow = [number, number, number, number, number, number];

/** A town the game can offer in "Future storm" (Structures' city list + build server). */
export interface CityEntry {
  place_id: string;
  name: string;
  /** 'ready' = places/<id>/ exists; 'building' = the build server is working on it. */
  status: 'ready' | 'building' | 'missing';
}

/** Scene methods the game needs beyond web/src/scene/types.ts SceneAPI. All optional for now. */
export interface SceneExtensions {
  /** Color/raise buildings by a 0..1+ value (shelter effectiveness); null clears. */
  highlightBuildings?(values: Record<string, number> | null): void;
  /** Walking/driving reach ring around a selected shelter; id lets the game remove it. */
  showReach?(id: string, lon: number, lat: number, radiusM: number): void;
  hideReach?(id?: string): void;
  /** Ground clicks for drawing a tornado path or hurricane track (>= 2 points). */
  onGroundClick?(cb: ((lon: number, lat: number) => void) | null): void;
  /** Hurricane: draw the track and animate the eye along it (time_h drives the pace). */
  showHurricaneTrack?(track: TrackRow[], category: number): void;
  playHurricane?(durationMs: number, onProgress?: (t: number) => void): Promise<void>;
  hideHurricaneTrack?(): void;
  /** Hurricane map: same hexes as showRiskMap, colored by displacement share. */
  showDisplacementMap?(cells: HurricaneCells): Promise<void>;
  /** City list and build-server status for "Future storm". */
  listCities?(): Promise<CityEntry[]>;
}

/** Path drawn by the player (tornado) or track points (hurricane), in [lon, lat]. */
export type DrawnLine = LonLat[];
