import { useFrame } from '@react-three/fiber';
import { cellToLatLng } from 'h3-js';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { Frame } from './geo';
import { RISK_COLOR } from './palette';
import { useSceneStore } from './store';
import { RISK_RISE_MS } from './timing';

/**
 * Smooth 3D heat map: a regular grid of translucent columns over the town. Each column's value is a
 * Gaussian-weighted average of the nearby H3 results (people-weighted), so the surface is continuous
 * instead of a patchwork of block colors. Color follows the same band cutoffs as the legend,
 * interpolated between them; height is the value. Columns only appear where people live.
 */
const GRID_M = 150;          // column footprint
const SIGMA_M = 220;         // smoothing radius (about 1.5 H3 res-10 cells)
const REACH = 3;             // kernel cut-off in sigmas
const MIN_PEOPLE = 4;        // weighted people needed before a column is drawn
const MAX_H = 380;           // tallest column, meters
const MIN_H = 12;

type Stop = [number, string];
// Tornado: log10 risk per person; anchors at the band cutoffs (1e-5 yellow, 1e-3 red, 1e-2 deep red).
const TORNADO_STOPS: Stop[] = [[-6.5, RISK_COLOR.green], [-5, RISK_COLOR.yellow], [-3, RISK_COLOR.red], [-2, RISK_COLOR.deep_red], [-1, '#5c0f16']];
// Hurricane: share of residents displaced; anchors at 10% / 40% / 70%.
const HURRICANE_STOPS: Stop[] = [[0, RISK_COLOR.green], [0.1, RISK_COLOR.yellow], [0.4, RISK_COLOR.red], [0.7, RISK_COLOR.deep_red], [1, '#5c0f16']];

function colorAt(stops: Stop[], v: number, out: THREE.Color) {
  if (v <= stops[0]![0]) return out.set(stops[0]![1]);
  for (let i = 1; i < stops.length; i++) {
    const [x1, c1] = stops[i]!;
    if (v <= x1) {
      const [x0, c0] = stops[i - 1]!;
      return out.set(c0).lerp(new THREE.Color(c1), (v - x0) / (x1 - x0));
    }
  }
  return out.set(stops[stops.length - 1]![1]);
}

interface Column { x: number; z: number; y: number; h: number; color: THREE.Color }

type SourceCell = { expected_deaths?: number; people?: number; displaced?: number; residents?: number };

function buildColumns(frame: Frame, hazard: 'tornado' | 'hurricane', source: Record<string, SourceCell>): Column[] {
  const nx = Math.ceil(frame.width / GRID_M), nz = Math.ceil(frame.depth / GRID_M);
  const x0 = -frame.width / 2, z0 = -frame.depth / 2;
  const num = new Float64Array(nx * nz), den = new Float64Array(nx * nz);
  const r = Math.ceil((REACH * SIGMA_M) / GRID_M), inv2s2 = 1 / (2 * SIGMA_M * SIGMA_M);
  for (const [h3, c] of Object.entries(source)) {
    let lat: number, lon: number;
    try { [lat, lon] = cellToLatLng(h3); } catch { continue; }
    const [cx, cz] = frame.toXZ(lon, lat);
    const people = hazard === 'tornado' ? c.people ?? 0 : c.residents ?? 0;
    const hit = hazard === 'tornado' ? c.expected_deaths ?? 0 : c.displaced ?? 0;
    if (people <= 0) continue;
    const gi = Math.floor((cx - x0) / GRID_M), gk = Math.floor((cz - z0) / GRID_M);
    for (let i = Math.max(0, gi - r); i <= Math.min(nx - 1, gi + r); i++) {
      for (let k = Math.max(0, gk - r); k <= Math.min(nz - 1, gk + r); k++) {
        const dx = x0 + (i + 0.5) * GRID_M - cx, dz = z0 + (k + 0.5) * GRID_M - cz;
        const w = Math.exp(-(dx * dx + dz * dz) * inv2s2);
        num[i * nz + k] += w * hit; den[i * nz + k] += w * people;
      }
    }
  }
  const stops = hazard === 'tornado' ? TORNADO_STOPS : HURRICANE_STOPS;
  const lo = stops[0]![0], hi = stops[stops.length - 1]![0];
  const out: Column[] = [];
  for (let i = 0; i < nx; i++) {
    for (let k = 0; k < nz; k++) {
      const d = den[i * nz + k]!;
      if (d < MIN_PEOPLE) continue;
      const ratio = num[i * nz + k]! / d;
      const v = hazard === 'tornado' ? Math.log10(Math.max(ratio, 1e-9)) : ratio;
      const t = Math.min(1, Math.max(0, (v - lo) / (hi - lo)));
      const x = x0 + (i + 0.5) * GRID_M, z = z0 + (k + 0.5) * GRID_M;
      out.push({ x, z, y: frame.groundY(x, z), h: MIN_H + t * (MAX_H - MIN_H), color: colorAt(stops, v, new THREE.Color()) });
    }
  }
  return out;
}

export function HeatVoxels({ frame }: { frame: Frame }) {
  const risk = useSceneStore(s => s.risk);
  const style = useSceneStore(s => s.mapStyle);
  const lowered = useSceneStore(s => s.highlight !== null);
  const columns = useMemo(
    () => (risk && style === 'heat' ? buildColumns(frame, risk.hazard, risk.source as Record<string, SourceCell>) : []),
    [risk, style, frame]);
  const mesh = useRef<THREE.InstancedMesh>(null);
  const geometry = useMemo(() => new THREE.BoxGeometry(GRID_M * 0.94, 1, GRID_M * 0.94).translate(0, 0.5, 0), []);
  const material = useMemo(() => new THREE.MeshStandardMaterial({ transparent: true, opacity: 0.6, depthWrite: false, roughness: 0.55, metalness: 0 }), []);
  const done = useRef(false);
  useEffect(() => () => { geometry.dispose(); material.dispose(); }, [geometry, material]);

  useEffect(() => {
    const m = mesh.current;
    if (!m) return;
    columns.forEach((c, i) => m.setColorAt(i, c.color));
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
    material.needsUpdate = true;   // compile with per-instance colors
    done.current = false;
  }, [columns]);

  const tmp = useMemo(() => new THREE.Object3D(), []);
  useFrame(() => {
    const m = mesh.current;
    if (!m || !risk || columns.length === 0) return;
    material.opacity = lowered ? 0.32 : 0.6;
    if (done.current) return;
    // Columns rise together over the same time as the block map.
    const k = Math.min(1, (performance.now() - risk.shownAt) / RISK_RISE_MS);
    const ease = 1 - Math.pow(1 - k, 3);
    columns.forEach((c, i) => {
      tmp.position.set(c.x, c.y, c.z);
      tmp.scale.set(1, Math.max(0.01, c.h * ease), 1);
      tmp.updateMatrix();
      m.setMatrixAt(i, tmp.matrix);
    });
    m.instanceMatrix.needsUpdate = true;
    if (k >= 1) done.current = true;
  });

  if (!risk || style !== 'heat' || columns.length === 0) return null;
  return <instancedMesh key={columns.length} ref={mesh} args={[geometry, material, columns.length]} raycast={() => null} renderOrder={2} />;
}
