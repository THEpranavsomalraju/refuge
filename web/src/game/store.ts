import { create } from 'zustand';
import { scene, type LonLat, type PlaceData } from '../scene';
import type { SceneExtensions } from '../shared/contract';
import showcase from '../../../sim/scenarios/lumberton_tornado.json';
import { defaultBudget, riskBands, sim, type DetailedResult, type ShelterCandidate, type ShelterPlan,
  type TornadoScenario } from './simClient';
import { PAST_EVENTS, type PastEvent } from './events';
import { stormGlow } from './stormGlow';

/** Median NOAA path width by EF rating, 2007-2025 (ml/exports/tornado_width_by_ef.json). */
export const WIDTH_BY_EF = [45.7, 137.2, 274.3, 640.1, 965.6, 1207];
const STORM_MS = 6000;
/** How many candidate buildings the planning list shows (the optimizer's top set). */
export const SHOWN_CANDIDATES = 12;
/** Featured towns for "Future storm" until Structures' city list exists. */
export const CITIES = [
  { place_id: 'lumberton', name: 'Lumberton, NC' },
  { place_id: 'chapel_hill', name: 'Chapel Hill, NC' },
  { place_id: 'morganton', name: 'Morganton, NC' },
];
const ext = scene as typeof scene & SceneExtensions;

/** Plan section 1. `busy` overlays any step while the worker runs. */
export type Step = 'intro' | 'choose_mode' | 'choose_event' | 'choose_city' | 'choose_hazard' | 'storm_setup'
  | 'load_place' | 'storm_animation' | 'results_map' | 'plan' | 'replay' | 'optimal' | 'score';
export type MapView = 'before' | 'yours' | 'optimal';

interface GameState {
  step: Step;
  busy: string | null;
  error: string | null;
  mode: 'past' | 'future' | null;
  event: PastEvent | null;
  placeId: string;
  place: PlaceData | null;
  /** Future-mode storm settings (past events use the event's scenario unchanged). */
  ef: number;
  hour: number;
  warning: number;
  path: LonLat[];
  drawing: boolean;
  budget: number;
  baseline: DetailedResult | null;
  candidates: ShelterCandidate[];
  /** Selected building id -> scene marker id ('' while hidden). */
  placed: Map<string, string>;
  yours: DetailedResult | null;
  optimal: { plan: ShelterPlan; result: DetailedResult } | null;
  view: MapView;
  optimalMarkers: string[];

  go(step: Step): void;
  chooseMode(mode: 'past' | 'future'): void;
  chooseEvent(id: string): void;
  chooseCity(placeId: string): void;
  chooseHazard(): void;
  placeLoaded(place: PlaceData): Promise<void>;
  placeFailed(message: string): void;
  set(patch: Partial<Pick<GameState, 'ef' | 'hour' | 'warning' | 'budget'>>): void;
  startDrawing(): void;
  play(): Promise<void>;
  plan(): Promise<void>;
  toggle(buildingId: string): void;
  /** Fill the plan with the optimizer's best picks for this budget (the player can still change them). */
  fillBest(): Promise<void>;
  replay(): Promise<void>;
  best(): Promise<void>;
  show(view: MapView): void;
  restart(): void;
}

/** A straight 8 km west-to-east path through the town center (default until the player draws). */
function defaultPath(place: PlaceData): LonLat[] {
  if (place.meta.place_id === showcase.place_id) return showcase.path as LonLat[];
  const [lon, lat] = place.meta.center;
  const dLon = 4000 / (111_320 * Math.cos(lat * Math.PI / 180));
  return [[lon - dLon, lat - 0.01], [lon + dLon, lat + 0.01]];
}

