import { SITE } from '../site.config';
import type { HeroSection as Config } from '../types';

export function HeroSection({ section }: { section: Config }) {
  return (
    <>
      <div className="hero-band">
        <h1 className="wordmark">{section.title ?? SITE.title}</h1>
        <p className="tagline">{SITE.tagline}</p>
      </div>
      {section.stats && section.stats.length > 0 && (
        <div className="container stat-row">
          {section.stats.map(s => (
            <div key={s.label} className="card">
              <div className="label">{s.label}</div>
              <div className="value">{s.value}{s.unit && <small>{s.unit}</small>}</div>
              {s.note && <div className="note">{s.note}</div>}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
