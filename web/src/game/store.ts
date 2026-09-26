import { create } from 'zustand';
import { scene, type LonLat, type PlaceData } from '../scene';
import showcase from '../../../sim/scenarios/lumberton_tornado.json';
import { defaultBudget, riskBands, sim, type DetailedResult, type ShelterCandidate, type ShelterPlan,
  type TornadoScenario } from './simClient';
import { stormGlow } from './stormGlow';

/** Median NOAA path width by EF rating, 2007-2025 (ml/exports/tornado_width_by_ef.json). */
export const WIDTH_BY_EF = [45.7, 137.2, 274.3, 640.1, 965.6, 1207];
const STORM_MS = 6000;
/** How many candidate buildings the planning list shows (the optimizer's top set). */
export const SHOWN_CANDIDATES = 12;

export type Phase = 'loading' | 'setup' | 'simulating' | 'storm' | 'results' | 'planning' | 'replayed' | 'compare';
export type MapView = 'before' | 'yours' | 'optimal';

interface GameState {
  phase: Phase;
  error: string | null;
  place: PlaceData | null;
  ef: number;
  hour: number;
  warning: number;
  path: LonLat[];
  budget: number;
  baseline: DetailedResult | null;
  /** Every eligible building for this storm, most effective first. */
  candidates: ShelterCandidate[];
  /** Selected building id -> scene marker id ('' while hidden). */
  placed: Map<string, string>;
  yours: DetailedResult | null;
  optimal: { plan: ShelterPlan; result: DetailedResult } | null;
  view: MapView;
  optimalMarkers: string[];

  init(place: PlaceData): Promise<void>;
  set(patch: Partial<Pick<GameState, 'ef' | 'hour' | 'warning' | 'budget'>>): void;
  play(): Promise<void>;
  plan(): Promise<void>;
  toggle(buildingId: string): void;
  replay(): Promise<void>;
  compare(): Promise<void>;
  show(view: MapView): void;
  restart(): void;
}

export const useGame = create<GameState>((set, get) => {
  const scenarioOf = (shelters: string[] = []): TornadoScenario => {
    const { ef, hour, warning, path } = get();
    return { ...(showcase as unknown as TornadoScenario), ef, hour, warning_min: warning, path,
      width_m: WIDTH_BY_EF[ef]!, protections: shelters.map(building_id => ({ type: 'shelter' as const, building_id })) };
  };
  const candidate = (id: string) => get().candidates.find(c => c.building_id === id);
  const mark = (id: string) => { const c = candidate(id)!; return scene.placeProtection('safe_room', c.lon, c.lat); };
  const cost = () => [...get().placed.keys()].reduce((s, id) => s + (candidate(id)?.cost_usd ?? 0), 0);

  /** Simulate, animate the storm with buildings lighting up as it passes, then raise the risk map. */
  async function run(shelters: string[]): Promise<DetailedResult> {
    const s = scenarioOf(shelters);
    scene.hideRiskMap();
    scene.clearBuildingGlow();
    scene.showTornadoPath(s.path as LonLat[], s.width_m);
    set({ phase: 'simulating' });
    const result = await sim.run(s);
    set({ phase: 'storm' });
    await scene.playStorm(STORM_MS, stormGlow(get().place!, s.path as LonLat[], result.building_prob));
    scene.clearBuildingGlow();
    scene.hideTornadoPath();
    await scene.showRiskMap(result.cells, riskBands);
    return result;
  }
  const fail = (error: unknown) => set({ error: error instanceof Error ? error.message : String(error) });

  return {
    phase: 'loading', error: null, place: null,
    ef: showcase.ef, hour: showcase.hour, warning: showcase.warning_min, path: showcase.path as LonLat[],
    budget: defaultBudget, baseline: null, candidates: [], placed: new Map(), yours: null, optimal: null,
    view: 'before', optimalMarkers: [],

    async init(place) {
      if (get().place === place) return;
      set({ place, phase: 'loading' });
      await sim.load({ buildings: place.buildings, cells: place.cells, crossings: place.crossings });
      set({ phase: 'setup' });
      scene.showTornadoPath(get().path, WIDTH_BY_EF[get().ef]!);
    },
    set(patch) {
      set(patch);
      if (patch.ef !== undefined) scene.showTornadoPath(get().path, WIDTH_BY_EF[get().ef]!);
    },
    async play() {
      try {
        const baseline = await run([]);
        set({ baseline, phase: 'results', view: 'before' });
      } catch (e) { fail(e); }
    },
    async plan() {
      try {
        if (get().candidates.length === 0) set({ candidates: await sim.candidates(scenarioOf()) });
        get().show('before');
        const placed = new Map<string, string>();
        for (const id of get().placed.keys()) placed.set(id, mark(id));
        set({ phase: 'planning', placed });
      } catch (e) { fail(e); }
    },
    toggle(id) {
      const placed = new Map(get().placed);
      const marker = placed.get(id);
      if (marker !== undefined) { if (marker) scene.removeProtection(marker); placed.delete(id); }
      else {
        if (cost() + candidate(id)!.cost_usd > get().budget) return;
        placed.set(id, mark(id));
      }
      set({ placed });
    },
    async replay() {
      try {
        const yours = await run([...get().placed.keys()]);
        set({ yours, phase: 'replayed', view: 'yours' });
      } catch (e) { fail(e); }
    },
    async compare() {
      try {
        set({ phase: 'simulating' });
        // The user's picks join the top candidates, so the scores are comparable.
        const optimal = await sim.optimize(scenarioOf(), get().budget, [...get().placed.keys()]);
        set({ optimal, phase: 'compare' });
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
      for (const marker of get().placed.values()) if (marker) scene.removeProtection(marker);
      for (const id of get().optimalMarkers) scene.removeProtection(id);
      scene.hideRiskMap();
      scene.clearBuildingGlow();
      set({ phase: 'setup', baseline: null, yours: null, optimal: null, candidates: [], placed: new Map(),
        optimalMarkers: [], view: 'before', error: null });
      scene.showTornadoPath(get().path, WIDTH_BY_EF[get().ef]!);
    },
  };
});
