import type { Band } from '../scene';

/** "1 in N" with N rounded to a readable step: 1 in 17, 1 in 45, 1 in 320, 1 in 5,300. */
export function oneInN(risk: number): string {
  if (risk <= 0) return 'no measurable chance';
  const n = 1 / risk;
  const step = n < 20 ? 1 : n < 100 ? 5 : n < 1000 ? 10 : 10 ** (Math.floor(Math.log10(n)) - 1);
  return `1 in ${Math.max(1, Math.round(n / step) * step).toLocaleString('en-US')}`;
}

export const BAND_WORDS: Record<Band, string> = {
  green: 'Low', yellow: 'Elevated', red: 'Severe', deep_red: 'Extreme', sparse: 'Too few people', empty: 'Empty',
};
export const BAND_COLOR: Record<Band, string> = {
  green: '#3f8f5a', yellow: '#d8b13a', red: '#d0512f', deep_red: '#8e1b2b', sparse: '#5d6b68', empty: '#2c3a37',
};

export function hourWords(hour: number): string {
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return `${h} ${hour < 12 ? 'AM' : 'PM'}`;
}

const DRIVER_WORDS: Record<string, string> = {
  MH: 'mostly mobile homes', RES_WOOD: 'mostly wood-frame houses', RES_MASONRY: 'mostly masonry houses',
  MULTI: 'mostly apartments', SCHOOL: 'mostly schools', WORSHIP: 'mostly places of worship',
  COMMERCIAL: 'mostly businesses', BIGROOF: 'mostly big-box and warehouse buildings', OTHER: 'mostly other buildings',
  VEHICLE: 'mostly drivers at crossings', no_basement: 'no basements', flood_depth: 'deep water',
  crossing_traffic: 'crossing traffic',
};
/** ["MH", "no_basement", "night"] at 2 AM -> "mostly mobile homes, no basements, 2 AM". */
export function driverWords(drivers: readonly string[], hour: number): string {
  return drivers.map(d => d === 'night' ? hourWords(hour) : DRIVER_WORDS[d] ?? d).join(', ');
}

export const usd = (n: number): string => `$${Math.round(n).toLocaleString('en-US')}`;
export const deaths = (n: number): string => n < 10 ? n.toFixed(1) : Math.round(n).toLocaleString('en-US');

/** Results panel groups (overview: mobile homes, houses, public buildings, vehicles). */
export const GROUPS: { label: string; classes: string[] }[] = [
  { label: 'Mobile homes', classes: ['MH'] },
  { label: 'Houses and apartments', classes: ['RES_WOOD', 'RES_MASONRY', 'MULTI'] },
  { label: 'Public buildings', classes: ['SCHOOL', 'WORSHIP', 'COMMERCIAL', 'BIGROOF'] },
  { label: 'Vehicles', classes: ['VEHICLE'] },
  { label: 'Other', classes: ['OTHER'] },
];
