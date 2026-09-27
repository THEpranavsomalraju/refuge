import type { CityEntry, HurricaneCells, TrackRow } from '../shared/contract';
import type { BuildStatus } from './places';
import type { DiffCells } from './store';

// Shapes of the place files in places/<place_id>/ (see places/README.md) and of the
// scene API the game calls. Result types mirror sim/core/types.ts on Mahil's branch.

export const BUILDING_CLASSES = [
  'MH', 'RES_WOOD', 'RES_MASONRY', 'MULTI', 'SCHOOL', 'WORSHIP', 'COMMERCIAL', 'BIGROOF', 'OTHER',
] as const;
export type BuildingClass = typeof BUILDING_CLASSES[number];
export type LonLat = [number, number];

export interface BuildingRecord {
  id: string;
  lon: number;
  lat: number;
  h3: string;
  cbfips: string | null;
  footprint: LonLat[] | null;
  /** NSI footprint area of the whole building (sq ft); shelter capacity and cost use it. */
  footprint_sqft: number | null;
  occtype: string;
  cls: BuildingClass;
  stories: number | null;
  basement: boolean;
  ground_elev_m: number | null;
  first_floor_ht_m: number | null;
  hand_m: number | null;
  firmzone: string | null;
  pop_night_u65: number;
  pop_night_o65: number;
  pop_day_u65: number;
  pop_day_o65: number;
}

export interface CellRecord {
  h3: string;
  center: LonLat;
  boundary: LonLat[];
  ground_elev_m: number | null;
  pop_night: number;
  pop_day: number;
}

export interface CrossingRecord {
  id: string;
  lon: number;
  lat: number;
  h3: string;
  road_name: string | null;
  road_class: string;
  road_elev_m: number;
  hand_m: number | null;
  cars_per_hour: number[] | null;
}

export interface TerrainSource {
  file: string;
  format: string;
  width: number;
  height: number;
  bbox: [number, number, number, number];
  min_m: number;
  max_m: number;
  source: string;
}

export interface PlaceMeta {
  place_id: string;
  name: string | null;
  county_fips: string | null;
  bbox: [number, number, number, number];
  center: LonLat;
  camera: unknown | null;
  terrain_source: TerrainSource | null;
  streams: LonLat[][];
  roads: { class: string; line: LonLat[] }[];
}

export interface PlaceData {
  meta: PlaceMeta;
  buildings: BuildingRecord[];
  cells: CellRecord[];
  crossings: CrossingRecord[];
  terrain: Float32Array | null;
}

// --- Simulation results (sim/core/types.ts) ---
export type Band = 'green' | 'yellow' | 'red' | 'deep_red' | 'sparse' | 'empty';
export interface CellResult {
  people: number;
  expected_deaths: number;
  p05: number;
  p95: number;
  risk: number;
  band: Band;
  uncertain: boolean;
  drivers: string[];
}
/** Cutoffs on risk per person (sim_params.json risk_bands) plus min_cell_people. */
export interface RiskBands {
  yellow: number;
  red: number;
  deep_red: number;
  min_cell_people: number;
}

export type ProtectionType = 'safe_room' | 'siren' | 'gate' | 'bridge' | 'elevate';

/** A place the player can put a protection. `selected` draws it as chosen. */
export interface CandidateSite { id: string; lon: number; lat: number; label: string; selected?: boolean }

