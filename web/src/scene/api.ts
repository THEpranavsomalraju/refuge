import { cellToLatLng } from 'h3-js';
import { useSceneStore } from './store';
import type { LonLat, SceneAPI } from './types';

/** Duration of the hexagon rise in showRiskMap / showDifference, ms. */
export const RISK_RISE_MS = 2400;
/** Default duration of a camera move, ms. */
export const CAMERA_MS = 1600;
/** Camera moves never frame less than this radius, so a single cell isn't a close-up. */
const MIN_FRAME_RADIUS_M = 450;

let protectionSeq = 0;

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
  showRiskMap(cells, bands) {
    useSceneStore.setState({ risk: { cells, bands, shownAt: performance.now() }, diff: null });
    return new Promise(resolve => setTimeout(resolve, RISK_RISE_MS));
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
