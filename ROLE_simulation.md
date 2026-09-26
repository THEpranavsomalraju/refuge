# Role: Simulation (read with REFUGE_overview.md)

You are helping me build my part of Refuge, a storm simulator for real towns. Read REFUGE_overview.md first. My job: the simulation engine, the protections, the optimizer, and the game interface. I pair all day with the Structures and 3D teammate, who builds the building and place files my engine reads. We test storms together every hour.

## Folders I own
`sim/` (engine, params, CLI, tests) and `web/src/game/` (game interface and results panel). Do not edit other folders without asking me.

## Datasets and references for my role

| Source | Use | Link |
|---|---|---|
| Enhanced Fujita scale, damage indicators and degrees of damage | Wind speeds at which each building type reaches each damage level | https://www.spc.noaa.gov/efscale/ |
| NOAA Storm Events bulk files | Tornado path widths per EF rating for default widths | https://www.ncei.noaa.gov/pub/data/swdi/stormevents/csvfiles/ |
| Storm Events column guide | Field meanings (TOR_F_SCALE, TOR_WIDTH, TOR_LENGTH) | https://www.ncei.noaa.gov/pub/data/swdi/stormevents/csvfiles/Storm-Data-Bulk-csv-Format.pdf |
| FEMA Hazus | Flood depth-damage functions by occupancy | https://www.fema.gov/flood-maps/products-tools/hazus |
| USACE go-consequences | Open source depth-damage and consequence code using NSI | https://github.com/USACE/go-consequences |
| USACE LifeSim | Life loss concepts for floods (lethality by depth and building) | https://www.hec.usace.army.mil/software/lifesim/ |
| NWS Turn Around Don't Drown | Water depths dangerous for vehicles | https://www.weather.gov/safety/flood-turn-around-dont-drown |
| USGS Flood Event Viewer | Helene high water marks, to sanity check flood heights | https://stn.wim.usgs.gov/FEV/ |

## Phase 1 (hours 0 to 3): engine skeleton on fake data
1. Set up `sim/` as a TypeScript package with pure functions and no browser dependencies, so the same code runs in a web worker and in Node.
2. Build a fake `buildings.json` with 200 buildings across all classes until the Structures teammate sends the real file.
3. Write `sim/params/sim_params.default.json`:
   - Wind: for each class, the wind speeds at which damage levels 1 to 4 begin (minor, major, destroyed, swept away), taken from the EF damage indicators. Mobile homes fail far earlier than masonry buildings.
   - Flood: depth above first floor at which each damage level begins, per class, from Hazus style curves.
   - Lethality: probability of death per occupant for each damage level and class. Modifiers for basement, night hours, warning minutes, and share over 65.
   - Vehicles: probability a car attempts a flooded crossing, and lethality by water depth over the road.
   - Tornado wind profile: wind drops from the center line toward the edge of the path.
   - Heatmap: `risk_bands` with starting cutoffs green below 0.0001, yellow 0.0001 to 0.01, red 0.01 to 0.1, deep red above 0.1, and `min_cell_people` of 5.
   Mark every number with a source note in a sibling `sim_params.sources.md`. The ML lead calibrates lethality values later.
4. Engine functions in `sim/core/`:
   - `intensityAt(building, scenario)`: wind speed from distance to path center line and EF rating, or water depth from flood height, `hand_m`, and first floor height.
   - `damageLevel(cls, intensity, params)`.
   - `deathProb(building, damage, scenario, params)`: uses night or day population by the scenario hour.
   - `vehicleDeathProb(crossing, scenario, params)`.
   - `expected(scenario, place, params)`: fast deterministic expected deaths, summing probabilities. Used by the optimizer and calibration.
   - `simulate(scenario, place, params)`: 500 seeded random runs returning the result format from the overview, including `cells`.
   - `aggregateCells(runs, place, scenario, params)`: for each H3 cell, people at the scenario hour (building occupants plus drivers at crossings in the cell), expected deaths, p05 and p95 from the runs, `risk` = expected deaths divided by people, `band` from `risk_bands`, `uncertain` = true when p05 and p95 risk fall in different bands, and `drivers`: the top two or three reasons (dominant building class, missing basements, night hour, flood depth, crossing traffic). Cells with zero people get `band: "empty"`. Cells below `min_cell_people` get `band: "sparse"`.
   - `diffCells(before, after)`: per cell change in expected deaths and risk, for the difference view.
5. Node CLI `sim/cli.ts`: reads a scenario JSON and place folder, prints the result JSON. Supports a batch mode reading many scenarios. The ML lead calls this from Python for calibration and backtests, so keep the interface stable.
6. Unit tests: a mobile home at the path center of an EF3 at night shows high risk, a masonry house with a basement at the edge shows low risk, a building on a hill shows zero flood risk, an empty cell returns band `empty`, cell expected deaths sum to the town total.

## Phase 2 (hours 3 to 8): real places and protections
1. Swap in real files from the Structures teammate. Test on every place together.
2. Write `sim/params/protections.json` with five protections and their effects on engine inputs:
   - Safe room: occupants of buildings within a walking radius move to protected shelter when warning time exceeds a minimum.
   - Siren upgrade: adds warning minutes for the whole place.
   - Crossing gates: cars stop before the chosen crossing.
   - Road to bridge: raises the crossing road above flood height.
   - Elevate or buy out: removes occupants from chosen flood-zone homes.
   Costs come from the Story lead with sources. Placement rules state where each protection goes (safe rooms on open lots, gates only at crossings).
3. Game state with Zustand in `web/src/game/`: place, storm type, EF or flood height, hour, warning minutes, tornado path drawing, budget, placed protections.

## Phase 3 (hours 8 to 14): game interface
1. Storm controls, tornado path drawing on the map (click start and end, drag to adjust), flood height slider.
2. Run the engine in a web worker so the interface never freezes.
3. Results panel: expected deaths, range from p05 to p95, breakdown by class, before and after comparison.
4. Call the Structures teammate's scene API for water level, tornado path, and placed protections during the storm. When the storm animation ends, call `showRiskMap(cells, bands)`. After a replay with protections, offer a toggle between the new risk map and `showDifference(before, after)`.
5. Cell hover card: odds written as "1 in N chance of death for someone here" (round N sensibly), people at this hour, expected deaths with range, and the drivers in plain words, for example "mostly mobile homes, no basements, 2 AM." Empty cells say "Nobody here at this hour." Sparse cells say "Too few people for a stable estimate."
6. Legend with the four bands in plain words (low, elevated, severe, extreme) and their odds ranges.
7. Building data card on click.

## Phase 4 (hours 14 to 18): optimizer and score screen (plain code, no LLM)
1. Candidate sites: a short list per protection type generated from the place (open lots near dense mobile homes for safe rooms, every crossing for gates and bridges, the highest-risk flood homes for elevation).
2. Optimal plan: maximize lives saved within the budget using `expected()`. With a small candidate list, search every affordable combination. If the list grows too large, use branch and bound or a greedy start by lives saved per dollar followed by swap improvements, and say which method ran.
3. Score screen: user lives saved, optimal lives saved, percentage of optimal reached, money spent by each plan, both plans drawn on the map, and `showSwipeCompare(userDiff, optimalDiff)` so the user drags a divider between the two difference maps and sees the red zones the optimizer protected.
4. H18 feature freeze.

## Definition of done
Engine passes tests, runs in the browser and in the CLI, all three places simulate correctly for both storm types, cell results drive the risk map with correct bands and hover text, five protections work, optimizer returns the best plan within budget, score screen shows how far the user landed from optimal.
