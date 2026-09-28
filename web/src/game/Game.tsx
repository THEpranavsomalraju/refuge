import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { differenceLegendFor, legendFor, RiskLegend, scene, type LoadState } from '../scene';
import { PAST_EVENTS, type PastEvent } from './events';
import { hurricaneParams, isHurricane, riskBands, shelterRules, type DetailedResult, type HurricaneRun,
  type Result, type ShelterCandidate } from './simClient';
import { SHOWN_CANDIDATES, useGame, type MapView } from './store';
import { useSceneStore } from '../scene/store';
import { INTRO_STEPS, IntroOverlay } from './intro/IntroOverlay';
import './ui.css';
import { shelterSiteId } from '../../../sim/core/protections.js';
import type { Place } from '../../../sim/core/types.js';
import { GROUPS, deaths, driverWords, hourWords, oneInN, usd } from './format';

type G = ReturnType<typeof useGame.getState>;
const num = (n: number) => Math.round(n).toLocaleString('en-US');
const pct = (x: number) => `${Math.round(x * 100)}%`;
/** Scenario hour for display: the event's own hour in past mode. */
const hourOf = (g: G) => g.event ? Number(g.event.scenario.hour) : g.hour;
const warningOf = (g: G) => g.event ? Number(g.event.scenario.warning_min ?? 0) : g.warning;
const CLASS_WORDS: Record<string, string> = { SCHOOL: 'School', WORSHIP: 'Place of worship', COMMERCIAL: 'Business', BIGROOF: 'Big-box / warehouse' };

/** Game UI (plan section 1): intro -> mode -> past event or future storm -> storm -> map -> plan -> replay -> best plan -> score. */
export function Game({ load }: { load: LoadState }) {
  const g = useGame();
  useEffect(() => {
    if (load.state === 'ready' && load.place.meta.place_id === g.placeId) void g.placeLoaded(load.place);
    if (load.state === 'error') g.placeFailed(load.message);
    // g.place resets to null when a town is chosen; rerun so an already-loaded town (same id) is picked up again.
  }, [load, g.placeId, g.place === null]); // eslint-disable-line react-hooks/exhaustive-deps

  const title = g.event ? g.event.title
    : g.place && !['intro', 'choose_mode', 'choose_city'].includes(g.step) ? g.place.meta.name : 'Refuge';
  // The blue "what your plan changed" view gets its own legend.
  const base = g.view.endsWith('_diff') ? differenceLegendFor(g.hazard)
    : g.hazard === 'hurricane'
      ? legendFor('hurricane', hurricaneParams.cells.bands, hurricaneParams.cells.min_residents)
      : legendFor('tornado', riskBands, riskBands.min_cell_people);
  // "Your plan" / "Best plan" maps: areas the shelters took care of are drawn in blue.
  const legend = g.view === 'yours' || g.view === 'optimal'
    ? { ...base, rows: [{ label: 'Protected', range: g.hazard === 'hurricane' ? 'blue: people here have a shelter bed' : 'blue: people here reach a shelter', color: 'linear-gradient(90deg, #9cc9ef, #1f5fb8)', hatched: false }, ...base.rows] }
    : base;
  const intro = INTRO_STEPS.includes(g.step);
  return (
    <>
      <IntroOverlay />
      {!intro && <div className="gp-panel" style={panel}>
        <div className="gp-head">
          <div>
            <div className="gp-kicker">{g.hazard === 'hurricane' ? 'Hurricane' : 'Tornado'} · {STEP_WORDS[g.step] ?? 'Simulation'}</div>
            <div className="gp-title">{(title ?? 'Refuge').replace(/, USA$/, '')}</div>
          </div>
          {!g.busy && ['choose_city', 'choose_hazard', 'storm_setup', 'results_map', 'plan', 'replay', 'best_preview', 'score'].includes(g.step) && (
            <button className="gp-link" onClick={g.back}>← Back</button>
          )}
        </div>
        {g.error && <div style={bad}>{g.error}</div>}
        {g.busy ? <div style={muted}>{g.busy}</div> : <Step />}
        {g.error && <button className="gp-btn gp-ghost" onClick={g.restart}>Back to start</button>}
      </div>}
      {g.step === 'plan' && g.inspected && <ShelterCard />}
      {g.step === 'plan' && <ShelterHoverCard />}
      {g.baseline && !g.mapHidden && <HoverCard />}
      {g.baseline && !g.mapHidden && <div style={legendBox}><RiskLegend legend={legend} /></div>}
    </>
  );
}

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

const STEP_WORDS: Partial<Record<string, string>> = {
  storm_setup: 'Set up the storm', storm_animation: 'Storm passing', results_map: 'Results', plan: 'Plan shelters',
  replay: 'Your plan', best_preview: 'Best plan', optimal: 'Best plan', score: 'Score',
};

