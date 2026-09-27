# Methods (ML)

ML metrics below are produced by the scripts in `ml/` and stored in `ml/exports/`. Simulation assumptions and teammate checks are identified separately.

## Data
- **NOAA Storm Events, 1996–2025.** The raw download has 1.78M event reports and 23,852 fatality records, including direct and indirect deaths and unknown locations. Models and national mortality summaries use direct deaths in the 50 states and DC. The dot export retains direct and indirect deaths, labeled D/I. Hours were converted from NOAA's local standard time to local clock time.
- **CDC/ATSDR Social Vulnerability Index 2022** (county level, built on ACS 2018–2022): mobile home share, share over 65, households without a vehicle, population density, SVI score. Connecticut's 2022 county redraw means its NOAA counties do not join.
- **USACE National Structure Inventory** (via `places/fetch_nsi.py`): available building records, type, basement, and modeled 2 AM / 2 PM population. These are **modeled estimates** retrieved in September 2026, not verified historical exposure. Population estimates have their own source vintage; retrieval date does not establish the vintage of every inventory attribute. Missing structures can materially change results.
- **FHWA National Household Travel Survey 2017** and **Highway Statistics 2023**: hourly traffic shape and daily vehicles per road class, for cars at flooded crossings.

## National risk model
LightGBM with a **Poisson** objective predicts direct deaths per tornado or flash flood event (150,812 events, 1,891 fatal). Poisson fits counts that are mostly zero with rare large values. Features are only things known about the storm and the place: event type, EF rating, path length and width, duration, storm system size, tropical rain flag, hour, month, and five county features. Injuries and damage are left out because they measure the outcome.

**Validation:** 5-fold **GroupKFold by state** (the model is always tested on states it never saw) plus a **time split** (train through 2019, test 2020–2025). The number of boosting rounds (409) was chosen by grouped CV on pre-2020 data only.

| Test | AUC (fatal or not) | Deviance explained | Fatal events in top 5% |
|---|---|---|---|
| State folds 1–5 | 0.74, 0.81, 0.83, 0.84, 0.82 | 21%, 42%, 51%, 40%, 33% | 26%–51% |
| 2020–2025 | **0.83** | **29%** | 42% |
| 2020–2025, tornadoes | 0.95 | 62% | 79% |
| 2020–2025, flash floods | 0.74 | 10% | 24% |

On 2020–2025 the model predicts 799 deaths against 994 recorded. Most of the gap is the July 2025 Kerr County, TX flood (two reports with 61 and 45 deaths), which the model gave about 0.03 each. Without events of 40+ deaths, deviance explained is 32%. The calibration table by decile is in `model_metrics.json`.

**SHAP** (effect on expected deaths vs an average event): EF0 0.3×, EF2 5×, EF3 24×, EF4 91×. Midnight 1.2× vs midday 0.9×. Counties in the top tenth for mobile home share 1.12× vs 0.94× in the bottom tenth. These are **model estimates, not causal effects**.

**Leakage checks.** EF rating is assigned after the storm from damage surveys, so part of its effect is "the storm hit buildings". That is acceptable here because the simulator takes EF as an input. County features act like a fingerprint, so a model trained on all data partly memorizes past disasters. The county map (`county_risk.json`) therefore uses **out-of-fold** predictions from models that never saw that county's state.

## Location model
Multinomial logistic regression predicts where deaths happen (mobile home, house, public building, vehicle, water, outdoors, other) for a fatal event. It uses 4,047 direct deaths with a known location, and each event gets equal total weight. It beats the baseline of national shares per event type in every state fold (0.3% to 6.0% lower log loss) and on 2020–2025 (1.369 vs 1.448, 5.5% lower). Among direct deaths with known locations, mobile homes are 42% of tornado deaths (54% at night) and vehicles are 45% of flash flood deaths.

The game models building occupants and crossing vehicles. It has no WATER or OUTDOOR exposure model, and its OTHER building class does not map to NOAA's OTHER location class. Its breakdown therefore has a different denominator from the national chart. The 45% vehicle share is a national descriptive comparison, not a target for each town or flood scenario.

