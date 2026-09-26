import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { scene, type Band, type LoadState } from '../scene';
import { riskBands, safeRoom, type DetailedResult } from './simClient';
import { useGame, type MapView } from './store';
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
        <button style={primary} onClick={() => void g.compare()}>Compare with the optimal plan</button>
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

function Planning() {
  const g = useGame();
  const spent = g.placed.size * safeRoom.cost_usd;
  return (
    <>
      <div style={muted}>
        Community safe rooms hold {safeRoom.capacity} people. Mobile-home residents within a {g.warning - safeRoom.mobilize_min > 0
          ? `${Math.round(safeRoom.walk_speed_mps * (g.warning - safeRoom.mobilize_min) * 60)} m` : 'zero'} walk
        can reach one in {g.warning} minutes of warning; about {Math.round(safeRoom.compliance * 100)}% go.
      </div>
      <div style={row}><span>Budget</span><span style={mono}>{usd(spent)} of {usd(g.budget)}</span></div>
      <div style={{ display: 'grid', gap: 4 }}>
        {g.sites.map((s, i) => {
          const on = g.placed.has(i);
          const affordable = on || spent + safeRoom.cost_usd <= g.budget;
          return (
            <button key={s.h3} disabled={!affordable} onClick={() => g.toggleSite(i)}
              style={{ ...site, borderColor: on ? '#e3eae7' : '#2c3a37', opacity: affordable ? 1 : 0.4 }}>
              <span>{on ? '■' : '□'} Site {i + 1}</span>
              <span style={muted}>up to {Math.round(s.reachable)} people · {usd(safeRoom.cost_usd)}</span>
            </button>
          );
        })}
        {g.sites.length === 0 && <div style={muted}>No sites: with this little warning nobody can reach a safe room.</div>}
      </div>
      <button style={primary} onClick={() => void g.replay()}>
        Replay storm with {g.placed.size} safe room{g.placed.size === 1 ? '' : 's'}
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
      <div style={row}><span>With your {g.placed.size} room{g.placed.size === 1 ? '' : 's'}</span><span style={mono}>{deaths(g.yours!.expected_deaths)}</span></div>
      <div style={{ ...row, fontWeight: 700 }}><span>Lives saved</span><span style={mono}>{saved.toFixed(1)}</span></div>
      <div style={muted}>{Math.round(g.yours!.sheltered ?? 0)} people in safe rooms · range {g.yours!.p05}–{g.yours!.p95}</div>
    </div>
  );
}

function Compare() {
  const g = useGame();
  const yourSaved = g.baseline!.expected_deaths - g.yours!.expected_deaths;
  const plan = g.optimal!.plan;
  const pct = plan.lives_saved > 0 ? Math.round(100 * yourSaved / plan.lives_saved) : 100;
  // Plan sites come back from the worker as copies: match them by cell id.
  const optimalNames = plan.sites.map(s => `Site ${g.sites.findIndex(x => x.h3 === s.h3) + 1}`).join(', ') || 'no rooms';
  return (
    <>
      <div style={{ fontSize: 30, fontWeight: 700, lineHeight: 1 }}>{pct}%</div>
      <div style={muted}>of the lives the optimal plan saves</div>
      <div style={row}><span>Your plan saves</span><span style={mono}>{yourSaved.toFixed(1)} · {usd(g.placed.size * safeRoom.cost_usd)}</span></div>
      <div style={row}><span>Optimal plan saves</span><span style={mono}>{plan.lives_saved.toFixed(1)} · {usd(plan.cost_usd)}</span></div>
      <div style={muted}>Optimal: {optimalNames}. Searched all {plan.evaluated} plans within {usd(g.budget)}.</div>
      <Views options={['before', 'yours', 'optimal']} />
      <button style={secondary} onClick={() => void g.plan()}>Try another plan</button>
      <button style={secondary} onClick={g.restart}>New storm</button>
    </>
  );
}

const VIEW_WORDS: Record<MapView, string> = { before: 'No protections', yours: 'Your plan', optimal: 'Optimal plan' };
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
