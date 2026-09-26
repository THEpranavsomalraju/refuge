import { scene, type LonLat, type PlaceData } from '../scene';

/**
 * Progress callback for scene.playStorm: each building with a death probability
 * lights up when the storm passes its position along the path. Glow scales with
 * sqrt(probability / 5%), so a 5% chance of death glows fully.
 */
export function stormGlow(place: PlaceData, path: readonly LonLat[], prob: Record<string, number>): (t: number) => void {
  const lat0 = path[0]![1] * Math.PI / 180;
  const xy = ([lon, lat]: readonly [number, number]) => [lon * 111320 * Math.cos(lat0), lat * 110574] as const;
  const pts = path.map(xy);
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1]! + Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]));
  const total = cum.at(-1)! || 1;

  // Fraction of the path length at the point nearest each building.
  const queue: { id: string; at: number; glow: number }[] = [];
  for (const b of place.buildings) {
    const p = prob[b.id];
    if (!p) continue;
    const [x, y] = xy([b.lon, b.lat]);
    let best = Infinity, at = 0;
    for (let i = 1; i < pts.length; i++) {
      const [ax, ay] = pts[i - 1]!, [bx, by] = pts[i]!;
      const len2 = (bx - ax) ** 2 + (by - ay) ** 2 || 1;
      const u = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / len2));
      const d = Math.hypot(x - (ax + u * (bx - ax)), y - (ay + u * (by - ay)));
      if (d < best) { best = d; at = (cum[i - 1]! + u * (cum[i]! - cum[i - 1]!)) / total; }
    }
    queue.push({ id: b.id, at, glow: Math.min(1, Math.sqrt(p / 0.05)) });
  }
  queue.sort((a, b) => a.at - b.at);
  let next = 0;
  return t => {
    while (next < queue.length && queue[next]!.at <= t) {
      const q = queue[next++]!;
      scene.setBuildingGlow(q.id, q.glow);
    }
  };
}