export const useGame = create<GameState>((set, get) => {
  const scenarioOf = (shelters: string[] = []): TornadoScenario => {
    const protections = shelters.map(building_id => ({ type: 'shelter' as const, building_id }));
    const { event, ef, hour, warning, path, placeId } = get();
    if (event) return { ...(event.scenario as unknown as TornadoScenario), protections };
    return { ...(showcase as unknown as TornadoScenario), place_id: placeId, ef, hour, warning_min: warning, path,
      width_m: WIDTH_BY_EF[ef]!, protections };
  };
  const candidate = (id: string) => get().candidates.find(c => c.building_id === id);
  const mark = (id: string) => { const c = candidate(id)!; return scene.placeProtection('safe_room', c.lon, c.lat); };
  const cost = () => [...get().placed.keys()].reduce((s, id) => s + (candidate(id)?.cost_usd ?? 0), 0);
  const fail = (error: unknown) => set({ error: error instanceof Error ? error.message : String(error), busy: null });
  const clearScene = () => {
    for (const marker of get().placed.values()) if (marker) scene.removeProtection(marker);
    for (const id of get().optimalMarkers) scene.removeProtection(id);
    scene.hideRiskMap(); scene.clearBuildingGlow(); scene.hideTornadoPath();
    ext.onGroundClick?.(null);
  };
  const fresh = { baseline: null, yours: null, optimal: null, candidates: [], placed: new Map<string, string>(),
    optimalMarkers: [], view: 'before' as MapView, error: null, drawing: false };

  /** Simulate, animate the storm with buildings lighting up as it passes, then raise the risk map. */
  async function run(shelters: string[]): Promise<DetailedResult> {
    const s = scenarioOf(shelters);
    scene.hideRiskMap(); scene.clearBuildingGlow();
    scene.showTornadoPath(s.path as LonLat[], s.width_m);
    set({ busy: 'Running 500 simulated storms…' });
    const result = await sim.run(s);
    set({ busy: null });
    await scene.playStorm(STORM_MS, stormGlow(get().place!, s.path as LonLat[], result.building_prob));
    scene.clearBuildingGlow(); scene.hideTornadoPath();
    await scene.showRiskMap(result.cells, riskBands);
    return result;
  }

  return {
    step: 'intro', busy: null, error: null, mode: null, event: null, placeId: 'lumberton', place: null,
    ef: showcase.ef, hour: showcase.hour, warning: showcase.warning_min, path: [], drawing: false,
    budget: defaultBudget, baseline: null, candidates: [], placed: new Map(), yours: null, optimal: null,
    view: 'before', optimalMarkers: [],

    go(step) { set({ step, error: null }); },
    chooseMode(mode) { set({ mode, step: mode === 'past' ? 'choose_event' : 'choose_city', error: null }); },
    chooseEvent(id) {
      const event = PAST_EVENTS.find(e => e.id === id)!;
      clearScene();
      set({ ...fresh, event, placeId: event.scenario.place_id, place: null, step: 'load_place', busy: 'Loading town…' });
    },
    chooseCity(placeId) {
      clearScene();
      set({ ...fresh, event: null, placeId, place: null, step: 'choose_hazard' });
    },
    chooseHazard() { set({ step: get().place ? 'storm_setup' : 'load_place', busy: get().place ? null : 'Loading town…' }); },
    async placeLoaded(place) {
      if (get().place === place) return;
      set({ place, busy: 'Loading town…' });
      try {
        await sim.load({ buildings: place.buildings, cells: place.cells, crossings: place.crossings });
        set({ busy: null, path: get().event ? [] : defaultPath(place) });
        if (get().step !== 'load_place') return;
        if (get().event) await get().play();
        else { set({ step: 'storm_setup' }); scene.showTornadoPath(get().path, WIDTH_BY_EF[get().ef]!); }
      } catch (e) { fail(e); }
    },
    placeFailed(message) {
      if (get().step === 'load_place' || get().step === 'choose_hazard') {
        set({ busy: null, error: `This town isn't built yet (places/${get().placeId}/): ${message}` });
      }
    },
    set(patch) {
      set(patch);
      if (patch.ef !== undefined && get().step === 'storm_setup') scene.showTornadoPath(get().path, WIDTH_BY_EF[get().ef]!);
    },
    startDrawing() {
      if (!ext.onGroundClick) return;
      set({ drawing: true, path: [] });
      scene.hideTornadoPath();
      ext.onGroundClick((lon, lat) => {
        const path = [...get().path, [lon, lat] as LonLat];
        set({ path });
        if (path.length >= 2) scene.showTornadoPath(path, WIDTH_BY_EF[get().ef]!);
      });
    },
    async play() {
      try {
        ext.onGroundClick?.(null);
        set({ step: 'storm_animation', drawing: false });
        const baseline = await run([]);
        set({ baseline, step: 'results_map', view: 'before' });
      } catch (e) { fail(e); }
    },
    async plan() {
      try {
        if (get().candidates.length === 0) {
          set({ busy: 'Ranking buildings…' });
          set({ candidates: await sim.candidates(scenarioOf()), busy: null });
        }
        get().show('before');
        const placed = new Map<string, string>();
        for (const id of get().placed.keys()) placed.set(id, mark(id));
        set({ step: 'plan', placed });
      } catch (e) { fail(e); }
    },
    toggle(id) {
      // Show the player where this building is.
      const c = candidate(id);
      if (c) scene.frameCoords([[c.lon, c.lat]], 1200, 350);
      const placed = new Map(get().placed);
      const marker = placed.get(id);
      if (marker !== undefined) { if (marker) scene.removeProtection(marker); placed.delete(id); }
      else {
        if (cost() + candidate(id)!.cost_usd > get().budget) return;
        placed.set(id, mark(id));
      }
      set({ placed });
    },
    async fillBest() {
      try {
        set({ busy: 'Finding the best plan for this budget…' });
        const optimal = await sim.optimize(scenarioOf(), get().budget, [...get().placed.keys()]);
        for (const marker of get().placed.values()) if (marker) scene.removeProtection(marker);
        const placed = new Map<string, string>();
        for (const id of optimal.plan.building_ids) if (candidate(id)) placed.set(id, mark(id));
        set({ placed, busy: null });
        const picks = [...placed.keys()].map(candidate).filter(Boolean).map(c => [c!.lon, c!.lat] as LonLat);
        if (picks.length) scene.frameCoords(picks, 1500, 400);
      } catch (e) { fail(e); }
    },
    async replay() {
      try {
        set({ step: 'replay' });
        const yours = await run([...get().placed.keys()]);
        set({ yours, view: 'yours' });
      } catch (e) { fail(e); }
    },
    async best() {
      try {
        set({ step: 'optimal', busy: 'Searching every affordable plan…' });
        // The user's picks join the top candidates, so the scores are comparable.
        const optimal = await sim.optimize(scenarioOf(), get().budget, [...get().placed.keys()]);
        set({ optimal, busy: null, step: 'score' });
        get().show('optimal');
      } catch (e) { fail(e); }
    },
    show(view) {
      const { baseline, yours, optimal, placed } = get();
      const result = view === 'before' ? baseline : view === 'yours' ? yours : optimal?.result;
      if (!result) return;
      for (const id of get().optimalMarkers) scene.removeProtection(id);
      for (const marker of placed.values()) if (marker) scene.removeProtection(marker);
      const next = new Map<string, string>();
      for (const id of placed.keys()) next.set(id, view === 'yours' ? mark(id) : '');
      const optimalMarkers = view === 'optimal' && optimal ? optimal.plan.building_ids.map(id => {
        const b = get().place!.buildings.find(x => x.id === id)!;
        return scene.placeProtection('safe_room', b.lon, b.lat);
      }) : [];
      set({ view, placed: next, optimalMarkers });
      void scene.showRiskMap(result.cells, riskBands);
    },
    restart() {
      clearScene();
      set({ ...fresh, step: 'choose_mode', mode: null, event: null, busy: null });
    },
  };
});