function Step() {
  const g = useGame();
  const built = useBuiltPlaces();
  switch (g.step) {
    case 'intro': return (
      <>
        <div style={muted}>Send a real storm through a real town, see who is at risk and why, then turn existing buildings into shelters and see how close your plan gets to the best one.</div>
        <button className="gp-btn" onClick={() => void g.chooseMode('future')}>Start</button>
      </>
    );
    case 'choose_mode': case 'choose_event': return <ChooseCity />;
    case 'choose_city': return <ChooseCity />;
    case 'choose_hazard': return (
      <>
        <button className="gp-choice" onClick={() => g.chooseHazard('tornado')}><b>Tornado</b><span style={muted}>Chance of death per person, and shelters that save lives.</span></button>
        <button className="gp-choice" onClick={() => g.chooseHazard('hurricane')}><b>Hurricane</b><span style={muted}>Damage and displacement, and shelters for people who lose their homes.</span></button>
      </>
    );
    case 'load_place': return <div style={muted}>Loading town…</div>;
    case 'storm_setup': return <Setup />;
    case 'storm_animation': return <div style={muted}>{g.hazard === 'hurricane' ? 'Hurricane passing…' : 'Storm passing through town…'}</div>;
    case 'results_map': return (
      <>
        {g.event ? <RecordedVsSimulated /> : <Summary r={g.baseline!} />}
        <button className="gp-btn" onClick={() => void g.plan()}>Plan shelters</button>
        <MapToggle />
      </>
    );
    case 'plan': return <Planning />;
    case 'replay': return g.yours ? (
      <>
        <BeforeAfter />
        <Views options={['before', 'yours', 'yours_diff']} />
        <button className="gp-btn" onClick={() => void g.best()}>Show the best plan</button>
        <button className="gp-btn gp-ghost" onClick={() => void g.plan()}>Change my plan</button>
      </>
    ) : <div style={muted}>Replaying the same storm…</div>;
    case 'best_preview': return <BestPreview />;
    case 'optimal': return <div style={muted}>Replaying the storm with the best plan…</div>;
    case 'score': return <Compare />;
  }
}

function ChooseEvent() {
  const g = useGame();
  return (
    <>
      {PAST_EVENTS.map(e => {
        const ready = g.builtEvents.has(e.id);
        return (
          <button key={e.id} className="gp-choice" style={{ opacity: ready ? 1 : 0.45 }} disabled={!ready} onClick={() => g.chooseEvent(e.id)}>
            <b>{e.title}</b><span style={muted}>{e.subtitle}</span>
            <span style={muted}>{ready ? recordedLine(e) : 'Town still being built'}</span>
          </button>
        );
      })}
    </>
  );
}
const recordedLine = (e: PastEvent) => e.hazard === 'tornado'
  ? `${e.recorded.deaths_direct} direct deaths recorded`
  : `${usd(e.recorded.property_damage_usd ?? 0)} property damage recorded`;

function ChooseCity() {
  const g = useGame();
  const [city, setCity] = useState('');
  const [state, setState] = useState('');
  return (
    <>
      {g.cities.length === 0 && <div style={muted}>Loading cities…</div>}
      {g.cities.filter(c => !PAST_EVENTS.some(e => e.scenario.place_id === c.place_id)).map(c => (
        <button key={c.place_id} className="gp-choice" style={{ opacity: c.status === 'ready' ? 1 : 0.45 }} disabled={c.status !== 'ready'}
          onClick={() => g.chooseCity(c.place_id)}>
          <b>{c.name}</b>{c.status !== 'ready' && <span style={muted}>{c.status === 'building' ? 'Building…' : 'Not built'}</span>}
        </button>
      ))}
      {g.canBuild && (
        <div style={{ display: 'grid', gap: 6, borderTop: '1px solid var(--ui-line)', paddingTop: 8 }}>
          <div style={{ fontWeight: 600 }}>Build a new city</div>
          <div style={{ display: 'flex', gap: 6 }}>
            <input placeholder="City" value={city} onChange={e => setCity(e.target.value)} className="gp-input" style={{ flex: 1 }} />
            <input placeholder="ST" maxLength={2} value={state} onChange={e => setState(e.target.value.toUpperCase())} className="gp-input" style={{ width: 44 }} />
          </div>
          {g.build ? (
            <>
              <div className="gp-bar"><div className="gp-bar-fill" style={{ width: pct(g.build.progress) }} /></div>
              <div style={muted}>{g.build.message}</div>
            </>
          ) : (
            <button className="gp-btn gp-ghost" disabled={!city.trim() || state.length !== 2} onClick={() => void g.buildCity(city.trim(), state)}>
              Build (1–3 minutes)
            </button>
          )}
        </div>
      )}
    </>
  );
}

