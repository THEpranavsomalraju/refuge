// Open Location Code (plus code) decoding, enough to read NSI's UBID building boxes.
// Algorithm from https://github.com/google/open-location-code (Apache-2.0 spec).

const ALPHABET = '23456789CFGHJMPQRVWX';
const PAIR_RES = [20.0, 1.0, 0.05, 0.0025, 0.000125];

export interface CodeArea { latLo: number; lngLo: number; latHi: number; lngHi: number }

/** Decode a full plus code (e.g. "87C4PXQ6+2V") to its cell, or null if it isn't one. */
export function decodeOlc(code: string): CodeArea | null {
  const c = code.replace('+', '').replace(/0+$/, '').toUpperCase();
  if (c.length < 2 || [...c].some(ch => !ALPHABET.includes(ch))) return null;
  let lat = -90, lng = -180, latRes = 0, lngRes = 0;
  const pairs = Math.min(c.length, 10);
  for (let i = 0; i < pairs; i += 2) {
    const res = PAIR_RES[i / 2]!;
    lat += ALPHABET.indexOf(c[i]!) * res;
    if (i + 1 < pairs) lng += ALPHABET.indexOf(c[i + 1]!) * res;
    latRes = lngRes = res;
  }
  // Grid refinement (characters after the 10th): 5 rows x 4 columns per step.
  for (let i = 10; i < c.length; i++) {
    latRes /= 5; lngRes /= 4;
    const v = ALPHABET.indexOf(c[i]!);
    lat += Math.floor(v / 4) * latRes;
    lng += (v % 4) * lngRes;
  }
  return { latLo: lat, lngLo: lng, latHi: lat + latRes, lngHi: lng + lngRes };
}