## Simulator calibration
- **Storms.** 80 historical tornadoes, 2015–2025, EF1+, 26 states. NOAA county segments were stitched back into whole paths (82% of NOAA-marked continuations linked). Each storm had to hit something: a death, an injury, or at least $250k damage.
- **Sampling.** 40 fatal and 40 non-fatal storms from 1,663 eligible tornadoes. Stratum-size weights approximate their prevalence; the per-state selection cap means these are not exact inverse inclusion probabilities. Thirty storms were held out from parameter fitting. A post-test experiment is disclosed below.
- **Exclusions.** Two training storms are excluded by stated rules: Edwardsville 2021 (all deaths in a warehouse missing from NSI) and one storm whose NOAA begin and end points coincide.
- **Free knobs.** Five knobs, all inside bounds agreed with Simulation: death rate multipliers for mobile homes, houses and apartments, and public buildings, plus the night and basement modifiers. Vehicle, over-65 and warning-time effects stay at Simulation's values. Every storm uses a fixed 10-minute warning, so the warning effect cannot be fit.
- **Loss.** Weighted Poisson deviance against direct deaths after subtracting known VEHICLE, OUTDOOR, WATER and OTHER locations. Unknown locations remain; this is a comparison target, not confirmed building deaths. Legacy export keys `building_deaths` and `recorded_in_buildings` retain their names for compatibility. The loss adds 0.1 to expected deaths inside the objective only, a penalty for mismatch with the location model's mix, and a mild pull toward Simulation's engineering defaults. Published expected deaths do not include that floor.
- **Result.** Mobile home 1.02, house and apartment 1.66, public 0.98, night 1.26, basement 0.24. The simulated mix of building deaths moved from 74/21/5% to 66/29/5% (mobile home / house / public) against the location model's 62/33/5%.
- **Disclosure.** After seeing the held-out results, we tried one more knob, a scale on the death rate for minor and major damage. The training storms rejected it: it added deaths to storms that killed nobody faster than it explained fatal ones. We removed it. The held-out results below are unchanged by that test.

## Backtest (30 held-out tornadoes)

| Method | Predicted vs comparison target | Rank correlation | Target inside p05–p95 |
|---|---|---|---|
| Simulator, calibrated | 10.0 vs 28 | 0.49 | 67% |
| Simulator, uncalibrated | 10.7 vs 28 | 0.50 | 67% |
| National model alone | 20.6 vs 28 | 0.51 | 80% |

The largest held-out storm (Texas 2024, EF3, 7 deaths) simulates at 6.2 (range 3–10). The simulator underpredicts the full test target. NOAA endpoint geometry, missing or contemporary NSI exposure, and simplified hazard/lethality assumptions may contribute; this experiment does not identify their separate effects or establish spatial accuracy. Drawing a path in the game does not remove uncertainty in exposure or lethality. Surveyed tracks remain future work, not an agreed rebuild.

The national model predicts all direct deaths, whereas the simulator comparison target excludes known nonbuilding locations. Its row is not a target-matched validation benchmark. Simulator p05–p95 covers independent occupant sampling conditional on fixed inputs, not uncertainty in paths, parameters or population. The nominal 90% range covers only 67% of these test targets.

## Flood integration and class ranking

The `flood` and `vehicle` blocks in `sim/params/sim_params.json` are copied unchanged from Mahil's defaults at `ce766f5`. They are **uncalibrated**, with assumption sources in `sim/params/sim_params.sources.md` on that branch. Building depth is `flood_height_m - hand_m - first_floor_ht_m`; a null first-floor height currently defaults to zero. Crossing depth is `flood_height_m - hand_m`. One stream-relative height is applied across the place; this is not a hydraulic flow simulation.

Flood ignores the tornado MH/RES/PUBLIC multipliers and basement modifier. It retains night, warning and building age effects, plus VEHICLE for crossings. Sharing the tornado-fitted night modifier does not establish flood calibration. Null HAND or crossing traffic is reported in `no_flood_data`; omitted exposure must not be displayed as verified zero risk. Real flood checks await Structures' HAND and crossing data.

