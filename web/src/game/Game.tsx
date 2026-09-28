import { useEffect, useState, type ReactNode } from 'react';
import { ChevronLeft, CircleAlert, Eraser, Eye, EyeOff, Info, PenLine, Play, Undo2, X } from 'lucide-react';
import { differenceLegendFor, legendFor, RiskLegend, scene, type LoadState } from '../scene';
import { type PastEvent } from './events';
import { hurricaneParams, isHurricane, riskBands, shelterRules, type DetailedResult, type HurricaneRun,
  type Result } from './simClient';
import { useGame, type MapView } from './store';
import { useSceneStore } from '../scene/store';
import { INTRO_STEPS, IntroOverlay } from './intro/IntroOverlay';
import { shelterSiteId } from '../../../sim/core/protections.js';
import type { Place } from '../../../sim/core/types.js';
import { GROUPS, deaths, driverWords, hourWords, oneInN, usd } from './format';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Separator } from '@/components/ui/separator';
import { Slider } from '@/components/ui/slider';
import { Spinner } from '@/components/ui/spinner';
import { Toggle } from '@/components/ui/toggle';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { cn } from '@/lib/utils';

type G = ReturnType<typeof useGame.getState>;
const num = (n: number) => Math.round(n).toLocaleString('en-US');
const pct = (x: number) => `${Math.round(x * 100)}%`;
/** Scenario hour for display: the event's own hour in past mode. */
const hourOf = (g: G) => g.event ? Number(g.event.scenario.hour) : g.hour;
const warningOf = (g: G) => g.event ? Number(g.event.scenario.warning_min ?? 0) : g.warning;
const CLASS_WORDS: Record<string, string> = { SCHOOL: 'School', WORSHIP: 'Place of worship', COMMERCIAL: 'Business', BIGROOF: 'Big-box / warehouse' };
const STEP_WORDS: Partial<Record<string, string>> = {
  storm_setup: 'Set up the storm', storm_animation: 'Storm passing', results_map: 'Results', plan: 'Plan shelters',
  replay: 'Your plan', best_preview: 'Best plan', optimal: 'Best plan', score: 'Score',
};
const BACK_STEPS = ['storm_setup', 'results_map', 'plan', 'replay', 'best_preview', 'score'];

/** Game UI: intro (IntroOverlay) -> storm setup -> storm -> map -> plan -> replay -> best plan -> score. */
export function Game({ load }: { load: LoadState }) {
  const g = useGame();
  useEffect(() => {
    if (load.state === 'ready' && load.place.meta.place_id === g.placeId) void g.placeLoaded(load.place);
    if (load.state === 'error') g.placeFailed(load.message);
    // g.place resets to null when a town is chosen; rerun so an already-loaded town (same id) is picked up again.
  }, [load, g.placeId, g.place === null]); // eslint-disable-line react-hooks/exhaustive-deps

  const title = g.event ? g.event.title : g.place ? g.place.meta.name?.replace(/, USA$/, '') ?? 'Refuge' : 'Refuge';
  // The blue "what your plan changed" view gets its own legend.
  const base = g.view.endsWith('_diff') ? differenceLegendFor(g.hazard)
    : g.hazard === 'hurricane'
      ? legendFor('hurricane', hurricaneParams.cells.bands, hurricaneParams.cells.min_residents)
      : legendFor('tornado', riskBands, riskBands.min_cell_people);
  // "Your plan" / "Best plan" maps: areas the shelters took care of are drawn in blue.
  const legend = g.view === 'yours' || g.view === 'optimal'
    ? { ...base, rows: [{ label: 'Protected', range: g.hazard === 'hurricane' ? 'people here have a shelter bed' : 'people here reach a shelter', color: '#4a90d9', hatched: false }, ...base.rows] }
    : base;
  const intro = INTRO_STEPS.includes(g.step);
  return (
    <>
      <IntroOverlay />
      {!intro && (
        // Above the map's floating labels (drei Html uses z-index up to 20), below the intro (30).
        <Card className="absolute top-3 left-3 z-[25] flex max-h-[calc(100%-24px)] w-[340px] gap-0 overflow-hidden py-0">
          <CardHeader className="border-b pt-4 [.border-b]:pb-4">
            <CardDescription className="text-xs">{g.hazard === 'hurricane' ? 'Hurricane' : 'Tornado'} · {STEP_WORDS[g.step] ?? 'Simulation'}</CardDescription>
            <CardTitle className="text-base">{title}</CardTitle>
            {!g.busy && BACK_STEPS.includes(g.step) && (
              <CardAction>
                <Button variant="ghost" size="sm" onClick={g.back}><ChevronLeft />Back</Button>
              </CardAction>
            )}
          </CardHeader>
          <CardContent className="flex flex-col gap-4 overflow-y-auto py-4">
            {g.error && (
              <Alert variant="destructive">
                <CircleAlert />
                <AlertTitle>Something went wrong</AlertTitle>
                <AlertDescription>{g.error}</AlertDescription>
              </Alert>
            )}
            {g.busy ? <Muted className="flex items-center gap-2 text-sm"><Spinner />{g.busy}</Muted> : <Step />}
            {g.error && <Button variant="outline" onClick={g.restart}>Back to start</Button>}
          </CardContent>
        </Card>
      )}
      {g.step === 'plan' && g.inspected && <ShelterCard />}
      {g.step === 'plan' && <ShelterHoverCard />}
      {g.baseline && !g.mapHidden && <HoverCard />}
      {g.baseline && !g.mapHidden && <div className="absolute top-[60px] right-3 z-[25]"><RiskLegend legend={legend} /></div>}
    </>
  );
}

