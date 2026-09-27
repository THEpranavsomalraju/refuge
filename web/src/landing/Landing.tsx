import { useEffect, type ComponentType } from 'react';
import { SECTION_TYPES } from './sectionTypes';
import { SITE } from './site.config';
import type { SectionConfig } from './types';
import './landing.css';

// Page shell: nav + one <section> per config entry. Nothing section-specific lives here.
export function Landing() {
  const navItems = SITE.sections.filter(s => s.title && s.nav !== false);
  // Links like /#play: the browser tries to jump before React has rendered the sections,
  // so jump once they exist, and keep following the target while charts above it load and
  // resize. Stops after a few seconds or as soon as the visitor scrolls themselves.
  useEffect(() => {
    const target = document.getElementById(decodeURIComponent(location.hash.slice(1)));
    const main = document.querySelector('main');
    if (!target || !main) return;
    const jump = () => target.scrollIntoView({ behavior: 'instant' });
    jump();
    const ro = new ResizeObserver(jump);
    ro.observe(main);
    const events = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const;
    const stop = () => {
      ro.disconnect();
      events.forEach(e => window.removeEventListener(e, stop));
    };
    events.forEach(e => window.addEventListener(e, stop, { passive: true }));
    const timer = setTimeout(stop, 4000);
    return () => { clearTimeout(timer); stop(); };
  }, []);
  return (
    <div className="landing">
      <nav className="nav">
        <a className="nav-brand" href="#top">
          <span className="nav-mark">R</span>
          {SITE.title}
        </a>
        <div className="nav-links">
          {navItems.map(s => <a key={s.id} href={`#${s.id}`}>{s.title}</a>)}
        </div>
      </nav>
      <main id="top">
        {SITE.sections.map(s => {
          const Render = SECTION_TYPES[s.kind] as ComponentType<{ section: SectionConfig }>;
          return (
            <section key={s.id} id={s.id} className={`section section-${s.kind}`}>
              <Render section={s} />
            </section>
          );
        })}
      </main>
      <footer className="footer">Carolina Data Challenge 2026 · Natural Science track</footer>
    </div>
  );
}
