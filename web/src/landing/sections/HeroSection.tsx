import { SITE } from '../site.config';
import type { HeroSection as Config } from '../types';

export function HeroSection({ section }: { section: Config }) {
  return (
    <div className="hero-band">
      <h1 className="wordmark">{section.title ?? SITE.title}</h1>
      <p className="tagline">{SITE.tagline}</p>
    </div>
  );
}