function Step() {
  const g = useGame();
  switch (g.step) {
    case 'storm_setup': return <Setup />;
    case 'storm_animation': return <Muted className="flex items-center gap-2 text-sm"><Spinner />{g.hazard === 'hurricane' ? 'Hurricane passing…' : 'Storm passing through town…'}</Muted>;
    case 'results_map': return (
      <>
        {g.event ? <RecordedVsSimulated /> : <Summary r={g.baseline!} />}
        <Button onClick={() => void g.plan()}>Plan shelters</Button>
        <MapToggle />
      </>
    );
    case 'plan': return <Planning />;
    case 'replay': return g.yours ? (
      <>
        <BeforeAfter />
        <Views options={['before', 'yours', 'yours_diff']} />
        <Button onClick={() => void g.best()}>Show the best plan</Button>
        <Button variant="outline" onClick={() => void g.plan()}>Change my plan</Button>
      </>
    ) : <Muted className="flex items-center gap-2 text-sm"><Spinner />Replaying the same storm…</Muted>;
    case 'best_preview': return <BestPreview />;
    case 'optimal': return <Muted className="flex items-center gap-2 text-sm"><Spinner />Replaying the storm with the best plan…</Muted>;
    case 'score': return <Compare />;
    default: return null;   // intro steps are handled by IntroOverlay
  }
}

function Muted({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('text-xs leading-relaxed text-muted-foreground', className)}>{children}</div>;
}
function SectionTitle({ children }: { children: ReactNode }) {
  return <div className="text-sm font-medium">{children}</div>;
}
/** Label/value pairs in a bordered box. */
function Rows({ rows, className }: { rows: [ReactNode, ReactNode, boolean?][]; className?: string }) {
  return (
    <div className={cn('grid gap-2 rounded-lg border p-3 text-sm', className)}>
      {rows.map(([k, v, strong], i) => (
        <div key={i} className={cn('flex items-baseline justify-between gap-3', strong ? 'font-medium' : '')}>
          <span className={strong ? '' : 'text-muted-foreground'}>{k}</span><span className="text-right tabular-nums">{v}</span>
        </div>
      ))}
    </div>
  );
}