function Setup() {
  const g = useGame();
  const tornado = g.hazard === 'tornado';
  return (
    <>
      {tornado ? (
        <Row label="Strength">
          <select value={g.ef} onChange={e => g.set({ ef: Number(e.target.value) })} className="gp-input">
            {[0, 1, 2, 3, 4, 5].map(ef => <option key={ef} value={ef}>EF{ef}</option>)}
          </select>
        </Row>
      ) : (
        <Row label="Category">
          <select value={g.category} onChange={e => g.set({ category: Number(e.target.value) })} className="gp-input">
            {[1, 2, 3, 4, 5].map(c => <option key={c} value={c}>Category {c}</option>)}
          </select>
        </Row>
      )}
      <Row label={`Time: ${hourWords(g.hour)}`}>
        <input type="range" min={0} max={23} value={g.hour} onChange={e => g.set({ hour: Number(e.target.value) })} />
      </Row>
      {tornado && (
        <Row label={`Warning: ${g.warning} min`}>
          <input type="range" min={0} max={30} value={g.warning} onChange={e => g.set({ warning: Number(e.target.value) })} />
        </Row>
      )}
      <button className="gp-btn gp-ghost" onClick={g.startDrawing}>
        {g.drawing ? `Click the map to add points: ${g.path.length} so far` : `Draw the ${tornado ? 'path' : 'track'} (2+ clicks)`}
      </button>
      {g.drawing && (
        <div style={{ display: 'flex', gap: 6 }}>
          <button className="gp-btn gp-ghost" style={{ flex: 1 }} disabled={g.path.length === 0} onClick={g.undoPoint}>Undo last point</button>
          <button className="gp-btn gp-ghost" style={{ flex: 1 }} disabled={g.path.length === 0} onClick={g.clearPath}>Clear</button>
        </div>
      )}
      {g.drawing && <div style={muted}>Right-click the map or press Backspace to remove the last point.</div>}
      {!g.drawing && <div style={muted}>Using {g.placeId === 'lumberton' && tornado ? 'the showcase path through both mobile-home parks' : `a default ${tornado ? 'path' : 'track'} through the town center`} until you draw one.</div>}
      {!tornado && <div style={muted}>The storm arrives from {hurricaneParams.drawn_track_extension_km} km out along your line and leaves the same way, at 20 km/h; size and shape from recent Category {g.category} hurricanes (NOAA HURDAT2).</div>}
      <button className="gp-btn" disabled={g.path.length < 2} onClick={() => void g.play()}>Play storm</button>
    </>
  );
}

function Summary({ r }: { r: Result }) {
  const g = useGame();
  if (isHurricane(r)) return <HurricaneSummary r={r} />;
  const ef = g.event ? Number(g.event.scenario.ef) : g.ef;
  const warning = g.event ? Number(g.event.scenario.warning_min) : g.warning;
  const parts = groups(r);
  const total = parts.reduce((a, [, v]) => a + v, 0) || 1;
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div style={muted}>EF{ef} tornado · {hourWords(hourOf(g))} · {warning} min warning · no shelters</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <Stat value={num(r.people_exposed)} label="people in buildings the storm damaged" />
        <Stat value={deaths(r.expected_deaths)} label="expected deaths" strong />
      </div>
      <div style={muted}>Most likely between <b style={{ color: 'var(--ui-text)' }}>{r.p05}</b> and <b style={{ color: 'var(--ui-text)' }}>{r.p95}</b> deaths (9 in 10 of 500 simulated storms).</div>
      {parts.length > 0 && (
        <div style={{ display: 'grid', gap: 5 }}>
          <div style={{ ...muted, fontWeight: 600 }}>Where the deaths happen</div>
          {parts.map(([label, v]) => <Bar key={label} label={label} value={deaths(v)} share={v / total} />)}
        </div>
      )}
    </div>
  );
}

/** One headline number with its meaning underneath. */
function Stat({ value, label, strong }: { value: string; label: string; strong?: boolean }) {
  return (
    <div className="gp-stat" data-strong={strong || undefined}>
      <div className="gp-stat-value">{value}</div>
      <div style={muted}>{label}</div>
    </div>
  );
}

/** A labeled share bar (where deaths or displacement happen). */
function Bar({ label, value, share }: { label: string; value: string; share: number }) {
  return (
    <div style={{ display: 'grid', gap: 2 }}>
      <div style={row}><span>{label}</span><span style={mono}>{value}</span></div>
      <div className="gp-bar"><div className="gp-bar-fill is-risk" style={{ width: `${Math.max(2, Math.round(share * 100))}%` }} /></div>
    </div>
  );
}
const groups = (r: DetailedResult) => GROUPS.map(({ label, classes }) =>
  [label, classes.reduce((a, c) => a + (r.by_class[c as keyof typeof r.by_class] ?? 0), 0)] as const).filter(([, v]) => v >= 0.05);

