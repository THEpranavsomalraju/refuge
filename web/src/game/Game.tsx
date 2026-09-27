import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { scene, type Band, type LoadState } from '../scene';
import type { SceneExtensions } from '../shared/contract';
import { HURRICANE_READY, PAST_EVENTS } from './events';
import { riskBands, shelterRules, type DetailedResult } from './simClient';
import { CITIES, SHOWN_CANDIDATES, useGame, type MapView } from './store';
import { BAND_COLOR, BAND_WORDS, GROUPS, deaths, driverWords, hourWords, oneInN, usd } from './format';

/** Game UI (plan section 1): intro -> mode -> past event or future storm -> storm -> map -> plan -> replay -> best plan -> score. */
export function Game({ load }: { load: LoadState }) {
  const g = useGame();
  useEffect(() => {
    if (load.state === 'ready' && load.place.meta.place_id === g.placeId) void g.placeLoaded(load.place);
    if (load.state === 'error') g.placeFailed(load.message);
    // g.step: picking the town that is already loaded (the Lumberton backdrop) must not wait for a new load.
  }, [load, g.placeId, g.step]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <div style={panel}>
        <div style={{ fontWeight: 700, fontSize: 15 }}>{g.event ? g.event.title : g.place && g.step !== 'intro' && g.step !== 'choose_mode' ? g.place.meta.name : 'Refuge'}</div>
        {g.error && <div style={bad}>{g.error}</div>}
        {g.busy ? <div style={muted}>{g.busy}</div> : <Step />}
        {g.error && <button style={secondary} onClick={g.restart}>Back to start</button>}
      </div>
      {g.baseline && <HoverCard />}
      {g.baseline && <Legend />}
    </>
  );
}

/** Scenario hour for display: the event's own hour in past mode. */
const hourOf = (g: ReturnType<typeof useGame.getState>) => g.event ? Number(g.event.scenario.hour) : g.hour;

