import { create } from 'zustand';
import type { RiskCell } from './RiskMap';
import type { BuildingRecord, CandidateSite, LonLat, ProtectionType } from './types';

/** Per-cell values compared by the difference view (tornado or hurricane result cells). */
export type DiffCells = Record<string, { expected_deaths?: number; displaced?: number; people?: number; residents?: number }>;

export interface Protection { id: string; type: ProtectionType; lon: number; lat: number }

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
  risk: { hazard: 'tornado' | 'hurricane'; cells: Record<string, RiskCell>; shownAt: number } | null;
  diff: { before: DiffCells; after: DiffCells; shownAt: number } | null;
  sites: CandidateSite[];
  camera: CameraGoal | null;
  onBuildingClick: ((b: BuildingRecord) => void) | null;
  onCellHover: ((h3: string | null) => void) | null;
  onSiteClick: ((id: string) => void) | null;
  /** While set, clicks on the ground (not drags) are reported here and marked in groundClicks. */
  onGroundClick: ((lon: number, lat: number) => void) | null;
  groundClicks: LonLat[];
}

export const useSceneStore = create<SceneState>(() => ({
  glow: new Map(),
  glowVersion: 0,
  water: null,
  tornado: null,
  stormT: null,
  protections: [],
  risk: null,
  diff: null,
  sites: [],
  camera: null,
  onBuildingClick: null,
  onCellHover: null,
  onSiteClick: null,
  onGroundClick: null,
  groundClicks: [],
}));
