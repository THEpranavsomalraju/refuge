# Role: ML Lead (read with REFUGE_overview.md)

You are helping me build my part of Refuge, a storm simulator for real towns. Read REFUGE_overview.md first. My job: the machine learning. I train the national risk and location models on NOAA storm deaths, calibrate the simulator's lethality numbers so simulated storms match history, run the backtest against real storms, and export the data behind the landing page charts. I work mostly alone. My two dependencies: the Simulation teammate's Node CLI (`sim/cli.ts`) and the Structures teammate's `fetch_buildings(bbox)` function.

## How to work with me (read before starting)

- Work **one phase at a time**, in order. Never start the next phase until I say so.
- At the start of each phase, give me a short plan: the files you will create, the commands you will run, and anything you need from me.
- Explain what you are doing as you go, in detail. When you make a choice (a model setting, a data filter, a cutoff), tell me the choice and why.
- At the end of each phase, stop and give me a **checkpoint report**:
  1. What you built, with file paths.
  2. What you ran and the actual output (row counts, metrics, plots saved, errors fixed).
  3. How you verified the work runs end to end.
  4. Anything suspicious in the data or results.
  5. What the next phase will do.
  Then ask me to confirm before continuing.
- If something fails or looks wrong, stop and tell me instead of working around the problem silently.
- Ask me before installing anything outside `ml/requirements.txt`, before deleting files, and before touching any folder other than `ml/` and `sim/params/sim_params.json`.

## Phase 0 (hour 0): initialize the repo and add collaborators

Before running anything, ask me for: the repo name (default `refuge`), whether the repo is public or private, and the GitHub usernames of my three teammates (Structures and 3D, Simulation, Story lead).

1. Check the tools: `git --version` and `gh --version`. If the GitHub CLI is missing, give me install steps for my OS. Then run `gh auth status`, and if I am not logged in, walk me through `gh auth login`.
2. Create the local repo with this layout, each empty folder holding a `.gitkeep`:
   ```
   refuge/
     ml/
     places/
     sim/params/
     web/src/scene/
     web/src/landing/
     web/src/game/
     web/src/shared/
     story/
     data/            (gitignored)
   ```
3. Add `REFUGE_overview.md` and all three role files (`ROLE_ml.md`, `ROLE_structures_3d.md`, `ROLE_simulation.md`) at the repo root. Ask me for the files if they are not in the folder yet.
4. Write `.gitignore` covering: `data/`, `ml/work/`, `.env`, `*.env`, `__pycache__/`, `.venv/`, `node_modules/`, `dist/`, `.DS_Store`, `*.parquet` outside `ml/exports/`.
5. Write a short root `README.md`: project one-liner, folder ownership table from the overview, and how each person starts (clone, read the overview plus their role file).
6. Write `.github/CODEOWNERS` mapping `ml/` to me, `places/`, `web/src/scene/`, `web/src/landing/` to the Structures teammate, `sim/` and `web/src/game/` to the Simulation teammate, `story/` to the Story lead, using the usernames I gave you.
7. `git init`, first commit on `main`, then create the GitHub repo and push:
   `gh repo create <repo-name> --private --source=. --remote=origin --push` (use `--public` if I chose public).
8. Add each teammate as a collaborator with write access:
   `gh api -X PUT repos/<my-username>/<repo-name>/collaborators/<teammate-username> -f permission=push`
   Run this once per teammate. Then list pending invitations with `gh api repos/<my-username>/<repo-name>/invitations` and show me the result. Remind me to tell each teammate to accept the email invite.
9. Optional, ask me first: protect `main` so merges need a pull request. On a private repo with a free account, branch protection might be unavailable. If the command fails, tell me and move on.
10. Create my working branch: `git checkout -b ml/phase-1`.

**Checkpoint 0:** show me the repo URL, the folder tree, the collaborator invitation list, and the current branch. Wait for my go-ahead before Phase 1.

## Folder I own
`ml/`, plus the final `sim/params/sim_params.json` file (the Simulation teammate owns every other file in `sim/`). Do not edit other folders without asking me.

## Datasets for my role

