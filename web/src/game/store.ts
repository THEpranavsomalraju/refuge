import { create } from 'zustand';
import { scene, type BuildStatus, type LonLat, type PlaceData } from '../scene';
import type { CityEntry, SceneExtensions, TrackRow } from '../shared/contract';
import showcase from '../../../sim/scenarios/lumberton_tornado.json';
import { extendDrawnLine, trackFromDrawing } from '../../../sim/core/hurricane.js';
import { defaultBudget, hurricaneParams, isHurricane, riskBands, shelterRules, sim, type AnyScenario, type Result,
  type ShelterCandidate, type ShelterPlan, type TornadoScenario } from './simClient';
import { PAST_EVENTS, type PastEvent } from './events';
import { usd } from './format';
import { stormGlow } from './stormGlow';

/** Median NOAA path width by EF rating, 2007-2025 (ml/exports/tornado_width_by_ef.json). */
export const WIDTH_BY_EF = [45.7, 137.2, 274.3, 640.1, 965.6, 1207];
const STORM_MS = 6000;
/** How many candidate buildings the planning list shows (the optimizer's top set). */
export const SHOWN_CANDIDATES = 12;
/** Saffir-Simpson lower bounds, 1-min sustained kt (ml/hurricane_wind.py CATEGORY_KT). */
const CATEGORY_KT = [64, 83, 96, 113, 137];
export const categoryOf = (track: readonly TrackRow[]) =>
  Math.max(1, CATEGORY_KT.filter(kt => Math.max(...track.map(r => r[2])) >= kt).length);
const ext = scene as typeof scene & SceneExtensions;

/** Plan section 1. `busy` overlays any step while the worker runs. */
export type Step = 'intro' | 'choose_mode' | 'choose_event' | 'choose_city' | 'choose_hazard' | 'storm_setup'
  | 'load_place' | 'storm_animation' | 'results_map' | 'plan' | 'replay' | 'optimal' | 'score';
export type Hazard = 'tornado' | 'hurricane';
/** Risk maps (before / your plan / best plan) and difference maps (what each plan changed). */
export type MapView = 'before' | 'yours' | 'optimal' | 'yours_diff' | 'optimal_diff';

interface GameState {
  step: Step;
  busy: string | null;
  error: string | null;
  mode: 'past' | 'future' | null;
  event: PastEvent | null;
  /** Past-event towns that exist (places/index.json kind "past_event"). */
  builtEvents: Set<string>;
  cities: CityEntry[];
  canBuild: boolean;
  build: BuildStatus | null;
  hazard: Hazard;
  placeId: string;
  place: PlaceData | null;
  /** Future-mode settings (past events use the event's scenario unchanged). */
  ef: number;
  category: number;
  hour: number;
  warning: number;
  path: LonLat[];
  drawing: boolean;
  budget: number;
  baseline: Result | null;
  candidates: ShelterCandidate[];
  /** Selected building ids, in the order picked. */
  selected: string[];
  /** Building shown in the shelter card. */
  inspected: string | null;
  /** Short message for the plan box (e.g. over budget). */
  notice: string | null;
  yours: Result | null;
  optimal: { plan: ShelterPlan; result: Result } | null;
  view: MapView;
  /** Risk layer lowered so the buildings show in their own colors (results screens). */
  mapHidden: boolean;

  go(step: Step): void;
  chooseMode(mode: 'past' | 'future'): Promise<void>;
  chooseEvent(id: string): void;
  chooseCity(placeId: string): void;
  buildCity(city: string, state: string): Promise<void>;
  chooseHazard(hazard: Hazard): void;
  placeLoaded(place: PlaceData): Promise<void>;
  placeFailed(message: string): void;
  set(patch: Partial<Pick<GameState, 'ef' | 'category' | 'hour' | 'warning' | 'budget'>>): void;
  startDrawing(): void;
  /** Remove the last drawn point (also right-click or Backspace on the map). */
  undoPoint(): void;
  /** Remove every drawn point. */
  clearPath(): void;
  play(): Promise<void>;
  plan(): Promise<void>;
  inspect(buildingId: string | null): void;
  /** Select or remove a shelter; over budget it leaves the plan unchanged and sets `notice`. */
  toggle(buildingId: string): void;
  /** A map click in the plan step: toggle an eligible building and open its card. */
  pickFromMap(buildingId: string): void;
  /** Fill the plan with the optimizer's best picks for this budget (the player can still change them). */
  fillBest(): Promise<void>;
  replay(): Promise<void>;
  best(): Promise<void>;
  show(view: MapView): void;
  /** Lower the risk layer to see the buildings, or raise the current view again. */
  toggleMap(): void;
  restart(): void;
}

