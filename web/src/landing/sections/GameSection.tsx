import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import type { GameSection as Config } from '../types';

// The scene + game (Three.js, ~1.3 MB) load as their own chunk once the section is near.
const GameMount = lazy(() => import('./GameMount').then(m => ({ default: m.GameMount })));

// Sized box around the game, plus scroll behavior and full screen. The scene/game wiring is in GameMount.tsx.
export function GameSection({ section }: { section: Config }) {
  const box = useRef<HTMLDivElement>(null);
  const near = useNearViewport(box);
  const { full, toggle } = useFullscreen(box);
  const active = useClickToInteract(box) || full;

  return (
    <div ref={box} className={`game-box${full ? ' is-full' : ''}`} style={{ height: full ? undefined : section.height ?? '100vh' }}>
      {near && (
        <Suspense fallback={<div className="game-loading">Loading town…</div>}>
          <GameMount />
        </Suspense>
      )}
      <button className="game-full" onClick={toggle} aria-pressed={full}
        aria-label={full ? 'Exit full screen' : 'Full screen'} title={full ? 'Exit full screen (Esc)' : 'Full screen (F)'}>
        <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden>
          {full
            ? <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" />
            : <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />}
        </svg>
        <span>{full ? 'Exit' : 'Full screen'}</span>
      </button>
      {!active && <div className="game-hint">Click the map to zoom · scroll to keep reading</div>}
    </div>
  );
}

/**
 * Full screen for the game box. Uses the browser's Fullscreen API; where a page element can't go
 * full screen (iPhone Safari), the box is pinned over the page instead. F toggles, Esc leaves, and
 * the page comes back to the same scroll position either way.
 */
function useFullscreen(ref: React.RefObject<HTMLElement | null>) {
  const [native, setNative] = useState(false);
  const [pinned, setPinned] = useState(false);
  const scrollY = useRef(0);

  useEffect(() => {
    const change = () => {
      const on = document.fullscreenElement === ref.current;
      setNative(on);
      if (!on) requestAnimationFrame(() => window.scrollTo({ top: scrollY.current, behavior: 'instant' as ScrollBehavior }));
    };
    document.addEventListener('fullscreenchange', change);
    return () => document.removeEventListener('fullscreenchange', change);
  }, [ref]);

  // Pinned fallback: lock page scroll underneath while it's up.
  useEffect(() => {
    if (!pinned) return;
    const html = document.documentElement, prev = html.style.overflow;
    html.style.overflow = 'hidden';
    return () => {
      html.style.overflow = prev;
      window.scrollTo({ top: scrollY.current, behavior: 'instant' as ScrollBehavior });
    };
  }, [pinned]);

  const toggle = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    if (document.fullscreenElement) { void document.exitFullscreen(); return; }
    if (pinned) { setPinned(false); return; }
    scrollY.current = window.scrollY;
    if (el.requestFullscreen) el.requestFullscreen({ navigationUI: 'hide' }).catch(() => setPinned(true));
    else setPinned(true);
  }, [ref, pinned]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.key === 'Escape' && pinned) { setPinned(false); return; }
      if ((e.key === 'f' || e.key === 'F') && !e.metaKey && !e.ctrlKey && !e.altKey) {
        // Only when the game is what you're looking at.
        const r = ref.current?.getBoundingClientRect();
        if (r && r.top < window.innerHeight * 0.5 && r.bottom > window.innerHeight * 0.5) { e.preventDefault(); toggle(); }
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [ref, pinned, toggle]);

  return { full: native || pinned, toggle };
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
    const onWheel = (e: WheelEvent) => { if (!activeRef.current && !el.classList.contains('is-full')) e.stopPropagation(); };
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
