import { ChartFrame } from '../ChartFrame';
import type { ChartsSection as Config } from '../types';

export function ChartsSection({ section }: { section: Config }) {
  return (
    <div className="container">
      {section.title && section.showTitle !== false && <h2>{section.title}</h2>}
      {[section.intro ?? []].flat().map((p, i) => <p key={i} className="intro">{p}</p>)}
      <div className="chart-grid">
        {section.charts.map(c => <ChartFrame key={c.src} chart={c} />)}
      </div>
    </div>
  );
}
