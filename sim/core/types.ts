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
  protections: readonly never[];
  runs: number;
  seed: number;
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
  risk_bands: { yellow: number; red: number; deep_red: number };
  min_cell_people: number;
}

/** `cells` lists every cells.json entry, so empty featured-place cells still get a result. */
export interface Place { buildings: readonly Building[]; cells?: readonly { h3: string }[] }
export type ClassTotals = Record<BuildingClass | 'VEHICLE', number>;
export interface ExpectedResult {
  place_id: string;
  expected_deaths: number;
  by_class: ClassTotals;
  people_exposed: number;
}
export interface SimulationResult extends ExpectedResult { p05: number; p95: number }

export type Band = 'green' | 'yellow' | 'red' | 'deep_red' | 'sparse' | 'empty';
export type Driver = BuildingClass | 'no_basement' | 'night';
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
}
export interface CellDiff { delta_expected_deaths: number; delta_risk: number }

export const CALIBRATION_GROUP: Readonly<Record<BuildingClass, Exclude<CalibrationGroup, 'VEHICLE'> | null>> = {
  MH: 'MH', RES_WOOD: 'RES', RES_MASONRY: 'RES', MULTI: 'RES',
  SCHOOL: 'PUBLIC', WORSHIP: 'PUBLIC', COMMERCIAL: 'PUBLIC', BIGROOF: 'PUBLIC', OTHER: null,
};