const RES_WORDS: Record<string, string> = { MH: 'Mobile homes', RES_WOOD: 'Wood-frame houses', RES_MASONRY: 'Masonry houses', MULTI: 'Apartments' };
function HurricaneSummary({ r }: { r: HurricaneRun }) {
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div style={muted}>Hurricane · no shelters · displaced = home at major damage or worse</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <Stat value={num(r.displaced)} label={`of ${num(r.residents)} residents displaced (${Math.round((100 * r.displaced) / Math.max(1, r.residents))}%)`} strong />
        <Stat value={num(r.destroyed)} label="from homes destroyed" />
      </div>
      <div style={{ ...muted, fontWeight: 600 }}>Displaced, by type of home</div>
      {Object.entries(r.by_class).filter(([, c]) => c.displaced >= 0.5).map(([cls, c]) => (
        <Bar key={cls} label={RES_WORDS[cls] ?? cls} value={`${num(c.displaced)} of ${num(c.residents)}`} share={c.displaced / Math.max(1, c.residents)} />
      ))}
      <div style={muted}>Expected deaths from wind at home: {r.expected_deaths.toFixed(2)} (hurricane wind rarely kills people indoors).</div>
    </div>
  );
}

/** Past mode: NOAA's record next to the simulation, plus every caveat from the event file. */
function RecordedVsSimulated() {
  const g = useGame();
  const e = g.event!, r = g.baseline!;
  const rec = e.recorded as PastEvent['recorded'] & { deaths_indirect?: number };
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <div style={muted}>{e.subtitle}</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <div style={{ display: 'grid', gap: 3, alignContent: 'start' }}>
          <div style={muted}>Recorded (NOAA)</div>
          <div style={bigger}>{rec.deaths_direct}</div>
          <div style={muted}>direct deaths</div>
          {rec.injuries_direct !== undefined && <div style={muted}>{rec.injuries_direct} injuries</div>}
          {rec.deaths_indirect !== undefined && <div style={muted}>{rec.deaths_indirect} indirect deaths</div>}
          {rec.property_damage_usd !== undefined && <div style={muted}>{usd(rec.property_damage_usd)} property damage</div>}
          {Object.entries(rec.death_locations ?? {}).map(([loc, n]) => <div key={loc} style={muted}>{n} · {loc}</div>)}
          {rec.zones && <div style={muted}>Zones: {rec.zones.join(', ')}</div>}
        </div>
        <div style={{ display: 'grid', gap: 3, alignContent: 'start' }}>
          <div style={muted}>Simulated</div>
          {isHurricane(r) ? (
            <>
              <div style={bigger}>{r.expected_deaths.toFixed(2)}</div>
              <div style={muted}>expected deaths from wind at home</div>
              <div style={muted}>{num(r.displaced)} displaced of {num(r.residents)} residents</div>
              <div style={muted}>{num(r.destroyed)} from destroyed homes</div>
            </>
          ) : (
            <>
              <div style={bigger}>{deaths(r.expected_deaths)}</div>
              <div style={muted}>expected · {r.p05}–{r.p95}</div>
              <div style={muted}>injuries not modeled</div>
              {groups(r).map(([label, v]) => <div key={label} style={muted}>{deaths(v)} · {label}</div>)}
            </>
          )}
        </div>
      </div>
      {e.notes.map(n => <div key={n} style={{ ...muted, fontSize: 11 }}>{n}</div>)}
    </div>
  );
}

/** Words for the plan's objective, per hazard. */
const objective = (g: G) => g.hazard === 'hurricane'
  ? { effect: 'displaced people served if converted', unit: 'need served', short: 'serves' }
  : { effect: 'lives saved if converted', unit: 'lives saved', short: 'saves' };

