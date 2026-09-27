import type { SectionConfig } from './types';

// THE page. Sections render top to bottom in this order.
//  - Reorder entries to reorder the page.
//  - nav: false hides a section from the top nav (it still renders).
//  - showTitle: false keeps the nav link but skips the heading (for charts with their own).
//  - kind: 'placeholder' holds a spot for something still being built.
//  - A chart `src` is a folder name in web/public/charts/, or a full URL (e.g. Flourish).
// See README.md in this folder for recipes.
export const SITE: { title: string; tagline: string; sections: SectionConfig[] } = {
  title: 'Refuge',
  tagline: 'Send a tornado or hurricane through a real town. See who is at risk and why. Turn existing buildings into shelters, then replay the storm.',
  sections: [
    { id: 'hero', kind: 'hero', nav: false },
    { id: 'play', kind: 'game', title: 'Try a storm', height: '100vh' },
    {
      id: 'where',
      kind: 'charts',
      title: 'Where people died',
      showTitle: false,
      charts: [{ src: 'where-people-died', title: 'Where people died', height: 500, wide: true, bare: true }],
    },
    {
      id: 'risk-factors',
      kind: 'charts',
      title: 'Risk factors',
      showTitle: false,
      charts: [
        { src: 'risk-factors', title: 'Risk factors', height: 900, wide: true, bare: true },
        { src: 'deaths-by-hour', title: 'Tornado deaths by hour of day', height: 380, wide: true },
      ],
    },
    {
      id: 'national-map',
      kind: 'charts',
      title: '30 years of storm deaths',
      showTitle: false,
      charts: [{ src: 'national-animation', title: 'Tornado and hurricane deaths, 1996–2025', height: 620, wide: true, bare: true, clickToInteract: true }],
    },
    { id: 'model', kind: 'placeholder', title: 'The model, explained', note: 'SHAP charts from ml/exports/shap_summary.json' },
    { id: 'backtest', kind: 'placeholder', title: 'Backtest against real storms', note: 'ml/exports/backtest.json' },
    {
      id: 'methods',
      kind: 'text',
      title: 'Methods',
      paragraphs: [
        'Every building comes from the USACE National Structure Inventory. For a tornado, the simulator estimates wind speed, damage level, and lethality for the people inside each building, then samples 500 runs to get expected deaths and a range. Lethality is calibrated to NOAA Storm Events fatality records, 1996–2025.',
        'For a hurricane, winds come from a Holland wind profile around the storm track. Hurricane wind rarely kills people indoors, so hurricane mode plans for the people displaced from damaged homes rather than for deaths. Storm surge, rain flooding and falling trees are not modeled.',
        'Structure Inventory populations are modeled estimates. Shelter effects are model estimates, not proven causal effects.',
      ],
    },
  ],
};
