import { ChartFrame } from '../ChartFrame';
import type { ChartsSection as Config } from '../types';

export function ChartsSection({ section }: { section: Config }) {
  return (
    <div className="container">
      {section.title && <h2>{section.title}</h2>}
      {section.intro && <p className="intro">{section.intro}</p>}
      <div className="chart-grid">
        {section.charts.map(c => <ChartFrame key={c.src} chart={c} />)}
      </div>
    </div>
  );
}
