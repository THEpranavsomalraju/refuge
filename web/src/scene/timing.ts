// Animation timings shared by api.ts and the map layers. Kept in a module with no
// imports so RiskMap/DifferenceMap can read them at load time without the
// api.ts <-> RiskMap.tsx import cycle leaving them uninitialized.

/** Duration of the hexagon rise in showRiskMap / showDifference, ms. */
export const RISK_RISE_MS = 2400;
/** Default duration of a camera move, ms. */
export const CAMERA_MS = 1600;
