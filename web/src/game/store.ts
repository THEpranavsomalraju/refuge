import { create } from 'zustand';
import { scene, type BuildStatus, type LonLat, type PlaceData } from '../scene';
import type { CityEntry, SceneExtensions, TrackRow } from '../shared/contract';
import showcase from '../../../sim/scenarios/lumberton_tornado.json';
import { extendDrawnLine, trackFromDrawing } from '../../../sim/core/hurricane.js';
import { defaultBudget, hurricaneParams, isHurricane, riskBands, shelterRules, sim, type AnyScenario, type Result,
  type ShelterCandidate, type ShelterPlan, type TornadoScenario } from './simClient';
import { PAST_EVENTS, type PastEvent } from './events';
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
  yours: Result | null;
  optimal: { plan: ShelterPlan; result: Result } | null;
  view: MapView;

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
  play(): Promise<void>;
  plan(): Promise<void>;
  inspect(buildingId: string | null): void;
  toggle(buildingId: string): void;
  /** Fill the plan with the optimizer's best picks for this budget (the player can still change them). */
  fillBest(): Promise<void>;
  replay(): Promise<void>;
  best(): Promise<void>;
  show(view: MapView): void;
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
  const clearScene = () => {
    showShelters([]);
    ext.highlightBuildings?.(null);
    scene.hideRiskMap(); scene.clearBuildingGlow(); scene.hideTornadoPath(); ext.hideHurricaneTrack?.();
    scene.onGroundClick(null); scene.onBuildingClick(null);
  };
  const fresh = { baseline: null, yours: null, optimal: null, candidates: [], selected: [], inspected: null,
    view: 'before' as MapView, error: null, drawing: false, build: null };

  const showMap = (r: Result) => isHurricane(r) ? scene.showDisplacementMap(r.cells) : scene.showRiskMap(r.cells, riskBands);
  /** Cells to end the camera on: the worst band present (deep red, or extreme then severe for hurricanes). */
  const hotCells = (r: Result) => {
    const order = isHurricane(r) ? ['extreme', 'severe'] : ['deep_red', 'red'];
    for (const band of order) {
      const hits = Object.entries(r.cells).filter(([, c]) => c.band === band).map(([h3]) => h3);
      if (hits.length) return hits;
    }
    return [];
  };

  /** Simulate, animate the storm, then raise the map and end on the worst cells. */
  async function run(shelters: string[]): Promise<Result> {
    const s = scenarioOf(shelters);
    scene.hideRiskMap(); scene.clearBuildingGlow();
    set({ busy: s.hazard === 'hurricane' ? 'Computing wind at every building…' : 'Running 500 simulated storms…' });
    const result = await sim.run(s);
    set({ busy: null });
    if (s.hazard === 'tornado') {
      scene.showTornadoPath(s.path as LonLat[], s.width_m);
      scene.frameStormPath();
      await scene.playStorm(STORM_MS, stormGlow(get().place!, s.path as LonLat[], (result as { building_prob: Record<string, number> }).building_prob));
      scene.clearBuildingGlow(); scene.hideTornadoPath();
    } else if (ext.showHurricaneTrack && ext.playHurricane) {
      ext.showHurricaneTrack(s.track, categoryOf(s.track));
      await ext.playHurricane(STORM_MS);
      ext.hideHurricaneTrack?.();
    } else {
      scene.frameCoords(s.track.map(r => [r[0], r[1]] as LonLat));
    }
    await showMap(result);
    const hot = hotCells(result);
    if (hot.length) scene.focusCells(hot);
    return result;
  }

  return {
    step: 'intro', busy: null, error: null, mode: null, event: null, builtEvents: new Set(), cities: [], canBuild: false,
    build: null, hazard: 'tornado', placeId: 'lumberton', place: null,
    ef: showcase.ef, category: 2, hour: showcase.hour, warning: showcase.warning_min, path: [], drawing: false,
    budget: defaultBudget.tornado, baseline: null, candidates: [], selected: [], inspected: null, yours: null, optimal: null,
    view: 'before',

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
      if (get().path.length < 2) {
        // Nothing drawn yet: show the whole town so every part of it can be clicked.
        const [w, s, e, n] = get().place!.meta.bbox;
        scene.frameCoords([[w, s], [e, n]]);
        return;
      }
      // Preview the storm line: tornado strip at the EF width, hurricane track as a line of points.
      if (get().hazard === 'tornado') { scene.showTornadoPath(get().path, WIDTH_BY_EF[get().ef]!); scene.frameStormPath(); }
      else {
        const track = (scenarioOf() as { track: TrackRow[] }).track;
        if (ext.showHurricaneTrack) ext.showHurricaneTrack(track, get().category);
        else scene.frameCoords(get().path);
      }
    },
    startDrawing() {
      set({ drawing: true, path: [] });
      scene.hideTornadoPath(); ext.hideHurricaneTrack?.();
      get().set({});
      scene.onGroundClick((lon, lat) => {
        set({ path: [...get().path, [lon, lat] as LonLat] });
        get().set({});
      });
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
        scene.onBuildingClick(b => get().inspect(b.id));
        set({ step: 'plan' });
      } catch (e) { fail(e); }
    },
    inspect(id) { set({ inspected: id }); },
    toggle(id) {
      // Show the player where this building is.
      const c = candidate(id);
      if (c) scene.frameCoords([[c.lon, c.lat]], 1200, 350);
      const selected = get().selected.includes(id) ? get().selected.filter(x => x !== id) : [...get().selected, id];
      if (cost(selected) > get().budget && selected.length > get().selected.length) return;
      set({ selected });
      showShelters(selected);
    },
    async fillBest() {
      try {
        set({ busy: 'Finding the best plan for this budget…' });
        const optimal = await sim.optimize(scenarioOf(), get().budget, get().selected);
        const selected = optimal.plan.building_ids.filter(id => candidate(id));
        set({ selected, busy: null });
        showShelters(selected);
        const picks = selected.map(candidate).map(c => [c!.lon, c!.lat] as LonLat);
        if (picks.length) scene.frameCoords(picks, 1500, 400);
      } catch (e) { fail(e); }
    },
    async replay() {
      try {
        scene.onBuildingClick(null); ext.highlightBuildings?.(null);
        set({ step: 'replay', yours: null, inspected: null });
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
      set({ view });
      if (view.endsWith('_diff')) void scene.showDifference(baseline.cells, after.cells);
      else void showMap(after);
    },
    restart() {
      clearScene();
      set({ ...fresh, step: 'choose_mode', mode: null, event: null, busy: null });
    },
  };
});
