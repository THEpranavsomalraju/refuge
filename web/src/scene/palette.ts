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
  neutral: '#8a918e',
  moon: '#c9d6e8',
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
