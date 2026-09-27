import { Html, Line } from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react';
import * as THREE from 'three';
import { buildDiff, EPS, value } from './DifferenceMap';
import type { Frame } from './geo';
import { DIFF_COLOR } from './palette';
import { Marker, Reach } from './Protections';
import { cellHeightM, displacedHeightM, RISK_FADE_MS } from './RiskMap';
import { useSceneStore, type DiffCells, type SwipeSide } from './store';
import { RISK_RISE_MS } from './timing';
import type { PlaceData } from './types';

/** three.js layers for each half; layer 0 (town, terrain, lights) draws on both. */
const LEFT_LAYER = 1;
const RIGHT_LAYER = 2;
/** Arrow keys move the divider this share of the width. */
const KEY_STEP = 0.05;
/**
 * "Missed" cells on the right half: the right plan prevented at least MISSED_SHARE of the
 * cell's storm value more than the left plan, and the gap is at least the hazard's floor.
 */
const MISSED_SHARE = 0.25;
const MISSED_FLOOR = { tornado: 0.01, hurricane: 5 };   // expected deaths / displaced people

/**
 * scene.showSwipeCompare: two difference maps against one shared `before`, split by a
 * draggable vertical divider. The scene is drawn twice per frame, each half through a
 * scissor rectangle, so orbit and pan keep working on both. Heights use the same absolute
 * scale as showDifference, so a weaker plan stands shorter.
 */
export function SwipeCompare({ place, frame }: { place: PlaceData; frame: Frame }) {
  const swipe = useSceneStore(s => s.swipe);
  if (!swipe) return null;
  return <SwipeView key={swipe.shownAt} place={place} frame={frame} swipe={swipe} />;
}

type Swipe = NonNullable<ReturnType<typeof useSceneStore.getState>['swipe']>;

function SwipeView({ place, frame, swipe }: { place: PlaceData; frame: Frame; swipe: Swipe }) {
  const left = useMemo(() => buildDiff(place, frame, swipe.before, swipe.left.after), [place, frame, swipe]);
  const right = useMemo(() => buildDiff(place, frame, swipe.before, swipe.right.after), [place, frame, swipe]);
  const missed = useMemo(() => missedOutline(place, frame, swipe.before, swipe.left.after, swipe.right.after),
    [place, frame, swipe]);
  useEffect(() => () => { for (const d of [left, right]) { d.bars.dispose(); d.flat.dispose(); } }, [left, right]);

  // Raise both halves together (same easing as the difference view); outlines appear at the top.
  const outline = useRef<THREE.Object3D>(null);
  const risen = useRef(-1);
  useFrame(() => {
    const t = Math.min(1, Math.max(0, (performance.now() - swipe.shownAt - RISK_FADE_MS) / (RISK_RISE_MS - RISK_FADE_MS)));
    const eased = 1 - Math.pow(1 - t, 3);
    if (outline.current) outline.current.visible = t >= 1;
    if (Math.abs(eased - risen.current) < 1e-4) return;
    risen.current = eased;
    for (const d of [left, right]) {
      const pos = d.bars.getAttribute('position') as THREE.BufferAttribute;
      for (let v = 0; v < pos.count; v++) pos.setY(v, d.base[v] + d.lift[v] * eased);
      pos.needsUpdate = true;
      d.bars.computeBoundingSphere();
    }
  });

  return (
    <>
      <OnLayer layer={LEFT_LAYER}>
        <Bars d={left} />
        <Shelters side={swipe.left} frame={frame} />
      </OnLayer>
      <OnLayer layer={RIGHT_LAYER}>
        <Bars d={right} />
        <Shelters side={swipe.right} frame={frame} />
        {missed.length > 0 && (
          <Line ref={outline as never} points={missed} segments color={DIFF_COLOR.missed} lineWidth={3}
            depthTest={false} renderOrder={6} raycast={() => null} visible={false} />
        )}
      </OnLayer>
      <SplitRenderer />
      <Divider left={swipe.left.label} right={swipe.right.label} />
    </>
  );
}

function Bars({ d }: { d: ReturnType<typeof buildDiff> }) {
  return (
    <>
      <mesh geometry={d.bars} raycast={() => null}>
        <meshStandardMaterial vertexColors roughness={0.7} metalness={0} emissive="#0d2a4d" emissiveIntensity={0.35} />
      </mesh>
      <mesh geometry={d.flat} raycast={() => null}>
        <meshBasicMaterial color={DIFF_COLOR.unchanged} transparent opacity={0.75} depthWrite={false} />
      </mesh>
    </>
  );
}

function Shelters({ side, frame }: { side: SwipeSide; frame: Frame }) {
  return (
    <>
      {side.shelters.map(s => (
        <group key={s.id}>
          <Marker p={{ id: s.id, type: 'safe_room', lon: s.lon, lat: s.lat }} frame={frame} pin={false} />
          {s.reachM ? <Reach lon={s.lon} lat={s.lat} radiusM={s.reachM} frame={frame} /> : null}
        </group>
      ))}
    </>
  );
}

/** Puts every object below it on one layer (layers are per object, not inherited). */
function OnLayer({ layer, children }: { layer: number; children: ReactNode }) {
  const group = useRef<THREE.Group>(null);
  useLayoutEffect(() => { group.current?.traverse(o => o.layers.set(layer)); });
  useFrame(() => { group.current?.traverse(o => { if (!o.layers.isEnabled(layer)) o.layers.set(layer); }); });
  return <group ref={group}>{children}</group>;
}

