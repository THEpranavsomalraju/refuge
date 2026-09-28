import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { MAX_SIDE_KM, type PlaceBoundary } from '@/builder';
import type { LonLat } from '@/builder/geometry';

/**
 * Pick the part of a big city to build: a static street map (OpenStreetMap tiles, darkened with a
 * filter to match the theme) with the city boundary, and a MAX_SIDE_KM square you drag or click into place.
 */
const TILE = 256;
const tileUrl = (z: number, x: number, y: number) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
const worldX = (lon: number, z: number) => ((lon + 180) / 360) * TILE * 2 ** z;
const worldY = (lat: number, z: number) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * TILE * 2 ** z;
};
const lonAt = (x: number, z: number) => (x / (TILE * 2 ** z)) * 360 - 180;
const latAt = (y: number, z: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / (TILE * 2 ** z)))) * 180) / Math.PI;

export function AreaPicker({ boundary, start, onChange, height = 300 }: {
  boundary: PlaceBoundary; start: LonLat; onChange: (center: LonLat) => void; height?: number;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(480);
  const [center, setCenter] = useState<LonLat>(start);
  const drag = useRef(false);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  useEffect(() => { onChange(center); }, [center]); // eslint-disable-line react-hooks/exhaustive-deps

  // Zoom that fits the whole boundary (with a little room), and the map's top-left in world pixels.
  const view = useMemo(() => {
    const [w, s, e, n] = boundary.bbox;
    let z = 14;
    while (z > 3 && ((worldX(e, z) - worldX(w, z)) > width * 0.92 || (worldY(s, z) - worldY(n, z)) > height * 0.92)) z--;
    const cx = (worldX(w, z) + worldX(e, z)) / 2, cy = (worldY(n, z) + worldY(s, z)) / 2;
    return { z, left: cx - width / 2, top: cy - height / 2 };
  }, [boundary, width, height]);

  const tiles = useMemo(() => {
    const out: { x: number; y: number; px: number; py: number }[] = [];
    const n = 2 ** view.z;
    for (let ty = Math.floor(view.top / TILE); ty <= Math.floor((view.top + height) / TILE); ty++)
      for (let tx = Math.floor(view.left / TILE); tx <= Math.floor((view.left + width) / TILE); tx++)
        if (ty >= 0 && ty < n) out.push({ x: ((tx % n) + n) % n, y: ty, px: tx * TILE - view.left, py: ty * TILE - view.top });
    return out;
  }, [view, width, height]);

  const toPx = ([lon, lat]: LonLat): [number, number] => [worldX(lon, view.z) - view.left, worldY(lat, view.z) - view.top];
  const rings = boundary.rings.map(r => r.map(p => toPx(p).join(',')).join(' '));
  const mPerPx = (156_543.034 * Math.cos((center[1] * Math.PI) / 180)) / 2 ** view.z;
  const side = (MAX_SIDE_KM * 1000) / mPerPx;
  const [sx, sy] = toPx(center);

  const move = (e: ReactPointerEvent) => {
    const r = box.current!.getBoundingClientRect();
    const [w, s, ee, n] = boundary.bbox;
    const lon = Math.min(ee, Math.max(w, lonAt(e.clientX - r.left + view.left, view.z)));
    const lat = Math.min(n, Math.max(s, latAt(e.clientY - r.top + view.top, view.z)));
    setCenter([lon, lat]);
  };

  return (
    <div ref={box} className="relative w-full cursor-crosshair touch-none overflow-hidden rounded-lg border bg-background select-none" style={{ height }}
      onPointerDown={e => { drag.current = true; (e.target as Element).setPointerCapture?.(e.pointerId); move(e); }}
      onPointerMove={e => { if (drag.current) move(e); }}
      onPointerUp={() => { drag.current = false; }}
      role="application" aria-label="Map: click or drag to place the area to build">
      {tiles.map(t => (
        <img key={`${t.x}-${t.y}-${t.px}`} src={tileUrl(view.z, t.x, t.y)} alt="" draggable={false}
          className="pointer-events-none absolute max-w-none" style={{ left: t.px, top: t.py, width: TILE, height: TILE,
            filter: 'invert(1) hue-rotate(180deg) brightness(0.85) contrast(0.9) saturate(0.6)' }} />
      ))}
      <svg className="pointer-events-none absolute inset-0" width={width} height={height}>
        {rings.map((pts, i) => <polygon key={i} points={pts} strokeWidth={1.5} strokeDasharray="4 3"
          style={{ fill: 'none', stroke: 'var(--muted-foreground)' }} />)}
        <rect x={sx - side / 2} y={sy - side / 2} width={side} height={side} rx={4} strokeWidth={2}
          style={{ fill: 'color-mix(in oklab, var(--primary) 16%, transparent)', stroke: 'var(--primary)' }} />
      </svg>
      <div className="pointer-events-none absolute bottom-1 right-1.5 text-[10px] text-muted-foreground">© OpenStreetMap contributors</div>
    </div>
  );
}
