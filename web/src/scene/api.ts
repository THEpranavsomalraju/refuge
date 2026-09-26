import { useSceneStore } from './store';
import type { SceneAPI } from './types';

/** Duration of the hexagon rise in showRiskMap, ms (bands rise one after another). */
export const RISK_RISE_MS = 2400;

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
    useSceneStore.setState({ risk: { cells, bands, shownAt: performance.now() } });
    return new Promise(resolve => setTimeout(resolve, RISK_RISE_MS));
  },
  hideRiskMap() {
    useSceneStore.setState({ risk: null });
  },
};