function Planning() {
  const g = useGame();
  const hurricane = g.hazard === 'hurricane';
  const h = hurricane ? shelterRules.hurricane : shelterRules.tornado;
  const t = shelterRules.tornado;
  const reach = Math.round(t.walk_speed_mps * Math.max(0, warningOf(g) - t.mobilize_min) * 60);
  const byId = (id: string) => g.candidates.find(c => c.building_id === id);
  const spent = g.selected.reduce((s, id) => s + (byId(id)?.cost_usd ?? 0), 0);
  const shown = g.candidates.slice(0, SHOWN_CANDIDATES);
  return (
    <>
      {g.baseline && (g.event ? <RecordedVsSimulated /> : <Summary r={g.baseline} />)}
      <div className="gp-section">Plan your shelters</div>
      <button className="gp-tab" onClick={g.toggleMap} aria-pressed={g.mapHidden}>
        {g.mapHidden ? 'Show the risk map' : 'Hide the risk map to see the shelter options'}
      </button>
      <div>Click a highlighted school, church or business to make it a shelter; click again to remove it. Hover one to see its size and cost.</div>
      <ul className="gp-rules">
        <li>FEMA P-361 safe room · {h.sqft_per_person} sq ft and {usd(h.cost_per_person)} per person</li>
        <li>{hurricane
          ? `Displaced residents within ${shelterRules.hurricane.reach_km} km drive there, nearest first`
          : `Its own occupants first, then ~${pct(t.compliance)} of mobile-home residents within ${reach} m`}</li>
      </ul>
      <Row label="Budget">
        <input type="number" min={0} step={hurricane ? 1_000_000 : 50_000} value={g.budget} className="gp-input" style={{ width: 130 }}
          onChange={e => g.set({ budget: Math.max(0, Number(e.target.value) || 0) })} />
      </Row>
      <div className="gp-bar"><div className="gp-bar-fill" style={{ width: pct(Math.min(1, g.budget ? spent / g.budget : 0)) }} /></div>
      <div style={row}><span style={muted}>Spent</span><span style={mono}>{usd(spent)} of {usd(g.budget)}</span></div>
      {g.notice && <div style={bad}>{g.notice}</div>}

      <div className="gp-section">Your shelters ({g.selected.length})</div>
      {g.selected.length === 0 && <div style={muted}>None yet. Click a highlighted building on the map.</div>}
      {g.selected.map(id => {
        const c = byId(id);
        if (!c) return null;
        return (
          <div key={id} className="gp-site" data-state="on">
            <span style={row}>
              <button className="gp-link" style={{ color: 'var(--ui-text)', fontWeight: 600 }} onClick={() => g.inspect(id)}>{CLASS_WORDS[c.cls] ?? c.cls}</button>
              <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <button className="gp-link" aria-label={`Remove ${CLASS_WORDS[c.cls] ?? c.cls}`} style={{ fontSize: 16, lineHeight: 1 }} onClick={() => g.toggle(id)}>×</button>
              </span>
            </span>
            <span style={muted}>{num(c.capacity)} people · {usd(c.cost_usd)}</span>
          </div>
        );
      })}
      <button className="gp-btn" onClick={() => void g.replay()}>
        Submit plan: replay the storm with {g.selected.length} shelter{g.selected.length === 1 ? '' : 's'}
      </button>
    </>
  );
}

function CandidateRow({ c, spent }: { c: ShelterCandidate; spent: number }) {
  const g = useGame();
  const on = g.selected.includes(c.building_id);
  const affordable = on || spent + c.cost_usd <= g.budget;
  return (
    <button className="gp-site" data-state={on ? 'on' : g.inspected === c.building_id ? 'inspected' : undefined}
      onClick={() => { g.toggle(c.building_id); g.inspect(c.building_id); }} style={{ opacity: affordable ? 1 : 0.5 }}>
      <span style={row}><span>{on ? '■' : '□'} {CLASS_WORDS[c.cls] ?? c.cls}</span><span style={mono}>{objective(g).short} {c.effectiveness.toFixed(1)}</span></span>
      <span style={muted}>{num(c.capacity)} people · {usd(c.cost_usd)}</span>
    </button>
  );
}

/** Card for the building the player clicked (plan step). */
/** Follows the cursor over a highlighted shelter option: what converting it would do, and how to pick it. */
function ShelterHoverCard() {
  const g = useGame();
  const hoverId = useSceneStore(s => s.hoverId);
  const [pos, setPos] = useState<[number, number] | null>(null);
  useEffect(() => {
    const move = (e: MouseEvent) => setPos([e.clientX, e.clientY]);
    window.addEventListener('mousemove', move);
    return () => window.removeEventListener('mousemove', move);
  }, []);
  const siteId = hoverId && g.place ? shelterSiteId(g.place as unknown as Place, shelterRules.eligible_classes, hoverId) : hoverId;
  const i = siteId ? g.candidates.findIndex(c => c.building_id === siteId) : -1;
  const hc = i >= 0 ? g.candidates[i] : null;
  const t = shelterRules.tornado;
  const reachM = g.hazard === 'hurricane' ? shelterRules.hurricane.reach_km * 1000 : t.walk_speed_mps * Math.max(0, warningOf(g) - t.mobilize_min) * 60;
  // The ring = who this shelter can serve. Drawn only while hovering, so the map stays clean.
  useEffect(() => {
    if (!hc) return;
    scene.showReach('hover', hc.lon, hc.lat, reachM);
    return () => scene.hideReach('hover');
  }, [hc, reachM]);
  if (!hc || !pos) return null;
  const c = hc;
  const b = g.place?.buildings.find(x => x.id === c.building_id);
  const hurricane = g.hazard === 'hurricane';
  const on = g.selected.includes(c.building_id);
  return (
    <div className="gp-panel" style={{ ...panel, position: 'fixed', left: pos[0] + 18, top: pos[1] + 18, right: 'auto', bottom: 'auto', width: 250, pointerEvents: 'none', zIndex: 30 }}>
      <div style={row}><b>{b ? CLASS_WORDS[b.cls] ?? b.cls : 'Building'}</b></div>
      <div style={row}><span>Capacity</span><span style={mono}>{num(c.capacity)} people</span></div>
      <div style={row}><span>Cost</span><span style={mono}>{usd(c.cost_usd)}</span></div>
      <div style={muted}>Serves {hurricane ? `displaced people within ${shelterRules.hurricane.reach_km} km (the ring)` : `people within a ${Math.round(reachM)} m walk (the ring)`}</div>
      <div style={muted}>{on ? 'Selected: click to remove' : 'Click to add to your plan'}</div>
    </div>
  );
}

