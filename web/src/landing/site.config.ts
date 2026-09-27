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
    // Charts read live from ml/exports. The numbers written in the prose below are from
    // ml/METHODS.md as of 2026-09-27; re-check them if the ML exports are regenerated.
    {
      id: 'does-it-work',
      kind: 'charts',
      title: 'Does it work?',
      intro:
        'Refuge runs on two models. A national model, trained on 150,000 tornadoes and flash floods from 1996–2025, ' +
        'learns what makes a storm deadly and tunes how dangerous each kind of damaged building is. The simulator then ' +
        'applies those rates building by building. Both were tested on storms they never saw.',
      charts: [
        {
          src: 'model-drivers', title: 'What the model leans on most', height: 280,
          note: 'EF rating is assigned from damage surveys after the storm, so part of its weight is simply that the storm hit buildings. These are model estimates, not proof of cause.',
        },
        {
          src: 'ef-risk', title: 'Stronger tornadoes are far deadlier', height: 280,
          note: 'An EF4 carries about 90 times the expected deaths of an average storm; an EF0, about a quarter.',
        },
        {
          src: 'deadly-storm-catch', title: 'It picks out the deadly storms', height: 170, wide: true,
          note: 'Rank every 2020–2025 storm by the model’s predicted risk. For tornadoes, the top 5% of that list holds 79% of the storms that killed someone.',
        },
        {
          src: 'backtest', title: 'The simulator on 30 real tornadoes', height: 820, wide: true,
          note: 'Tornadoes from 2017–2025, held out when the simulator was calibrated. Recorded deaths are NOAA direct deaths minus those known to be outside buildings (unknown locations kept), so these counted deaths are a comparison target, not confirmed building deaths. Ranges come from 500 simulated runs and leave out uncertainty in the path, the building data and the parameters.',
        },
      ],
    },
    {
      id: 'does-it-work-notes',
      kind: 'text',
      title: 'What this means',
      nav: false,
      paragraphs: [
        'The national model is good at telling deadly storms from harmless ones, especially tornadoes. The simulator gets the quiet storms right: of the 17 held-out tornadoes with no counted deaths, it puts 16 near zero.',
        'It undercounts the deadly ones. Across all 30 storms it expects 10 deaths against 28 recorded, and only 3 of the 13 storms with counted deaths land inside its range. The largest, Texas 2024 (7 recorded), comes closest at 6.2. Calibration barely moved the total (10.7 before, 10.0 after).',
        'Likely reasons, which this test can’t separate: NOAA records a straight line between a tornado’s start and end points rather than its surveyed track; the Structure Inventory is a 2026 snapshot that misses some buildings; and the damage and lethality rules are simplified. The game’s death totals are likely on the low side, and they’re most useful for comparing plans against the same storm.',
        'Hurricane mode uses a separate wind-damage model fit to 44 US landfalls from 2004–2024. Wind rarely kills people indoors, so it plans for people displaced from damaged homes rather than for deaths.',
      ],
    },
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
