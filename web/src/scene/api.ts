import { cellToLatLng } from 'h3-js';
import { buildCity, buildServerAvailable, listCities } from './places';
import { hurricaneCells, tornadoCells, type RiskCell } from './RiskMap';
import type { TrackRow } from '../shared/contract';
import { useSceneStore } from './store';
import type { LonLat, SceneAPI } from './types';

import { CAMERA_MS, RISK_RISE_MS } from './timing';

export { CAMERA_MS, RISK_RISE_MS };
/** Camera moves never frame less than this radius, so a single cell isn't a close-up. */
const MIN_FRAME_RADIUS_M = 450;

let protectionSeq = 0;

/**
 * Shows a risk or displacement map. Showing the result that is already on screen (the
 * game re-shows it when switching views) keeps it standing instead of replaying the rise.
 */
function showMap(hazard: 'tornado' | 'hurricane', source: object, convert: () => Record<string, RiskCell>): Promise<void> {
  const cur = useSceneStore.getState().risk;
  if (cur && cur.hazard === hazard && cur.source === source) {
    useSceneStore.setState({ diff: null });
    return Promise.resolve();
  }
  useSceneStore.setState({ risk: { hazard, cells: convert(), shownAt: performance.now(), source }, diff: null });
  return new Promise(resolve => setTimeout(resolve, RISK_RISE_MS));
}

/**
 * The scene API the game calls (web/src/game). Import `scene` and call it from anywhere;
 * calls made before the town has loaded are kept and applied once it renders.
 */
export const scene: SceneAPI = {
  setBuildingGlow(id, value) {
    useSceneStore.setState(s => {
      const glow = new Map(s.glow);
      if (value > 0) glow.set(id, Math.min(1, value)); else glow.delete(id);
      return { glow, glowVersion: s.glowVersion + 1 };
    });
  },
  clearBuildingGlow() {
    useSceneStore.setState(s => ({ glow: new Map(), glowVersion: s.glowVersion + 1 }));
  },
  setWaterLevel(m) {
    useSceneStore.setState({ water: m });
  },
  showTornadoPath(coords, widthM) {
    useSceneStore.setState({ tornado: { coords, widthM }, stormT: null });
  },
  hideTornadoPath() {
    useSceneStore.setState({ tornado: null, stormT: null });
  },
  playStorm(durationMs, onProgress) {
    return new Promise(resolve => {
      const start = performance.now();
      const tick = (now: number) => {
        const t = Math.min(1, (now - start) / durationMs);
        useSceneStore.setState({ stormT: t });
        onProgress?.(t);
        if (t < 1) requestAnimationFrame(tick);
        else { useSceneStore.setState({ stormT: null }); resolve(); }
      };
      requestAnimationFrame(tick);
    });
  },
  placeProtection(type, lon, lat) {
    const id = `p_${++protectionSeq}`;
    useSceneStore.setState(s => ({ protections: [...s.protections, { id, type, lon, lat }] }));
    return id;
  },
  removeProtection(id) {
    useSceneStore.setState(s => ({ protections: s.protections.filter(p => p.id !== id) }));
  },
  onBuildingClick(cb) {
    useSceneStore.setState({ onBuildingClick: cb });
  },
  onCellHover(cb) {
    useSceneStore.setState({ onCellHover: cb });
  },
  showRiskMap(cells) {
    // Only cells present in the result are drawn (absent = unaffected). Band cutoffs
    // are applied by the sim; the legend (RiskLegend) shows them.
    return showMap('tornado', cells, () => tornadoCells(cells));
  },
  showDisplacementMap(cells) {
    return showMap('hurricane', cells, () => hurricaneCells(cells));
  },
  hideRiskMap() {
    useSceneStore.setState({ risk: null, diff: null });
  },
  showDifference(before, after) {
    useSceneStore.setState({ diff: { before, after, shownAt: performance.now() }, risk: null });
    return new Promise(resolve => setTimeout(resolve, RISK_RISE_MS));
  },
  showCandidateSites(sites) {
    useSceneStore.setState({ sites: sites.map(s => ({ ...s })) });
  },
  hideCandidateSites() {
    useSceneStore.setState({ sites: [] });
  },
  onSiteClick(cb) {
    useSceneStore.setState({ onSiteClick: cb });
  },
  listCities,
  buildServerAvailable,
  buildCity,
  showHurricaneTrack(track, category) {
    useSceneStore.setState({ hurricane: { track: track.map(r => [...r] as TrackRow), category }, hurricaneT: null });
  },
  hideHurricaneTrack() {
    useSceneStore.setState({ hurricane: null, hurricaneT: null });
  },
  playHurricane(durationMs, onProgress) {
    return new Promise(resolve => {
      const h = useSceneStore.getState().hurricane;
      if (!h) { resolve(); return; }
      const start = performance.now();
      const tick = (now: number) => {
        const t = Math.min(1, (now - start) / durationMs);
        useSceneStore.setState({ hurricaneT: t });
        onProgress?.(t);
        if (t < 1) requestAnimationFrame(tick);
        else { useSceneStore.setState({ hurricaneT: null }); resolve(); }
      };
      requestAnimationFrame(tick);
    });
  },
  onGroundClick(cb) {
    // A new callback (or null) starts a fresh set of point markers.
    useSceneStore.setState({ onGroundClick: cb, groundClicks: [] });
  },
  frameCoords(coords, ms = CAMERA_MS, marginM = 300) {
    if (!coords.length) return;
    let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
    for (const [lon, lat] of coords) {
      minLon = Math.min(minLon, lon); maxLon = Math.max(maxLon, lon);
      minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat);
    }
    const lat0 = (minLat + maxLat) / 2;
    const halfW = ((maxLon - minLon) / 2) * 111_320 * Math.cos((lat0 * Math.PI) / 180);
    const halfH = ((maxLat - minLat) / 2) * 110_900;
    const radiusM = Math.max(MIN_FRAME_RADIUS_M, Math.hypot(halfW, halfH) + marginM);
    const seq = (useSceneStore.getState().camera?.seq ?? 0) + 1;
    useSceneStore.setState({ camera: { center: [(minLon + maxLon) / 2, lat0], radiusM, ms, seq } });
  },
  frameStormPath(ms = CAMERA_MS) {
    const t = useSceneStore.getState().tornado;
    if (t) scene.frameCoords(t.coords, ms, t.widthM);
  },
  focusCells(h3s, ms = CAMERA_MS) {
    const pts: LonLat[] = [];
    for (const h of h3s) {
      try { const [lat, lon] = cellToLatLng(h); pts.push([lon, lat]); } catch { /* not an H3 id */ }
    }
    scene.frameCoords(pts, ms, 250);
  },
};
