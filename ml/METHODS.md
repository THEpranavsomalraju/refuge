# Methods (ML)

All numbers below are produced by the scripts in `ml/` and stored in `ml/exports/`. Rerun the pipeline and they regenerate.

## Data
- **NOAA Storm Events, 1996–2025.** 1.78M event reports and 23,852 deaths with where each person was. Hours were converted from NOAA's local standard time to local clock time. Territories are left out.
- **CDC/ATSDR Social Vulnerability Index 2022** (county level, built on ACS 2018–2022): mobile home share, share over 65, households without a vehicle, population density, SVI score. Connecticut's 2022 county redraw means its NOAA counties do not join.
- **USACE National Structure Inventory** (via `places/fetch_nsi.py`): every building, its type, basement, and modeled 2 AM / 2 PM population. These are **modeled estimates** from a 2025 inventory.
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
Multinomial logistic regression predicts where deaths happen (mobile home, house, public building, vehicle, water, outdoors, other) for a fatal event. It uses 4,047 deaths with a known location, and each event gets equal total weight. It beats the baseline of national shares per event type in every state fold (0.3% to 6.0% lower log loss) and on 2020–2025 (1.369 vs 1.448, 5.5% lower). In the data, mobile homes are 42% of tornado deaths (54% at night) and vehicles are 45% of flash flood deaths.

## Simulator calibration
- **Storms.** 80 historical tornadoes, 2015–2025, EF1+, 26 states. NOAA county segments were stitched back into whole paths (82% of NOAA-marked continuations linked). Each storm had to hit something: a death, an injury, or at least $250k damage.
- **Sampling.** 40 fatal and 40 non-fatal storms, with sampling weights so the fit still represents all 1,663 eligible tornadoes. 30 were held out at random and **never used for tuning**.
- **Exclusions.** Two training storms are excluded by stated rules: Edwardsville 2021 (all deaths in a warehouse missing from NSI) and one storm whose NOAA begin and end points coincide.
- **Free knobs.** Five knobs, all inside bounds agreed with Simulation: death rate multipliers for mobile homes, houses and apartments, and public buildings, plus the night and basement modifiers. Vehicle, over-65 and warning-time effects stay at Simulation's values. Every storm uses a fixed 10-minute warning, so the warning effect cannot be fit.
- **Loss.** Weighted Poisson deviance between simulated and recorded **building** deaths. Deaths NOAA records in vehicles or outdoors are removed, because the tornado simulator only models people in buildings. The loss adds a 0.1-death floor per storm for deaths the simulator cannot see, a penalty for mismatch with the location model's mix, and a mild pull toward Simulation's engineering defaults.
- **Result.** Mobile home 1.02, house and apartment 1.66, public 0.98, night 1.26, basement 0.24. The simulated mix of building deaths moved from 74/21/5% to 66/29/5% (mobile home / house / public) against the location model's 62/33/5%.
- **Disclosure.** After seeing the held-out results, we tried one more knob, a scale on the death rate for minor and major damage. The training storms rejected it: it added deaths to storms that killed nobody faster than it explained fatal ones. We removed it. The held-out results below are unchanged by that test.

## Backtest (30 held-out tornadoes)

| Method | Predicted vs recorded building deaths | Rank correlation | Recorded inside p05–p95 |
|---|---|---|---|
| Simulator, calibrated | 10.0 vs 28 | 0.49 | 67% |
| Simulator, uncalibrated | 10.7 vs 28 | 0.50 | 67% |
| National model alone | 20.6 vs 28 | 0.51 | 80% |

The largest held-out storm (Texas 2024, EF3, 7 deaths) simulates at 6.2 (range 3–10). **What the backtest misses, and why:** NOAA gives each county segment only a begin and end point, so the simulated path is a straight line and often misses the neighborhood the real storm curved through. NSI has 2025 buildings and populations, so older storms replay on today's town. Deaths in cars and outdoors are outside the tornado simulator. The national model is better at totals. The simulator's job is showing *where* inside a town the risk sits.

## Heatmap bands
Risk per cell = expected deaths in the H3 cell / people there at the storm's hour. We ran EF1–EF4 through all 79 backtest towns at 2 AM and 3 PM (a Python replica of the simulator's expected mode, matching the CLI exactly). With the starting cutoffs, deep red never appeared, even for an EF4 at night. **Final cutoffs, one decade lower, log scale:** yellow from 1 in 100,000, red from 1 in 1,000, deep red from 1 in 100. Minimum 5 people per cell. EF4 cells at night are then 18% green, 56% yellow, 18% red and 7% deep red; EF1 cells are 85% green. The red cutoff falls in the natural gap between damaged and destroyed buildings (`ml/figures/cell_risk_distribution.png`). These bands are frozen in `sim/params/sim_params.json`.
