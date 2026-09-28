import type { SectionConfig } from './types';

// THE page. Sections render top to bottom in this order.
//  - Reorder entries to reorder the page.
//  - nav: false hides a section from the top nav (it still renders).
//  - showTitle: false keeps the nav link but skips the heading (for charts with their own).
//  - kind: 'placeholder' holds a spot for something still being built.
//  - A chart `src` is a folder name in web/public/charts/, or a full URL (e.g. Flourish).
export const SITE: { title: string; tagline: string; sections: SectionConfig[] } = {
  title: 'Refuge',
  tagline: 'Send a tornado or hurricane through a real town. See who is at risk and why. Turn existing buildings into shelters, then replay the storm.',
  sections: [
    { id: 'hero', kind: 'hero', nav: false },
    { id: 'play', kind: 'game', title: 'Try a storm', height: 'calc(100dvh - 52px)' },
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
    // ml/exports as of 2026-09-27; re-check them if the ML exports are regenerated.
    {
      id: 'does-it-work',
      kind: 'charts',
      title: 'Does it work?',
      intro:
        'Behind the simulator are two models trained on NOAA storm deaths from 1996–2025. A national model, trained on 150,812 tornadoes ' +
        'and flash floods, learns what makes a storm deadly. A location model learns where the deaths happen: mobile homes, houses, public buildings. ' +
        'The simulator’s death rates for each kind of damaged building were then calibrated against real tornadoes and that location mix. ' +
        'All of it was tested on storms it never saw.',
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
          src: 'calibration-mix', title: 'Calibration moved the simulator toward where people really die', height: 140, wide: true,
          note: 'Share of simulated building deaths on 48 historical tornadoes, before and after fitting five multipliers: houses and apartments 1.66×, mobile homes 1.02×, public buildings 0.98×, night 1.26×, basement 0.24×. The target comes from the location model, which beats national-average shares in every held-out state.',
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
        'It undercounts the deadly ones. Across all 30 storms it expects 10 deaths against 28 recorded, and only 3 of the 13 storms with counted deaths land inside its range; its nominal 90% range holds the real count for 67% of storms, not 90%. The largest, Texas 2024 (7 recorded), comes closest at 6.2. Calibration barely moved the total (10.7 before, 10.0 after). The national model on its own expects 20.6, but it predicts all deaths rather than the same target, so that isn’t a like-for-like comparison.',
        'Likely reasons, which this test can’t separate: NOAA records a straight line between a tornado’s start and end points rather than its surveyed track; the Structure Inventory is a 2026 snapshot that misses some buildings; and the damage and lethality rules are simplified. The game’s death totals are likely on the low side, and they’re most useful for comparing plans against the same storm.',
        'Hurricane mode uses a separate wind model. Its wind field gives 162 mph at Mexico Beach for Hurricane Michael (2018) and 96 mph in Wilmington for Florence (2018), where the airport measured a 105 mph gust. Deaths from wind at home, fit to 44 US landfalls from 2004–2024, are rare (about 1 in 237,000 in a house at a 160 mph gust), so hurricane mode plans for the people displaced from damaged homes rather than for deaths.',
      ],
    },
    // Numbers below are from ml/exports/shelter_candidates_lumberton.json as of 2026-09-27.
    {
      id: 'shelters',
      kind: 'charts',
      title: 'Where a shelter saves the most',
      intro: [
        'In the game’s planning phase you turn existing schools, churches and businesses into tornado shelters: a hardened quarter of the building, 5 square feet per person, about $1,500 per person. On the Lumberton demo storm (EF3 at 2 AM, 10 minutes’ warning), the best buildings aren’t the biggest. A church that holds 129 people saves nearly twice as many lives as one that holds 745, at a sixth of the cost: 345 mobile-home residents live within a short walk of the smaller church, against 187 for the larger one.',
        'Even the best plan has a ceiling. If 30% of mobile-home residents go to a shelter (the share Chaney and Weaver found in a 2010 study), no set of shelters saves more than about 5.6 of the storm’s 18.9 expected deaths. Warning time and willingness to go matter as much as the buildings.',
      ],
      charts: [
        {
          src: 'shelter-candidates', title: 'The 25 buildings that save the most on their own', height: 320, wide: true,
          note: 'Each dot is one candidate building on the Lumberton demo storm. Only mobile-home residents within a 321 m walk (the reach with 10 minutes’ warning) are assumed to go. Lives saved depend on the storm’s path, so the game recomputes them for every storm you draw. Model estimates, not proven effects.',
        },
      ],
    },
    {
      id: 'methods',
      kind: 'text',
      title: 'Methods',
      paragraphs: [
        'Data: NOAA Storm Events Database, 1996–2025 (1.78 million event reports, 23,852 fatality records; models use direct deaths in the 50 states and DC); CDC/ATSDR Social Vulnerability Index 2022; USACE National Structure Inventory, retrieved September 2026; FHWA travel survey and highway statistics.',
        'The national model is a LightGBM model with a Poisson objective, which suits counts that are mostly zero with rare large values. It sees only what is known about the storm and the place: EF rating, path length and width, duration, storm system size, hour, month and five county features. Injuries and damage are left out because they measure the outcome. It was tested on states it never saw and on 2020–2025 after training through 2019.',
        'The location model is a multinomial logistic regression on 4,047 direct deaths with a known location. It predicts the share of a fatal storm’s deaths in mobile homes, houses, public buildings, vehicles, water and outdoors.',
        'For a tornado, the simulator estimates wind speed, damage level and lethality for the people inside each building from the Structure Inventory, then samples 500 runs to get expected deaths and a range. For a hurricane, winds come from a Holland wind profile around the storm track; storm surge, rain flooding and falling trees are not modeled.',
        'Limits: Structure Inventory populations are modeled estimates, and the inventory can miss buildings. One calibration storm (Edwardsville, Illinois, 2021) was excluded because the warehouse where its deaths happened isn’t in it. The risk map’s color bands are fixed presentation thresholds, not validated mortality categories. Model effects and shelter effects are estimates, not proven causes.',
      ],
    },
  ],
};
