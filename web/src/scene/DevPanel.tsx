import { useEffect, useMemo, useRef, useState } from 'react';
import { scene } from './api';
import { useSceneStore } from './store';
import type { LoadState } from './Town';
import type { BuildingRecord, CellResult, LonLat, RiskBands } from './types';

/** Sample result written by Mahil's simulateDetailed into data/dev_results/ (dev server only). */
interface DevResult {
  scenario: { path: LonLat[]; width_m: number; ef: number; hour: number; warning_min: number };
  summary: { expected_deaths: number; p05: number; p95: number };
  building_prob: Record<string, number>;
  cells: Record<string, CellResult>;
  bands: RiskBands;
}

const STORM_MS = 7000;
const GLOW_FULL_AT = 0.02; // death probability that shows as full glow

/**
 * Developer overlay for testing the scene before the game UI exists: load status,
 * a showcase tornado run, the hovered cell, and the clicked building. Not part of the product.
 */
export function DevPanel({ load }: { load: LoadState }) {
  const [cell, setCell] = useState<string | null>(null);
  const [picked, setPicked] = useState<BuildingRecord | null>(null);
  const [status, setStatus] = useState<string>('');
  const [result, setResult] = useState<DevResult | null>(null);
  const riskShown = useSceneStore(s => s.risk !== null);
  const busy = useRef(false);
  const place = load.state === 'ready' ? load.place : null;
  const cells = useMemo(() => new Map(place?.cells.map(c => [c.h3, c]) ?? []), [place]);

  useEffect(() => {
    scene.onCellHover(setCell);
    scene.onBuildingClick(b => {
      setPicked(b);
      if (!useSceneStore.getState().risk && !busy.current) { scene.clearBuildingGlow(); scene.setBuildingGlow(b.id, 1); }
    });
    return () => { scene.onCellHover(null); scene.onBuildingClick(null); };
  }, []);

  const playTornado = async () => {
    if (!place || busy.current) return;
    busy.current = true;
    try {
      setStatus('Loading sample result…');
      const res = await fetch(`${import.meta.env.BASE_URL}dev-results/${place.meta.place_id}_tornado.json`);
      if (!res.ok) throw new Error(`No sample result for ${place.meta.place_id} (HTTP ${res.status}).`);
      const r = (await res.json()) as DevResult;
      setResult(r);
      scene.hideRiskMap();
      scene.clearBuildingGlow();
      scene.showTornadoPath(r.scenario.path, r.scenario.width_m);
      // Buildings light up as the funnel passes them.
      const along = place.buildings
        .filter(b => (r.building_prob[b.id] ?? 0) > 0)
        .map(b => ({ id: b.id, t: progressAlong(r.scenario.path, [b.lon, b.lat]), v: Math.min(1, r.building_prob[b.id] / GLOW_FULL_AT) }))
        .sort((a, b) => a.t - b.t);
      let next = 0;
      setStatus('Storm passing…');
      await scene.playStorm(STORM_MS, t => {
        while (next < along.length && along[next].t <= t) { scene.setBuildingGlow(along[next].id, along[next].v); next++; }
      });
      setStatus('Risk map rising…');
      await scene.showRiskMap(r.cells, r.bands);
      setStatus(`Expected deaths ${r.summary.expected_deaths.toFixed(1)} (range ${r.summary.p05}–${r.summary.p95})`);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      busy.current = false;
    }
  };

  const reset = () => {
    scene.hideRiskMap(); scene.hideTornadoPath(); scene.clearBuildingGlow();
    for (const p of useSceneStore.getState().protections) scene.removeProtection(p.id);
    setStatus('');
  };
  const placeShelter = () => { if (picked) scene.placeProtection('safe_room', picked.lon, picked.lat); };

  const c = cell ? cells.get(cell) : null;
  const rc = cell && riskShown && result ? result.cells[cell] : null;
  return (
    <div style={panel}>
      <div style={{ fontWeight: 700 }}>Scene dev panel</div>
      <div style={muted}>
        {load.state === 'loading' && 'Loading place files…'}
        {load.state === 'error' && `Could not load: ${load.message}`}
        {place && `${place.meta.name} · ${place.buildings.length.toLocaleString()} buildings`}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        <button style={btn} onClick={playTornado} disabled={!place}>Play showcase tornado</button>
        <button style={btn} onClick={() => scene.hideRiskMap()} disabled={!riskShown}>Hide risk map</button>
        <button style={btn} onClick={placeShelter} disabled={!picked}>Place safe room at clicked building</button>
        <button style={btn} onClick={reset}>Reset</button>
      </div>
      {status && <div style={{ fontSize: 12.5 }}>{status}</div>}
      <div style={row}><span>Cell</span><span style={mono}>{cell ?? '—'}</span></div>
      {c && <div style={row}><span>People 2 AM / 2 PM</span><span style={mono}>{c.pop_night} / {c.pop_day}</span></div>}
      {rc && (
        <>
          <div style={row}><span>Band</span><span style={mono}>{rc.band}{rc.uncertain ? ' (uncertain)' : ''}</span></div>
          {rc.risk > 0 && <div style={row}><span>Chance of death</span><span style={mono}>1 in {Math.round(1 / rc.risk).toLocaleString()}</span></div>}
          <div style={row}><span>Expected deaths</span><span style={mono}>{rc.expected_deaths.toFixed(2)} ({rc.p05}–{rc.p95})</span></div>
          {rc.drivers.length > 0 && <div style={row}><span>Drivers</span><span style={mono}>{rc.drivers.join(', ')}</span></div>}
        </>
      )}
      {picked && (
        <div style={{ borderTop: '1px solid #2c3a37', paddingTop: 8, display: 'grid', gap: 2 }}>
          <div style={{ fontWeight: 600 }}>{picked.cls} · {picked.occtype}</div>
          <div style={row}><span>Stories</span><span style={mono}>{picked.stories ?? '—'}</span></div>
          <div style={row}><span>Basement</span><span style={mono}>{picked.basement ? 'yes' : 'no'}</span></div>
          <div style={row}><span>Height above stream</span><span style={mono}>{picked.hand_m ?? '—'} m</span></div>
          <div style={row}><span>People 2 AM / 2 PM</span><span style={mono}>{picked.pop_night_u65 + picked.pop_night_o65} / {picked.pop_day_u65 + picked.pop_day_o65}</span></div>
        </div>
      )}
      <div style={muted}>Drag to pan · right-drag to rotate · scroll to zoom · click a building</div>
    </div>
  );
}

