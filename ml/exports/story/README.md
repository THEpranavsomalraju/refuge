# Refuge data for charts (from the ML lead)

All files are CSV and load straight into Flourish. Source: NOAA Storm Events 1996-2025 (direct deaths, 50 states + DC),
CDC/ATSDR Social Vulnerability Index 2022, USACE National Structure Inventory, FHWA travel survey.
Everything regenerates from `ml/story_exports.py`, so if a number changes it changes everywhere.

## Headline numbers (safe to quote)

- Mobile homes: **42% of tornado deaths** where the location is known, rising to **54% at night**.
- Vehicles: **45% of flash flood deaths with known locations**; another 24% were in the water.
- Night tornadoes (8 PM to 6 AM) are 29% of tornadoes but **36% of tornado deaths**
  (6.3 vs 4.6 deaths per 100 tornadoes).
- The national model ranks storms well: on 2020-2025 storms it never saw, AUC **0.83**
  (tornadoes 0.95, flash floods 0.74).
- Backtest on 30 tornadoes held out from parameter fitting (see the experiment disclosure in METHODS.md): the largest, Texas 2024
  (EF3, 7 deaths), simulated at **6.2 (range 3-10)**.
  Across all 30, the simulator predicts 10 deaths vs 28 recorded
  in the comparison target, with rank correlation 0.49.

## Files and suggested charts

| File | Chart idea |
|---|---|
| deaths_by_year.csv | Line or column chart, tornado vs flash flood deaths per year |
| deaths_by_storm_type.csv | Bar chart: which storms kill (all NOAA types) |
| deaths_by_hour.csv | Radial or column chart by hour; use *_per_100_storms to show night danger |
| deaths_by_month.csv | Seasonality |
| deaths_by_location.csv | Stacked bar or waffle: where people die, tornado day vs night vs flash flood |
| fatalities_dots.csv (in ml/exports/) | Direct AND indirect deaths (23,187 rows); filter fatality_type to D for comparison with direct-death charts |
| model_drivers.csv | Bar chart: what the model says drives deaths |
| model_effect_hour.csv / _ef_rating.csv / _mobile_home_share.csv | Line charts; relative_risk 1.3 = 30% more expected deaths than an average storm |
| model_validation.csv | Table: how well the model does on states and years it never saw |
| model_calibration_by_decile.csv | Paired bars: predicted vs actual deaths, storms grouped by predicted risk |
| location_model_examples.csv | Stacked bars: same EF3 tornado, night vs day, many vs few mobile homes |
| backtest_storms.csv | Dot plot: recorded deaths vs simulator expected with its low-high range, one row per real storm |
| backtest_summary.csv | Table: simulator vs national model on the held-out storms |
| calibration_knobs.csv | Table: what calibration changed |
| county_risk.csv | US county map (Flourish uses 5 digit FIPS). risk_same_ef2_tornado_at_night compares counties on vulnerability alone. Highest: Putnam County, Florida, Lewis County, Tennessee, DeSoto County, Florida, Adams County, Wisconsin, Liberty County, Texas |

## Words to use

- "risk per person" and "expected deaths with a range", never "this person will die".
- Model effects are **estimates, not proof of cause**.
- Structure Inventory populations are **modeled estimates**.

## Caveats to keep on the chart or in a footnote

- Location shares leave out deaths NOAA recorded as "Unknown" (about 16% overall, 6% for tornadoes).
- Connecticut is blank on the county map (its counties were redrawn in 2022). Territories are not included.
- County map values come from a model that never saw that county's state, so past disasters are not memorized.
- The backtest target (legacy recorded_in_buildings field) excludes known VEHICLE, OUTDOOR, WATER and OTHER
  locations but retains unknown locations. It is not confirmed building deaths. The national model predicts
  all direct deaths, so its comparison against this reduced target is not target-matched.
- NOAA endpoint geometry, inventory gaps and simplified lethality may contribute to underprediction;
  the backtest does not isolate the cause or establish spatial accuracy. Drawing a path does not validate death estimates.
- Sampling ranges condition on fixed inputs and omit parameter, exposure and geometry uncertainty.
- Buildings and modeled populations are contemporary NSI records retrieved in 2026; older storms replay
  on contemporary exposure, not reconstructed historical towns.
- The game models buildings and crossing vehicles; its breakdown excludes WATER and OUTDOOR exposures
  and differs from the national location chart. A town's vehicle share need not equal the national 45%.
- Flood/vehicle parameters are uncalibrated. Missing HAND or traffic is unavailable data, not verified safety.
- Night in all charts = 8 PM to 5:59 AM local clock time.
