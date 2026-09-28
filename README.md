# Refuge

Send a tornado or hurricane through a real American town. See who is at risk and why, turn existing schools, churches and businesses into shelters, then replay the storm and compare your plan with the best one.

1st place, Carolina Data Challenge 2026, Natural Science track.

**Live site: https://refugestorms.vercel.app**

## Any U.S. town

In the game's town step, search for any U.S. city or town. The browser builds it in about a minute from public data: buildings and populations (USACE National Structure Inventory), outlines, heights, roads and rivers (OpenStreetMap), elevation (AWS Terrain Tiles) and the boundary (Census TIGERweb). Big cities are cropped to a 15 × 15 km area you pick, holding up to 20,000 buildings. Built towns are saved in that browser. The builder lives in `web/src/builder/` and follows the same rules as the Python pipeline in `places/` (a browser-built Lumberton matches the Python one building for building).

The Structure Inventory and one OpenStreetMap server are reached through same-origin proxy paths (`/nsi-api`, `/overpass-api`), set up in `web/vite.config.ts` for local runs and `vercel.json` for the live site.

The Python pipeline can also build a town locally, which the featured towns use:

```bash
python3.12 -m venv places/.venv
places/.venv/bin/pip install -r places/requirements.txt
places/.venv/bin/python places/build_server.py
```

## Simulation engine tests

```bash
npm ci --prefix sim
npm test --prefix sim
```

## ML pipeline

The outputs are already in `ml/exports/` and `sim/params/sim_params.json`, so this is only needed to rebuild them.

```bash
python3.12 -m venv ml/.venv
ml/.venv/bin/pip install -r ml/requirements.txt

ml/.venv/bin/python ml/download.py          # NOAA, SVI, FHWA files -> data/raw/ (~320 MB)
ml/.venv/bin/python ml/build_tables.py      # -> data/processed/
ml/.venv/bin/python ml/patterns.py          # deaths by hour, month and location
ml/.venv/bin/python ml/train_risk.py        # national risk model, SHAP, county map
ml/.venv/bin/python ml/train_location.py    # where deaths happen
ml/.venv/bin/python ml/traffic_curve.py     # hourly traffic for road crossings
ml/.venv/bin/python ml/backtest_select.py   # historical tornadoes for calibration and backtest
ml/.venv/bin/python ml/calibrate.py fit     # fit the simulator (needs `npm run build --prefix sim`)
ml/.venv/bin/python ml/heatmap_bands.py     # risk map bands -> sim/params/sim_params.json
ml/.venv/bin/python ml/calibrate.py backtest
ml/.venv/bin/python ml/hurricane_wind.py    # hurricane wind model
ml/.venv/bin/python ml/hurricane_calibrate.py
ml/.venv/bin/python ml/hurricane_damage.py
ml/.venv/bin/python ml/story_exports.py     # CSVs for the charts
```

## Layout

| Folder | What |
|---|---|
| `web/` | Site, game UI and 3D town (React, React Three Fiber) |
| `sim/` | Storm engine: tornado and hurricane effects, shelters, plan optimizer |
| `places/` | Town builder (buildings, roads, streams, terrain) and the prebuilt towns |
| `ml/` | Risk and location models, simulator calibration, backtest, chart data |

## Data

NOAA Storm Events Database (1996–2025), CDC/ATSDR Social Vulnerability Index 2022, USACE National Structure Inventory, USGS 3DEP elevation, OpenStreetMap, NOAA HURDAT2, FHWA travel survey and highway statistics.

## Team

- Pranav Somalraju: models and calibration
- Mahil Manoharan: simulation
- Soham Patki: town data and 3D
- Ananya Anchlia: story and site
