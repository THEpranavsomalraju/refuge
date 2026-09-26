import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { scene, type Band, type LoadState } from '../scene';
import { riskBands, shelterRules, type DetailedResult } from './simClient';
import { SHOWN_CANDIDATES, useGame, type MapView } from './store';
import { BAND_COLOR, BAND_WORDS, GROUPS, deaths, driverWords, hourWords, oneInN, usd } from './format';

/** Game UI for the Lumberton tornado flow: storm -> risk map -> safe rooms -> replay -> optimal plan. */
export function Game({ load }: { load: LoadState }) {
  const g = useGame();
  useEffect(() => { if (load.state === 'ready') void g.init(load.place); }, [load]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <div style={panel}>
        <div style={{ fontWeight: 700, fontSize: 15 }}>{load.state === 'ready' ? load.place.meta.name : 'Refuge'}</div>
        {load.state === 'error' && <div style={bad}>Could not load the town: {load.message}</div>}
        {g.error && <div style={bad}>{g.error}</div>}
        <Phase />
      </div>
      {g.baseline && <HoverCard />}
      {g.baseline && <Legend />}
    </>
  );
}

function Phase() {
  const g = useGame();
  switch (g.phase) {
    case 'loading': return <div style={muted}>Loading buildings…</div>;
    case 'simulating': return <div style={muted}>Running 500 simulated storms…</div>;
    case 'storm': return <div style={muted}>Storm passing through town…</div>;
    case 'setup': return <Setup />;
    case 'results': return (
      <>
        <Summary title="Without protections" r={g.baseline!} hour={g.hour} />
        <button style={primary} onClick={() => void g.plan()}>Plan protections</button>
      </>
    );
    case 'planning': return <Planning />;
    case 'replayed': return (
      <>
        <BeforeAfter />
        <Views options={['before', 'yours']} />
        <button style={primary} onClick={() => void g.compare()}>Compare with the best plan</button>
        <button style={secondary} onClick={() => void g.plan()}>Change my plan</button>
      </>
    );
    case 'compare': return <Compare />;
  }
}

function Setup() {
  const g = useGame();
  return (
    <>
      <div style={muted}>A tornado crosses Lumberton's two largest mobile-home parks. Set it up and press play.</div>
      <Row label="Strength">
        <select value={g.ef} onChange={e => g.set({ ef: Number(e.target.value) })} style={input}>
          {[1, 2, 3, 4, 5].map(ef => <option key={ef} value={ef}>EF{ef}</option>)}
        </select>
      </Row>
      <Row label={`Time: ${hourWords(g.hour)}`}>
        <input type="range" min={0} max={23} value={g.hour} onChange={e => g.set({ hour: Number(e.target.value) })} />
      </Row>
      <Row label={`Warning: ${g.warning} min`}>
        <input type="range" min={0} max={30} value={g.warning} onChange={e => g.set({ warning: Number(e.target.value) })} />
      </Row>
      <button style={primary} onClick={() => void g.play()}>Play storm</button>
    </>
  );
}

function Summary({ title, r, hour }: { title: string; r: DetailedResult; hour: number }) {
  return (
    <div style={{ display: 'grid', gap: 4 }}>
      <div style={muted}>{title} · {hourWords(hour)}</div>
      <div style={{ fontSize: 30, fontWeight: 700, lineHeight: 1 }}>{deaths(r.expected_deaths)}</div>
      <div style={muted}>expected deaths · range {r.p05}–{r.p95} in 90% of 500 runs</div>
      {GROUPS.map(({ label, classes }) => {
        const v = classes.reduce((a, c) => a + (r.by_class[c as keyof typeof r.by_class] ?? 0), 0);
        return v >= 0.05 ? <div key={label} style={row}><span>{label}</span><span style={mono}>{deaths(v)}</span></div> : null;
      })}
    </div>
  );
}

const CLASS_WORDS: Record<string, string> = { SCHOOL: 'School', WORSHIP: 'Place of worship', COMMERCIAL: 'Business', BIGROOF: 'Big-box / warehouse' };

