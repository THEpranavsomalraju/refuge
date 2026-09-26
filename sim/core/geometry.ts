import type { Coordinate } from './types.js';

const RADIUS_M = 6371008.8; // mean Earth radius, spherical distance approximation
const RAD = Math.PI / 180;
type Point = { lon: number; lat: number };
type Segment = { start: Point; end: Point; length: number; bearing: number };
const point = ([lon, lat]: Coordinate): Point => ({ lon: lon * RAD, lat: lat * RAD });
const clamp = (x: number) => Math.max(-1, Math.min(1, x));

function angularDistance(a: Point, b: Point): number {
  const h = Math.sin((b.lat - a.lat) / 2) ** 2 +
    Math.cos(a.lat) * Math.cos(b.lat) * Math.sin((b.lon - a.lon) / 2) ** 2;
  return 2 * Math.asin(Math.sqrt(Math.max(0, Math.min(1, h))));
}
function bearing(a: Point, b: Point): number {
  return Math.atan2(Math.sin(b.lon - a.lon) * Math.cos(b.lat),
    Math.cos(a.lat) * Math.sin(b.lat) - Math.sin(a.lat) * Math.cos(b.lat) * Math.cos(b.lon - a.lon));
}

/** Precompute finite great-circle segments once per scenario. No map dependency. */
export function preparePath(path: readonly Coordinate[]): (lon: number, lat: number) => number {
  const points = path.map(point);
  const segments: Segment[] = points.slice(1).map((end, i) => {
    const start = points[i]!;
    const length = angularDistance(start, end);
    if (Math.PI - length < 1e-10) throw new Error('path: antipodal endpoints do not define a unique segment');
    return { start, end, length, bearing: bearing(start, end) };
  });
  return (lon, lat) => {
    const p = point([lon, lat]);
    let nearest = Infinity;
    for (const segment of segments) {
      const fromStart = angularDistance(segment.start, p);
      if (segment.length === 0) { nearest = Math.min(nearest, fromStart); continue; }
      const angle = bearing(segment.start, p) - segment.bearing;
      const along = Math.atan2(Math.sin(fromStart) * Math.cos(angle), Math.cos(fromStart));
      const distance = along < 0 ? fromStart : along > segment.length ? angularDistance(segment.end, p) :
        Math.abs(Math.asin(clamp(Math.sin(fromStart) * Math.sin(angle))));
      nearest = Math.min(nearest, distance);
    }
    return nearest * RADIUS_M;
  };
}