function ShelterCard() {
  const g = useGame();
  const id = g.inspected!;
  const c = g.candidates.find(x => x.building_id === id);
  const b = g.place?.buildings.find(x => x.id === id);
  const on = g.selected.includes(id);
  const spent = g.selected.reduce((s, x) => s + (g.candidates.find(y => y.building_id === x)?.cost_usd ?? 0), 0);
  const hurricane = g.hazard === 'hurricane';
  return (
    <div className="gp-panel" style={{ ...panel, left: 'auto', right: 12, top: 'auto', bottom: 12, width: 300 }}>
      <div style={row}><b>{b ? CLASS_WORDS[b.cls] ?? b.cls : 'Building'}</b><button className="gp-link" onClick={() => g.inspect(null)}>close</button></div>
      {!c ? (
        <div style={muted}>This building can't be a shelter: only schools, places of worship and businesses with a known footprint qualify.</div>
      ) : (
        <>
          <div style={row}><span>Footprint</span><span style={mono}>{num(c.footprint_sqft)} sq ft</span></div>
          <div style={row}><span>Capacity</span><span style={mono}>{num(c.capacity)} people, {hurricane ? shelterRules.hurricane.sqft_per_person : shelterRules.tornado.sqft_per_person} sq ft each</span></div>
          <div style={row}><span>Cost</span><span style={mono}>{usd(c.cost_usd)}</span></div>
          <div style={muted}>Hardened safe room (FEMA P-361), built to survive a direct hit.</div>
          <button className={on ? 'gp-btn gp-ghost' : 'gp-btn'} onClick={() => g.toggle(id)}>{on ? 'Remove' : 'Select'}</button>
          {!on && spent + c.cost_usd > g.budget && <div style={bad}>Over budget: {usd(g.budget - spent)} left.</div>}
        </>
      )}
    </div>
  );
}

function BeforeAfter() {
  const g = useGame();
  const before = g.baseline!, after = g.yours!;
  const n = g.selected.length;
  const plural = `${n} shelter${n === 1 ? '' : 's'}`;
  if (isHurricane(before) && isHurricane(after)) {
    return (
      <div style={{ display: 'grid', gap: 4 }}>
        <div style={row}><span>Displaced, no shelter: before</span><span style={mono}>{num(before.displaced_unsheltered)}</span></div>
        <div style={row}><span>With your {plural}</span><span style={mono}>{num(after.displaced_unsheltered)}</span></div>
        <div style={{ ...row, fontWeight: 700 }}><span>People sheltered</span><span style={mono}>{num(after.sheltered)}</span></div>
        <div style={muted}>Need served {(after.need_served ?? 0).toFixed(0)} (1 per person from a destroyed home, 0.5 from major damage).</div>
      </div>
    );
  }
  const b = before as DetailedResult, a = after as DetailedResult;
  return (
    <div style={{ display: 'grid', gap: 4 }}>
      <div style={row}><span>Before</span><span style={mono}>{deaths(b.expected_deaths)}</span></div>
      <div style={row}><span>With your {plural}</span><span style={mono}>{deaths(a.expected_deaths)}</span></div>
      <div style={{ ...row, fontWeight: 700 }}><span>Lives saved</span><span style={mono}>{(b.expected_deaths - a.expected_deaths).toFixed(1)}</span></div>
      <div style={muted}>{num(a.sheltered ?? 0)} people in shelters · range {a.p05}–{a.p95}</div>
      <div style={muted}>{HOME_NOTE}</div>
    </div>
  );
}

/** "Your plan: 2 shelters, 2,000 beds, $12.0M. 1,000 of 11,122 displaced people get a shelter bed (9%)." */
function PlanSentence({ who, ids, result }: { who: string; ids: readonly string[]; result: Result }) {
  const g = useGame();
  const cs = ids.map(id => g.candidates.find(c => c.building_id === id)).filter(Boolean);
  const beds = cs.reduce((s, c) => s + (c?.capacity ?? 0), 0);
  const cost = cs.reduce((s, c) => s + (c?.cost_usd ?? 0), 0);
  const head = `${who}: ${ids.length} shelter${ids.length === 1 ? '' : 's'}, ${num(beds)} places, ${usd(cost)}.`;
  if (isHurricane(result) && isHurricane(g.baseline!)) {
    const sheltered = result.sheltered ?? 0, displaced = g.baseline.displaced;
    return <div style={muted}>{head} {num(sheltered)} of {num(displaced)} displaced people get a shelter bed ({pct(displaced ? sheltered / displaced : 0)}).</div>;
  }
  const before = (g.baseline as DetailedResult).expected_deaths, after = (result as DetailedResult).expected_deaths;
  return <div style={muted}>{head} Saves {(before - after).toFixed(1)} of {before.toFixed(1)} expected deaths.</div>;
}