function Planning() {
  const g = useGame();
  const t = shelterRules.tornado;
  const reach = Math.round(t.walk_speed_mps * Math.max(0, g.warning - t.mobilize_min) * 60);
  const spent = [...g.placed.keys()].reduce((s, id) => s + (g.candidates.find(c => c.building_id === id)?.cost_usd ?? 0), 0);
  const shown = g.candidates.slice(0, SHOWN_CANDIDATES);
  return (
    <>
      <div style={muted}>
        Turn existing buildings into tornado shelters (a FEMA P-361 hardened core, {Math.round(shelterRules.hardened_share * 100)}% of
        the footprint, {t.sqft_per_person} sq ft per person, {usd(t.cost_per_person)} per person). The building's own occupants go first,
        then about {Math.round(t.compliance * 100)}% of mobile-home residents within a {reach} m walk ({g.warning} min warning).
        People inside are modeled as safe. Tornado shelter only.
      </div>
      <Row label="Budget">
        <input type="number" min={0} step={50000} value={g.budget} style={{ ...input, width: 120 }}
          onChange={e => g.set({ budget: Math.max(0, Number(e.target.value) || 0) })} />
      </Row>
      <div style={row}><span>Spent</span><span style={mono}>{usd(spent)} of {usd(g.budget)}</span></div>
      <div style={muted}>Most effective buildings for this storm (lives saved if converted alone):</div>
      <div style={{ display: 'grid', gap: 4, maxHeight: 300, overflowY: 'auto' }}>
        {shown.map(c => {
          const on = g.placed.has(c.building_id);
          const affordable = on || spent + c.cost_usd <= g.budget;
          return (
            <button key={c.building_id} disabled={!affordable} onClick={() => g.toggle(c.building_id)}
              style={{ ...site, display: 'grid', gap: 2, borderColor: on ? '#e3eae7' : '#2c3a37', opacity: affordable ? 1 : 0.4 }}>
              <span style={row}><span>{on ? '■' : '□'} {CLASS_WORDS[c.cls] ?? c.cls}</span><span style={mono}>saves {c.effectiveness.toFixed(1)}</span></span>
              <span style={muted}>{c.capacity} people · {usd(c.cost_usd)} · {Math.round(c.people_in_reach)} mobile-home residents in reach</span>
            </button>
          );
        })}
        {shown.length === 0 && <div style={muted}>No eligible buildings: needs schools, churches or businesses with a known footprint (footprint_sqft).</div>}
      </div>
      <button style={primary} onClick={() => void g.replay()}>
        Replay storm with {g.placed.size} shelter{g.placed.size === 1 ? '' : 's'}
      </button>
    </>
  );
}

function BeforeAfter() {
  const g = useGame();
  const saved = g.baseline!.expected_deaths - g.yours!.expected_deaths;
  return (
    <div style={{ display: 'grid', gap: 4 }}>
      <div style={row}><span>Before</span><span style={mono}>{deaths(g.baseline!.expected_deaths)}</span></div>
      <div style={row}><span>With your {g.placed.size} shelter{g.placed.size === 1 ? '' : 's'}</span><span style={mono}>{deaths(g.yours!.expected_deaths)}</span></div>
      <div style={{ ...row, fontWeight: 700 }}><span>Lives saved</span><span style={mono}>{saved.toFixed(1)}</span></div>
      <div style={muted}>{Math.round(g.yours!.sheltered ?? 0)} people in shelters · range {g.yours!.p05}–{g.yours!.p95}</div>
      <div style={muted}>{HOME_NOTE}</div>
    </div>
  );
}

function Compare() {
  const g = useGame();
  const yourSaved = g.baseline!.expected_deaths - g.yours!.expected_deaths;
  const plan = g.optimal!.plan;
  const none = plan.value <= 1e-9;
  const pct = none ? null : Math.round(100 * yourSaved / plan.value);
  const yourCost = [...g.placed.keys()].reduce((s, id) => s + (g.candidates.find(c => c.building_id === id)?.cost_usd ?? 0), 0);
  const names = plan.building_ids.map(id => CLASS_WORDS[g.candidates.find(c => c.building_id === id)?.cls ?? ''] ?? id).join(', ') || 'no shelters';
  return (
    <>
      {none
        ? <div style={{ fontWeight: 600 }}>No shelter plan among these buildings saves lives in this storm.</div>
        : <><div style={{ fontSize: 30, fontWeight: 700, lineHeight: 1 }}>{pct}%</div>
          <div style={muted}>of the lives the {plan.label} plan saves</div></>}
      <div style={row}><span>Your plan saves</span><span style={mono}>{yourSaved.toFixed(1)} · {usd(yourCost)}</span></div>
      <div style={row}><span>{plan.label === 'best' ? 'Best' : 'Best found'} plan saves</span><span style={mono}>{plan.value.toFixed(1)} · {usd(plan.cost_usd)}</span></div>
      <div style={muted}>
        {plan.label === 'best' ? 'Best' : 'Best found'} plan: {names}; {deaths(plan.expected_deaths)} expected deaths remain.
        {plan.method === 'exhaustive'
          ? ` Every affordable combination of the ${plan.candidates.length} top buildings (including yours) was checked: ${plan.evaluated} plans within ${usd(g.budget)}.`
          : ` Greedy search with swaps over ${plan.candidates.length} buildings (${plan.evaluated} plans); not guaranteed optimal.`}
      </div>
      <div style={muted}>{HOME_NOTE}</div>
      <Views options={['before', 'yours', 'optimal']} />
      <button style={secondary} onClick={() => void g.plan()}>Try another plan</button>
      <button style={secondary} onClick={g.restart}>New storm</button>
    </>
  );
}

