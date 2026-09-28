import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowRight, ChevronLeft, ChevronRight, Circle, CircleAlert, CircleCheck, CloudRainWind, MapPin, Search, Tornado, X } from 'lucide-react';
import { PAST_EVENTS } from '../events';
import { useGame, type Hazard } from '../store';
import { IntroScene, type IntroSceneState } from './IntroScene';
import { AreaPicker } from './AreaPicker';
import {
  build, BUILD_STEPS, deleteTown, listTowns, LOCAL_PREFIX, MAX_BUILDINGS, MAX_SIDE_KM, placeBoundary, searchPlaces,
  type BuildProgress, type LocalTown, type PlaceBoundary, type PlaceHit, type TownSpec,
} from '@/builder';
import { bboxKm, squareAround, type LonLat } from '@/builder/geometry';
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
 * The game's opening: title card, then storm type, then town (a featured town, one built on this
 * device, or any U.S. place, built here in the browser), then a short load before the map takes over.
 * It drives the same store actions as the old panel (chooseMode, chooseCity, chooseHazard).
 */

/** Steps that belong to the intro; the regular game panel takes over after them. */
export const INTRO_STEPS = ['intro', 'choose_mode', 'choose_event', 'choose_city', 'choose_hazard', 'load_place'];

type Stage = 'title' | 'hazard' | 'city' | 'area' | 'building' | 'loading';
interface TownStats { buildings: number; pop_night: number }
interface Pending { hit: PlaceHit; boundary: PlaceBoundary }
interface Building { name: string; progress: BuildProgress | null; error: string | null }