| Data | Use | Link |
|---|---|---|
| NOAA Storm Events bulk files, details and fatalities, 1996 onward | Training data: events, strength, path, time, deaths, location of each death | https://www.ncei.noaa.gov/pub/data/swdi/stormevents/csvfiles/ |
| Storm Events column guide | Field meanings | https://www.ncei.noaa.gov/pub/data/swdi/stormevents/csvfiles/Storm-Data-Bulk-csv-Format.pdf |
| Census ACS 5-year API, county | Mobile home share, age 65 and over, no vehicle households, population, housing units, commuting | https://api.census.gov/data/2023/acs/acs5 |
| CDC/ATSDR Social Vulnerability Index 2022, county (parquet mirror) | Vulnerability features | https://data.source.coop/cboettig/social-vulnerability/2022/SVI2022_US_county.parquet |
| National Structure Inventory (through the Structures teammate's function) | Real buildings along historical tornado paths for the backtest | https://www.hec.usace.army.mil/confluence/nsi/technicalreferences/latest/api-reference-guide |
| Iowa Environmental Mesonet warning archive (stretch) | Warned versus unwarned events and lead times | https://mesonet.agron.iastate.edu/request/gis/watchwarn.phtml |
| SPC tornado database (optional) | Cleaner tornado track coordinates | https://www.spc.noaa.gov/wcm/ |

Storm Events notes:
- File names carry a creation date, for example `StormEvents_details-ftp_v1.0_d2024_c20260323.csv.gz`. List the directory and take the newest file per year.
- `BEGIN_DATE_TIME` uses a two digit year (`08-MAY-24 18:12:00`). Take the century from `YEAR`.
- Fatality locations include Mobile/Trailer Home, Permanent Home, Permanent Structure, Vehicle/Towed Trailer, In Water, Outside/Open Areas, Under Tree, Business, School, Church, Long Span Roof, Camping, Boating, Ball Field, and others.
- Useful ACS variables: `B01003_001E` population, `B25001_001E` housing units, `B25024_001E` total units, `B25024_010E` mobile homes, `B08201_001E` and `B08201_002E` households and households without a vehicle, `B01001_020E` to `B01001_025E` and `B01001_044E` to `B01001_049E` for ages 65 and over.

## Phase 1 (hours 0 to 4): data
1. `ml/requirements.txt` with pinned versions: polars, pyarrow, duckdb, requests, lightgbm, scikit-learn, shap, statsmodels, scipy, matplotlib.
2. `ml/download.py` fetches Storm Events details and fatalities 1996 onward, ACS county data, and SVI into `data/raw/` (gitignored).
3. `ml/build_tables.py` produces:
   - `events.parquet`: one row per event with type, EF rating, magnitude, path length and width, begin and end coordinates, hour, month, year, county FIPS, deaths direct and indirect, injuries.
   - `fatalities.parquet`: one row per death with location mapped to our classes (`MH`, `RES`, `PUBLIC` for school, church, business, long span roof, and permanent structure, `VEHICLE`, `WATER`, `OUTDOOR`, `OTHER`), age, sex, time.
   - `county_features.parquet`: ACS and SVI features by FIPS.
4. Focus event types: Tornado and Flash Flood. Keep other types for landing page charts.

**Checkpoint 1:** show me row counts per year for events and fatalities, the share of events with coordinates and widths, the mapping table from NOAA fatality locations to our classes with counts, the county join rate, and a sample of 5 rows from each table. Commit, push, open a pull request, and wait for my go-ahead.

## Phase 2 (hours 4 to 10): models
1. **National risk model.** LightGBM with a Poisson objective predicting direct deaths per event. Features: event type, EF rating, path length and width, hour, month, county mobile home share, share over 65, no vehicle share, population density, SVI. Validation: GroupKFold by state or NWS region plus a time split (train through 2019, test 2020 onward). Report Poisson deviance, calibration by predicted decile, and recall of fatal events among the top ranked events. SHAP summary and dependence plots for hour, EF rating, and mobile home share.
2. **Location model.** Given a fatal event, predict the share of deaths by location class. Multinomial model on event and county features. Report log loss against a baseline of national average shares per event type.
3. **Hour and season patterns.** Tables of deaths by hour and month for tornadoes and flash floods, for the landing page and as calibration targets.
4. Export landing page data to `ml/exports/`: `deaths_by_hour.json`, `deaths_by_location.json`, `shap_summary.json`, `county_risk.json` (predicted risk per county for the national map), `model_metrics.json`. Share a Flourish-ready `fatalities_dots.csv` (one row per death: year, event type, location class, age band, sex) with the Story lead.

**Checkpoint 2:** show me validation metrics for each fold and the time split, the calibration table by decile, the location model log loss against the baseline, the SHAP plots saved to `ml/figures/`, and the list of exported JSON files with sizes. Flag anything which looks too good to be true (possible leakage). Commit, push, open a pull request, and wait for my go-ahead.

## Phase 3 (hours 10 to 16): calibration and backtest
1. **Backtest set.** Select about 80 historical tornadoes from 2008 onward with begin and end coordinates, recorded width, and EF1 or stronger, across many states. Hold out a random 30 for testing and never tune on them. If time allows, add 20 flash flood events with good narratives.
2. **Buildings per path.** For each tornado, call `fetch_buildings(bbox)` from the Structures teammate on a box around the path. Cache everything.
3. **Scenarios.** Convert each event to the scenario format: path from begin and end points, width from `TOR_WIDTH`, EF rating, local hour. Warning minutes from the IEM archive if built, otherwise a fixed typical value noted in methods.
4. **Calibration.** Treat a few lethality multipliers in `sim_params.default.json` as free parameters (one per class plus the night and basement modifiers). Run the Simulation teammate's CLI in batch mode on the 50 training tornadoes and search for the multipliers minimizing Poisson deviance between simulated and recorded deaths, plus a penalty for mismatch between the simulated location mix and the location model. Use `scipy.optimize` or a simple grid, with `expected()` mode for speed. Keep multipliers inside sensible bounds.
5. **Backtest.** Run the 30 held-out tornadoes with calibrated params. Report predicted versus actual deaths per storm, total error, rank correlation, and how often actual deaths fall inside the p05 to p95 range. Compare against two baselines: default uncalibrated params, and the national risk model alone. Export `backtest.json` for the landing page chart.
6. **Heatmap bands.** After calibration, run every featured place under a range of storms and look at the distribution of cell risk. Keep log scale bands and adjust the starting cutoffs (1 in 10,000, 1 in 100, 1 in 10) only if the map ends up nearly all one color or the red band loses meaning. Write the final `risk_bands` and `min_cell_people` into `sim_params.json`, record the reasoning in `ml/METHODS.md`, and freeze them.
7. Write the final `sim/params/sim_params.json` and tell the Simulation teammate.
8. Stretch: for backtest tornadoes with detailed narratives naming where deaths happened, check whether the simulator's red cells overlap those areas.

**Checkpoint 3:** before calibrating, confirm the Simulation CLI and `fetch_buildings(bbox)` both work on one test tornado and show me the output. After calibration, show me the fitted multipliers with their bounds, training error, held-out backtest results against both baselines, the coverage of the p05 to p95 range, the heatmap band decision with the risk distribution plot, and the final `sim_params.json` diff. Commit, push, open a pull request, and wait for my go-ahead.

## Phase 4 (hours 16 to 22): story and defense
1. `ml/METHODS.md`: one page plain English methods with every metric.
2. Answers for Q&A: what the heatmap color means (risk per person, not total deaths), why the bands use a log scale, why Poisson, why grouped validation, how calibration avoids overfitting, what the backtest misses and why, why effects are model estimates and not causal proof.
3. Check every number in the slides and on the site against `ml/exports/`.

**Checkpoint 4:** show me `ml/METHODS.md`, the Q&A answers, and a table of every number used in the slides or on the site with the export file each one comes from. Wait for my sign-off.

## Definition of done
Models trained and validated with grouped and time splits. Calibrated `sim_params.json` committed with final heatmap bands. Backtest results on held-out storms exported with baselines. Landing page JSON files exported. Methods written.
