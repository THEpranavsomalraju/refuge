import { useEffect, useMemo, useState } from 'react';
import { scene } from './api';
import type { LoadState } from './Town';
import type { BuildingRecord } from './types';

/**
 * Developer overlay for testing the scene before the game UI exists: load status,
 * the hovered H3 cell, and a card for the clicked building. Not part of the product.
 */
export function DevPanel({ load }: { load: LoadState }) {
  const [cell, setCell] = useState<string | null>(null);
  const [picked, setPicked] = useState<BuildingRecord | null>(null);
  const cells = useMemo(() => load.state === 'ready' ? new Map(load.place.cells.map(c => [c.h3, c])) : new Map(), [load]);

  useEffect(() => {
    scene.onCellHover(setCell);
    scene.onBuildingClick(b => {
      setPicked(b);
      scene.clearBuildingGlow();
      scene.setBuildingGlow(b.id, 1);
    });
    return () => { scene.onCellHover(null); scene.onBuildingClick(null); };
  }, []);

  const c = cell ? cells.get(cell) : null;
  return (
    <div style={panel}>
      <div style={{ fontWeight: 700 }}>Scene dev panel</div>
      <div style={muted}>
        {load.state === 'loading' && 'Loading place files…'}
        {load.state === 'error' && `Could not load: ${load.message}`}
        {load.state === 'ready' && `${load.place.meta.name} · ${load.place.buildings.length.toLocaleString()} buildings`}
      </div>
      <div style={row}><span>Cell</span><span style={mono}>{cell ?? '—'}</span></div>
      {c && <div style={row}><span>People 2 AM / 2 PM</span><span style={mono}>{c.pop_night} / {c.pop_day}</span></div>}
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

const panel: React.CSSProperties = {
  position: 'absolute', top: 12, left: 12, width: 280, padding: '10px 12px', display: 'grid', gap: 6,
  background: 'rgba(16, 24, 23, 0.92)', border: '1px solid #2c3a37', borderRadius: 8, fontSize: 13, color: '#e3eae7',
};
const row: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', gap: 10 };
const muted: React.CSSProperties = { color: '#93a4a0', fontSize: 12 };
const mono: React.CSSProperties = { fontFamily: 'ui-monospace, Consolas, monospace', fontVariantNumeric: 'tabular-nums' };