/** place_ids listed in places/index.json (towns that are built and loadable). */
function useBuiltPlaces(): Set<string> | null {
  const [built, setBuilt] = useState<Set<string> | null>(null);
  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}places/index.json`)
      .then(r => (r.ok ? r.json() : []))
      .then((index: { place_id: string }[]) => setBuilt(new Set(index.map(e => e.place_id))))
      .catch(() => setBuilt(new Set()));
  }, []);
  return built;
}

function Step() {
  const g = useGame();
  const built = useBuiltPlaces();
  switch (g.step) {
    case 'intro': return (
      <>
        <div style={muted}>Send a real storm through a real town, see who is at risk and why, then turn existing buildings into shelters and see how close your plan gets to the best one.</div>
        <button style={primary} onClick={() => g.go('choose_mode')}>Start</button>
      </>
    );
    case 'choose_mode': return (
      <>
        {PAST_EVENTS.some(e => built?.has(e.scenario.place_id)) && (
          <button style={choice} onClick={() => g.chooseMode('past')}><b>Past disaster</b><span style={muted}>Replay a real storm on today's buildings and compare with what NOAA recorded.</span></button>
        )}
        <button style={choice} onClick={() => g.chooseMode('future')}><b>Future storm</b><span style={muted}>Pick a town and design the storm yourself.</span></button>
      </>
    );
    case 'choose_event': return (
      <>
        {PAST_EVENTS.map(e => {
          const townBuilt = built?.has(e.scenario.place_id) ?? false;
          const ready = townBuilt && (e.hazard === 'tornado' || HURRICANE_READY);
          const note = !townBuilt ? (built ? 'Town not built yet' : 'Checking…')
            : ready ? `${e.recorded.deaths_direct} direct deaths recorded` : 'Hurricane mode is coming next';
          return (
            <button key={e.id} style={{ ...choice, opacity: ready ? 1 : 0.45 }} disabled={!ready} onClick={() => g.chooseEvent(e.id)}>
              <b>{e.title}</b><span style={muted}>{e.subtitle}</span>
              <span style={muted}>{note}</span>
            </button>
          );
        })}
        <button style={secondary} onClick={() => g.go('choose_mode')}>Back</button>
      </>
    );
    case 'choose_city': return (
      <>
        {CITIES.map(c => <button key={c.place_id} style={choice} onClick={() => g.chooseCity(c.place_id)}><b>{c.name}</b></button>)}
        <button style={secondary} onClick={() => g.go('choose_mode')}>Back</button>
      </>
    );
    case 'choose_hazard': return (
      <>
        <button style={choice} onClick={g.chooseHazard}><b>Tornado</b><span style={muted}>Chance of death per person.</span></button>
        <button style={{ ...choice, opacity: 0.45 }} disabled><b>Hurricane</b><span style={muted}>Damage and displacement: coming next.</span></button>
        <button style={secondary} onClick={() => g.go('choose_city')}>Back</button>
      </>
    );
    case 'load_place': return <div style={muted}>Loading town…</div>;
    case 'storm_setup': return <Setup />;
    case 'storm_animation': return <div style={muted}>Storm passing through town…</div>;
    case 'results_map': return (
      <>
        {g.event ? <RecordedVsSimulated /> : <Summary title="Without shelters" r={g.baseline!} hour={g.hour} />}
        <button style={primary} onClick={() => void g.plan()}>Plan shelters</button>
      </>
    );
    case 'plan': return <Planning />;
    case 'replay': return g.yours ? (
      <>
        <BeforeAfter />
        <Views options={['before', 'yours']} />
        <button style={primary} onClick={() => void g.best()}>Compare with the best plan</button>
        <button style={secondary} onClick={() => void g.plan()}>Change my plan</button>
      </>
    ) : <div style={muted}>Replaying the same storm…</div>;
    case 'optimal': return <div style={muted}>Searching every affordable plan…</div>;
    case 'score': return <Compare />;
  }
}

function Setup() {
  const g = useGame();
  const canDraw = typeof (scene as typeof scene & SceneExtensions).onGroundClick === 'function';
  return (
    <>
      <Row label="Strength">
        <select value={g.ef} onChange={e => g.set({ ef: Number(e.target.value) })} style={input}>
          {[0, 1, 2, 3, 4, 5].map(ef => <option key={ef} value={ef}>EF{ef}</option>)}
        </select>
      </Row>
      <Row label={`Time: ${hourWords(g.hour)}`}>
        <input type="range" min={0} max={23} value={g.hour} onChange={e => g.set({ hour: Number(e.target.value) })} />
      </Row>
      <Row label={`Warning: ${g.warning} min`}>
        <input type="range" min={0} max={30} value={g.warning} onChange={e => g.set({ warning: Number(e.target.value) })} />
      </Row>
      {canDraw
        ? <button style={secondary} onClick={g.startDrawing}>{g.drawing ? `Click the map: ${g.path.length} point${g.path.length === 1 ? '' : 's'}` : 'Draw the path'}</button>
        : <div style={muted}>Path drawing arrives with the scene's ground-click hook; using {g.placeId === 'lumberton' ? 'the showcase path through both mobile-home parks' : 'a path through the town center'}.</div>}
      <button style={primary} disabled={g.path.length < 2} onClick={() => void g.play()}>Play storm</button>
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

/** Past mode: NOAA's record next to the simulation, plus every caveat from the event file. */
function RecordedVsSimulated() {
  const g = useGame();
  const e = g.event!, r = g.baseline!;
  const groups = GROUPS.map(({ label, classes }) => [label, classes.reduce((a, c) => a + (r.by_class[c as keyof typeof r.by_class] ?? 0), 0)] as const)
    .filter(([, v]) => v >= 0.05);
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <div style={muted}>{e.subtitle}</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <div style={{ display: 'grid', gap: 3 }}>
          <div style={muted}>Recorded (NOAA)</div>
          <div style={{ fontSize: 26, fontWeight: 700, lineHeight: 1 }}>{e.recorded.deaths_direct}</div>
          <div style={muted}>direct deaths</div>
          {e.recorded.injuries_direct !== undefined && <div style={muted}>{e.recorded.injuries_direct} injuries</div>}
          {Object.entries(e.recorded.death_locations ?? {}).map(([loc, n]) => <div key={loc} style={muted}>{n} · {loc}</div>)}
        </div>
        <div style={{ display: 'grid', gap: 3 }}>
          <div style={muted}>Simulated</div>
          <div style={{ fontSize: 26, fontWeight: 700, lineHeight: 1 }}>{deaths(r.expected_deaths)}</div>
          <div style={muted}>expected · {r.p05}–{r.p95}</div>
          <div style={muted}>injuries not modeled</div>
          {groups.map(([label, v]) => <div key={label} style={muted}>{deaths(v)} · {label}</div>)}
        </div>
      </div>
      {e.notes.map(n => <div key={n} style={{ ...muted, fontSize: 11 }}>{n}</div>)}
    </div>
  );
}

const CLASS_WORDS: Record<string, string> = { SCHOOL: 'School', WORSHIP: 'Place of worship', COMMERCIAL: 'Business', BIGROOF: 'Big-box / warehouse' };

function Planning() {
  const g = useGame();
  const t = shelterRules.tornado;
  const reach = Math.round(t.walk_speed_mps * Math.max(0, (g.event ? Number(g.event.scenario.warning_min) : g.warning) - t.mobilize_min) * 60);
  const spent = [...g.placed.keys()].reduce((s, id) => s + (g.candidates.find(c => c.building_id === id)?.cost_usd ?? 0), 0);
  const shown = g.candidates.slice(0, SHOWN_CANDIDATES);
  return (
    <>
      <div style={muted}>
        Turn existing buildings into tornado shelters (a FEMA P-361 hardened core, {Math.round(shelterRules.hardened_share * 100)}% of
        the footprint, {t.sqft_per_person} sq ft per person, {usd(t.cost_per_person)} per person). The building's own occupants go first,
        then about {Math.round(t.compliance * 100)}% of mobile-home residents within a {reach} m walk ({g.event ? Number(g.event.scenario.warning_min) : g.warning} min warning).
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
      <button style={bestButton} onClick={() => void g.fillBest()}>
        ★ Use the best plan for {usd(g.budget)}
      </button>
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
        {plan.label === 'best' ? 'Best' : 'Best found'} plan: {names}; {deaths(plan.remaining)} expected deaths remain.
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
      {c.band !== 'empty' && <div style={row}><span>People at {hourWords(hourOf(g))}</span><span style={mono}>{Math.round(c.people)}</span></div>}
      {c.expected_deaths > 0 && <div style={row}><span>Expected deaths</span><span style={mono}>{c.expected_deaths.toFixed(2)} ({c.p05}–{c.p95})</span></div>}
      {c.drivers.length > 0 && <div style={muted}>{driverWords(c.drivers, hourOf(g))}{c.uncertain ? ' · uncertain' : ''}</div>}
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
const bestButton: CSSProperties = { ...primary, background: '#2f6f5e', border: '1px solid #5fe0c8', color: '#eafffa', fontWeight: 700 };
const secondary: CSSProperties = { ...primary, background: 'transparent', color: '#e3eae7', border: '1px solid #2c3a37' };
const choice: CSSProperties = { display: 'grid', gap: 3, padding: '8px 10px', borderRadius: 6, border: '1px solid #2c3a37', background: 'transparent', color: '#e3eae7', cursor: 'pointer', textAlign: 'left' };
const site: CSSProperties = { ...row, padding: '6px 8px', borderRadius: 6, border: '1px solid', background: 'transparent', color: '#e3eae7', cursor: 'pointer', textAlign: 'left' };
const tab: CSSProperties = { flex: 1, padding: '5px 6px', borderRadius: 5, border: '1px solid #2c3a37', cursor: 'pointer', fontSize: 12 };
