# ML integration handoff — September 26, 2026

The next product milestone is one complete **Lumberton tornado** flow:
town → animated storm → risk map → place a safe room → replay → compare with a budget-constrained shelter search.
Extend the working flow to flood and the other towns afterward. This does not add a new historical backtest or change the mortality model.

## Ready to consume

- `sim/params/sim_params.json`: fitted tornado knobs, accepted risk bands, and unchanged uncalibrated flood/vehicle blocks from Simulation `ce766f5`.
- `ml/exports/`: national evidence, traffic profiles, widths, model metrics and backtest. Its README defines scope and denominators.
- Simulation's `sim/scenarios/lumberton_tornado.json`: hypothetical demo path, not a replay of a historical Lumberton event.
- Structures `places/phase-1` at `2ee3e93`: real building records, footprints, populations and H3 cells for the three featured places.

With these exact inputs, the Lumberton scenario at EF3, 2 AM, width 640.1 m, warning 10 minutes, seed 42 and 500 runs gives **18.8568734272 expected deaths, p05 12, p95 27**. Use this as an integration reference, not a claim of real-world accuracy. Preserve building order for identical seeded intervals.

Colors use cell expected deaths divided by cell occupants: yellow ≥ 0.00001, red ≥ 0.001, deep red ≥ 0.01. Height represents expected deaths. Zero-occupant cells are empty; fewer than five occupants are sparse. Do not recolor independently using relative rankings or a different threshold set.

## Checks completed

`ml/check_sim_integration.mjs` validates the final ML parameter file with the actual built engine, evaluates 48 training and 30 test places, compares the test results with saved exports, checks cell sums on all three featured towns, and exercises flood building/vehicle exposure through the public CLI using synthetic inputs.

```sh
npm run build --prefix sim
node ml/check_sim_integration.mjs
```

Before branches are integrated, point it at built teammate checkouts:

```sh
node ml/check_sim_integration.mjs --sim-root /path/to/simulation-checkout/sim --places /path/to/structures-checkout/places
```

It requires the cached historical places/scenarios in `data/backtest/` and writes `ml/work/sim_integration_check.json`. A successful exit confirms the integration assertions; inspect each town's flood status separately. Geographic validation is not implied by executable code or passing synthetic checks.

The current check passes with Simulation `ce766f5` and Structures `2ee3e93`. No saved tornado test values changed. Heatmap regeneration preserves flood/vehicle blocks when the saved tornado calibration predates them.

## Flood is waiting for exposure data

Morganton has 13,595 buildings, Lumberton 14,551 and Chapel Hill 21,065. Every building currently has null HAND; all three crossing and stream arrays are empty. A 4.5 m flood at 2 AM with 30 minutes warning therefore returns zero expected deaths **because exposure is skipped**, with all buildings counted in `no_flood_data`.

The UI must suppress the safety interpretation of those totals and colors and show unavailable/incomplete flood exposure. A zero missing-crossing count does not prove crossing coverage when no crossings were supplied. After Phase 2 lands, review whether flood exposure follows stream valleys, high ground stays dry, traffic is plausible, and skipped exposure is understood. Do not force a low death total as an acceptance criterion.

Compare modeled VEHICLE share only when the total is positive and data coverage is usable. The national 45% statistic covers known-location direct flash-flood deaths and includes exposure categories absent from the game. A single town's modeled buildings-plus-vehicles share need not match it.

## Acceptance checks for the first playable flow

Simulation owns the protection schema, effects and game controls; Structures owns the scene and placement geometry. Agree those interfaces together. ML supplies the current parameters and reference calculations.

1. Load Lumberton and run the exact baseline above. The displayed total and cell sum agree with the engine. Weather animation, the drawn path and the calculated scenario use the same inputs.
2. Place one safe room at an eligible site. State capacity, cost, residual risk, warning-time/reachability assumptions and hazard suitability. A tornado safe room is not automatically a flood evacuation destination.
3. Transfer reachable occupants from their origin buildings into shelter exposure without duplicating people. Overlapping shelter catchments cannot protect anyone twice. Capacity and budget limits apply, and removing a shelter restores the baseline. Record origin/destination assignments so scene animation and before/after counts agree.
4. Replay the same hazard, hour, warning and seed. Show baseline, protected expected deaths, and modeled lives saved. Expected values must not depend on random seed. Explain whether a map represents occupants' current locations or benefit attributed to their original locations; relocation alone must not be mistaken for protection.
5. Search all affordable combinations of a small agreed candidate-site set using deterministic `expected()`. Apply the same placement, cost, capacity and assignment rules as the user plan. For a comparable score, the user's eligible sites must be in the search set. Label the result best for those candidates and that model; a heuristic gets “best found,” not a guaranteed optimum.
6. Run the expensive sampling only for the displayed baseline and selected plans, in a worker. Show before/after and user/search comparisons; handle a zero available benefit without division by zero. Verify responsiveness on the presentation laptop before expanding scope.

No shelter or optimizer implementation is claimed by this document. Their benefit assumptions must be described as model assumptions, not proven causal estimates.

## Reporting corrections to carry into the UI

- The backtest target retains unknown-location deaths; use “comparison target,” not “confirmed building deaths.”
- The simulator underpredicts that target. Geometry is a possible contributor, not an established complete explanation. A drawn path does not validate mortality estimates.
- Sampling ranges omit parameter, exposure and geometry uncertainty.
- The national location chart includes WATER/OUTDOOR; the game does not. Simulator OTHER buildings differ from NOAA OTHER locations.
- Keep the shared tornado lethality table. Whole-swath MH/wood ratios are diagnostics, not validation. One source-note sentence needs correction: not every class reaches level 4 at EF4 centerline; wood houses require 200 mph while the model's EF4 peak is 183 mph.
- Flood/vehicle parameters are uncalibrated; the retained tornado-fitted night effect is also unvalidated for flood.

PRs remain stacked #1 → #2 → #3. Updating #3 does not merge them. The game can load the calibrated file after the team integrates the branches.
