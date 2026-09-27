import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { GameSection as Config } from '../types';

// The scene + game (Three.js, ~1.3 MB) load as their own chunk once the section is near.
const GameMount = lazy(() => import('./GameMount').then(m => ({ default: m.GameMount })));

// Sized box around the game, plus scroll behavior. The scene/game wiring is in GameMount.tsx.
export function GameSection({ section }: { section: Config }) {
  const box = useRef<HTMLDivElement>(null);
  const near = useNearViewport(box);
  const active = useClickToInteract(box);

  return (
    <div ref={box} className="game-box" style={{ height: section.height ?? '100vh' }}>
      {near && (
        <Suspense fallback={<div className="game-loading">Loading town…</div>}>
          <GameMount />
        </Suspense>
      )}
      {!active && <div className="game-hint">Click the map to zoom · scroll to keep reading</div>}
    </div>
  );
}

/** Mount the 3D scene only once the section is close to the viewport. Stays mounted after. */
function useNearViewport(ref: React.RefObject<HTMLElement | null>) {
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || near) return;
    const io = new IntersectionObserver(([e]) => e?.isIntersecting && setNear(true), { rootMargin: '400px' });
    io.observe(el);
    return () => io.disconnect();
  }, [ref, near]);
  return near;
}

/**
 * The map's wheel zoom would trap page scrolling. Until the user clicks inside the box,
 * wheel events are stopped at the box (capture phase) so they never reach the canvas and
 * the page scrolls normally. Clicking outside, Esc, or scrolling away releases it again.
 */
function useClickToInteract(ref: React.RefObject<HTMLElement | null>) {
  const [active, setActive] = useState(false);
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => { if (!activeRef.current) e.stopPropagation(); };
    const onDown = (e: PointerEvent) => setActive(el.contains(e.target as Node));
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setActive(false); };
    const io = new IntersectionObserver(([e]) => { if (e && e.intersectionRatio < 0.5) setActive(false); }, { threshold: [0.5] });
    el.addEventListener('wheel', onWheel, { capture: true });
    window.addEventListener('pointerdown', onDown, { capture: true });
    window.addEventListener('keydown', onKey);
    io.observe(el);
    return () => {
      el.removeEventListener('wheel', onWheel, { capture: true });
      window.removeEventListener('pointerdown', onDown, { capture: true });
      window.removeEventListener('keydown', onKey);
      io.disconnect();
    };
  }, [ref]);
  return active;
}
