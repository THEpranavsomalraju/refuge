import type { BuildingClass } from './types';

// Calm night palette. PLACEHOLDER until the Story lead signs off on art direction;
// every scene color comes from this file so it can be swapped in one place.
export const PALETTE = {
  sky: '#0c1214',
  fog: '#0c1214',
  ground: '#27332f',
  groundHigh: '#3a4640',
  road: '#6f7c78',
  roadMajor: '#9aa6a2',
  stream: '#3f8fd0',
  glow: '#ff6a3d',
  neutral: '#3a413f',   // buildings under the risk map: dark, so the bands stand out
  moon: '#c9d6e8',
  path: '#c9d3dc',
  funnel: '#d9e2ea',
  shelter: '#5fe0c8',
  site: '#e8eef0',
};

/** Difference view: lives saved (light to deep blue), unchanged (gray), worse (amber). */
export const DIFF_COLOR = {
  savedLow: '#9cc9ef',
  savedHigh: '#1f5fb8',
  unchanged: '#5d6663',
  worse: '#e0a030',
};

/**
 * Risk bands, colorblind-safe ramp from the overview: pale yellow-green, amber,
 * orange-red, deep red (deep red is also hatched). Check in a CVD simulator before locking.
 */
export const RISK_COLOR = {
  green: '#cfe5a0',
  yellow: '#f2b134',
  red: '#e4572e',
  deep_red: '#8e1b24',
  sparse: '#9aa6a2',
  unavailable: '#7d8582',
};

export const CLASS_COLOR: Record<BuildingClass, string> = {
  MH: '#e0707e',
  RES_WOOD: '#b9c4a8',
  RES_MASONRY: '#c9a887',
  MULTI: '#a595cf',
  SCHOOL: '#e6bf5c',
  WORSHIP: '#6cbfb6',
  COMMERCIAL: '#98a8c2',
  BIGROOF: '#7d8b94',
  OTHER: '#7a776f',
};