const VIEW_WORDS: Record<MapView, string> = { before: 'No protections', yours: 'Your plan', optimal: 'Best plan' };
const HOME_NOTE = 'The map shows risk where people live: residents who reach a shelter still count in their home cell, with no risk.';
function Views({ options }: { options: MapView[] }) {
  const g = useGame();
  return (
    <div style={{ display: 'flex', gap: 4 }}>
      {options.map(v => (
        <button key={v} onClick={() => g.show(v)}
          style={{ ...tab, background: g.view === v ? '#e3eae7' : 'transparent', color: g.view === v ? '#101817' : '#e3eae7' }}>
          {VIEW_WORDS[v]}
        </button>
      ))}
    </div>
  );
}

function HoverCard() {
  const g = useGame();
  const [h3, setH3] = useState<string | null>(null);
  useEffect(() => { scene.onCellHover(setH3); return () => scene.onCellHover(null); }, []);
  const result = g.view === 'yours' ? g.yours : g.view === 'optimal' ? g.optimal?.result : g.baseline;
  const c = h3 && result ? result.cells[h3] : null;
  if (!c) return null;
  const text = c.band === 'empty' ? 'Nobody here at this hour.'
    : c.band === 'sparse' ? 'Too few people for a stable estimate.'
    : `${oneInN(c.risk)} chance of death for someone here`;
  return (
    <div style={{ ...panel, top: 'auto', bottom: 12, width: 300 }}>
      <div style={{ fontWeight: 600 }}>{text}</div>
      {c.band !== 'empty' && <div style={row}><span>People at {hourWords(g.hour)}</span><span style={mono}>{Math.round(c.people)}</span></div>}
      {c.expected_deaths > 0 && <div style={row}><span>Expected deaths</span><span style={mono}>{c.expected_deaths.toFixed(2)} ({c.p05}–{c.p95})</span></div>}
      {c.drivers.length > 0 && <div style={muted}>{driverWords(c.drivers, g.hour)}{c.uncertain ? ' · uncertain' : ''}</div>}
    </div>
  );
}

function Legend() {
  const n = oneInN;
  const items: [Band, string][] = [
    ['green', `below ${n(riskBands.yellow)}`],
    ['yellow', `${n(riskBands.yellow)} to ${n(riskBands.red)}`],
    ['red', `${n(riskBands.red)} to ${n(riskBands.deep_red)}`],
    ['deep_red', `above ${n(riskBands.deep_red)}`],
  ];
  return (
    <div style={{ ...panel, left: 'auto', right: 12, width: 250 }}>
      <div style={{ fontWeight: 600 }}>Chance of death for a person here</div>
      {items.map(([b, text]) => (
        <div key={b} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ width: 12, height: 12, borderRadius: 2, background: BAND_COLOR[b] }} />
          <span>{BAND_WORDS[b]}</span><span style={{ ...muted, marginLeft: 'auto' }}>{text}</span>
        </div>
      ))}
      <div style={muted}>Outline only: fewer than {riskBands.min_cell_people} people</div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return <label style={{ ...row, alignItems: 'center' }}><span>{label}</span>{children}</label>;
}

const panel: CSSProperties = {
  position: 'absolute', top: 12, left: 12, width: 320, padding: '12px 14px', display: 'grid', gap: 8,
  background: 'rgba(16, 24, 23, 0.94)', border: '1px solid #2c3a37', borderRadius: 8, fontSize: 13, color: '#e3eae7',
};
const row: CSSProperties = { display: 'flex', justifyContent: 'space-between', gap: 10 };
const muted: CSSProperties = { color: '#93a4a0', fontSize: 12 };
const bad: CSSProperties = { color: '#f08c73', fontSize: 12 };
const mono: CSSProperties = { fontFamily: 'ui-monospace, Consolas, monospace', fontVariantNumeric: 'tabular-nums' };
const input: CSSProperties = { background: '#101817', color: '#e3eae7', border: '1px solid #2c3a37', borderRadius: 4 };
const primary: CSSProperties = { padding: '8px 10px', borderRadius: 6, border: 0, background: '#e3eae7', color: '#101817', fontWeight: 600, cursor: 'pointer' };
const secondary: CSSProperties = { ...primary, background: 'transparent', color: '#e3eae7', border: '1px solid #2c3a37' };
const site: CSSProperties = { ...row, padding: '6px 8px', borderRadius: 6, border: '1px solid', background: 'transparent', color: '#e3eae7', cursor: 'pointer', textAlign: 'left' };
const tab: CSSProperties = { flex: 1, padding: '5px 6px', borderRadius: 5, border: '1px solid #2c3a37', cursor: 'pointer', fontSize: 12 };