/** Takes over rendering while mounted: left half with layer 1, right half with layer 2. */
function SplitRenderer() {
  useFrame(({ gl, scene, camera, size }) => {
    const x = Math.round(size.width * useSceneStore.getState().swipeSplit);
    const mask = camera.layers.mask;
    gl.setScissorTest(true);
    for (const [x0, w, layer] of [[0, x, LEFT_LAYER], [x, size.width - x, RIGHT_LAYER]] as const) {
      if (w <= 0) continue;
      camera.layers.set(0);
      camera.layers.enable(layer);
      gl.setScissor(x0, 0, w, size.height);
      gl.render(scene, camera);
    }
    gl.setScissorTest(false);
    camera.layers.mask = mask;
  }, 1);
  return null;
}

/** Divider line, drag handle (mouse, touch, arrow keys) and the two side labels. */
function Divider({ left, right }: { left: string; right: string }) {
  const split = useSceneStore(s => s.swipeSplit);
  const gl = useThree(s => s.gl);
  const set = (v: number) => useSceneStore.setState({ swipeSplit: Math.min(1, Math.max(0, v)) });
  const drag = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = gl.domElement.getBoundingClientRect();
    set((e.clientX - r.left) / r.width);
  };
  const pct = `${split * 100}%`;
  return (
    <Html fullscreen zIndexRange={[20, 0]} style={{ pointerEvents: 'none' }}>
      <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none' }}>
        <div style={{ position: 'absolute', top: 0, bottom: 0, left: pct, width: 2, marginLeft: -1, background: '#e3eae7', boxShadow: '0 0 6px rgba(0,0,0,0.6)' }} />
        <div style={{ ...label, right: `calc(${100 - split * 100}% + 10px)`, textAlign: 'right' }}>{left}</div>
        <div style={{ ...label, left: `calc(${pct} + 10px)` }}>{right}</div>
        <div
          role="slider" tabIndex={0} aria-label="Compare the two plans: drag to move the divider"
          aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(split * 100)}
          onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); drag(e); }}
          onPointerMove={e => { if (e.currentTarget.hasPointerCapture(e.pointerId)) drag(e); }}
          onKeyDown={e => {
            if (e.key === 'ArrowLeft') { set(split - KEY_STEP); e.preventDefault(); }
            if (e.key === 'ArrowRight') { set(split + KEY_STEP); e.preventDefault(); }
          }}
          style={{
            position: 'absolute', top: '50%', left: pct, width: 34, height: 34, margin: '-17px 0 0 -17px',
            borderRadius: '50%', background: '#e3eae7', border: '2px solid #101817', boxShadow: '0 2px 8px rgba(0,0,0,0.5)',
            display: 'grid', placeItems: 'center', cursor: 'ew-resize', pointerEvents: 'auto', touchAction: 'none',
            color: '#101817', font: '700 14px system-ui, sans-serif', userSelect: 'none',
          }}>
          ◂▸
        </div>
      </div>
    </Html>
  );
}

const label: React.CSSProperties = {
  position: 'absolute', top: 12, maxWidth: 'min(42%, 320px)', padding: '5px 9px', borderRadius: 6,
  background: 'rgba(16, 24, 23, 0.92)', border: '1px solid #2c3a37', color: '#e3eae7',
  font: '600 12.5px "Public Sans", "Segoe UI", system-ui, sans-serif', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
};

/** Line-segment pairs outlining, at bar-top height, the cells the right plan protected much better. */
function missedOutline(place: PlaceData, frame: Frame, before: DiffCells, left: DiffCells, right: DiffCells): THREE.Vector3[] {
  const hurricane = [before, left, right].some(m => Object.values(m).some(c => c.displaced !== undefined));
  const floor = hurricane ? MISSED_FLOOR.hurricane : MISSED_FLOOR.tornado;
  const heightOf = hurricane ? displacedHeightM : cellHeightM;
  const pts: THREE.Vector3[] = [];
  for (const cell of place.cells) {
    const b = value(before[cell.h3]);
    const gap = value(left[cell.h3]) - value(right[cell.h3]);   // how much more the right plan prevented
    if (gap < floor || gap < MISSED_SHARE * b) continue;
    const ring = cell.boundary.map(([lon, lat]) => frame.toXZ(lon, lat));
    let ground = Infinity;
    for (const [x, z] of ring) ground = Math.min(ground, frame.groundY(x, z));
    const saved = b - value(right[cell.h3]);
    const y = ground + (saved > EPS ? heightOf(saved) : 0) + 3;
    for (let k = 0; k < ring.length; k++) {
      const [ax, az] = ring[k], [bx, bz] = ring[(k + 1) % ring.length];
      pts.push(new THREE.Vector3(ax, y, az), new THREE.Vector3(bx, y, bz));
    }
  }
  return pts;
}

/** Cells that changed on either half (for framing the camera). */
export function swipeChangedCells(s: Swipe): string[] {
  const ids = new Set([...Object.keys(s.before), ...Object.keys(s.left.after), ...Object.keys(s.right.after)]);
  const b = (h: string) => value(s.before[h]);
  return [...ids].filter(h => Math.abs(b(h) - value(s.left.after[h])) > EPS || Math.abs(b(h) - value(s.right.after[h])) > EPS);
}
