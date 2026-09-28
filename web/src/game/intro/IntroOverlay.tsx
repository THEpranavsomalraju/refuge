import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowRight, ChevronLeft, ChevronRight, CircleAlert, CircleCheck, CloudRainWind, Tornado } from 'lucide-react';
import { PAST_EVENTS } from '../events';
import { useGame, type Hazard } from '../store';
import { IntroScene, type IntroSceneState } from './IntroScene';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Kbd } from '@/components/ui/kbd';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Separator } from '@/components/ui/separator';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';

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
  const scene = useRef<IntroSceneState>({ focus: null, shot: 'wide' });

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

  // The render where the step first leaves the intro counts as leaving too (the effect sets `leaving` right after).
  const exiting = leaving || (wasIntro.current && !onIntroStep);
  const gone = !onIntroStep && !exiting;
  scene.current = {
    // Both storms always circle the card; the one you point at (or picked) comes forward.
    focus: hover ?? (stage === 'title' ? null : hazard),
    shot: exiting ? 'dive' : stage === 'title' ? 'wide' : 'choose',
  };

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
    <div className={cn('absolute inset-0 z-30 overflow-hidden bg-background transition-opacity delay-300 duration-700',
      exiting && 'pointer-events-none opacity-0')}>
      <IntroScene state={scene} />
      <div className="pointer-events-none absolute top-4 left-5 text-xs text-muted-foreground">Refuge · Storm simulator</div>
      <div className="pointer-events-none absolute right-5 bottom-4 hidden text-xs text-muted-foreground sm:block">
        NOAA 1996–2025 · USACE Structure Inventory · FEMA P-361
      </div>
      <div className="pointer-events-none absolute inset-0 grid place-items-center p-4">
        <Card className={cn('pointer-events-auto max-h-full w-full max-w-md gap-5 overflow-y-auto shadow-2xl transition-all duration-500',
          'animate-in fade-in zoom-in-95', exiting && 'scale-95 opacity-0')}>
          <div key={stage} className="flex animate-in flex-col gap-5 fade-in slide-in-from-bottom-2 duration-300">
            {stage === 'title' && <Title onBegin={() => setStage('hazard')} />}
            {stage === 'hazard' && (
              <HazardStep onHover={setHover} onBack={() => setStage('title')}
                onPick={h => { setHazard(h); setHover(null); setStage('city'); }} />
            )}
            {stage === 'city' && <CityStep hazard={hazard} stats={stats} onBack={() => setStage('hazard')} onPick={pickTown} />}
            {stage === 'loading' && <Loading stats={stats} onBack={() => setStage('city')} />}
          </div>
        </Card>
      </div>
    </div>
  );
}

function Title({ onBegin }: { onBegin: () => void }) {
  return (
    <>
      <CardHeader className="justify-items-center gap-3 text-center">
        <Badge variant="outline">Storm simulator for real towns</Badge>
        <CardTitle className="font-brand text-6xl font-bold tracking-tight">Refuge</CardTitle>
        <CardDescription className="max-w-sm text-balance">
          Send a tornado or hurricane through a real town. See who is at risk and why, then plan the shelters that save lives.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <Button size="lg" className="w-full" onClick={onBegin} autoFocus>Begin simulation<ArrowRight /></Button>
        <p className="text-center text-xs text-muted-foreground">or press <Kbd>Enter</Kbd></p>
      </CardContent>
    </>
  );
}

function StepHeader({ step, title, note, onBack }: { step: number; title: string; note?: string; onBack?: () => void }) {
  return (
    <CardHeader>
      <CardDescription>Step {step} of 3</CardDescription>
      <CardTitle className="text-xl">{title}{note && <span className="ml-2 text-sm font-normal text-muted-foreground">{note}</span>}</CardTitle>
      {onBack && <CardAction><Button variant="ghost" size="sm" onClick={onBack}><ChevronLeft />Back</Button></CardAction>}
    </CardHeader>
  );
}

