# ml/exports

Data files for the landing page, the Story lead, and the Simulation and Structures teammates. Regenerate with:

```bash
ml/.venv/bin/python ml/patterns.py        # deaths_by_hour, deaths_by_location, tornado_width_by_ef, fatalities_dots.csv
ml/.venv/bin/python ml/train_risk.py      # model_metrics (risk), shap_summary, county_risk
ml/.venv/bin/python ml/train_location.py  # model_metrics (location)
ml/.venv/bin/python ml/traffic_curve.py   # traffic_by_hour
ml/.venv/bin/python ml/calibrate.py fit        # calibration.json (needs the sim CLI and backtest places)
ml/.venv/bin/python ml/heatmap_bands.py        # heatmap_bands.json + writes sim/params/sim_params.json
ml/.venv/bin/python ml/calibrate.py backtest   # backtest.json
ml/.venv/bin/python ml/story_exports.py        # story/ (Flourish CSVs)
```

Unless stated otherwise, mortality summaries use NOAA Storm Events direct deaths, 50 states + DC, 1996-2025. Hours are local clock time. `fatalities_dots.csv` includes both direct (`D`) and indirect (`I`) deaths; filter `fatality_type == D` when comparing it with the direct-death charts.

Location shares exclude unknown locations. The simulator models buildings and crossing vehicles, not WATER or OUTDOOR exposures, so its breakdown does not have the same denominator as the national location chart. Simulator `OTHER` buildings are also not the NOAA `OTHER` location category.

The legacy backtest keys `recorded_in_buildings` and `summary.building_deaths` exclude known VEHICLE, OUTDOOR, WATER and OTHER locations but retain unknown locations. Label this **comparison target**, not confirmed building deaths. National-model predictions target all direct deaths. See `ml/METHODS.md` for validation limits.

| File | For | Shape |
|---|---|---|
| `deaths_by_hour.json` | landing page | `hour["Tornado"]` / `hour["Flash Flood"]`: 24 rows `{hour, events, fatal_events, deaths, deaths_per_100_events, share_of_deaths}`. Same under `month` (1-12). `tornado_night`: headline night vs day numbers. |
| `deaths_by_location.json` | landing page | `by_event_type[type].shares[class]` for classes MH, RES, PUBLIC, VEHICLE, WATER, OUTDOOR, OTHER. Tornado and Flash Flood also have `shares_night` / `shares_day`. |
| `shap_summary.json` | landing page (model explained) | `importance`: features ranked by mean abs SHAP. `dependence.hour / ef_rating / mh_share`: points `{x, mean_shap, relative_risk, n}`; `relative_risk` 1.3 means 30% more expected deaths than an average event. |
| `county_risk.json` | national map (deck.gl) | `fields` names the columns; `counties["37021"]` is a row in that order. Key is the 5 digit county FIPS string. Connecticut uses 2022 planning region codes, so it will not match older county maps. |
| `model_metrics.json` | methods section | `risk`: grouped by state folds, time split, calibration by decile. `location`: log loss vs baseline. |
| `fatalities_dots.csv` | Story lead (Flourish) | one row per death: year, event_type, location_class, age_band, sex, fatality_type (D direct, I indirect). |
| `traffic_by_hour.json` | Structures (`cars_per_hour` in crossings.json) | `cars_per_hour[h] = daily_volume_by_osm_tag["rural"][highway] * curves.weekday_rural.share[h]`. Shares: 24 values summing to 1, from FHWA NHTS 2017. Daily volumes: FHWA Highway Statistics 2023 (VM-2 / HM-20), keyed by OSM `highway` tag, rural and urban. |
| `backtest.json` | landing page (backtest chart) | `storms`: one row per held-out tornado with `recorded`, `recorded_in_buildings`, and `{expected, p05, p95}` for `calibrated`, `default_params`, `national_model`. `summary.building_deaths` / `summary.all_recorded_deaths`: totals, rank correlation, p05-p95 coverage per method. |
| `calibration.json` | methods section | fitted knobs vs defaults, bounds, loss parts before/after, optimizer trace. |
| `heatmap_bands.json` | methods section | final `risk_bands` and the share of storm cells per band for EF1-EF4, day and night, for each candidate cutoff set. |
| `story/` | Story lead | Flourish-ready CSVs + README with headline numbers, chart ideas and caveats. |
| `tornado_width_by_ef.json` | Simulation (default widths) | `by_ef.EF3.width_m.median` etc., p10 to p90, 2007-2025 tornado segments. |
