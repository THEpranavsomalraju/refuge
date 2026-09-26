import type { Place, ProtectionConfig, SafeRoom, ShelterAssignment, SafeRoomConfig, Scenario, SimParams, TornadoScenario } from './types.js';
import { distanceM } from './geometry.js';
import { expected, isNight, occupants } from './engine.js';

/** Walking reach: speed x time left after hearing the warning and getting moving. */
export function reachM(scenario: Scenario, room: SafeRoomConfig): number {
  return room.walk_speed_mps * Math.max(0, scenario.warning_min - room.mobilize_min) * 60;
}

/**
 * Share of each building's occupants inside a safe room. Occupants of eligible
 * classes within reach go with probability `compliance`; (home, room) pairs are
 * filled nearest-first until each room is full, and a person is assigned at most
 * once, so overlapping rooms never double-count.
 */
export function assignShelters(scenario: Scenario, place: Place, config: ProtectionConfig):
  { share: Float64Array; total: number; assignments: ShelterAssignment[] } {
  const n = place.buildings.length;
  const share = new Float64Array(n);
  const assignments: ShelterAssignment[] = [];
  const rooms = scenario.protections;
  if (rooms.length === 0) return { share, total: 0, assignments };
  const cfg = config.safe_room;
  const reach = reachM(scenario, cfg);
  const night = isNight(scenario.hour);
  const eligible = new Set<string>(cfg.eligible_classes);
  const goers = new Float64Array(n);
  const pairs: [distance: number, building: number, room: number][] = [];
  for (let i = 0; i < n; i++) {
    const b = place.buildings[i]!;
    if (!eligible.has(b.cls)) continue;
    const [u, o] = occupants(b, night);
    if (u + o <= 0) continue;
    goers[i] = (u + o) * cfg.compliance;
    rooms.forEach((r, j) => {
      const d = distanceM(b.lon, b.lat, r.lon, r.lat);
      if (d <= reach) pairs.push([d, i, j]);
    });
  }
  pairs.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  const capacity = rooms.map(() => cfg.capacity);
  let total = 0;
  for (const [, i, j] of pairs) {
    const take = Math.min(goers[i]!, capacity[j]!);
    if (take <= 0) continue;
    goers[i]! -= take; capacity[j]! -= take;
    share[i]! += take; total += take;
    assignments.push({ building_id: place.buildings[i]!.id, room: j, people: take });
  }
  for (let i = 0; i < n; i++) {
    if (share[i]! > 0) {
      const [u, o] = occupants(place.buildings[i]!, night);
      share[i] = share[i]! / (u + o);
    }
  }
  return { share, total, assignments };
}

export interface SafeRoomSite { h3: string; lon: number; lat: number; reachable: number }

/**
 * Candidate sites: empty cells (no buildings) ranked by how many eligible people
 * would come (occupants at the scenario hour x compliance, capped at capacity),
 * taken greedily at least `site_spacing_reach` x reach apart. Depends on the hour
 * and warning time, not on the storm path.
 */
export function safeRoomSites(place: Place, scenario: Scenario, config: ProtectionConfig): SafeRoomSite[] {
  const cfg = config.safe_room;
  const reach = reachM(scenario, cfg);
  if (reach <= 0 || cfg.candidate_sites === 0) return [];
  const night = isNight(scenario.hour);
  const eligible = new Set<string>(cfg.eligible_classes);
  const occupied = new Set(place.buildings.map(b => b.h3));
  const homes: { lon: number; lat: number; goers: number }[] = [];
  for (const b of place.buildings) {
    if (!eligible.has(b.cls)) continue;
    const [u, o] = occupants(b, night);
    if (u + o > 0) homes.push({ lon: b.lon, lat: b.lat, goers: (u + o) * cfg.compliance });
  }
  const dLat = reach / 111_000;
  const scored: SafeRoomSite[] = [];
  for (const c of place.cells ?? []) {
    if (!c.center || occupied.has(c.h3)) continue;
    const [lon, lat] = c.center;
    const dLon = dLat / Math.max(0.01, Math.cos(lat * Math.PI / 180));
    let goers = 0;
    for (const h of homes) {
      if (Math.abs(h.lat - lat) > dLat || Math.abs(h.lon - lon) > dLon) continue;
      if (distanceM(lon, lat, h.lon, h.lat) <= reach) goers += h.goers;
    }
    if (goers > 0) scored.push({ h3: c.h3, lon, lat, reachable: Math.min(cfg.capacity, goers) });
  }
  scored.sort((a, b) => b.reachable - a.reachable || (a.h3 < b.h3 ? -1 : a.h3 > b.h3 ? 1 : 0));
  const picked: SafeRoomSite[] = [];
  for (const s of scored) {
    if (picked.length >= cfg.candidate_sites) break;
    if (picked.every(p => distanceM(p.lon, p.lat, s.lon, s.lat) >= cfg.site_spacing_reach * reach)) picked.push(s);
  }
  return picked;
}

export interface SafeRoomPlan {
  sites: SafeRoomSite[];
  protections: SafeRoom[];
  cost_usd: number;
  expected_deaths: number;
  baseline_deaths: number;
  lives_saved: number;
  /** Number of affordable plans evaluated (every subset of sites within budget). */
  evaluated: number;
}

export const siteRooms = (sites: readonly SafeRoomSite[]): SafeRoom[] =>
  sites.map(s => ({ type: 'safe_room', lon: s.lon, lat: s.lat }));

/**
 * Exhaustive search: every subset of candidate sites that fits the budget, scored by
 * expected deaths for this storm. Ties go to the cheaper plan. Existing protections
 * on the scenario are ignored (the optimal plan starts from nothing).
 */
export function optimizeSafeRooms(scenario: TornadoScenario, place: Place, params: SimParams,
  config: ProtectionConfig, sites: readonly SafeRoomSite[], budgetUsd: number): SafeRoomPlan {
  const cost = config.safe_room.cost_usd;
  const maxRooms = Math.floor(budgetUsd / cost + 1e-9);
  const baseline = expected({ ...scenario, protections: [] }, place, params, config).expected_deaths;
  let best = { mask: 0, rooms: 0, deaths: baseline };
  let evaluated = 0;
  for (let mask = 0; mask < 1 << sites.length; mask++) {
    const chosen = sites.filter((_, i) => mask & (1 << i));
    if (chosen.length > maxRooms) continue;
    evaluated++;
    if (mask === 0) continue;
    const deaths = expected({ ...scenario, protections: siteRooms(chosen) }, place, params, config).expected_deaths;
    if (deaths < best.deaths - 1e-12 || (Math.abs(deaths - best.deaths) <= 1e-12 && chosen.length < best.rooms)) {
      best = { mask, rooms: chosen.length, deaths };
    }
  }
  const chosen = sites.filter((_, i) => best.mask & (1 << i));
  return { sites: chosen, protections: siteRooms(chosen), cost_usd: chosen.length * cost,
    expected_deaths: best.deaths, baseline_deaths: baseline, lives_saved: baseline - best.deaths, evaluated };
}
