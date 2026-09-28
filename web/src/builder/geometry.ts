// Small planar geometry helpers for the town builder. Towns are at most ~15 km across, so a local
// equirectangular projection around the town's center is accurate to well under a meter.

export type XY = [number, number];
export type LonLat = [number, number];
export type BBox = [number, number, number, number]; // min lon, min lat, max lon, max lat

export const M_PER_DEG_LAT = 110_574;

/** Lon/lat <-> meters around (lon0, lat0). */
export function localProjection(lon0: number, lat0: number) {
  const kx = 111_320 * Math.cos((lat0 * Math.PI) / 180);
  return {
    toXY: ([lon, lat]: LonLat): XY => [(lon - lon0) * kx, (lat - lat0) * M_PER_DEG_LAT],
    toLonLat: ([x, y]: XY): LonLat => [lon0 + x / kx, lat0 + y / M_PER_DEG_LAT],
  };
}

/** Width and height of a bbox in km. */
export function bboxKm([w, s, e, n]: BBox): [number, number] {
  const lat = ((s + n) / 2) * (Math.PI / 180);
  return [((e - w) * 111_320 * Math.cos(lat)) / 1000, ((n - s) * M_PER_DEG_LAT) / 1000];
}

/** Square bbox of `sideKm` centered on a point. */
export function squareAround([lon, lat]: LonLat, sideKm: number): BBox {
  const dLat = (sideKm * 500) / M_PER_DEG_LAT;
  const dLon = (sideKm * 500) / (111_320 * Math.cos((lat * Math.PI) / 180));
  return [lon - dLon, lat - dLat, lon + dLon, lat + dLat];
}

export const inBBox = ([lon, lat]: LonLat, [w, s, e, n]: BBox) => lon >= w && lon <= e && lat >= s && lat <= n;

/** Signed area (shoelace); positive for counterclockwise rings. */
export function ringArea(ring: XY[]): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j]![0] + ring[i]![0]) * (ring[j]![1] - ring[i]![1]);
  return -a / 2;
}

export function pointInRing([x, y]: XY, ring: XY[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!, [xj, yj] = ring[j]!;
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Ramer-Douglas-Peucker on an open polyline. */
export function simplifyLine(pts: XY[], tol: number): XY[] {
  if (pts.length <= 2) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = pts[a]!, [bx, by] = pts[b]!;
    const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1e-12;
    let far = -1, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = pts[i]!;
      const d = Math.abs(dy * px - dx * py + bx * ay - by * ax) / len;
      if (d > far) { far = d; idx = i; }
    }
    if (far > tol && idx > 0) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

/** Simplify a closed ring (given without the repeated first point). */
export function simplifyRing(ring: XY[], tol: number): XY[] {
  if (ring.length <= 4) return ring;
  const closed = simplifyLine([...ring, ring[0]!], tol);
  return closed.slice(0, -1);
}

/** Convex hull (monotone chain). */
export function convexHull(pts: XY[]): XY[] {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: XY, a: XY, b: XY) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: XY[] = [], upper: XY[] = [];
  for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, q) <= 0) lower.pop(); lower.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]!; while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, q) <= 0) upper.pop(); upper.push(q); }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/** Clip a polyline to a bbox (Liang-Barsky per segment); returns the inside parts. */
export function clipLine(line: LonLat[], [w, s, e, n]: BBox): LonLat[][] {
  const parts: LonLat[][] = [];
  let cur: LonLat[] = [];
  const flush = () => { if (cur.length >= 2) parts.push(cur); cur = []; };
  for (let i = 0; i + 1 < line.length; i++) {
    const [x0, y0] = line[i]!, [x1, y1] = line[i + 1]!;
    const dx = x1 - x0, dy = y1 - y0;
    let t0 = 0, t1 = 1, ok = true;
    for (const [p, q] of [[-dx, x0 - w], [dx, e - x0], [-dy, y0 - s], [dy, n - y0]] as const) {
      if (p === 0) { if (q < 0) { ok = false; break; } continue; }
      const r = q / p;
      if (p < 0) { if (r > t1) { ok = false; break; } if (r > t0) t0 = r; }
      else { if (r < t0) { ok = false; break; } if (r < t1) t1 = r; }
    }
    if (!ok) { flush(); continue; }
    const a: LonLat = [x0 + t0 * dx, y0 + t0 * dy], b: LonLat = [x0 + t1 * dx, y0 + t1 * dy];
    if (cur.length === 0 || t0 > 0) { flush(); cur.push(a); }
    cur.push(b);
    if (t1 < 1) flush();
  }
  flush();
  return parts;
}

export const round = (v: number, nd: number) => { const k = 10 ** nd; return Math.round(v * k) / k; };
