# Landing page

The site is one scrolling page. It's built from a list of sections in **`site.config.ts`**, and that's the only file you normally touch.

```
site.config.ts      ordered list of sections (edit this)
types.ts            what each section kind accepts
sectionTypes.tsx    kind → component registry
Landing.tsx         nav + renders the list (no section logic)
ChartFrame.tsx      iframe wrapper for one standalone chart
sections/           one component per kind
  GameSection.tsx   sized box, lazy-load, scroll handling
  GameMount.tsx     the only file that imports scene/ and game/
landing.css         layout only
../../public/brand.css           brand colors + fonts, shared with chart pages
../../public/charts/<id>/        standalone chart pages
```

## Add a chart

1. Copy `web/public/charts/_template/` to `web/public/charts/<your-chart>/`, and put your HTML/JS in its `index.html`. Any library from a CDN works. It runs isolated in an iframe.
2. Add one line to a `charts` section in `site.config.ts`:
   `{ src: '<your-chart>', title: 'Deaths by month', height: 400 }`
   Options: `note: '…'` adds a line of text under the chart. `wide: true` spans the full row. `bare: true` drops the card and caption, for charts with their own heading. `clickToInteract: true` covers the chart until it's clicked, for maps that zoom on scroll. `src` can also be a full URL (e.g. a Flourish embed).
   If a chart page sets `min-height: 100vh`, give it a starting `height` smaller than its content. The frame grows to fit but can't shrink.

Helpers: `/charts/_lib/chart-kit.js` (load after D3) gives a hover tooltip, auto-height, width-aware redraw (`onWidth`), rounded bars and label fitting. The "Does it work?" and shelter charts (`model-drivers`, `ef-risk`, `deadly-storm-catch`, `calibration-mix`, `backtest`, `shelter-candidates`) show how to use it. Chart colors in `brand.css` are checked for colorblind separation and contrast on navy: `--chart-model` (predictions) and `--chart-actual` (what really happened), and `--class-mh` / `--class-house` / `--class-public` for building types, validated as a set in that order. The raw `--cyan` is too bright for bars and dots.

Data: `ml/exports/*` is served at `/data/*`, e.g. `fetch('/data/backtest.json')`. Brand: `<link rel="stylesheet" href="/brand.css">`, then use `var(--cyan)`, `var(--font-body)`, etc. The template's last `<script>` lets the frame auto-fit the chart's height.

## Add, move or hide a section

- Reorder entries in `SITE.sections` to reorder the page.
- `nav: false` hides a section from the top nav. `showTitle: false` keeps the nav link but skips the heading.
- Not built yet? Use `{ id: 'x', kind: 'placeholder', title: '…', note: 'who / what' }`, then swap the `kind` when it's ready.

## Add a new kind of section (e.g. a React chart, deck.gl map)

1. `types.ts`: add `interface MapSection extends Base { kind: 'map'; … }` and add it to `SectionConfig`.
2. `sections/MapSection.tsx`: `export function MapSection({ section }: { section: MapSection }) { … }`
3. `sectionTypes.tsx`: add `map: MapSection`. TypeScript errors until you do.

## The game

`sections/GameMount.tsx` mounts `<Town>` + `<Game>` exactly like the old full-screen `App.tsx`. When the scene or game API changes, fix it there only. `GameSection.tsx` wraps it and:
- lazy-loads the 3D scene (its own ~1.3 MB chunk) only when you scroll near it, and
- keeps the map's wheel zoom from trapping page scroll until you click the map. Esc or a click outside releases it.

## Story charts

`where-people-died`, `risk-factors` and `national-animation` are copies of `story/flourish/*.html` (outside this repo). The only change is the height snippet appended before `</body>`. Re-copy them when the originals change.
