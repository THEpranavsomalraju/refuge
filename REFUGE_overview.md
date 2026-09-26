# Refuge: Project Overview (share with the whole team)

Carolina Data Challenge 2026, Natural Science track, theme AI for social good. 24 hour build. 7 minute presentation plus 2 minutes of Q&A. Submission on DevPost with code and visuals.

## One line

Refuge is a storm simulator for real American towns. Pick a place, send a tornado or flash flood through the real buildings, see who is at risk and why, then spend a budget on protections, replay the storm, and see how close your plan came to the best possible plan.

## What a user experiences

1. The site opens on a stylized 3D model of a real North Carolina town at night. Rain starts, a creek rises, and homes by the water and cars at a road crossing glow red. A counter settles on expected deaths with a range.
2. The user takes control. They pick one of three featured places, choose tornado or flash flood, set strength, time of day, and warning lead time. For a tornado, they draw the path across town with the mouse. For a flood, they set the flood height.
3. They press play. Storm effects run. When the storm ends, the weather fades, buildings drop to neutral gray, and the town turns into a risk map: hexagon cells rise out of the ground colored by the chance of death for a person in each area. A results panel shows expected deaths, a range from 500 simulated runs, and a breakdown by location type: mobile homes, houses, public buildings, vehicles, outdoors.
4. Hovering a cell shows odds in plain words ("1 in 40 chance of death for someone here"), people inside at this hour, expected deaths with a range, and what drives the risk ("mostly mobile homes, no basements, 2 AM"). Clicking a building shows a data card: building type, stories, basement, elevation, people inside at this hour, and why the risk runs high or low.
5. Planning phase. The user gets a budget and five protections: community safe room, siren upgrade (longer warning), automatic gates at low water crossings, raising a road into a bridge, and elevating or buying out flood-prone homes. They place items and replay the same storm.
6. Score screen. The code computes the optimal plan for the same storm and budget with a search algorithm (no LLM). The screen shows the user's lives saved, the optimal lives saved, the percentage of optimal the user reached, and a swipe slider comparing two difference maps: cells the user's plan made safer versus cells the optimal plan made safer. The user sees which red zones the optimizer protected and they missed.
7. Scrolling down leaves the game and enters the evidence: national storm death patterns, the ML model explained, the backtest against real historical storms, and methods.

## How the simulator decides who is at risk

The simulator reads a data card for every real building from the USACE National Structure Inventory: occupancy type (mobile home, house, school, church, business), construction material, stories, basement, ground elevation, flood zone, and population at 2 AM and 2 PM split by under and over 65. Then four steps per building:

1. **Intensity.** Wind speed from the building's position inside the tornado path, or water depth from flood height minus building elevation.
2. **Damage.** Damage level for the building type at the intensity, from Enhanced Fujita damage indicators (wind) and depth-damage curves (flood).
3. **Lethality.** Probability of death for occupants given damage level, basement, time of day, warning time, and age mix. Vehicles at crossings follow a separate rule based on water depth and traffic.
4. **Sampling.** 500 random runs give expected deaths and a range.

The ML model trained on NOAA Storm Events fatality records calibrates the lethality numbers so simulated totals and the location mix of deaths match history. A backtest replays real historical tornadoes on the real buildings along each path and compares predicted deaths to recorded deaths.

## The post-storm risk map