function Setup() {
  const g = useGame();
  const tornado = g.hazard === 'tornado';
  return (
    <>
      <div className="grid gap-2">
        <Label>{tornado ? 'Strength' : 'Category'}</Label>
        <ToggleGroup type="single" variant="outline" size="sm" className="w-full"
          value={String(tornado ? g.ef : g.category)}
          onValueChange={v => { if (v) g.set(tornado ? { ef: Number(v) } : { category: Number(v) }); }}>
          {(tornado ? [0, 1, 2, 3, 4, 5] : [1, 2, 3, 4, 5]).map(n => (
            <ToggleGroupItem key={n} value={String(n)}>{tornado ? `EF${n}` : `Cat ${n}`}</ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
      <div className="grid gap-3">
        <div className="flex items-center justify-between"><Label>Time of day</Label><span className="text-sm tabular-nums text-muted-foreground">{hourWords(g.hour)}</span></div>
        <Slider min={0} max={23} step={1} value={[g.hour]} onValueChange={([v]) => g.set({ hour: v ?? g.hour })} />
      </div>
      {tornado && (
        <div className="grid gap-3">
          <div className="flex items-center justify-between"><Label>Warning</Label><span className="text-sm tabular-nums text-muted-foreground">{g.warning} min</span></div>
          <Slider min={0} max={30} step={1} value={[g.warning]} onValueChange={([v]) => g.set({ warning: v ?? g.warning })} />
        </div>
      )}
      <Separator />
      <div className="grid gap-2">
        <Button variant="outline" onClick={g.startDrawing}>
          <PenLine />{g.drawing ? `Click the map to add points (${g.path.length})` : `Draw the ${tornado ? 'path' : 'track'}`}
        </Button>
        {g.drawing && (
          <div className="grid grid-cols-2 gap-2">
            <Button variant="outline" size="sm" disabled={g.path.length === 0} onClick={g.undoPoint}><Undo2 />Undo</Button>
            <Button variant="outline" size="sm" disabled={g.path.length === 0} onClick={g.clearPath}><Eraser />Clear</Button>
          </div>
        )}
        <Muted>
          {g.drawing ? 'Click at least two points. Right-click or Backspace removes the last one.'
            : `Using ${g.placeId === 'lumberton' && tornado ? 'the showcase path through both mobile-home parks' : `a default ${tornado ? 'path' : 'track'} through the town center`} until you draw one.`}
          {!tornado && ` The storm arrives from ${hurricaneParams.drawn_track_extension_km} km out along your line at 20 km/h; size and shape from recent Category ${g.category} hurricanes (NOAA HURDAT2).`}
        </Muted>
      </div>
      <Button size="lg" disabled={g.path.length < 2} onClick={() => void g.play()}><Play />Play storm</Button>
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
    <div className="grid gap-4">
      <Muted>EF{ef} tornado · {hourWords(hourOf(g))} · {warning} min warning · no shelters</Muted>
      <div className="grid grid-cols-2 gap-2">
        <Stat value={num(r.people_exposed)} label="people in buildings the storm damaged" />
        <Stat value={deaths(r.expected_deaths)} label="expected deaths" strong />
      </div>
      <Muted>Most likely between <span className="font-medium text-foreground">{r.p05}</span> and <span className="font-medium text-foreground">{r.p95}</span> deaths (9 in 10 of 500 simulated storms).</Muted>
      {parts.length > 0 && (
        <div className="grid gap-3">
          <SectionTitle>Where the deaths happen</SectionTitle>
          {parts.map(([label, v]) => <Share key={label} label={label} value={deaths(v)} share={v / total} />)}
        </div>
      )}
    </div>
  );
}

/** One headline number with its meaning underneath. */
function Stat({ value, label, strong }: { value: string; label: string; strong?: boolean }) {
  return (
    <div className="grid content-start gap-1 rounded-lg border p-3">
      <div className={cn('text-2xl font-semibold tabular-nums', strong ? 'text-destructive' : '')}>{value}</div>
      <Muted>{label}</Muted>
    </div>
  );
}

/** A labeled share bar (where deaths or displacement happen). */
function Share({ label, value, share }: { label: string; value: string; share: number }) {
  return (
    <div className="grid gap-1.5">
      <div className="flex justify-between text-sm"><span>{label}</span><span className="tabular-nums text-muted-foreground">{value}</span></div>
      <Progress value={Math.max(2, Math.round(share * 100))} className="h-1.5 [&_[data-slot=progress-indicator]]:bg-destructive" />
    </div>
  );
}
const groups = (r: DetailedResult) => GROUPS.map(({ label, classes }) =>
  [label, classes.reduce((a, c) => a + (r.by_class[c as keyof typeof r.by_class] ?? 0), 0)] as const).filter(([, v]) => v >= 0.05);

const RES_WORDS: Record<string, string> = { MH: 'Mobile homes', RES_WOOD: 'Wood-frame houses', RES_MASONRY: 'Masonry houses', MULTI: 'Apartments' };
function HurricaneSummary({ r }: { r: HurricaneRun }) {
  return (
    <div className="grid gap-4">
      <Muted>Hurricane · no shelters · displaced = home at major damage or worse</Muted>
      <div className="grid grid-cols-2 gap-2">
        <Stat value={num(r.displaced)} label={`of ${num(r.residents)} residents displaced (${Math.round((100 * r.displaced) / Math.max(1, r.residents))}%)`} strong />
        <Stat value={num(r.destroyed)} label="from homes destroyed" />
      </div>
      <div className="grid gap-3">
        <SectionTitle>Displaced, by type of home</SectionTitle>
        {Object.entries(r.by_class).filter(([, c]) => c.displaced >= 0.5).map(([cls, c]) => (
          <Share key={cls} label={RES_WORDS[cls] ?? cls} value={`${num(c.displaced)} of ${num(c.residents)}`} share={c.displaced / Math.max(1, c.residents)} />
        ))}
      </div>
      <Muted>Expected deaths from wind at home: {r.expected_deaths.toFixed(2)} (hurricane wind rarely kills people indoors).</Muted>
    </div>
  );
}

/** Past mode: NOAA's record next to the simulation, plus every caveat from the event file. */
function RecordedVsSimulated() {
  const g = useGame();
  const e = g.event!, r = g.baseline!;
  const rec = e.recorded as PastEvent['recorded'] & { deaths_indirect?: number };
  return (
    <div className="grid gap-3">
      <Muted>{e.subtitle}</Muted>
      <div className="grid grid-cols-2 gap-2">
        <Stat value={String(rec.deaths_direct)} label="direct deaths recorded (NOAA)" />
        {isHurricane(r)
          ? <Stat value={r.expected_deaths.toFixed(2)} label="simulated deaths from wind at home" strong />
          : <Stat value={deaths(r.expected_deaths)} label={`simulated · ${r.p05}–${r.p95}`} strong />}
      </div>
      {e.notes.map(n => <Muted key={n}>{n}</Muted>)}
    </div>
  );
}

function Planning() {
  const g = useGame();
  const hurricane = g.hazard === 'hurricane';
  const h = hurricane ? shelterRules.hurricane : shelterRules.tornado;
  const t = shelterRules.tornado;
  const reach = Math.round(t.walk_speed_mps * Math.max(0, warningOf(g) - t.mobilize_min) * 60);
  const byId = (id: string) => g.candidates.find(c => c.building_id === id);
  const spent = g.selected.reduce((s, id) => s + (byId(id)?.cost_usd ?? 0), 0);
  return (
    <>
      {g.baseline && (g.event ? <RecordedVsSimulated /> : <Summary r={g.baseline} />)}
      <Separator />
      <div className="grid gap-1">
        <SectionTitle>Plan your shelters</SectionTitle>
        <Muted>Click a highlighted school, church or business to make it a shelter; click again to remove it. Hover one to see its size and cost.</Muted>
      </div>
      <MapToggle label={g.mapHidden ? 'Show the risk map' : 'Hide the risk map to see the options'} />
      <Alert>
        <Info />
        <AlertTitle>Shelter rules</AlertTitle>
        <AlertDescription className="text-xs">
          <p>FEMA P-361 safe room: {h.sqft_per_person} sq ft and {usd(h.cost_per_person)} per person.</p>
          <p>{hurricane
            ? `Displaced residents within ${shelterRules.hurricane.reach_km} km drive there, nearest first.`
            : `Its own occupants first, then about ${pct(t.compliance)} of mobile-home residents within ${reach} m.`}</p>
        </AlertDescription>
      </Alert>
      <div className="grid gap-2">
        <div className="flex items-center justify-between">
          <Label htmlFor="budget">Budget</Label>
          <span className="text-xs tabular-nums text-muted-foreground">{usd(spent)} of {usd(g.budget)} spent</span>
        </div>
        <Input id="budget" type="number" min={0} step={hurricane ? 1_000_000 : 50_000} value={g.budget}
          onChange={e => g.set({ budget: Math.max(0, Number(e.target.value) || 0) })} />
        <Progress value={Math.min(100, g.budget ? (100 * spent) / g.budget : 0)} className="h-1.5" />
      </div>
      {g.notice && <Alert variant="destructive"><CircleAlert /><AlertDescription>{g.notice}</AlertDescription></Alert>}
      <div className="grid gap-2">
        <div className="flex items-center gap-2"><SectionTitle>Your shelters</SectionTitle><Badge variant="secondary">{g.selected.length}</Badge></div>
        {g.selected.length === 0 && <Muted>None yet. Click a highlighted building on the map.</Muted>}
        {g.selected.map(id => {
          const c = byId(id);
          if (!c) return null;
          const name = CLASS_WORDS[c.cls] ?? c.cls;
          return (
            <div key={id} className="flex items-center justify-between gap-2 rounded-lg border py-2 pr-1.5 pl-3">
              <div className="grid">
                <Button variant="link" size="sm" className="h-auto justify-start p-0 text-foreground" onClick={() => g.inspect(id)}>{name}</Button>
                <Muted>{num(c.capacity)} people · {usd(c.cost_usd)}</Muted>
              </div>
              <Button variant="ghost" size="icon" className="size-7" aria-label={`Remove ${name}`} onClick={() => g.toggle(id)}><X /></Button>
            </div>
          );
        })}
      </div>
      <Button size="lg" onClick={() => void g.replay()}>
        <Play />Replay with {g.selected.length} shelter{g.selected.length === 1 ? '' : 's'}
      </Button>
    </>
  );
}

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
  const on = g.selected.includes(c.building_id);
  return (
    <Card className="pointer-events-none fixed z-30 w-64 gap-3 py-4" style={{ left: pos[0] + 18, top: pos[1] + 18 }}>
      <CardHeader className="px-4">
        <CardTitle className="text-sm">{b ? CLASS_WORDS[b.cls] ?? b.cls : 'Building'}</CardTitle>
        <CardDescription className="text-xs">{on ? 'In your plan · click to remove' : 'Click to add to your plan'}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-2 px-4">
        <Rows className="border-0 p-0" rows={[['Capacity', `${num(c.capacity)} people`], ['Cost', usd(c.cost_usd)]]} />
        <Muted>Serves {g.hazard === 'hurricane' ? `displaced people within ${shelterRules.hurricane.reach_km} km` : `people within a ${Math.round(reachM)} m walk`} (the ring).</Muted>
      </CardContent>
    </Card>
  );
}

/** Card for the building the player clicked (plan step). */
function ShelterCard() {
  const g = useGame();
  const id = g.inspected!;
  const c = g.candidates.find(x => x.building_id === id);
  const b = g.place?.buildings.find(x => x.id === id);
  const on = g.selected.includes(id);
  const spent = g.selected.reduce((s, x) => s + (g.candidates.find(y => y.building_id === x)?.cost_usd ?? 0), 0);
  const hurricane = g.hazard === 'hurricane';
  return (
    <Card className="absolute right-3 bottom-3 z-[25] w-[300px] gap-3 py-4">
      <CardHeader className="px-4">
        <CardTitle className="text-sm">{b ? CLASS_WORDS[b.cls] ?? b.cls : 'Building'}</CardTitle>
        <CardDescription className="text-xs">{c ? 'Hardened safe room (FEMA P-361), built to survive a direct hit' : 'Not eligible'}</CardDescription>
        <CardAction><Button variant="ghost" size="icon" className="size-7" aria-label="Close" onClick={() => g.inspect(null)}><X /></Button></CardAction>
      </CardHeader>
      <CardContent className="grid gap-3 px-4">
        {!c ? (
          <Muted>Only schools, places of worship and businesses with a known footprint can become shelters.</Muted>
        ) : (
          <>
            <Rows rows={[
              ['Footprint', `${num(c.footprint_sqft)} sq ft`],
              ['Capacity', `${num(c.capacity)} people`],
              ['Space', `${hurricane ? shelterRules.hurricane.sqft_per_person : shelterRules.tornado.sqft_per_person} sq ft each`],
              ['Cost', usd(c.cost_usd)],
            ]} />
            <Button variant={on ? 'outline' : 'default'} onClick={() => g.toggle(id)}>{on ? 'Remove from plan' : 'Add to plan'}</Button>
            {!on && spent + c.cost_usd > g.budget && <Alert variant="destructive"><CircleAlert /><AlertDescription>Over budget: {usd(g.budget - spent)} left.</AlertDescription></Alert>}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function BeforeAfter() {
  const g = useGame();
  const before = g.baseline!, after = g.yours!;
  const n = g.selected.length;
  const plural = `${n} shelter${n === 1 ? '' : 's'}`;
  if (isHurricane(before) && isHurricane(after)) {
    return (
      <div className="grid gap-2">
        <Rows rows={[
          ['Displaced without shelter, before', num(before.displaced_unsheltered)],
          [`With your ${plural}`, num(after.displaced_unsheltered)],
          ['People sheltered', num(after.sheltered), true],
        ]} />
        <Muted>Need served {(after.need_served ?? 0).toFixed(0)} (1 per person from a destroyed home, 0.5 from major damage).</Muted>
      </div>
    );
  }
  const b = before as DetailedResult, a = after as DetailedResult;
  return (
    <div className="grid gap-2">
      <Rows rows={[
        ['Expected deaths, before', deaths(b.expected_deaths)],
        [`With your ${plural}`, deaths(a.expected_deaths)],
        ['Lives saved', (b.expected_deaths - a.expected_deaths).toFixed(1), true],
      ]} />
      <Muted>{num(a.sheltered ?? 0)} people in shelters · range {a.p05}–{a.p95}. {HOME_NOTE}</Muted>
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
    return <Muted>{head} {num(sheltered)} of {num(displaced)} displaced people get a shelter bed ({pct(displaced ? sheltered / displaced : 0)}).</Muted>;
  }
  const before = (g.baseline as DetailedResult).expected_deaths, after = (result as DetailedResult).expected_deaths;
  return <Muted>{head} Saves {(before - after).toFixed(1)} of {before.toFixed(1)} expected deaths.</Muted>;
}

function BestPreview() {
  const g = useGame();
  const plan = g.optimal!.plan;
  const cs = plan.building_ids.map(id => g.candidates.find(c => c.building_id === id)).filter(Boolean);
  const places = cs.reduce((s, c) => s + (c?.capacity ?? 0), 0);
  const names = cs.map(c => CLASS_WORDS[c!.cls] ?? c!.cls).join(', ') || 'no shelters';
  return (
    <>
      <div className="grid gap-1">
        <SectionTitle>The best plan for {usd(g.budget)}</SectionTitle>
        <Muted>{plan.building_ids.length} shelters ({names}), {num(places)} places, {usd(plan.cost_usd)}. They're marked on the map. Run it to see what it changes.</Muted>
      </div>
      <Button size="lg" onClick={() => void g.runBest()}><Play />Run the best plan</Button>
      <Button variant="outline" onClick={() => { g.go('replay'); g.show('yours'); }}>Back to my plan</Button>
    </>
  );
}

const objective = (g: G) => g.hazard === 'hurricane' ? 'need served' : 'lives saved';

function Compare() {
  const g = useGame();
  const plan = g.optimal!.plan;
  const yours = isHurricane(g.yours!) ? (g.yours.need_served ?? 0)
    : (g.baseline as DetailedResult).expected_deaths - (g.yours as DetailedResult).expected_deaths;
  const none = plan.value <= 1e-9;
  const yourCost = g.selected.reduce((s, id) => s + (g.candidates.find(c => c.building_id === id)?.cost_usd ?? 0), 0);
  const names = plan.building_ids.map(id => CLASS_WORDS[g.candidates.find(c => c.building_id === id)?.cls ?? ''] ?? id).join(', ') || 'no shelters';
  const label = plan.label === 'best' ? 'Best' : 'Best found';
  const score = none ? 0 : Math.round(100 * yours / plan.value);
  return (
    <>
      {none ? <SectionTitle>No shelter plan among these buildings helps in this storm.</SectionTitle> : (
        <div className="grid gap-2">
          <div className="text-4xl font-semibold tabular-nums">{score}%</div>
          <Muted>of the {objective(g)} the {label.toLowerCase()} plan achieves</Muted>
          <Progress value={Math.min(100, score)} className="h-1.5" />
        </div>
      )}
      <Rows rows={[
        ['Your plan', `${yours.toFixed(1)} · ${usd(yourCost)}`],
        [`${label} plan`, `${plan.value.toFixed(1)} · ${usd(plan.cost_usd)}`, true],
      ]} />
      <div className="grid gap-1.5">
        <PlanSentence who="Your plan" ids={g.selected} result={g.yours!} />
        <PlanSentence who={`${label} plan`} ids={plan.building_ids} result={g.optimal!.result} />
        <Muted>
          {label} plan: {names}.
          {plan.method === 'exhaustive'
            ? ` Every affordable combination of the ${plan.candidates.length} top buildings (including yours) was checked: ${num(plan.evaluated)} plans within ${usd(g.budget)}.`
            : ` Greedy search with swaps over ${plan.candidates.length} buildings; not guaranteed optimal.`}
        </Muted>
      </div>
      <Separator />
      <Views options={['yours_diff', 'optimal_diff', 'before', 'yours', 'optimal']} />
      <div className="grid grid-cols-2 gap-2">
        <Button variant="outline" onClick={() => void g.plan()}>Try another plan</Button>
        <Button variant="outline" onClick={g.restart}>New storm</Button>
      </div>
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
    <div className="grid gap-2">
      <Label>Map view</Label>
      <div className="grid grid-cols-2 gap-2">
        {options.map(v => (
          <Toggle key={v} variant="outline" size="sm" pressed={g.view === v && !g.mapHidden} onPressedChange={() => g.show(v)}
            className="h-auto min-h-8 py-1.5 text-xs whitespace-normal">
            {VIEW_WORDS[v]}
          </Toggle>
        ))}
      </div>
      <MapToggle />
    </div>
  );
}

/** Lowers the risk layer so the buildings show, or raises it again. */
function MapToggle({ label }: { label?: string }) {
  const g = useGame();
  return (
    <Toggle variant="outline" size="sm" className="w-full text-xs" pressed={g.mapHidden} onPressedChange={() => g.toggleMap()}>
      {g.mapHidden ? <Eye /> : <EyeOff />}
      {label ?? (g.mapHidden ? 'Show the risk map' : 'Hide the risk map (see buildings)')}
    </Toggle>
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
      <CellCard title={c.band === 'sparse' ? 'Too few residents for a stable estimate' : `${pct(c.share)} of residents displaced`}
        rows={[['Residents', num(c.residents)], [`Displaced${g.view !== 'before' ? ' without shelter' : ''}`, num(c.displaced)]]} />
    );
  }
  const c = result.cells[h3];
  if (!c) return null;
  return (
    <CellCard title={c.band === 'sparse' ? 'Too few people for a stable estimate' : `${oneInN(c.risk)} chance of death for someone here`}
      rows={[
        [`People at ${hourWords(hourOf(g))}`, String(Math.round(c.people))],
        ...(c.expected_deaths > 0 ? [['Expected deaths', `${c.expected_deaths.toFixed(2)} (${c.p05}–${c.p95})`] as [string, string]] : []),
      ]}
      note={c.drivers.length > 0 ? `${driverWords(c.drivers, hourOf(g))}${c.uncertain ? ' · uncertain' : ''}` : undefined} />
  );
}

/** Small read-out for the map cell under the cursor, bottom center. */
function CellCard({ title, rows, note }: { title: string; rows: [string, string][]; note?: string }) {
  return (
    <Card className="pointer-events-none absolute bottom-3 left-1/2 z-[25] w-[320px] -translate-x-1/2 gap-3 py-4">
      <CardHeader className="px-4"><CardTitle className="text-sm leading-snug">{title}</CardTitle></CardHeader>
      <CardContent className="grid gap-2 px-4">
        <Rows className="border-0 p-0" rows={rows} />
        {note && <Muted>{note}</Muted>}
      </CardContent>
    </Card>
  );
}

/** Before -> after for one cell under one plan (absent cells count as 0). */
function DiffHover({ h3, before, after, title }: { h3: string; before: Result; after: Result; title: string }) {
  if (isHurricane(before) && isHurricane(after)) {
    const b = before.cells[h3], a = after.cells[h3];
    if (!b && !a) return null;
    const was = b?.displaced ?? 0, now = a?.displaced ?? 0;
    return <CellCard title={`${title}: ${num(Math.max(0, was - now))} people sheltered from here`}
      rows={[['Displaced without shelter', `${num(was)} → ${num(now)}`], ['Residents', num(b?.residents ?? a?.residents ?? 0)]]} />;
  }
  const b = (before as DetailedResult).cells[h3], a = (after as DetailedResult).cells[h3];
  if (!b && !a) return null;
  const was = b?.expected_deaths ?? 0, now = a?.expected_deaths ?? 0;
  return <CellCard title={`${title}: ${Math.max(0, was - now).toFixed(2)} lives saved here`}
    rows={[['Expected deaths', `${was.toFixed(2)} → ${now.toFixed(2)}`], ['People here', String(Math.round(b?.people ?? a?.people ?? 0))]]} />;
}