function HazardStep({ onPick, onHover, onBack }: { onPick: (h: Hazard) => void; onHover: (h: Hazard | null) => void; onBack: () => void }) {
  const options: { id: Hazard; name: string; meta: string; text: string; icon: ReactNode }[] = [
    { id: 'tornado', name: 'Tornado', meta: 'EF0–EF5', text: 'Minutes of warning. Who is most likely to die, and which shelters save the most lives.', icon: <Tornado /> },
    { id: 'hurricane', name: 'Hurricane', meta: 'Cat 1–5', text: 'Days of warning. Which homes are lost, and where displaced people can shelter.', icon: <CloudRainWind /> },
  ];
  return (
    <>
      <StepHeader step={1} title="Choose a storm" onBack={onBack} />
      <CardContent className="grid gap-3 sm:grid-cols-2">
        {options.map(o => (
          <Button key={o.id} variant="outline" className="h-auto flex-col items-start gap-2 p-4 text-left whitespace-normal"
            onClick={() => onPick(o.id)} onPointerEnter={() => onHover(o.id)} onPointerLeave={() => onHover(null)}
            onFocus={() => onHover(o.id)} onBlur={() => onHover(null)}>
            <span className="flex size-9 items-center justify-center rounded-md bg-secondary [&_svg]:size-5">{o.icon}</span>
            <span className="flex items-center gap-2 text-base font-semibold">{o.name}<Badge variant="secondary">{o.meta}</Badge></span>
            <span className="text-xs leading-relaxed font-normal text-muted-foreground">{o.text}</span>
          </Button>
        ))}
      </CardContent>
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
      <StepHeader step={2} title="Choose a town" note={`for the ${hazard}`} onBack={onBack} />
      <CardContent className="grid gap-2">
        {g.cities.length === 0 && <div className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner />Loading towns…</div>}
        {towns.map(c => {
          const [name] = c.name.split(',').map(s => s.trim());
          const s = stats[c.place_id];
          return (
            <Button key={c.place_id} variant="outline" className="h-auto justify-between gap-4 p-4 text-left whitespace-normal" onClick={() => onPick(c.place_id)}>
              <span className="grid gap-1">
                <span className="text-base font-semibold">{name}</span>
                <span className="text-xs font-normal text-muted-foreground">
                  {BLURB[c.place_id] ?? c.name}{c.place_id === 'lumberton' && hazard === 'tornado' ? ' · showcase tornado path' : ''}
                </span>
              </span>
              <span className="flex items-center gap-3">
                {s && (
                  <span className="hidden text-right text-xs font-normal whitespace-nowrap text-muted-foreground tabular-nums sm:grid">
                    <span><span className="text-foreground">{num(s.buildings)}</span> buildings</span>
                    <span><span className="text-foreground">{num(s.pop_night)}</span> residents</span>
                  </span>
                )}
                <ChevronRight className="text-muted-foreground" />
              </span>
            </Button>
          );
        })}
        {g.canBuild && (
          <>
            <Separator className="my-2" />
            <Label>Or build any U.S. town (1–3 minutes)</Label>
            {g.build ? (
              <div className="grid gap-2">
                <Progress value={Math.round(g.build.progress * 100)} />
                <p className="text-xs text-muted-foreground">{g.build.message}</p>
              </div>
            ) : (
              <form className="flex gap-2" onSubmit={e => { e.preventDefault(); if (city.trim() && state.length === 2) void g.buildCity(city.trim(), state); }}>
                <Input placeholder="City" value={city} onChange={e => setCity(e.target.value)} />
                <Input placeholder="ST" maxLength={2} className="w-16" value={state} onChange={e => setState(e.target.value.toUpperCase())} />
                <Button type="submit" variant="secondary" disabled={!city.trim() || state.length !== 2}>Build</Button>
              </form>
            )}
          </>
        )}
      </CardContent>
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
      <StepHeader step={3} title={`Loading ${name}`} onBack={g.error ? onBack : undefined} />
      <CardContent className="grid gap-4">
        {g.error ? (
          <Alert variant="destructive"><CircleAlert /><AlertTitle>This town couldn't load</AlertTitle><AlertDescription>{g.error}</AlertDescription></Alert>
        ) : (
          <>
            <Progress value={ready ? 100 : town ? 70 : 30} />
            <ul className="grid gap-2 text-sm">
              {rows.map(([label, done]) => (
                <li key={label} className={cn('flex items-center gap-2', done ? 'text-foreground' : 'text-muted-foreground')}>
                  {done ? <CircleCheck className="size-4" /> : <Spinner />}{label}
                </li>
              ))}
            </ul>
          </>
        )}
      </CardContent>
    </>
  );
}
