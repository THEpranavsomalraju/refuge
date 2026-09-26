import { create } from 'zustand';
import type { BuildingRecord, CandidateSite, CellResult, LonLat, ProtectionType, RiskBands } from './types';

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
  risk: { cells: Record<string, CellResult>; bands: RiskBands; shownAt: number } | null;
  diff: { before: Record<string, CellResult>; after: Record<string, CellResult>; shownAt: number } | null;
  sites: CandidateSite[];
  camera: CameraGoal | null;
  onBuildingClick: ((b: BuildingRecord) => void) | null;
  onCellHover: ((h3: string | null) => void) | null;
  onSiteClick: ((id: string) => void) | null;
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
}));
