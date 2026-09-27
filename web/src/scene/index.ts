// Public surface of the 3D scene. The game (web/src/game) imports only from here.
export { scene, RISK_RISE_MS, CAMERA_MS } from './api';
export { Town, type LoadState } from './Town';
export type { BuildStatus } from './places';
export { CLASS_COLOR } from './palette';
export { legendFor, RiskLegend, type Legend, type LegendRow, type TornadoCutoffs, type HurricaneCutoffs } from './RiskLegend';
export type {
  Band, BuildingClass, CandidateSite, BuildingRecord, CellRecord, CellResult, CrossingRecord, LonLat,
  PlaceData, ProtectionType, RiskBands, SceneAPI,
} from './types';