function BestPreview() {
  const g = useGame();
  const plan = g.optimal!.plan;
  const cs = plan.building_ids.map(id => g.candidates.find(c => c.building_id === id)).filter(Boolean);
  const places = cs.reduce((s, c) => s + (c?.capacity ?? 0), 0);
  const names = cs.map(c => CLASS_WORDS[c!.cls] ?? c!.cls).join(', ') || 'no shelters';
  return (
    <>
      <div style={{ fontWeight: 700 }}>The best plan for {usd(g.budget)}</div>
      <div style={muted}>{plan.building_ids.length} shelters ({names}), {num(places)} places, {usd(plan.cost_usd)}. They're marked on the map. Run it to see what it changes.</div>
      <button className="gp-btn" onClick={() => void g.runBest()}>Run the best plan</button>
      <button className="gp-btn gp-ghost" onClick={() => { g.go('replay'); g.show('yours'); }}>Back to my plan</button>
    </>
  );
}

function Compare() {
  const g = useGame();
  const plan = g.optimal!.plan;
  const yours = isHurricane(g.yours!) ? (g.yours.need_served ?? 0)
    : (g.baseline as DetailedResult).expected_deaths - (g.yours as DetailedResult).expected_deaths;
  const none = plan.value <= 1e-9;
  const yourCost = g.selected.reduce((s, id) => s + (g.candidates.find(c => c.building_id === id)?.cost_usd ?? 0), 0);
  const names = plan.building_ids.map(id => CLASS_WORDS[g.candidates.find(c => c.building_id === id)?.cls ?? ''] ?? id).join(', ') || 'no shelters';
  const label = plan.label === 'best' ? 'Best' : 'Best found';
  const unit = objective(g).unit;
  return (
    <>
      {none
        ? <div style={{ fontWeight: 600 }}>No shelter plan among these buildings helps in this storm.</div>
        : <><div className="gp-big">{Math.round(100 * yours / plan.value)}%</div>
          <div style={muted}>of the {unit} the {label.toLowerCase()} plan achieves</div></>}
      <div style={row}><span>Your plan</span><span style={mono}>{yours.toFixed(1)} · {usd(yourCost)}</span></div>
      <div style={row}><span>{label} plan</span><span style={mono}>{plan.value.toFixed(1)} · {usd(plan.cost_usd)}</span></div>
      <PlanSentence who="Your plan" ids={g.selected} result={g.yours!} />
      <PlanSentence who={`${label} plan`} ids={plan.building_ids} result={g.optimal!.result} />
      <div style={muted}>
        {label} plan: {names}.
        {plan.method === 'exhaustive'
          ? ` Every affordable combination of the ${plan.candidates.length} top buildings (including yours) was checked: ${num(plan.evaluated)} plans within ${usd(g.budget)}.`
          : ` Greedy search with swaps over ${plan.candidates.length} buildings; not guaranteed optimal.`}
      </div>
      <Views options={['yours_diff', 'optimal_diff', 'before', 'yours', 'optimal']} />
      <button className="gp-btn gp-ghost" onClick={() => void g.plan()}>Try another plan</button>
      <button className="gp-btn gp-ghost" onClick={g.restart}>New storm</button>
    </>
  );
}

const VIEW_WORDS: Record<MapView, string> = {
  before: 'No shelters', yours: 'Your plan', optimal: 'Best plan', yours_diff: 'What your plan changed', optimal_diff: 'What the best plan changed',
};
const HOME_NOTE = 'The map shows risk where people live: residents who reach a shelter still count in their home cell, with no risk.';
function Views({ options }: { options: MapView[] }) {
  const g = useGame();
  return (
    <div className="gp-tabs">
      {options.map(v => (
        <button key={v} className="gp-tab" aria-pressed={g.view === v} onClick={() => g.show(v)}>
          {VIEW_WORDS[v]}
        </button>
      ))}
      <MapToggle />
    </div>
  );
}

/** Lowers the risk layer so the buildings show, or raises it again. */
function MapToggle() {
  const g = useGame();
  return (
    <button className="gp-tab" style={{ flexBasis: '100%' }} onClick={g.toggleMap} aria-pressed={g.mapHidden}>
      {g.mapHidden ? 'Show the risk map' : 'Hide the risk map (see buildings)'}
    </button>
  );
}

