export const BUILDING_CLASSES = [
  'MH', 'RES_WOOD', 'RES_MASONRY', 'MULTI', 'SCHOOL',
  'WORSHIP', 'COMMERCIAL', 'BIGROOF', 'OTHER',
] as const;
export type BuildingClass = typeof BUILDING_CLASSES[number];
export type CalibrationGroup = 'MH' | 'RES' | 'PUBLIC' | 'VEHICLE';
export type Coordinate = readonly [number, number]; // longitude, latitude
export type DamageLevel = 0 | 1 | 2 | 3 | 4;

export interface Building {
  id: string;
  lon: number;
  lat: number;
  cls: BuildingClass;
  basement: boolean;
  pop_night_u65: number;
  pop_night_o65: number;
  pop_day_u65: number;
  pop_day_o65: number;
  /** H3 resolution-10 cell; required by simulateDetailed, ignored by the CLI modes. */
  h3?: string;
  /** NSI ftprntsqft; required for a building to become a shelter. */
  footprint_sqft?: number | null;
  // Flood/scene fields are preserved by the loader but not required for tornadoes.
  [key: string]: unknown;
}

export interface TornadoScenario {
  place_id: string;
  hazard: 'tornado';
  ef: number;
  path: Coordinate[];
  width_m: number;
  hour: number;
  warning_min: number;
  protections: readonly Shelter[];
  runs: number;
  seed: number;
}

/** An existing building converted into a shelter (FEMA P-361 hardened core). */
export interface Shelter { type: 'shelter'; building_id: string }
export interface ShelterTornadoConfig {
  sqft_per_person: number; capacity_min: number; capacity_max: number; cost_per_person: number;
  walk_speed_mps: number; mobilize_min: number; compliance: number; served_classes: BuildingClass[];
}
export interface ShelterHurricaneConfig {
  sqft_per_person: number; capacity_min: number; capacity_max: number; cost_per_person: number;
  reach_km: number; major_damage_weight: number;
}
/** sim/params/protections.json */
export interface ProtectionConfig {
  schema_version: 2;
  default_budget_usd: number;
  shelter: {
    eligible_classes: BuildingClass[];
    hardened_share: number;
    tornado: ShelterTornadoConfig;
    hurricane: ShelterHurricaneConfig;
  };
  optimizer: { top_candidates: number; exhaustive_max: number };
}

/** Water surface height above the nearest stream, uniform across the place. */
export interface FloodScenario {
  place_id: string;
  hazard: 'flood';
  flood_height_m: number;
  hour: number;
  warning_min: number;
  /** Always empty until flood protections exist (validation rejects others). */
  protections: readonly Shelter[];
  runs: number;
  seed: number;
}
export type Scenario = TornadoScenario | FloodScenario;

export interface Crossing {
  id: string;
  lon: number;
  lat: number;
  /** H3 resolution-10 cell; required by simulateDetailed. */
  h3?: string;
  /** Road height above the nearest stream; null = no flood data. */
  hand_m: number | null;
  /** 24 hourly values, local clock hour; null = not computed yet. */
  cars_per_hour: number[] | null;
  [key: string]: unknown;
}

export interface FloodParams {
  /** Depth above first floor (m) where damage levels 1-4 begin. */
  damage_thresholds_m: Record<BuildingClass, number[]>;
  /** Added to levels 3-4 per story above the first (occupants move up); not for MH. */
  story_height_m: number;
  lethality_by_damage: number[];
}
export interface VehicleParams {
  exposure_hours: number;
  occupancy: number;
  attempt_prob: number;
  /** Water depth over the road (m) where levels 1-3 begin. */
  depth_thresholds_m: number[];
  lethality_by_depth: number[];
}

export interface SimParams {
  schema_version: 1;
  night_hours: number[];
  lethality_multiplier: Record<CalibrationGroup, number>;
  modifiers: { night: number; basement: number; warning_per_min: number; over65: number };
  wind: {
    peak_mph_by_ef: number[];
    profile: 'linear';
    damage_thresholds_mph: Record<BuildingClass, number[]>;
  };
  lethality_by_damage: Record<BuildingClass, number[]>;
  /** Required only for flood scenarios. */
  flood?: FloodParams;
  vehicle?: VehicleParams;
  risk_bands: { yellow: number; red: number; deep_red: number };
  min_cell_people: number;
}

/** `cells` lists every cells.json entry, so empty featured-place cells still get a result. */
export interface Place {
  buildings: readonly Building[];
  cells?: readonly { h3: string; center?: readonly [number, number] }[];
  /** Loaded for flood scenarios; tornadoes ignore crossings. */
  crossings?: readonly Crossing[];
}
export type ClassTotals = Record<BuildingClass | 'VEHICLE', number>;
export interface ExpectedResult {
  place_id: string;
  expected_deaths: number;
  by_class: ClassTotals;
  people_exposed: number;
  /** Flood only: buildings and crossings skipped because hand_m or traffic is null. */
  no_flood_data?: { buildings: number; crossings: number };
  /** Only when the scenario has protections: people inside safe rooms. */
  sheltered?: number;
}
export interface SimulationResult extends ExpectedResult { p05: number; p95: number }

export type Band = 'green' | 'yellow' | 'red' | 'deep_red' | 'sparse' | 'empty';
export type Driver = BuildingClass | 'VEHICLE' | 'no_basement' | 'night' | 'flood_depth' | 'crossing_traffic';
export interface CellResult {
  people: number;
  expected_deaths: number;
  p05: number;
  p95: number;
  risk: number;
  band: Band;
  uncertain: boolean;
  drivers: Driver[];
}
/** Deaths per run for each H3 cell, indexed by run number. */
export type CellRuns = ReadonlyMap<string, readonly number[]>;
export interface DetailedResult extends SimulationResult {
  building_prob: Record<string, number>;
  cells: Record<string, CellResult>;
  /** Only when the scenario has protections: who goes to which room (sums to `sheltered`). */
  shelter_assignments?: ShelterAssignment[];
}
/** Origin building -> shelter building, for animation and audits. */
export interface ShelterAssignment { building_id: string; shelter_id: string; people: number }

export interface CellDiff { delta_expected_deaths: number; delta_risk: number }

export const CALIBRATION_GROUP: Readonly<Record<BuildingClass, Exclude<CalibrationGroup, 'VEHICLE'> | null>> = {
  MH: 'MH', RES_WOOD: 'RES', RES_MASONRY: 'RES', MULTI: 'RES',
  SCHOOL: 'PUBLIC', WORSHIP: 'PUBLIC', COMMERCIAL: 'PUBLIC', BIGROOF: 'PUBLIC', OTHER: null,
};
