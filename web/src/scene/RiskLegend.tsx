import { RISK_COLOR } from './palette';

// Legends for the risk map (tornado) and displacement map (hurricane). Both hazards use
// the same four colors; only the title and labels change. Cutoffs are passed in, never
// hard-coded: tornado from sim_params.json risk_bands, hurricane from
// hurricane_damage_reference.json constants.bands.

export type LegendHazard = 'tornado' | 'hurricane';
export interface TornadoCutoffs { yellow: number; red: number; deep_red: number }
export interface HurricaneCutoffs { moderate: number; severe: number; extreme: number }

export interface LegendRow { label: string; range: string; color: string; hatched: boolean }
export interface Legend { title: string; rows: LegendRow[]; outline: string; height: string }

const oneIn = (p: number) => `1 in ${Math.round(1 / p).toLocaleString('en-US')}`;
const pct = (x: number) => `${Math.round(x * 100)}%`;

/** Legend text for a hazard. `minPeople` is the outline-only threshold (min_cell_people). */
export function legendFor(hazard: 'tornado', cutoffs: TornadoCutoffs, minPeople: number): Legend;
export function legendFor(hazard: 'hurricane', cutoffs: HurricaneCutoffs, minPeople: number): Legend;
export function legendFor(hazard: LegendHazard, cutoffs: TornadoCutoffs | HurricaneCutoffs, minPeople: number): Legend {
  if (hazard === 'tornado') {
    const c = cutoffs as TornadoCutoffs;
    return {
      title: 'Chance of death per person',
      rows: [
        { label: 'Low', range: `under ${oneIn(c.yellow)}`, color: RISK_COLOR.green, hatched: false },
        { label: 'Elevated', range: `to ${oneIn(c.red)}`, color: RISK_COLOR.yellow, hatched: false },
        { label: 'Severe', range: `to ${oneIn(c.deep_red)}`, color: RISK_COLOR.red, hatched: false },
        { label: 'Extreme', range: `over ${oneIn(c.deep_red)}`, color: RISK_COLOR.deep_red, hatched: true },
      ],
      outline: `Outline only: fewer than ${minPeople} people`,
      height: 'Height: expected deaths',
    };
  }
  const c = cutoffs as HurricaneCutoffs;
  return {
    title: 'Share of residents displaced',
    rows: [
      { label: 'Low', range: `under ${pct(c.moderate)}`, color: RISK_COLOR.green, hatched: false },
      { label: 'Moderate', range: `${pct(c.moderate)}–${pct(c.severe)}`, color: RISK_COLOR.yellow, hatched: false },
      { label: 'Severe', range: `${pct(c.severe)}–${pct(c.extreme)}`, color: RISK_COLOR.red, hatched: false },
      { label: 'Extreme', range: `${pct(c.extreme)} or more`, color: RISK_COLOR.deep_red, hatched: true },
    ],
    outline: `Outline only: fewer than ${minPeople} residents`,
    height: 'Height: displaced people',
  };
}

/** Ready-made legend panel; the game can place it anywhere or draw its own from legendFor(). */
export function RiskLegend({ legend }: { legend: Legend }) {
  return (
    <div role="group" aria-label={legend.title} style={box}>
      <div style={{ fontWeight: 700, fontSize: 13 }}>{legend.title}</div>
      {legend.rows.map(r => (
        <div key={r.label} style={row}>
          <span aria-hidden style={{
            width: 14, height: 14, borderRadius: 3, flex: 'none', background: r.color,
            backgroundImage: r.hatched ? 'repeating-linear-gradient(135deg, rgba(12,16,18,0.75) 0 3px, transparent 3px 7px)' : undefined,
          }} />
          <span style={{ fontWeight: 600, minWidth: 64 }}>{r.label}</span>
          <span style={{ color: '#b9c6c2', fontVariantNumeric: 'tabular-nums' }}>{r.range}{r.hatched ? ' (hatched)' : ''}</span>
        </div>
      ))}
      <div style={row}>
        <span aria-hidden style={{ width: 12, height: 12, borderRadius: 2, flex: 'none', border: `1.5px solid ${RISK_COLOR.sparse}` }} />
        <span style={muted}>{legend.outline}</span>
      </div>
      <div style={muted}>{legend.height}</div>
    </div>
  );
}

const box: React.CSSProperties = {
  display: 'grid', gap: 5, padding: '10px 12px', borderRadius: 8, fontSize: 12.5, color: '#e3eae7',
  background: 'rgba(16, 24, 23, 0.92)', border: '1px solid #2c3a37', fontFamily: '"Public Sans", "Segoe UI", system-ui, sans-serif',
};
const row: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8 };
const muted: React.CSSProperties = { color: '#93a4a0', fontSize: 12 };