Keep the existing shared tornado lethality table. Mahil's uniform-position, full-swath checks report MH/wood-house risk ratios of about 19, 138 and 25 at EF2, EF3 and EF4. These are model diagnostics, not independent validation against population studies. MULTI can outrank MH at an EF4 centerline because both reach their highest modeled damage level and RES has the larger fitted multiplier. This is not true for every building class: wood houses need 200 mph for level 4, above the model's 183 mph EF4 peak. Do not alter lethality simply to force a preferred color ranking.

## Heatmap bands
Risk per cell = expected deaths in the H3 cell / people there at the storm's hour, including modeled crossing occupants for flood. We ran EF1–EF4 through 78 active backtest places at 2 AM and 3 PM using a Python replica checked against CLI totals on 12 scenarios. With the starting cutoffs, deep red never appeared, even for an EF4 at night. **Final cutoffs, one decade lower, log scale:** yellow from 1 in 100,000, red from 1 in 1,000, deep red from 1 in 100. Minimum 5 people per cell; empty cells stay uncolored. Among touched cells with at least five people, EF4 at night is 18% green, 56% yellow, 18% red and 7% deep red; EF1 is 85% green. These fixed presentation thresholds in `sim/params/sim_params.json` are not validated mortality categories or universal damage boundaries. See `ml/figures/cell_risk_distribution.png` and `ml/INTEGRATION.md`.

## Hurricane mode (wind damage and displacement)
- **Wind field.** Holland-profile hurricane winds around the NOAA HURDAT2 best track (every 6 hours, 2004+ wind radii, 2021+ radius of maximum wind). A regression on 891 HURDAT2 points fills in the radius of maximum wind for older storms. The right side of the storm is stronger from forward motion. Winds are converted to over-land 3-second gusts (×0.80 then ×1.30, WMO wind-averaging guidance). Each building keeps its peak gust. Michael 2018 gives 162 mph at Mexico Beach; Florence 2018 gives 96 mph in Wilmington (the airport observed a 105 mph peak gust).
- **Damage.** Lognormal fragility around the same damage thresholds as tornado mode, with spread β = 0.15 (the EF damage-indicator bounds imply about 0.10, widened for hurricane duration). Displaced = residents of homes at major damage or worse; destroyed = level 3 or worse.
- **Deaths from wind at home.** A Poisson regression on 44 US hurricane landfalls (2004–2024; Katrina excluded as flood deaths), 12,148 storm–county pairs and 89 NOAA-recorded home deaths. Risk rises about 1.5× per 10 mph of gust; mobile homes are 5.1× riskier. On held-out storms it explains 16.5% of deviance beyond a constant rate. It misses Helene's unusual inland tree deaths. The resulting risks are tiny (1 in 237,000 at a 160 mph gust in a house), so hurricane mode plans for displacement rather than deaths.
- **Past replays.** Michael at Mexico Beach: 99% of residents displaced and 54% in destroyed homes; NOAA recorded 6 direct deaths and $6.9B in property damage for the zones. Florence in Wilmington: 25% displaced; NOAA recorded $1.0B and no direct deaths in the zone.
- **Drawn tracks (future mode).** Each point takes the chosen category's defaults (from 2021–2025 HURDAT2 storms) and a 20 km/h forward speed. The drawn line is extended 150 km past each end along its first and last segments (`drawn_track_extension_km` in `sim/params/hurricane.json`), so the storm arrives from outside town. Without this, a town-sized line leaves the eyewall (about 37 km out for Category 1–3) outside town and everyone sits in the calm eye. A Category 2 drawn across Lumberton displaces 11,044 residents, against 11,141 on the reference track.
- **Shelter budget.** Hurricane mode defaults to a $30M budget, since a 1,000-person shelter costs about $6M at $6,000 per person. That's in line with FEMA grants such as $6.0M for a 906-person safe room in Crawford County, Indiana. Tornado mode stays at $900,000.
- **Engine check.** Simulation's TypeScript engine reproduces the Python reference exactly on Lumberton Categories 1–4 and Michael at Mexico Beach: displaced, destroyed and deaths to the decimal, and gusts within 0.001 mph.
- **Not modeled:** storm surge, rain flooding, falling trees and vehicles, which account for most hurricane deaths.