/** What the game calls. Every function is safe to call before the place has loaded. */
export interface SceneAPI {
  setBuildingGlow(id: string, value0to1: number): void;
  clearBuildingGlow(): void;
  setWaterLevel(m: number | null): void;
  showTornadoPath(coords: LonLat[], widthM: number): void;
  hideTornadoPath(): void;
  /** Moves the storm along the path shown by showTornadoPath; resolves when it ends. */
  playStorm(durationMs: number, onProgress?: (t: number) => void): Promise<void>;
  /** `label` is shown under the pin (e.g. "School" or "3 shelters"). */
  placeProtection(type: ProtectionType, lon: number, lat: number, label?: string): string;
  removeProtection(id: string): void;
  onBuildingClick(cb: ((b: BuildingRecord) => void) | null): void;
  onCellHover(cb: ((h3: string | null) => void) | null): void;
  /** Tornado map. Only cells present in `cells` are drawn; absent cells were unaffected. */
  /** `before` (the no-shelter cells) makes areas the shelters protect show in blue. */
  showRiskMap(cells: Record<string, CellResult>, bands?: RiskBands, before?: Record<string, CellResult>): Promise<void>;
  /** Hurricane map: same hexes, colored by share displaced, height = displaced people. */
  showDisplacementMap(cells: HurricaneCells, before?: HurricaneCells): Promise<void>;
  /** Hides the risk map and the difference map. */
  /** Draw the risk map as smooth heat columns ('heat', default) or exact per-block hexagons ('blocks'). */
  setMapStyle(style: 'heat' | 'blocks'): void;
  hideRiskMap(): void;
  /**
   * Difference view: cells where expected deaths dropped rise in blue, height = lives
   * saved; unchanged cells with people stay gray and flat. Replaces the risk map.
   */
  showDifference(before: DiffCells, after: DiffCells): Promise<void>;

  /** Clickable markers for protection sites; replaces any shown before. */
  showCandidateSites(sites: CandidateSite[]): void;
  hideCandidateSites(): void;
  onSiteClick(cb: ((id: string) => void) | null): void;
  /** Cities for "Future storm": featured towns plus cities built on this machine (not past-event towns). */
  listCities(): Promise<CityEntry[]>;
  /** True when the local build server (places/build_server.py) is running; hide "Build a new city" otherwise. */
  buildServerAvailable(): Promise<boolean>;
  /** Builds a new city with the local build server; resolves with its place_id when done. */
  buildCity(city: string, state: string, onUpdate?: (s: BuildStatus) => void): Promise<string>;
  /**
   * Shelter candidates: color these buildings on one teal scale by value (0..1), everything
   * else neutral; hovering one shows a pointer and an outline. null clears. The risk map
   * lowers and fades while candidates are highlighted so the buildings stay visible.
   */
  highlightBuildings(values: Record<string, number> | null): void;
  /** Ground circle of radiusM around a selected shelter (321 m tornado walk, 3 km hurricane drive). */
  showReach(id: string, lon: number, lat: number, radiusM: number): void;
  /** Remove one reach circle, or all of them. */
  hideReach(id?: string): void;
  /** Hurricane track rows [lon, lat, vmax_kt, rmw_km, B, time_h]; draws the track and category. */
  showHurricaneTrack(track: TrackRow[], category: number): void;
  /** Moves the eye along the track by time_h (cloud band, eyewall ring, rain); resolves at the end. */
  playHurricane(durationMs: number, onProgress?: (t: number) => void): Promise<void>;
  hideHurricaneTrack(): void;
  /**
   * Ground clicks for drawing a tornado path or hurricane track; drags still pan. null stops.
   * `onUndo` is called on right-click (not a right-drag) or Backspace while drawing.
   */
  onGroundClick(cb: ((lon: number, lat: number) => void) | null, onUndo?: () => void): void;
  /** Remove the last point marker (call when the game drops its last point). */
  undoGroundClick(): void;
  /** Remove all point markers (call when the game clears the drawing). */
  clearGroundClicks(): void;

  /** Camera: frame points (plus a margin), the current storm path, or a set of H3 cells. */
  frameCoords(coords: LonLat[], ms?: number, marginM?: number): void;
  frameStormPath(ms?: number): void;
  /** Frame every cell on the current risk, displacement, or difference map. */
  frameRiskMap(ms?: number): void;
  focusCells(h3s: string[], ms?: number): void;
}