function HoverCard() {
  const g = useGame();
  const [hover, setHover] = useState<string | null>(null);
  useEffect(() => {
    scene.onCellHover(setHover);
    return () => scene.onCellHover(null);
  }, []);
  if (!hover) return null;
  const h3 = hover;
  // Difference views: what the plan changed in this cell.
  const diffPlan = g.view === 'yours_diff' ? 'yours' : g.view === 'optimal_diff' ? 'optimal' : null;
  if (diffPlan && g.baseline) {
    const after = diffPlan === 'yours' ? g.yours : g.optimal?.result;
    if (!after) return null;
    return <DiffHover h3={h3} before={g.baseline} after={after}
      title={diffPlan === 'yours' ? 'Your plan' : `${g.optimal?.plan.label === 'best found' ? 'Best found' : 'Best'} plan`} />;
  }
  const result: Result | null | undefined = g.view.startsWith('yours') ? g.yours : g.view.startsWith('optimal') ? g.optimal?.result : g.baseline;
  if (!result) return null;
  if (isHurricane(result)) {
    const c = result.cells[h3];
    if (!c) return null;
    return (
      <div className="gp-panel" style={{ ...panel, top: 'auto', bottom: 12, left: '50%', transform: 'translateX(-50%)', width: 300, pointerEvents: 'none' }}>
        <div style={{ fontWeight: 600 }}>{c.band === 'sparse' ? 'Too few residents for a stable estimate.' : `${pct(c.share)} of residents displaced`}</div>
        <div style={row}><span>Residents</span><span style={mono}>{num(c.residents)}</span></div>
        <div style={row}><span>Displaced{g.view !== 'before' ? ' without shelter' : ''}</span><span style={mono}>{num(c.displaced)}</span></div>
      </div>
    );
  }
  const c = result.cells[h3];
  if (!c) return null;
  const text = c.band === 'sparse' ? 'Too few people for a stable estimate.' : `${oneInN(c.risk)} chance of death for someone here`;
  return (
    <div className="gp-panel" style={{ ...panel, top: 'auto', bottom: 12, left: '50%', transform: 'translateX(-50%)', width: 300, pointerEvents: 'none' }}>
      <div style={{ fontWeight: 600 }}>{text}</div>
      <div style={row}><span>People at {hourWords(hourOf(g))}</span><span style={mono}>{Math.round(c.people)}</span></div>
      {c.expected_deaths > 0 && <div style={row}><span>Expected deaths</span><span style={mono}>{c.expected_deaths.toFixed(2)} ({c.p05}–{c.p95})</span></div>}
      {c.drivers.length > 0 && <div style={muted}>{driverWords(c.drivers, hourOf(g))}{c.uncertain ? ' · uncertain' : ''}</div>}
    </div>
  );
}

/** Before -> after for one cell under one plan (absent cells count as 0). */
function DiffHover({ h3, before, after, title }: { h3: string; before: Result; after: Result; title: string }) {
  if (isHurricane(before) && isHurricane(after)) {
    const b = before.cells[h3], a = after.cells[h3];
    if (!b && !a) return null;
    const was = b?.displaced ?? 0, now = a?.displaced ?? 0;
    return (
      <div className="gp-panel" style={{ ...panel, top: 'auto', bottom: 12, width: 300 }}>
        <div style={{ fontWeight: 600 }}>{title}: {num(Math.max(0, was - now))} people sheltered from here</div>
        <div style={row}><span>Displaced without shelter</span><span style={mono}>{num(was)} → {num(now)}</span></div>
        <div style={row}><span>Residents</span><span style={mono}>{num(b?.residents ?? a?.residents ?? 0)}</span></div>
      </div>
    );
  }
  const b = (before as DetailedResult).cells[h3], a = (after as DetailedResult).cells[h3];
  if (!b && !a) return null;
  const was = b?.expected_deaths ?? 0, now = a?.expected_deaths ?? 0;
  return (
    <div className="gp-panel" style={{ ...panel, top: 'auto', bottom: 12, width: 300 }}>
      <div style={{ fontWeight: 600 }}>{title}: {Math.max(0, was - now).toFixed(2)} lives saved here</div>
      <div style={row}><span>Expected deaths</span><span style={mono}>{was.toFixed(2)} → {now.toFixed(2)}</span></div>
      <div style={row}><span>People here</span><span style={mono}>{Math.round(b?.people ?? a?.people ?? 0)}</span></div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return <label style={{ ...row, alignItems: 'center' }}><span>{label}</span>{children}</label>;
}

// Position only; the look is .gp-panel in ui.css. Above the map's floating labels (drei Html uses
// z-index up to 20), below the intro (30).
const panel: CSSProperties = {
  position: 'absolute', zIndex: 25, top: 12, left: 12, width: 340, maxHeight: 'calc(100% - 24px)', overflowY: 'auto',
};
const legendBox: CSSProperties = { position: 'absolute', top: 60, right: 12 };
const row: CSSProperties = { display: 'flex', justifyContent: 'space-between', gap: 10 };
const muted: CSSProperties = { color: 'var(--ui-muted)', fontSize: 12 };
const bad: CSSProperties = { color: '#ff8a84', fontSize: 12 };
const bigger: CSSProperties = { font: '600 26px/1 var(--font-display)' };
const mono: CSSProperties = { fontVariantNumeric: 'tabular-nums' };
