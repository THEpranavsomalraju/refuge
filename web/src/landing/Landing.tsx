import type { ComponentType } from 'react';
import { SECTION_TYPES } from './sectionTypes';
import { SITE } from './site.config';
import type { SectionConfig } from './types';
import './landing.css';

// Page shell: nav + one <section> per config entry. Nothing section-specific lives here.
export function Landing() {
  const navItems = SITE.sections.filter(s => s.title && s.nav !== false);
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