/** Fraction (0..1) along a lon/lat polyline of the point nearest to `p` (planar approximation). */
function progressAlong(path: LonLat[], p: LonLat): number {
  const k = Math.cos((p[1] * Math.PI) / 180);
  const seg = path.slice(1).map((b, i) => {
    const a = path[i];
    return { ax: a[0] * k, ay: a[1], dx: (b[0] - a[0]) * k, dy: b[1] - a[1] };
  });
  const lens = seg.map(s => Math.hypot(s.dx, s.dy));
  const total = lens.reduce((x, y) => x + y, 0) || 1;
  let best = Infinity, at = 0, before = 0;
  seg.forEach((s, i) => {
    const px = p[0] * k, py = p[1];
    const u = Math.max(0, Math.min(1, ((px - s.ax) * s.dx + (py - s.ay) * s.dy) / ((lens[i] ** 2) || 1)));
    const d = Math.hypot(s.ax + u * s.dx - px, s.ay + u * s.dy - py);
    if (d < best) { best = d; at = (before + u * lens[i]) / total; }
    before += lens[i];
  });
  return at;
}

const panel: React.CSSProperties = {
  position: 'absolute', top: 12, left: 12, width: 300, padding: '10px 12px', display: 'grid', gap: 6,
  background: 'rgba(16, 24, 23, 0.92)', border: '1px solid #2c3a37', borderRadius: 8, fontSize: 13, color: '#e3eae7',
};
const btn: React.CSSProperties = {
  font: 'inherit', fontSize: 12, padding: '5px 8px', borderRadius: 6, border: '1px solid #3a4a47',
  background: '#1c2826', color: '#e3eae7', cursor: 'pointer',
};
const row: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', gap: 10 };
const muted: React.CSSProperties = { color: '#93a4a0', fontSize: 12 };
const mono: React.CSSProperties = { fontFamily: 'ui-monospace, Consolas, monospace', fontVariantNumeric: 'tabular-nums', textAlign: 'right' };
