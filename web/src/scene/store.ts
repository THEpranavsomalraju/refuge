import { create } from 'zustand';
import type { TrackRow } from '../shared/contract';
import type { RiskCell } from './RiskMap';
import type { BuildingRecord, CandidateSite, LonLat, ProtectionType } from './types';

/** Per-cell values compared by the difference view (tornado or hurricane result cells). */
export type DiffCells = Record<string, { expected_deaths?: number; displaced?: number; people?: number; residents?: number }>;

export interface Protection { id: string; type: ProtectionType; lon: number; lat: number; label?: string }

/** A camera move: frame a circle of `radiusM` around `center` over `ms`. `seq` bumps per request. */
export interface CameraGoal { center: LonLat; radiusM: number; ms: number; seq: number }

interface SceneState {
  /** Building id -> glow 0..1. `glowVersion` bumps on every change so meshes can repaint. */
  glow: Map<string, number>;
  glowVersion: number;
  water: number | null;
  tornado: { coords: LonLat[]; widthM: number } | null;
  /** Storm progress along the path, 0..1, or null when no storm is playing. */
  stormT: number | null;
  protections: Protection[];
  /** Risk or displacement map: cells already converted to band/height/hatch. */
  risk: { hazard: 'tornado' | 'hurricane'; cells: Record<string, RiskCell>; shownAt: number; source: object; before?: object } | null;
  /** How the risk map is drawn: smooth translucent heat columns, or the exact per-block hexagons. */
  mapStyle: 'heat' | 'blocks';
  diff: { before: DiffCells; after: DiffCells; shownAt: number } | null;
  sites: CandidateSite[];
  camera: CameraGoal | null;
  onBuildingClick: ((b: BuildingRecord) => void) | null;
  onCellHover: ((h3: string | null) => void) | null;
  onSiteClick: ((id: string) => void) | null;
  /** While set, clicks on the ground (not drags) are reported here and marked in groundClicks. */
  onGroundClick: ((lon: number, lat: number) => void) | null;
  /** While drawing, right-click (not a drag) or Backspace asks the game to remove the last point. */
  onGroundUndo: (() => void) | null;
  groundClicks: LonLat[];
  /** Hurricane track rows [lon, lat, vmax_kt, rmw_km, B, time_h] and the category label. */
  hurricane: { track: TrackRow[]; category: number } | null;
  /** Eye progress along the track by time, 0..1, or null when not playing. */
  hurricaneT: number | null;
  /** Shelter candidates: building id -> 0..1 (how effective). null = no highlight. */
  highlight: Map<string, number> | null;
  /** Building id under the pointer when it is a highlighted candidate. */
  hoverId: string | null;
  /** Buildings used as shelters in the plan on screen: outlined on the map. */
  shelterIds: string[];
  /** Reach circles around selected shelters, by id. */
  reach: Record<string, { lon: number; lat: number; radiusM: number }>;
}

export const useSceneStore = create<SceneState>(() => ({
  glow: new Map(),
  glowVersion: 0,
  water: null,
  tornado: null,
  stormT: null,
  protections: [],
  risk: null,
  mapStyle: 'heat',
  diff: null,
  sites: [],
  camera: null,
  onBuildingClick: null,
  onCellHover: null,
  onSiteClick: null,
  onGroundClick: null,
  onGroundUndo: null,
  groundClicks: [],
  hurricane: null,
  hurricaneT: null,
  highlight: null,
  hoverId: null,
  shelterIds: [],
  reach: {},
}));