const BLURB: Record<string, string> = {
  lumberton: 'Eastern NC · 11% mobile homes',
  morganton: 'Western NC foothills · 7% mobile homes',
  chapel_hill: 'Piedmont college town · under 1% mobile homes',
};
const num = (n: number) => Math.round(n).toLocaleString('en-US');
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
/** Browser-built town id; a picked area of a big city gets its center in the id. */
const townId = (hit: PlaceHit, center?: LonLat) =>
  `${LOCAL_PREFIX}${slug(`${hit.name}_${hit.state}`)}${center ? `_${Math.round(center[1] * 100)}_${Math.round(-center[0] * 100)}` : ''}`;

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
  const [towns, setTowns] = useState<LocalTown[]>([]);
  const [townName, setTownName] = useState('');
  const [pending, setPending] = useState<Pending | null>(null);
  const [building, setBuilding] = useState<Building | null>(null);
  const abort = useRef<AbortController | null>(null);
  const scene = useRef<IntroSceneState>({ focus: null, shot: 'wide' });

  // Town list (and whether a build server is up) as soon as the intro shows.
  useEffect(() => { if (g.step === 'intro') void g.chooseMode('future'); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}places/index.json`)
      .then(r => (r.ok ? r.json() : []))
      .then((rows: ({ place_id: string } & TownStats)[]) => setStats(Object.fromEntries(rows.map(r => [r.place_id, r]))))
      .catch(() => undefined);
    void listTowns().then(setTowns);
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
    if (!was && onIntroStep) { setLeaving(false); setHover(null); setStage('hazard'); void listTowns().then(setTowns); }
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

  const pickTown = (placeId: string, name: string) => {
    setTownName(name);
    setStage('loading');
    g.chooseCity(placeId);
    g.chooseHazard(hazard);
  };

  const startBuild = (spec: TownSpec) => {
    abort.current?.abort();
    const ctl = new AbortController();
    abort.current = ctl;
    setBuilding({ name: spec.name, progress: null, error: null });
    setStage('building');
    build(spec, progress => setBuilding(b => (b ? { ...b, progress } : b)), ctl.signal)
      .then(entry => { void listTowns().then(setTowns); pickTown(entry.place_id, entry.name.split(',')[0]!); })
      .catch(err => { if (!ctl.signal.aborted) setBuilding(b => (b ? { ...b, error: err instanceof Error ? err.message : String(err) } : b)); });
  };

  /** A search result: small places build right away; big ones go to the area picker first. */
  const choosePlace = async (hit: PlaceHit) => {
    const boundary = await placeBoundary(hit);
    const [wKm, hKm] = bboxKm(boundary.bbox);
    const name = `${hit.name}, ${hit.stateName}`;
    setPending(null);
    if (wKm <= MAX_SIDE_KM && hKm <= MAX_SIDE_KM) startBuild({ placeId: townId(hit), name, bbox: boundary.bbox, focus: hit.center });
    else { setPending({ hit, boundary }); setStage('area'); }
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
        <Card className={cn('pointer-events-auto max-h-full w-full gap-5 overflow-y-auto shadow-2xl transition-all duration-500',
          stage === 'area' ? 'max-w-2xl' : 'max-w-md', 'animate-in fade-in zoom-in-95', exiting && 'scale-95 opacity-0')}>
          <div key={stage} className="flex animate-in flex-col gap-5 fade-in slide-in-from-bottom-2 duration-300">
            {stage === 'title' && <Title onBegin={() => setStage('hazard')} />}
            {stage === 'hazard' && (
              <HazardStep onHover={setHover} onBack={() => setStage('title')}
                onPick={h => { setHazard(h); setHover(null); setStage('city'); }} />
            )}
            {stage === 'city' && (
              <CityStep hazard={hazard} stats={stats} towns={towns} onBack={() => setStage('hazard')} onPick={pickTown}
                onPlace={choosePlace} onDelete={id => void deleteTown(id).then(() => listTowns()).then(setTowns)} />
            )}
            {stage === 'area' && pending && (
              <AreaStep pending={pending} onBack={() => setStage('city')}
                onBuild={center => startBuild({
                  placeId: townId(pending.hit, center), name: `${pending.hit.name}, ${pending.hit.stateName}`,
                  bbox: squareAround(center, MAX_SIDE_KM), center,
                })} />
            )}
            {stage === 'building' && building && (
              <BuildStep building={building} onCancel={() => { abort.current?.abort(); setStage(pending ? 'area' : 'city'); }} />
            )}
            {stage === 'loading' && <Loading name={townName} stats={stats} onBack={() => setStage('city')} />}
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

/** One town row: name, a line under it, optional stats, and a chevron. */
function TownRow({ name, sub, stats, onClick, onDelete }: {
  name: string; sub: string; stats?: TownStats; onClick: () => void; onDelete?: () => void;
}) {
  return (
    <div className="flex items-stretch gap-1">
      <Button variant="outline" className="h-auto min-w-0 flex-1 justify-between gap-4 p-4 text-left whitespace-normal" onClick={onClick}>
        <span className="grid min-w-0 gap-1">
          <span className="truncate text-base font-semibold">{name}</span>
          <span className="text-xs font-normal text-muted-foreground">{sub}</span>
        </span>
        <span className="flex items-center gap-3">
          {stats && (
            <span className="hidden text-right text-xs font-normal whitespace-nowrap text-muted-foreground tabular-nums sm:grid">
              <span><span className="text-foreground">{num(stats.buildings)}</span> buildings</span>
              <span><span className="text-foreground">{num(stats.pop_night)}</span> residents</span>
            </span>
          )}
          <ChevronRight className="text-muted-foreground" />
        </span>
      </Button>
      {onDelete && (
        <Button variant="ghost" size="icon" className="h-auto w-9" aria-label={`Remove ${name} from this device`} onClick={onDelete}><X /></Button>
      )}
    </div>
  );
}

function CityStep({ hazard, stats, towns, onPick, onPlace, onDelete, onBack }: {
  hazard: Hazard; stats: Record<string, TownStats>; towns: LocalTown[];
  onPick: (id: string, name: string) => void; onPlace: (hit: PlaceHit) => Promise<void>; onDelete: (id: string) => void; onBack: () => void;
}) {
  const g = useGame();
  // Featured towns, the showcase (Lumberton) first.
  const featured = g.cities.filter(c => c.status === 'ready' && !c.place_id.startsWith(LOCAL_PREFIX) && !PAST_EVENTS.some(e => e.scenario.place_id === c.place_id))
    .sort((a, b) => Number(b.place_id === 'lumberton') - Number(a.place_id === 'lumberton'));
  return (
    <>
      <StepHeader step={2} title="Choose a town" note={`for the ${hazard}`} onBack={onBack} />
      <CardContent className="grid gap-2">
        {g.cities.length === 0 && <div className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner />Loading towns…</div>}
        {featured.map(c => {
          const name = c.name.split(',')[0]!.trim();
          return (
            <TownRow key={c.place_id} name={name} stats={stats[c.place_id]} onClick={() => onPick(c.place_id, name)}
              sub={`${BLURB[c.place_id] ?? c.name}${c.place_id === 'lumberton' && hazard === 'tornado' ? ' · showcase tornado path' : ''}`} />
          );
        })}
        {towns.length > 0 && (
          <>
            <Label className="mt-3 text-muted-foreground">Built on this device</Label>
            {towns.map(t => (
              <TownRow key={t.place_id} name={t.name.split(',')[0]!} stats={t} onClick={() => onPick(t.place_id, t.name.split(',')[0]!)}
                sub={`${t.name.split(',').slice(1).join(',').trim()}${t.trimmed ? ' · part of the city' : ''}`} onDelete={() => onDelete(t.place_id)} />
            ))}
          </>
        )}
        <Separator className="my-2" />
        <PlaceSearch onPlace={onPlace} />
      </CardContent>
    </>
  );
}

/** Any U.S. place: type, pick a suggestion. */
function PlaceSearch({ onPlace }: { onPlace: (hit: PlaceHit) => Promise<void> }) {
  const [text, setText] = useState('');
  const [hits, setHits] = useState<PlaceHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const q = text.trim();
    if (q.length < 2) { setHits([]); return; }
    const ctl = new AbortController();
    const t = setTimeout(() => {
      setSearching(true);
      searchPlaces(q, ctl.signal).then(h => { setHits(h); setError(null); })
        .catch(e => { if (!ctl.signal.aborted) setError(e instanceof Error ? e.message : String(e)); })
        .finally(() => { if (!ctl.signal.aborted) setSearching(false); });
    }, 250);
    return () => { clearTimeout(t); ctl.abort(); };
  }, [text]);
  return (
    <div className="grid gap-2">
      <Label htmlFor="place-search">Any U.S. town or city</Label>
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input id="place-search" className="pl-9" placeholder="Try Asheville, NC or New York" value={text} autoComplete="off"
          onChange={e => setText(e.target.value)} />
        {searching && <Spinner className="absolute top-1/2 right-3 -translate-y-1/2 text-muted-foreground" />}
      </div>
      {error && <Alert variant="destructive"><CircleAlert /><AlertDescription>{error}</AlertDescription></Alert>}
      {hits.length > 0 && (
        <div className="grid gap-1">
          {hits.map(h => (
            <Button key={`${h.layer}-${h.geoid}`} variant="ghost" className="h-auto justify-between gap-3 px-3 py-2 text-left" disabled={opening !== null}
              onClick={() => {
                setOpening(h.geoid);
                onPlace(h).catch(e => setError(e instanceof Error ? e.message : String(e))).finally(() => setOpening(null));
              }}>
              <span className="flex min-w-0 items-center gap-2">
                <MapPin className="text-muted-foreground" />
                <span className="truncate">{h.name}, <span className="text-muted-foreground">{h.stateName}</span></span>
              </span>
              {opening === h.geoid ? <Spinner /> : <span className="text-xs text-muted-foreground tabular-nums">{num(h.areaKm2)} km²</span>}
            </Button>
          ))}
        </div>
      )}
      {text.trim().length >= 2 && !searching && hits.length === 0 && !error && (
        <p className="text-xs text-muted-foreground">No U.S. places start with “{text.trim()}”.</p>
      )}
      <p className="text-xs text-muted-foreground">
        Built here in your browser from public data (buildings, outlines, elevation, roads) in about a minute. Up to {num(MAX_BUILDINGS)} buildings.
      </p>
    </div>
  );
}

function AreaStep({ pending, onBuild, onBack }: { pending: Pending; onBuild: (center: LonLat) => void; onBack: () => void }) {
  const [center, setCenter] = useState<LonLat>(pending.hit.center);
  return (
    <>
      <StepHeader step={2} title={`Pick part of ${pending.hit.name}`} onBack={onBack} />
      <CardContent className="grid gap-3">
        <p className="text-sm text-muted-foreground">
          {pending.hit.name} is bigger than one simulation can hold. Click or drag to place the square on the part you want
          ({MAX_SIDE_KM} × {MAX_SIDE_KM} km; in dense areas it shrinks around its center to {num(MAX_BUILDINGS)} buildings).
        </p>
        <AreaPicker boundary={pending.boundary} start={pending.hit.center} onChange={setCenter} />
        <Button size="lg" onClick={() => onBuild(center)}>Build this area<ArrowRight /></Button>
      </CardContent>
    </>
  );
}

function BuildStep({ building, onCancel }: { building: Building; onCancel: () => void }) {
  const p = building.progress;
  const current = p?.step ?? 0;
  return (
    <>
      <StepHeader step={3} title={`Building ${building.name.split(',')[0]}`} />
      <CardContent className="grid gap-4">
        {building.error ? (
          <Alert variant="destructive"><CircleAlert /><AlertTitle>Couldn't build this town</AlertTitle><AlertDescription>{building.error}</AlertDescription></Alert>
        ) : (
          <>
            <Progress value={Math.round((p?.progress ?? 0) * 100)} />
            <ul className="grid gap-2 text-sm">
              {BUILD_STEPS.map((label, i) => (
                <li key={label} className={cn('flex items-center gap-2', i <= current ? 'text-foreground' : 'text-muted-foreground')}>
                  {i < current ? <CircleCheck className="size-4" /> : i === current ? <Spinner /> : <Circle className="size-4" />}{label}
                </li>
              ))}
            </ul>
            {p && <p className="text-xs text-muted-foreground">{p.message}</p>}
          </>
        )}
        <Button variant="outline" onClick={onCancel}>{building.error ? 'Back' : 'Cancel'}</Button>
      </CardContent>
    </>
  );
}

function Loading({ name, stats, onBack }: { name: string; stats: Record<string, TownStats>; onBack: () => void }) {
  const g = useGame();
  const s = stats[g.placeId];
  const town = g.place !== null;
  const ready = !INTRO_STEPS.includes(g.step);
  const rows: [string, boolean][] = [
    [s ? `${num(s.buildings)} buildings, terrain and roads` : 'Buildings, terrain and roads', town],
    ['Storm engine', ready],
  ];
  return (
    <>
      <StepHeader step={3} title={`Loading ${name || 'town'}`} onBack={g.error ? onBack : undefined} />
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
