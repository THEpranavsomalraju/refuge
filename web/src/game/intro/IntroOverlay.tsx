import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { PAST_EVENTS } from '../events';
import { useGame, type Hazard } from '../store';
import { IntroScene, type IntroSceneState } from './IntroScene';
import './intro.css';

/**
 * The game's opening: title card, then storm type, then town, then a short load before the
 * map takes over. It drives the same store actions as the old panel (chooseMode, chooseCity,
 * chooseHazard), just in the order storm -> town.
 */

/** Steps that belong to the intro; the regular game panel takes over after them. */
export const INTRO_STEPS = ['intro', 'choose_mode', 'choose_event', 'choose_city', 'choose_hazard', 'load_place'];

type Stage = 'title' | 'hazard' | 'city' | 'loading';
interface TownStats { buildings: number; pop_night: number }

const BLURB: Record<string, string> = {
  lumberton: 'Eastern NC · 11% mobile homes',
  morganton: 'Western NC foothills · 7% mobile homes',
  chapel_hill: 'Piedmont college town · under 1% mobile homes',
};
const num = (n: number) => Math.round(n).toLocaleString('en-US');

export function IntroOverlay() {
  const g = useGame();
  const onIntroStep = INTRO_STEPS.includes(g.step);
  const [stage, setStage] = useState<Stage>(() => (g.step === 'intro' ? 'title' : 'hazard'));
  const [hazard, setHazard] = useState<Hazard>(g.hazard);
  const [hover, setHover] = useState<Hazard | null>(null);
  // Shown while the game is on an intro step, plus ~1.3 s after it leaves one (the fly-in).
  const [leaving, setLeaving] = useState(false);
  const wasIntro = useRef(onIntroStep);
  const [stats, setStats] = useState<Record<string, TownStats>>({});
  const scene = useRef<IntroSceneState>({ hazard: 'tornado', shot: 'wide' });

  // Town list (and whether a build server is up) as soon as the intro shows.
  useEffect(() => { if (g.step === 'intro') void g.chooseMode('future'); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}places/index.json`)
      .then(r => (r.ok ? r.json() : []))
      .then((rows: ({ place_id: string } & TownStats)[]) => setStats(Object.fromEntries(rows.map(r => [r.place_id, r]))))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    const was = wasIntro.current;
    wasIntro.current = onIntroStep;
    if (was && !onIntroStep) {
      // The town is loaded and the storm setup is up: fly into the map, then unmount (stops the 3D scene).
      setLeaving(true);
      const t = setTimeout(() => setLeaving(false), 1300);
      return () => clearTimeout(t);
    }
    // Coming back later (Back from the storm setup, or New storm): skip the title card.
    if (!was && onIntroStep) { setLeaving(false); setHover(null); setStage('hazard'); }
  }, [onIntroStep]);

  scene.current = {
    hazard: hover ?? (stage === 'title' ? 'tornado' : hazard),
    shot: leaving || (wasIntro.current && !onIntroStep) ? 'dive' : stage === 'title' ? 'wide' : 'choose',
  };

  // The render where the step first leaves the intro counts as leaving too (the effect sets `leaving` right after).
  const exiting = leaving || (wasIntro.current && !onIntroStep);
  const gone = !onIntroStep && !exiting;
  // Enter starts the simulation from the title card.
  useEffect(() => {
    if (stage !== 'title' || gone) return;
    const key = (e: KeyboardEvent) => { if (e.key === 'Enter' && !(e.target instanceof HTMLInputElement)) setStage('hazard'); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [stage, gone]);

  if (gone) return null;

  const pickTown = (placeId: string) => {
    setStage('loading');
    g.chooseCity(placeId);
    g.chooseHazard(hazard);
  };

  return (
    <div className="rf-intro" data-leaving={exiting || undefined}>
      <IntroScene state={scene} />
      <div className="rf-vignette" />
      <div className="rf-hud rf-hud-tl"><span className="rf-dot" />Refuge · storm simulator</div>
      <div className="rf-hud rf-hud-br">NOAA 1996–2025 · USACE Structure Inventory · FEMA P-361</div>
      <div className="rf-stage">
        <Card stage={stage}>
          {stage === 'title' && <Title onBegin={() => setStage('hazard')} />}
          {stage === 'hazard' && (
            <HazardStep onHover={setHover} onBack={() => setStage('title')}
              onPick={h => { setHazard(h); setHover(null); setStage('city'); }} />
          )}
          {stage === 'city' && (
            <CityStep hazard={hazard} stats={stats} onBack={() => setStage('hazard')} onPick={pickTown} />
          )}
          {stage === 'loading' && <Loading stats={stats} onBack={() => setStage('city')} />}
        </Card>
      </div>
    </div>
  );
}

/** The glass card. Its height follows its content, so switching steps resizes it smoothly. */
function Card({ stage, children }: { stage: Stage; children: ReactNode }) {
  const inner = useRef<HTMLDivElement>(null);
  const [h, setH] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = inner.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setH(el.offsetHeight));
    ro.observe(el);
    setH(el.offsetHeight);
    return () => ro.disconnect();
  }, []);
  return (
    <div className="rf-card" style={{ height: h === null ? undefined : h + 2 } as CSSProperties}>
      <span className="rf-corner tl" /><span className="rf-corner tr" /><span className="rf-corner bl" /><span className="rf-corner br" />
      <div ref={inner} className="rf-card-inner">
        <div key={stage} className="rf-step">{children}</div>
      </div>
    </div>
  );
}

function Title({ onBegin }: { onBegin: () => void }) {
  return (
    <div className="rf-title">
      <div className="rf-kicker">Storm simulator for real towns</div>
      <h1 className="rf-word" aria-label="Refuge">
        {'Refuge'.split('').map((c, i) => <span key={i} style={{ '--i': i } as CSSProperties}>{c}</span>)}
      </h1>
      <div className="rf-rule"><span /></div>
      <p className="rf-tag">Send a tornado or hurricane through a real town. See who is at risk and why, then plan the shelters that save lives.</p>
      <button className="rf-begin" onClick={onBegin} autoFocus>
        <span className="rf-begin-dot" />
        Begin simulation
        <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden><path d="M5 12h13M13 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      <div className="rf-hint">or press Enter</div>
    </div>
  );
}

function Steps({ at, onBack }: { at: 1 | 2 | 3; onBack?: () => void }) {
  const names = ['Storm', 'Town', 'Simulate'];
  return (
    <div className="rf-steps">
      <ol>
        {names.map((n, i) => (
          <li key={n} data-state={i + 1 < at ? 'done' : i + 1 === at ? 'now' : 'next'}>
            <span>{String(i + 1).padStart(2, '0')}</span>{n}
          </li>
        ))}
      </ol>
      {onBack && <button className="rf-back" onClick={onBack}>← Back</button>}
    </div>
  );
}

function HazardStep({ onPick, onHover, onBack }: {
  onPick: (h: Hazard) => void; onHover: (h: Hazard | null) => void; onBack: () => void;
}) {
  const options: { id: Hazard; name: string; meta: string; text: string; icon: ReactNode }[] = [
    { id: 'tornado', name: 'Tornado', meta: 'EF0–EF5 · minutes of warning', text: 'Who is most likely to die, and which shelters save the most lives.', icon: <TornadoIcon /> },
    { id: 'hurricane', name: 'Hurricane', meta: 'Category 1–5 · days of warning', text: 'Which homes are lost, and where displaced people can shelter.', icon: <HurricaneIcon /> },
  ];
  return (
    <>
      <Steps at={1} onBack={onBack} />
      <h2 className="rf-h2">Choose a storm</h2>
      <div className="rf-options">
        {options.map((o, i) => (
          <button key={o.id} className="rf-option" data-hazard={o.id}
            style={{ '--i': i } as CSSProperties}
            onClick={() => onPick(o.id)} onPointerEnter={() => onHover(o.id)} onPointerLeave={() => onHover(null)}
            onFocus={() => onHover(o.id)} onBlur={() => onHover(null)}>
            <span className="rf-option-icon">{o.icon}</span>
            <span className="rf-option-name">{o.name}</span>
            <span className="rf-option-meta">{o.meta}</span>
            <span className="rf-option-text">{o.text}</span>
          </button>
        ))}
      </div>
    </>
  );
}

function CityStep({ hazard, stats, onPick, onBack }: {
  hazard: Hazard; stats: Record<string, TownStats>; onPick: (id: string) => void; onBack: () => void;
}) {
  const g = useGame();
  const [city, setCity] = useState('');
  const [state, setState] = useState('');
  // Featured towns, the showcase (Lumberton) first.
  const towns = g.cities.filter(c => c.status === 'ready' && !PAST_EVENTS.some(e => e.scenario.place_id === c.place_id))
    .sort((a, b) => Number(b.place_id === 'lumberton') - Number(a.place_id === 'lumberton'));
  return (
    <>
      <Steps at={2} onBack={onBack} />
      <h2 className="rf-h2">Choose a town <span className="rf-h2-note">for the {hazard}</span></h2>
      {g.cities.length === 0 && <div className="rf-muted">Loading towns…</div>}
      <div className="rf-cities">
        {towns.map((c, i) => {
          const [name, st] = c.name.split(',').map(s => s.trim());
          const s = stats[c.place_id];
          return (
            <button key={c.place_id} className="rf-city" style={{ '--i': i } as CSSProperties} onClick={() => onPick(c.place_id)}>
              <span className="rf-city-main">
                <span className="rf-city-name">{name}</span>
                <span className="rf-city-sub">
                  {BLURB[c.place_id] ?? st}{c.place_id === 'lumberton' && hazard === 'tornado' ? ' · showcase tornado path' : ''}
                </span>
              </span>
              {s && (
                <span className="rf-city-stats">
                  <span><b>{num(s.buildings)}</b> buildings</span>
                  <span><b>{num(s.pop_night)}</b> residents</span>
                </span>
              )}
              <svg className="rf-city-arrow" width="16" height="16" viewBox="0 0 24 24" aria-hidden><path d="M5 12h13M13 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </button>
          );
        })}
      </div>
      {g.canBuild && (
        <div className="rf-build">
          <div className="rf-muted">Or build any U.S. town (1–3 minutes)</div>
          {g.build ? (
            <div className="rf-build-progress">
              <div className="rf-bar"><span style={{ width: `${Math.round(g.build.progress * 100)}%` }} /></div>
              <div className="rf-muted">{g.build.message}</div>
            </div>
          ) : (
            <form className="rf-build-row" onSubmit={e => { e.preventDefault(); if (city.trim() && state.length === 2) void g.buildCity(city.trim(), state); }}>
              <input placeholder="City" value={city} onChange={e => setCity(e.target.value)} />
              <input placeholder="ST" maxLength={2} value={state} onChange={e => setState(e.target.value.toUpperCase())} />
              <button type="submit" disabled={!city.trim() || state.length !== 2}>Build</button>
            </form>
          )}
        </div>
      )}
    </>
  );
}

function Loading({ stats, onBack }: { stats: Record<string, TownStats>; onBack: () => void }) {
  const g = useGame();
  const name = g.cities.find(c => c.place_id === g.placeId)?.name.split(',')[0] ?? 'town';
  const s = stats[g.placeId];
  const town = g.place !== null;
  const ready = !INTRO_STEPS.includes(g.step);
  const rows: [string, boolean][] = [
    [s ? `${num(s.buildings)} buildings, terrain and roads` : 'Buildings, terrain and roads', town],
    ['Storm engine', ready],
  ];
  return (
    <>
      <Steps at={3} onBack={g.error ? onBack : undefined} />
      <h2 className="rf-h2">Loading {name}</h2>
      {g.error ? <div className="rf-error">{g.error}</div> : (
        <>
          <div className="rf-bar rf-bar-live"><span style={{ width: ready ? '100%' : town ? '72%' : '34%' }} /></div>
          <ul className="rf-checks">
            {rows.map(([label, done]) => (
              <li key={label} data-done={done || undefined}><span className="rf-check" />{label}</li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

function TornadoIcon() {
  return (
    <svg className="rf-ico rf-ico-tornado" viewBox="0 0 48 48" aria-hidden>
      {[[6, 42, 10], [10, 38, 16], [14, 34, 22], [17, 31, 28], [20, 28, 34], [22, 26, 40]].map(([x1, x2, y], i) => (
        <line key={i} x1={x1} x2={x2} y1={y} y2={y} style={{ '--i': i } as CSSProperties} />
      ))}
    </svg>
  );
}

function HurricaneIcon() {
  return (
    <svg className="rf-ico rf-ico-hurricane" viewBox="0 0 48 48" aria-hidden>
      <g>
        <path d="M24 24 m-4 0 a4 4 0 1 0 8 0 a4 4 0 1 0 -8 0" />
        <path d="M28 24c0-7 6-12 14-12" />
        <path d="M20 24c0 7-6 12-14 12" />
        <path d="M24 20c7 0 12-6 12-14" />
        <path d="M24 28c-7 0-12 6-12 14" />
      </g>
    </svg>
  );
}
