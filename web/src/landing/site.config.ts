import type { SectionConfig } from './types';

// THE page. Sections render top to bottom in this order.
//  - Reorder entries to reorder the page.
//  - nav: false hides a section from the top nav (it still renders).
//  - kind: 'placeholder' holds a spot for something still being built.
//  - A chart `src` is a folder name in web/public/charts/, or a full URL (e.g. Flourish).
// See README.md in this folder for recipes.
export const SITE: { title: string; tagline: string; sections: SectionConfig[] } = {
  title: 'Refuge',
  tagline: 'Send a storm through a real town. See who is at risk and why. Plan protections, then replay it.',
  sections: [
    {
      id: 'hero',
      kind: 'hero',
      nav: false,
      stats: [
        { label: 'Tornado deaths at night', value: '36', unit: '%', note: 'of deaths, 29% of tornadoes (8 PM–6 AM)' },
        { label: 'Tornado deaths in mobile homes', value: '42', unit: '%', note: 'known locations, 1996–2025' },
        { label: 'Simulated runs per storm', value: '500' },
      ],
    },
    { id: 'play', kind: 'game', title: 'Try a storm', height: '100vh' },
    {
      id: 'patterns',
      kind: 'charts',
      title: 'Who dies in storms',
      intro: 'NOAA Storm Events direct deaths, 50 states + DC, 1996–2025.',
      charts: [
        { src: 'deaths-by-hour', title: 'Tornado deaths by hour of day', height: 380 },
        { src: 'deaths-by-location', title: 'Where tornado deaths happen', height: 380 },
      ],
    },
    { id: 'model', kind: 'placeholder', title: 'The model, explained', note: 'SHAP charts from ml/exports/shap_summary.json' },
    { id: 'backtest', kind: 'placeholder', title: 'Backtest against real storms', note: 'ml/exports/backtest.json' },
    { id: 'national-map', kind: 'placeholder', title: 'National risk map', note: 'deck.gl, county_risk.json' },
    {
      id: 'methods',
      kind: 'text',
      title: 'Methods',
      paragraphs: [
        'Every building comes from the USACE National Structure Inventory. For each one the simulator estimates storm intensity, damage level, and lethality for the people inside, then samples 500 runs to get expected deaths and a range.',
        'Lethality is calibrated to NOAA Storm Events fatality records. Structure Inventory populations are modeled estimates. Protection effects are model estimates, not proven causal effects.',
      ],
    },
  ],
};
