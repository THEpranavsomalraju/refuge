import type { PlaceholderSection as Config } from '../types';

// Holds a spot for a section that's still being built. Swap `kind` in site.config.ts when ready.
export function Placeholder({ section }: { section: Config }) {
  return (
    <div className="container">
      {section.title && <h2>{section.title}</h2>}
      <div className="placeholder card">
        <span className="label">Coming soon</span>
        {section.note && <span className="note">{section.note}</span>}
      </div>
    </div>
  );
}
