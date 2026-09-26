/** Run the calibrated params through Simulation's engine on the three featured towns.
 *
 *   node ml/featured_check.mjs --sim-root /path/to/sim --places /path/to/places
 *
 * 1. Lumberton demo tornado (sim/scenarios/lumberton_tornado.json) plus EF1-EF4 at 2 AM / 3 PM on the
 *    same path: band mix of populated cells, so the risk map is meaningful on the demo town.
 * 2. A test tornado across Chapel Hill and Morganton (bbox diagonal, EF3, 2 AM) to check bands there.
 * 3. Demo hotspots: highest-risk cells, and a reference list of places where a shelter would have the
 *    most expected deaths within WALK_M. This is ML reference data for the optimizer's candidate list,
 *    not the shelter rules (Simulation owns capacity, eligibility and reachability).
 * Writes ml/exports/featured_towns.json. Uses the engine's own per-cell results, no Python replica.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({ options: {
  'sim-root': { type: 'string', default: join(root, 'sim') },
  places: { type: 'string', default: join(root, 'places') },
} });
const sim = resolve(values['sim-root']);
const placesRoot = resolve(values.places);
const read = p => JSON.parse(readFileSync(p, 'utf8'));
const { simulateDetailed } = await import(pathToFileURL(join(sim, 'dist/core/index.js')));
const { parseParams, parseScenario, parseBuildings, parseCrossings } = await import(pathToFileURL(join(sim, 'dist/validation.js')));
const params = parseParams(read(join(root, 'sim/params/sim_params.json')));
const widths = read(join(root, 'ml/exports/tornado_width_by_ef.json')).by_ef;

const WALK_M = 400;          // assumed walking radius to a shelter within the warning time
const N_SITES = 5;
const BANDS = ['green', 'yellow', 'red', 'deep_red', 'sparse', 'empty'];

function loadPlace(id) {
  const f = join(placesRoot, id);
  return { buildings: parseBuildings(read(join(f, 'buildings.json'))), crossings: parseCrossings(read(join(f, 'crossings.json'))),
           cells: read(join(f, 'cells.json')), meta: read(join(f, 'place.json')) };
}

function run(place, scen) {
  const r = simulateDetailed(parseScenario(scen), place, params);
  const counts = Object.fromEntries(BANDS.map(b => [b, 0]));
  let touched = 0, uncertain = 0;
  for (const c of Object.values(r.cells)) {
    counts[c.band]++;
    if (c.expected_deaths > 0 && c.people >= params.min_cell_people) { touched++; if (c.uncertain) uncertain++; }
  }
  return { r, summary: { ef: scen.ef, hour: scen.hour, width_m: scen.width_m, expected_deaths: +r.expected_deaths.toFixed(3),
    p05: r.p05, p95: r.p95, people_exposed: r.people_exposed, band_counts: counts, cells_touched: touched,
    touched_uncertain_share: touched ? +(uncertain / touched).toFixed(3) : null,
    by_class: Object.fromEntries(Object.entries(r.by_class).filter(([, v]) => v > 0.005).map(([k, v]) => [k, +v.toFixed(3)])) } };
}

const toM = (lat0) => ([lon, lat]) => [lon * 111320 * Math.cos(lat0 * Math.PI / 180), lat * 110540];

function hotspots(place, r) {
  const center = new Map(place.cells.map(c => [c.h3, c.center]));
  const cells = Object.entries(r.cells).filter(([, c]) => c.expected_deaths > 0)
    .map(([h3, c]) => ({ h3, center: center.get(h3), ...c })).filter(c => c.center);
  const top = [...cells].sort((a, b) => b.risk - a.risk).filter(c => c.people >= params.min_cell_people).slice(0, 10)
    .map(c => ({ h3: c.h3, center: c.center, people: c.people, expected_deaths: +c.expected_deaths.toFixed(3),
                 risk: +c.risk.toFixed(5), band: c.band, drivers: c.drivers }));
  // greedy non-overlapping sites: the cell center with the most expected deaths within WALK_M
  const m = toM(cells[0]?.center[1] ?? 35);
  const pts = cells.map(c => ({ ...c, xy: m(c.center) }));
  const sites = [], used = new Set();
  for (let k = 0; k < N_SITES; k++) {
    let best = null;
    for (const p of pts) {
      if (used.has(p.h3)) continue;
      let deaths = 0, people = 0; const near = [];
      for (const q of pts) {
        if (used.has(q.h3) || Math.hypot(p.xy[0] - q.xy[0], p.xy[1] - q.xy[1]) > WALK_M) continue;
        deaths += q.expected_deaths; people += q.people; near.push(q.h3);
      }
      if (!best || deaths > best.deaths) best = { h3: p.h3, center: p.center, deaths, people, near };
    }
    if (!best || best.deaths <= 0) break;
    best.near.forEach(h => used.add(h));
    sites.push({ h3: best.h3, center: best.center, expected_deaths_within_walk: +best.deaths.toFixed(3),
                 people_within_walk: best.people, cells_within_walk: best.near.length });
  }
  return { top_risk_cells: top, shelter_reference_sites: sites };
}

const out = { note: ('Calibrated sim_params.json run through Simulation\'s engine (simulateDetailed) on the featured towns. '
  + 'band_counts cover every cell; cells_touched = cells with expected deaths > 0 and >= min_cell_people. shelter_reference_sites '
  + `are greedy non-overlapping spots with the most expected deaths within ${WALK_M} m: reference data, not Simulation's shelter rules.`),
  params_bands: params.risk_bands, walk_radius_m: WALK_M, towns: {} };

// 1. Lumberton demo + EF sweep on the same path
const lumberton = loadPlace('lumberton');
const demo = read(join(sim, 'scenarios/lumberton_tornado.json'));
const d = run(lumberton, demo);
out.towns.lumberton = { buildings: lumberton.buildings.length, demo: d.summary, ...hotspots(lumberton, d.r), sweep: [] };
for (const ef of [1, 2, 3, 4]) for (const hour of [2, 15]) {
  out.towns.lumberton.sweep.push(run(lumberton, { ...demo, ef, hour, width_m: widths[`EF${ef}`].width_m.median }).summary);
}

// 2. Chapel Hill and Morganton: EF3 at 2 AM across the bbox diagonal (a test path, not a historical storm)
for (const id of ['chapel_hill', 'morganton']) {
  const p = loadPlace(id);
  const [x0, y0, x1, y1] = p.meta.bbox;
  const scen = { ...demo, place_id: id, path: [[x0 + (x1 - x0) * 0.1, y0 + (y1 - y0) * 0.1], [x0 + (x1 - x0) * 0.9, y0 + (y1 - y0) * 0.9]],
                 ef: 3, hour: 2, width_m: widths.EF3.width_m.median };
  out.towns[id] = { buildings: p.buildings.length, test_ef3_night: run(p, scen).summary };
}

writeFileSync(join(root, 'ml/exports/featured_towns.json'), JSON.stringify(out, null, 1));
const fmtBands = b => `green ${b.green}  yellow ${b.yellow}  red ${b.red}  deep red ${b.deep_red}  sparse ${b.sparse}  empty ${b.empty}`;
const L = out.towns.lumberton;
console.log(`Lumberton demo (EF${L.demo.ef}, ${L.demo.hour}:00): ${L.demo.expected_deaths} expected [${L.demo.p05}-${L.demo.p95}], exposed ${L.demo.people_exposed}`);
console.log(`  cells: ${fmtBands(L.demo.band_counts)}  | touched ${L.demo.cells_touched}, uncertain ${L.demo.touched_uncertain_share}`);
console.log(`  by class: ${JSON.stringify(L.demo.by_class)}`);
for (const s of L.sweep) console.log(`  EF${s.ef} ${String(s.hour).padStart(2, '0')}h: ${s.expected_deaths} [${s.p05}-${s.p95}]  red ${s.band_counts.red}  deep red ${s.band_counts.deep_red}  yellow ${s.band_counts.yellow}`);
console.log('  top risk cells:', L.top_risk_cells.slice(0, 5).map(c => `${c.band} 1 in ${Math.round(1 / c.risk)} (${c.people} ppl, ${c.drivers.join('/')})`).join('; '));
console.log('  shelter reference sites:', L.shelter_reference_sites.map(s => `${s.expected_deaths_within_walk} deaths / ${s.people_within_walk} ppl`).join('; '));
for (const id of ['chapel_hill', 'morganton']) { const t = out.towns[id].test_ef3_night;
  console.log(`${id} test EF3 2 AM: ${t.expected_deaths} [${t.p05}-${t.p95}]  ${fmtBands(t.band_counts)}`); }
console.log('wrote ml/exports/featured_towns.json');
