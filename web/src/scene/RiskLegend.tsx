import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { DIFF_COLOR, RISK_COLOR } from './palette';

// Legends for the risk map (tornado) and displacement map (hurricane). Both hazards use
// the same four colors; only the title and labels change. Cutoffs are passed in, never
// hard-coded: tornado from sim_params.json risk_bands, hurricane from
// hurricane_damage_reference.json constants.bands.

export type LegendHazard = 'tornado' | 'hurricane';
export interface TornadoCutoffs { yellow: number; red: number; deep_red: number }
export interface HurricaneCutoffs { moderate: number; severe: number; extreme: number }

/** `color` may be a CSS color or a CSS gradient (used for the difference view's blue scale). */
export interface LegendRow { label: string; range: string; color: string; hatched: boolean }
export interface Legend { title: string; rows: LegendRow[]; outline: string | null; height: string }

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

/**
 * Legend for the difference view (scene.showDifference): what the plan changed compared
 * with no shelters. Blue = fewer deaths (tornado) or fewer displaced (hurricane).
 */
export function differenceLegendFor(hazard: LegendHazard): Legend {
  const tornado = hazard === 'tornado';
  return {
    title: 'What the shelters changed',
    rows: [
      { label: tornado ? 'Lives saved' : 'Sheltered', range: tornado
          ? 'blue rises where people reached a shelter; taller, darker = more lives saved there'
          : 'blue rises where displaced people now have a shelter bed; taller, darker = more people helped there',
        color: DIFF_COLOR.savedHigh, hatched: false },
      { label: 'Nothing', range: tornado ? 'no blue: nobody there reached a shelter' : 'no blue: nobody displaced there got a bed', color: 'transparent', hatched: false },
    ],
    outline: null,
    height: hazard === 'tornado' ? 'Compare with “No shelters” to see what was at risk.' : 'Compare with “No shelters” to see where people were displaced.',
  };
}

/** Ready-made legend panel; the game can place it anywhere or draw its own from legendFor(). */
export function RiskLegend({ legend }: { legend: Legend }) {
  return (
    <Card role="group" aria-label={legend.title} className="w-[320px] gap-3 py-4">
      <CardHeader className="px-4"><CardTitle className="text-sm">{legend.title}</CardTitle></CardHeader>
      <CardContent className="grid gap-2 px-4 text-xs">
        {legend.rows.map(r => (
          <div key={r.label} className="flex items-center gap-2.5">
            <span aria-hidden className="size-3 shrink-0 rounded-sm" style={{
              // The extreme band is drawn hatched on the map, so its swatch is too.
              background: r.hatched ? `repeating-linear-gradient(135deg, rgba(12,16,18,0.75) 0 3px, transparent 3px 7px), ${r.color}` : r.color,
            }} />
            <span className="w-16 shrink-0 font-medium">{r.label}</span>
            <span className="text-muted-foreground tabular-nums">{r.range}</span>
          </div>
        ))}
        {legend.outline && (
          <div className="flex items-center gap-2.5">
            <span aria-hidden className="size-3 shrink-0 rounded-sm border" style={{ borderColor: RISK_COLOR.sparse }} />
            <span className="text-muted-foreground">{legend.outline}</span>
          </div>
        )}
        <Separator className="my-1" />
        <div className="text-muted-foreground">{legend.height}</div>
      </CardContent>
    </Card>
  );
}
