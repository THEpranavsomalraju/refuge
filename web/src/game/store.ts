import { create } from 'zustand';
import { scene, type LonLat, type PlaceData } from '../scene';
import showcase from '../../../sim/scenarios/lumberton_tornado.json';
import { defaultBudget, riskBands, safeRoom, sim, type DetailedResult, type SafeRoomPlan,
  type SafeRoomSite, type TornadoScenario } from './simClient';
import { stormGlow } from './stormGlow';

/** Median NOAA path width by EF rating, 2007-2025 (ml/exports/tornado_width_by_ef.json). */
export const WIDTH_BY_EF = [45.7, 137.2, 274.3, 640.1, 965.6, 1207];
const STORM_MS = 6000;

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
  sites: SafeRoomSite[];
  /** Site index -> scene protection id, for the player's placed rooms. */
  placed: Map<number, string>;
  yours: DetailedResult | null;
  optimal: { plan: SafeRoomPlan; result: DetailedResult } | null;
  view: MapView;
  optimalMarkers: string[];

  init(place: PlaceData): Promise<void>;
  set(patch: Partial<Pick<GameState, 'ef' | 'hour' | 'warning'>>): void;
  play(): Promise<void>;
  plan(): Promise<void>;
  toggleSite(i: number): void;
  replay(): Promise<void>;
  compare(): Promise<void>;
  show(view: MapView): void;
  restart(): void;
}

let optimalJob: Promise<{ plan: SafeRoomPlan; result: DetailedResult }> | null = null;

export const useGame = create<GameState>((set, get) => {
  const scenarioOf = (rooms: SafeRoomSite[] = []): TornadoScenario => {
    const { ef, hour, warning, path } = get();
    return { ...(showcase as unknown as TornadoScenario), ef, hour, warning_min: warning, path,
      width_m: WIDTH_BY_EF[ef]!, protections: rooms.map(s => ({ type: 'safe_room' as const, lon: s.lon, lat: s.lat })) };
  };
  const placedSites = () => [...get().placed.keys()].sort((a, b) => a - b).map(i => get().sites[i]!);

  /** Simulate, animate the storm with buildings lighting up as it passes, then raise the risk map. */
  async function run(rooms: SafeRoomSite[]): Promise<DetailedResult> {
    const s = scenarioOf(rooms);
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
    budget: defaultBudget, baseline: null, sites: [], placed: new Map(), yours: null, optimal: null,
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
        const s = scenarioOf();
        const sites = await sim.sites(s);
        set({ sites, phase: 'planning' });
        // Search every affordable plan in the background while the player chooses.
        optimalJob = sim.optimize(s, sites, get().budget);
        optimalJob.catch(fail);
      } catch (e) { fail(e); }
    },
    toggleSite(i) {
      const placed = new Map(get().placed);
      const id = placed.get(i);
      if (id) { scene.removeProtection(id); placed.delete(i); }
      else {
        if ((placed.size + 1) * safeRoom.cost_usd > get().budget) return;
        const site = get().sites[i]!;
        placed.set(i, scene.placeProtection('safe_room', site.lon, site.lat));
      }
      set({ placed });
    },
    async replay() {
      try {
        const yours = await run(placedSites());
        set({ yours, phase: 'replayed', view: 'yours' });
      } catch (e) { fail(e); }
    },
    async compare() {
      try {
        const optimal = await optimalJob!;
        set({ optimal, phase: 'compare' });
        get().show('optimal');
      } catch (e) { fail(e); }
    },
    show(view) {
      const { baseline, yours, optimal, placed, sites } = get();
      const result = view === 'before' ? baseline : view === 'yours' ? yours : optimal?.result;
      if (!result) return;
      // Markers: the player's rooms for "yours", the optimizer's rooms for "optimal".
      for (const id of get().optimalMarkers) scene.removeProtection(id);
      for (const id of placed.values()) scene.removeProtection(id);
      // A placed site whose marker is hidden keeps its entry with an empty id.
      const next = new Map<number, string>();
      for (const i of placed.keys()) {
        next.set(i, view === 'yours' ? scene.placeProtection('safe_room', sites[i]!.lon, sites[i]!.lat) : '');
      }
      const optimalMarkers = view === 'optimal' && optimal
        ? optimal.plan.sites.map(s => scene.placeProtection('safe_room', s.lon, s.lat)) : [];
      set({ view, placed: next, optimalMarkers });
      void scene.showRiskMap(result.cells, riskBands);
    },
    restart() {
      for (const id of get().placed.values()) if (id) scene.removeProtection(id);
      for (const id of get().optimalMarkers) scene.removeProtection(id);
      scene.hideRiskMap();
      scene.clearBuildingGlow();
      optimalJob = null;
      set({ phase: 'setup', baseline: null, yours: null, optimal: null, sites: [], placed: new Map(),
        optimalMarkers: [], view: 'before', error: null });
      scene.showTornadoPath(get().path, WIDTH_BY_EF[get().ef]!);
    },
  };
});