- **What the color means:** risk of death for a person in the cell = expected deaths in the cell divided by people in the cell at the storm's hour (Structure Inventory 2 AM or 2 PM population, plus drivers at crossings inside the cell).
- **Unit:** H3 hexagon cells (resolution 10, roughly a city block). No single real home ever gets marked.
- **Bands (log scale, fixed for every storm and place):** green below 1 in 10,000, yellow 1 in 10,000 to 1 in 100, red 1 in 100 to 1 in 10, deep red above 1 in 10. Starting values. The ML lead finalizes cutoffs after calibration, then they freeze.
- **Colorblind safe:** the ramp runs pale yellow-green to orange to deep red with a subtle hatch on the deep red band. Never rely on red versus green alone.
- **Empty cells** (zero people at the storm's hour) stay uncolored, never green. Green means low risk, uncolored means nobody there.
- **Small cells** with fewer than 5 people show an outline only.
- **Uncertainty:** cells where the p05 to p95 range spans more than one band get a hatched texture.
- **Height (3D):** cell height shows expected deaths, color shows risk per person. Tall red means many people in grave danger.
- **Difference view** after protections: cells which got safer turn blue, unchanged cells stay gray.
- **Transition:** hexagons rise band by band, deep red last. Hold for a beat, then the results panel slides in.

## Scope

**Must ship:** three featured places, tornado and flash flood, five protections, post-storm risk map with difference view, results panel, optimal plan score screen with swipe comparison, landing page with charts and methods, backtest results.

**Stretch:** any U.S. county loaded live, warned versus unwarned analysis, shareable scenario links, hurricane storm surge.

**Featured places (team confirms in hour 1):** a western North Carolina mountain town hit by Helene flooding (for flash flood), an eastern North Carolina town with large mobile home communities and tornado history (for tornado), and Chapel Hill (for the judges).

## Team and roles

| Person | Role | Owns |
|---|---|---|
| ML lead | National risk model, location model, calibration, backtest, landing page data | `ml/` |
| Structures and 3D | Structure Inventory pipeline, roads, streams, terrain, low water crossings, 3D town, landing page build | `places/`, `web/src/scene/`, `web/src/landing/` |
| Simulation | Four step engine, storm effects logic, protections, optimizer, game UI and results panel | `sim/`, `web/src/game/` |
| Story lead (non-technical) | Place research, protection costs with sources, art direction, Flourish charts, copy, slides, DevPost, rehearsal | `story/` |

Structures and Simulation pair closely all day: every building format change gets tested against the engine the same hour.

## Architecture

- **Python** for data and ML (ML lead, Structures pipeline).
- **TypeScript** simulation engine as pure functions in `sim/core/`, used two ways: in the browser inside a web worker, and from the command line through a Node CLI so the ML lead runs calibration and backtests from Python.
- **Web app:** React with Vite, React Three Fiber and drei for 3D, Zustand for state, Tailwind for styling, deck.gl for the national map on the landing page, Flourish embeds for story charts.
- **Hosting:** Vercel or Netlify free plan. Code on GitHub.
- **Everything free.** No paid APIs. No LLM inside the product.

## Shared file formats (agree in hour 1, then freeze)

### 1. `places/<place_id>/buildings.json` (owner: Structures)
```json
[{
  "id": "nsi_496985931",
  "lon": -81.5754, "lat": 30.2622,
  "h3": "8a44c1a4b8dffff",
  "cbfips": "120310159233002",
  "footprint": [[-81.57541, 30.26215], "..."],
  "occtype": "RES1-1SWB",
  "cls": "MH",
  "stories": 1,
  "basement": false,
  "ground_elev_m": 5.8,
  "first_floor_ht_m": 0.6,
  "hand_m": 2.4,
  "firmzone": "AE",
  "pop_night_u65": 2, "pop_night_o65": 1,
  "pop_day_u65": 1, "pop_day_o65": 1
}]
```
`cls` values: `MH` (manufactured or mobile home), `RES_WOOD`, `RES_MASONRY`, `MULTI` (apartments), `SCHOOL`, `WORSHIP`, `COMMERCIAL`, `BIGROOF` (large open-span roofs like big-box stores and gyms), `OTHER`. `hand_m` is height above the nearest stream.

### 2. `places/<place_id>/crossings.json` (owner: Structures)
```json
[{"id": "x_12", "lon": -82.39, "lat": 35.60, "road_name": "Old Hwy 70",
  "road_class": "residential", "road_elev_m": 612.3, "hand_m": 0.8,
  "cars_per_hour": [2,1,1,1,2,6,14,22,18,10,9,10,11,10,11,14,20,24,16,10,8,6,4,3]}]
```

### 3. `places/<place_id>/place.json` (owner: Structures)
Place name, county FIPS, bounding box, center, camera start, stream lines, road lines, terrain source.

### 4. `sim/params/sim_params.json` (owner: ML lead, starting from Simulation's defaults)
Damage thresholds by building class for wind, depth-damage steps for flood, lethality by damage level and class, modifiers for basement, night, warning minutes, and age over 65, vehicle rule parameters, tornado wind profile, tornado width distribution per EF rating, and `risk_bands` (the fixed heatmap cutoffs) plus `min_cell_people` (default 5). Simulation writes `sim_params.default.json` from engineering sources. ML lead calibrates and writes `sim_params.json`.

### 5. `sim/params/protections.json` (owner: Simulation, costs from Story lead)
Each protection: id, name, cost in dollars, placement rule, and effect on the engine inputs.

### 6. Scenario in and result out (owner: Simulation)
```json
{"place_id": "swannanoa", "hazard": "tornado", "ef": 3,
 "path": [[-82.40, 35.59], [-82.33, 35.62]], "width_m": 400,
 "flood_height_m": null, "hour": 2, "warning_min": 8,
 "protections": [{"type": "safe_room", "lon": -82.37, "lat": 35.60}],
 "runs": 500, "seed": 42}
```
```json
{"expected_deaths": 3.4, "p05": 1, "p95": 7,
 "by_class": {"MH": 2.1, "RES_WOOD": 0.8, "VEHICLE": 0.3, "OTHER": 0.2},
 "building_prob": {"nsi_496985931": 0.12},
 "cells": {"8a44c1a4b8dffff": {"people": 38, "expected_deaths": 0.9, "p05": 0, "p95": 3,
   "risk": 0.0237, "band": "red", "uncertain": true, "drivers": ["MH", "no_basement", "night"]}}}
```

## Repo layout and merge rules

```
ml/            ML lead only
places/        Structures only (data pipeline and outputs)
sim/           Simulation only
web/src/scene/     Structures
web/src/landing/   Structures
web/src/game/      Simulation
web/src/shared/    agree before editing
story/         Story lead
```
Each person edits only their own folders. Each folder keeps its own dependency file. Pull often, open small pull requests, never commit files over 20 MB or any `.env` file.

## Timeline

| Hours | Milestone |
|---|---|
| 0 to 2 | Formats agreed, places picked, repo set up, datasets downloading |
| 2 to 8 | First place built from Structure Inventory, engine running on default params, first national model, 3D town renders |
| 8 to 14 | All three places, calibration and backtest, storm effects, protections working, landing page built |
| 14 to 18 | Optimizer and score screen, calibrated params wired in, deployed |
| 18 to 22 | Polish, performance on presentation laptop, backup demo video, slides |
| 22 to 24 | Two timed rehearsals, DevPost submitted |

## Honesty and sensitivity rules

- Show risk as hexagon cells and totals with ranges. Never show a specific person dying in a specific real home.
- Label protection effects as model estimates, not proven causal effects.
- Structure Inventory populations are modeled estimates. Say so on the methods page.
- Some featured places lost real people in Helene. Keep the tone calm and serious. No game-style scoreboards, explosions, or sound effects.

## The 7 minute pitch

- 0:00 Live opening: the mountain town flood at night.
- 1:00 The problem: storm deaths concentrate in predictable places (mobile homes, cars at crossings, night storms), and planners lack a way to test protections before the storm.
- 2:00 How Refuge works: real buildings, engineering damage rules, a model trained on 30 years of deaths.
- 3:00 Live demo: draw a tornado, place a safe room, replay, compare against the optimal plan.
- 5:00 Proof: backtest against real storms, model validation.
- 6:15 Who uses this: emergency managers, planners applying for mitigation grants, residents.
- 6:45 Team and close.