/** Default storm line through the town (until the player draws): showcase path, or 8 km SW-NE through the center. */
function defaultPath(place: PlaceData, hazard: Hazard): LonLat[] {
  if (hazard === 'tornado' && place.meta.place_id === showcase.place_id) return showcase.path as LonLat[];
  const [lon, lat] = place.meta.center;
  const km = 4;
  const dLon = km * 1000 / (111_320 * Math.cos(lat * Math.PI / 180)), dLat = km * 1000 / 110_574;
  return [[lon - dLon, lat - dLat], [lon + dLon, lat + dLat]];
}

export const useGame = create<GameState>((set, get) => {
  const scenarioOf = (shelters: string[] = []): AnyScenario => {
    const protections = shelters.map(building_id => ({ type: 'shelter' as const, building_id }));
    const { event, ef, category, hour, warning, path, placeId, hazard } = get();
    if (event) return { ...(event.scenario as unknown as AnyScenario), protections };
    if (hazard === 'hurricane') {
      return { place_id: placeId, hazard: 'hurricane', hour, protections,
        track: trackFromDrawing(extendDrawnLine(path as [number, number][], hurricaneParams.drawn_track_extension_km),
          category, hurricaneParams) };
    }
    return { ...(showcase as unknown as TornadoScenario), place_id: placeId, ef, hour, warning_min: warning, path,
      width_m: WIDTH_BY_EF[ef]!, protections };
  };
  const candidate = (id: string) => get().candidates.find(c => c.building_id === id);
  const cost = (ids = get().selected) => ids.reduce((s, id) => s + (candidate(id)?.cost_usd ?? 0), 0);
  const reachM = () => {
    if (get().hazard === 'hurricane') return shelterRules.hurricane.reach_km * 1000;
    const t = shelterRules.tornado, s = scenarioOf() as TornadoScenario;
    return t.walk_speed_mps * Math.max(0, s.warning_min - t.mobilize_min) * 60;
  };
  const fail = (error: unknown) => set({ error: error instanceof Error ? error.message : String(error), busy: null });

  // Scene markers for the shelters on screen (the player's picks, or the best plan's).
  let markers: string[] = [];
  const showShelters = (ids: readonly string[]) => {
    for (const m of markers) scene.removeProtection(m);
    ext.hideReach?.();
    markers = ids.map(id => {
      const b = get().place!.buildings.find(x => x.id === id)!;
      ext.showReach?.(id, b.lon, b.lat, reachM());
      return scene.placeProtection('safe_room', b.lon, b.lat);
    });
  };
  /** Labeled pins over the top shelter options (and any selected ones); clicking a pin selects or removes it. */
  const refreshPins = () => {
    const hurricane = get().hazard === 'hurricane';
    const sel = new Set(get().selected);
    const ranked = get().candidates;
    const shown = ranked.filter((c, i) => i < SHOWN_CANDIDATES || sel.has(c.building_id));
    scene.showCandidateSites(shown.map(c => ({
      id: c.building_id, lon: c.lon, lat: c.lat, selected: sel.has(c.building_id),
      label: `#${ranked.indexOf(c) + 1} · ${hurricane ? `${Math.round(c.effectiveness)} served` : `${c.effectiveness.toFixed(1)} lives`}`,
    })));
  };
  const hidePins = () => { scene.hideCandidateSites(); scene.onSiteClick(null); };
  const clearScene = () => {
    hidePins();
    showShelters([]);
    ext.highlightBuildings?.(null);
    scene.hideRiskMap(); scene.clearBuildingGlow(); scene.hideTornadoPath(); ext.hideHurricaneTrack?.();
    scene.onGroundClick(null); scene.onBuildingClick(null);
  };
  const fresh = { baseline: null, yours: null, optimal: null, candidates: [], selected: [], inspected: null, notice: null,
    view: 'before' as MapView, mapHidden: false, error: null, drawing: false, build: null };

  const showMap = (r: Result) => isHurricane(r) ? scene.showDisplacementMap(r.cells) : scene.showRiskMap(r.cells, riskBands);
  /** Simulate, animate the storm, then raise the map and end on the worst cells. */
  async function run(shelters: string[]): Promise<Result> {
    const s = scenarioOf(shelters);
    scene.hideRiskMap(); scene.clearBuildingGlow();
    set({ mapHidden: false, busy: s.hazard === 'hurricane' ? 'Computing wind at every building…' : 'Running 500 simulated storms…' });
    const result = await sim.run(s);
    set({ busy: null });
    if (s.hazard === 'tornado') {
      scene.showTornadoPath(s.path as LonLat[], s.width_m);
      scene.frameStormPath();
      await scene.playStorm(STORM_MS, stormGlow(get().place!, s.path as LonLat[], (result as { building_prob: Record<string, number> }).building_prob));
      scene.clearBuildingGlow(); scene.hideTornadoPath();
    } else if (ext.showHurricaneTrack && ext.playHurricane) {
      // The full (extended) track goes to the scene; its camera stays on the town. Never frame the track here.
      ext.showHurricaneTrack(s.track, categoryOf(s.track));
      await ext.playHurricane(STORM_MS);
      ext.hideHurricaneTrack?.();
    }
    await showMap(result);
    if (isHurricane(result)) {
      // A hurricane touches the whole town; end on the hardest-hit blocks instead of zooming out to all of it.
      const worst = Object.entries(result.cells as Record<string, { displaced: number }>)
        .sort((a, b) => b[1].displaced - a[1].displaced).slice(0, 25).map(([h3]) => h3);
      if (worst.length) scene.focusCells(worst);
    } else {
      // Tornado: every affected cell in view (the path's footprint).
      scene.frameRiskMap();
    }
    return result;
  }

  return {
    step: 'intro', busy: null, error: null, mode: null, event: null, builtEvents: new Set(), cities: [], canBuild: false,
    build: null, hazard: 'tornado', placeId: 'lumberton', place: null,
    ef: showcase.ef, category: 2, hour: showcase.hour, warning: showcase.warning_min, path: [], drawing: false,
    budget: defaultBudget.tornado, baseline: null, candidates: [], selected: [], inspected: null, notice: null, yours: null, optimal: null,
    view: 'before', mapHidden: false,

    go(step) { set({ step, error: null }); },
    async chooseMode(mode) {
      set({ mode, step: mode === 'past' ? 'choose_event' : 'choose_city', error: null });
      try {
        if (mode === 'past') {
          const res = await fetch(`${import.meta.env.BASE_URL}places/index.json`);
          const index = res.ok ? (await res.json()) as { place_id: string; kind?: string }[] : [];
          set({ builtEvents: new Set(index.filter(e => e.kind === 'past_event').map(e => e.place_id)) });
        } else {
          const [cities, canBuild] = await Promise.all([scene.listCities(), scene.buildServerAvailable()]);
          set({ cities, canBuild });
        }
      } catch (e) { fail(e); }
    },
    chooseEvent(id) {
      const event = PAST_EVENTS.find(e => e.id === id)!;
      clearScene();
      set({ ...fresh, event, hazard: event.hazard, budget: defaultBudget[event.hazard], hour: Number(event.scenario.hour),
        placeId: event.scenario.place_id, place: null, step: 'load_place', busy: 'Loading town…' });
    },
    chooseCity(placeId) {
      clearScene();
      set({ ...fresh, event: null, placeId, place: null, step: 'choose_hazard' });
    },
    async buildCity(city, state) {
      try {
        set({ build: { state: 'queued', progress: 0, place_id: null, message: 'Starting…' }, error: null });
        const placeId = await scene.buildCity(city, state, s => set({ build: s }));
        set({ build: null, cities: await scene.listCities() });
        get().chooseCity(placeId);
      } catch (e) { set({ build: null }); fail(e); }
    },
    chooseHazard(hazard) {
      set({ hazard, budget: defaultBudget[hazard], step: get().place ? 'storm_setup' : 'load_place',
        busy: get().place ? null : 'Loading town…' });
      if (get().place) { set({ path: defaultPath(get().place!, hazard) }); get().set({}); }
    },
    async placeLoaded(place) {
      if (get().place === place) return;
      set({ place, busy: 'Loading town…' });
      try {
        await sim.load({ buildings: place.buildings, cells: place.cells, crossings: place.crossings });
        set({ busy: null, path: get().event ? [] : defaultPath(place, get().hazard) });
        if (get().step !== 'load_place') return;
        if (get().event) await get().play();
        else { set({ step: 'storm_setup' }); get().set({}); }
      } catch (e) { fail(e); }
    },
    placeFailed(message) {
      if (get().step === 'load_place' || get().step === 'choose_hazard') {
        set({ busy: null, error: `This town isn't available yet (places/${get().placeId}/): ${message}` });
      }
    },
    set(patch) {
      set(patch);
      if (get().step !== 'storm_setup') return;
      // The camera never moves while the player is drawing: each click only updates the preview.
      const drawing = get().drawing;
      if (get().path.length < 2) {
        // Nothing drawn yet: show the whole town once, so every part of it can be clicked.
        if (!drawing) { const [w, s, e, n] = get().place!.meta.bbox; scene.frameCoords([[w, s], [e, n]]); }
        return;
      }
      // Preview the storm line: tornado strip at the EF width, hurricane track as a line of points.
      if (get().hazard === 'tornado') { scene.showTornadoPath(get().path, WIDTH_BY_EF[get().ef]!); if (!drawing) scene.frameStormPath(); }
      else {
        const track = (scenarioOf() as { track: TrackRow[] }).track;
        if (ext.showHurricaneTrack) ext.showHurricaneTrack(track, get().category);
      }
    },
    startDrawing() {
      set({ drawing: true, path: [] });
      scene.hideTornadoPath(); ext.hideHurricaneTrack?.();
      get().set({});
      scene.onGroundClick((lon, lat) => {
        set({ path: [...get().path, [lon, lat] as LonLat] });
        get().set({});
      }, () => get().undoPoint());   // right-click or Backspace removes the last point
    },
    undoPoint() {
      if (!get().drawing || get().path.length === 0) return;
      set({ path: get().path.slice(0, -1) });
      scene.undoGroundClick();
      if (get().path.length < 2) { scene.hideTornadoPath(); ext.hideHurricaneTrack?.(); }
      get().set({});
    },
    clearPath() {
      if (!get().drawing) return;
      set({ path: [] });
      scene.clearGroundClicks();
      scene.hideTornadoPath(); ext.hideHurricaneTrack?.();
      get().set({});
    },
    async play() {
      try {
        scene.onGroundClick(null);
        set({ step: 'storm_animation', drawing: false });
        const baseline = await run([]);
        set({ baseline, step: 'results_map', view: 'before' });
      } catch (e) { fail(e); }
    },
    async plan() {
      try {
        if (get().candidates.length === 0) {
          set({ busy: 'Ranking buildings for this storm…' });
          set({ candidates: await sim.candidates(scenarioOf()), busy: null });
        }
        get().show('before');
        const top = get().candidates[0]?.effectiveness ?? 0;
        ext.highlightBuildings?.(Object.fromEntries(get().candidates.map(c => [c.building_id, top > 0 ? c.effectiveness / top : 0])));
        showShelters(get().selected);
        scene.onBuildingClick(b => get().pickFromMap(b.id));
        scene.onSiteClick(id => get().pickFromMap(id));
        set({ step: 'plan', notice: null });
        refreshPins();
      } catch (e) { fail(e); }
    },
    inspect(id) { set({ inspected: id }); },
    toggle(id) {
      const c = candidate(id);
      if (!c) return;
      const adding = !get().selected.includes(id);
      const selected = adding ? [...get().selected, id] : get().selected.filter(x => x !== id);
      if (adding && cost(selected) > get().budget) {
        const left = get().budget - cost();
        set({ notice: `Over budget: ${usd(left)} left, this shelter costs ${usd(c.cost_usd)}.` });
        return;
      }
      // Show the player where this building is.
      if (adding) scene.frameCoords([[c.lon, c.lat]], 1200, 350);
      set({ selected, notice: null });
      showShelters(selected);
      if (get().step === 'plan') refreshPins();
    },
    pickFromMap(id) {
      if (candidate(id)) get().toggle(id);
      set({ inspected: id });
    },
    async fillBest() {
      try {
        set({ busy: 'Finding the best plan for this budget…' });
        const optimal = await sim.optimize(scenarioOf(), get().budget, get().selected);
        const selected = optimal.plan.building_ids.filter(id => candidate(id));
        set({ selected, busy: null });
        showShelters(selected);
      if (get().step === 'plan') refreshPins();
        const picks = selected.map(candidate).map(c => [c!.lon, c!.lat] as LonLat);
        if (picks.length) scene.frameCoords(picks, 1500, 400);
      } catch (e) { fail(e); }
    },
    async replay() {
      try {
        scene.onBuildingClick(null); ext.highlightBuildings?.(null); hidePins();
        set({ step: 'replay', yours: null, inspected: null, notice: null });
        const yours = await run(get().selected);
        set({ yours, view: 'yours' });
      } catch (e) { fail(e); }
    },
    async best() {
      try {
        set({ step: 'optimal', busy: 'Searching every affordable plan…' });
        // The user's picks join the top candidates, so the scores are comparable.
        const optimal = await sim.optimize(scenarioOf(), get().budget, get().selected);
        set({ optimal, busy: null, step: 'score' });
        get().show('optimal_diff');
      } catch (e) { fail(e); }
    },
    show(view) {
      const { baseline, yours, optimal, selected } = get();
      const after = view.startsWith('yours') ? yours : view.startsWith('optimal') ? optimal?.result : baseline;
      if (!baseline || !after) return;
      showShelters(view === 'before' ? [] : view.startsWith('yours') ? selected : optimal!.plan.building_ids);
      set({ view, mapHidden: false });
      if (view.endsWith('_diff')) void scene.showDifference(baseline.cells, after.cells);
      else void showMap(after);
    },
    toggleMap() {
      if (get().mapHidden) { get().show(get().view); return; }
      scene.hideRiskMap();
      set({ mapHidden: true });
    },
    restart() {
      clearScene();
      set({ ...fresh, step: 'choose_mode', mode: null, event: null, busy: null });
    },
  };
});
