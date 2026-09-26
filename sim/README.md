# Simulation calibration CLI

First deliverable: tornado expected deaths and seeded simulation on building
inventories. Supports lightweight backtest places and Node 22 (tested on
22.6.0). The pure `core/` also typechecks without Node or browser DOM imports
for later use in a web worker. Flood, protections, cell maps, and vehicle
exposure are subsequent chunks. Unsupported scenarios fail explicitly.

## Install and run

Run from the repository root. There is no root package.json: **use `--prefix sim`
for both installation and build**. Built `dist/` files are not committed.

```sh
npm ci --prefix sim
npm run build --prefix sim
node sim/dist/cli.js --batch ml/work/scenarios.jsonl --places data/backtest/places --params ml/work/candidate_001.json --mode expected
```

Or use the pinned local TypeScript runner after installation:

```sh
./sim/node_modules/.bin/tsx sim/cli.ts --batch ml/work/scenarios.jsonl --places data/backtest/places --params ml/work/candidate_001.json --mode expected
```

Use built JS for repeated calibration calls. `--params` is required and accepts
any file path. All relative paths resolve from the process working directory.
Copy `sim/params/sim_params.default.json` into your own candidate files; the
CLI reads but never rewrites them. ML owns the final `sim/params/sim_params.json`.

For one scenario, replace `--batch` with `--scenario path/to/scenario.json`.
Pass `--mode simulate` for p05/p95. `--help` lists arguments. No automatic
parameter discovery or implicit mode selection occurs.

## Python calibration loop

```python
import json
import subprocess

completed = subprocess.run(
    ["node", "sim/dist/cli.js", "--batch", "ml/work/scenarios.jsonl",
     "--places", "data/backtest/places", "--params", "ml/work/candidate_001.json",
     "--mode", "expected"],
    check=True, capture_output=True, text=True,
)
results = [json.loads(line) for line in completed.stdout.splitlines()]
```

One input JSON object per nonempty JSONL line; an ordinary final newline and
CRLF are supported. Blank interior lines are errors rather than skipped rows.
Each successful result includes `place_id`, in input order, including duplicate
IDs. The whole batch is validated and evaluated before any results are written.
Failure means exit code 1, a diagnostic on stderr, and no results on stdout.

The CLI reads `<places>/<place_id>/buildings.json`. It does not require terrain,
crossings, scene geometry, or flood elevations. Extra building fields are
accepted. Consumed fields are `id`, `lon`, `lat`, `cls`, `basement`, and all four
`pop_day_*`/`pop_night_*` values. Populations may be fractional but must be finite
and nonnegative; duplicate IDs and unknown classes fail validation. Empty
inventories are valid. Existing `cells.json`, `place.json`, and empty
`crossings.json` from `write_place_lite` can remain alongside the buildings.

The ML historical catalog `ml/backtest/tornadoes.json` wraps metadata and
records; it is **not** JSONL. ML's `backtest_select.py` produces scenario JSON
files in `data/backtest/scenarios/`. To assemble training rows only:

```python
from pathlib import Path

catalog = json.loads(Path("ml/backtest/tornadoes.json").read_text())
records = [r for r in catalog["tornadoes"] if r["split"] == "train"]
with Path("ml/work/scenarios.jsonl").open("w") as output:
    for r in records:
        scenario = json.loads(Path(f"data/backtest/scenarios/{r['place_id']}.json").read_text())
        output.write(json.dumps(scenario) + "\n")
```

## Model contract

- Night is **20:00–05:59 local clock time**, for both population choice and
  lethality modifier. No additional timezone or DST adjustment.
- `width_m` is full width. Distance is to the nearest finite segment of the
  complete lon/lat path, including rounded end caps. Wind tapers linearly to
  zero at half-width. Supplied width is required; no default is guessed.
- Age-specific probability = base probability for class/damage × class-group
  multiplier × night factor × basement factor × `exp(-warning_per_min * warning_min)`;
  over-65 probability additionally multiplies by `over65`. Clamp each age group
  separately to [0,1], then sum population × probability.
- `people_exposed` counts the selected-hour occupants of buildings at damage
  level 1 or above. This is not everyone inside the geometric path and does
  not change when only a lethality multiplier changes.
- `expected_deaths` and `by_class` are analytic expectations in **both modes**,
  not sample means. Expected mode does no sampling and ignores seed/run count
  for computation, although supplied fields must still be valid.
- Simulate uses the requested positive integer `runs` (default 500) and uint32
  `seed` (default 42). p05/p95 use empirical nearest-rank percentiles. These
  are conditional sampling intervals, not full model uncertainty intervals.

Every result's `by_class` includes these ten keys, with zero for absent classes:

```text
MH RES_WOOD RES_MASONRY MULTI SCHOOL WORSHIP COMMERCIAL BIGROOF OTHER VEHICLE
```

Group them for fitting as follows:

| Fit parameter | Result keys |
|---|---|
| MH | MH |
| RES | RES_WOOD, RES_MASONRY, MULTI |
| PUBLIC | SCHOOL, WORSHIP, COMMERCIAL, BIGROOF |
| VEHICLE | VEHICLE (always zero in this chunk) |

OTHER has a fixed multiplier of 1. As agreed with ML, exclude OTHER and the
unmodeled WATER/OUTDOOR locations from the location-share penalty. The engine
does not estimate outdoor or tornado vehicle exposure.

Hard inclusive parameter limits:

| Key | Default | Range |
|---|---:|---:|
| lethality_multiplier.MH/RES/PUBLIC/VEHICLE | 1 each | 0.05–20 |
| modifiers.night | 1.5 | 1–4 |
| modifiers.basement | 0.25 | 0.05–1 |
| modifiers.warning_per_min | 0.02 | 0–0.1 |
| modifiers.over65 | 1.5 | 1–3 |

ML currently fits MH/RES/PUBLIC, night, basement; the other values stay fixed.
Regularization toward 1 and tying PUBLIC to RES are done in Python. Supply the
entire version-1 parameter object, not a partial override. Unknown parameter
keys and out-of-bounds values fail rather than being silently ignored/clamped.
See [parameter sources](params/sim_params.sources.md) for every default and its
limitations. All base death probabilities are provisional pending calibration.

## Game API: cells (`sim/core`, browser-safe)

The CLI output is unchanged. The game calls the core directly:

```ts
import { simulateDetailed, aggregateCells, diffCells } from '@refuge/sim';
const r = simulateDetailed(scenario, { buildings, cells }, params);
// r = simulate() fields + building_prob {id: p} + cells {h3: CellResult}
```

- `simulateDetailed` gives the same `expected_deaths`/`p05`/`p95` as `simulate`
  (identical RNG use) and requires `h3` on every building.
- `cells` covers every `cells.json` entry plus every building's cell.
  `people` = building occupants at the scenario hour (2 AM or 2 PM NSI
  snapshot); crossing drivers join with the flood chunk.
- `risk` = cell expected deaths / people. `band`: `empty` if 0 people,
  `sparse` if under `min_cell_people`, else `green`/`yellow`/`red`/`deep_red`
  by `risk_bands` (a value equal to a cutoff takes the higher band).
- `uncertain`: the p05 and p95 cell risks fall in different bands (banded
  cells only).
- `drivers`: dominant class by expected deaths, then `no_basement` (basementless
  buildings hold over half the deaths; weight = those deaths x (1 - basement
  modifier)) and `night` (weight = deaths x (1 - 1/night modifier)), ranked by
  weight. Empty list when the cell has no expected deaths.
- `diffCells(before, after)` = `{h3: {delta_expected_deaths, delta_risk}}`
  (after minus before; a missing cell counts as zero). The scene's
  `showDifference` payload is not agreed yet.

Real-data check: Joplin box (25,277 buildings, 4,987 cells), EF4 at 2 AM with
ML's calibrated params: 94 ms, cell deaths sum exactly to the town total.

## Featured places (verified 2026-09-26, `places/phase-1` @ 2ee3e93)

Tornado runs through the center of each town (EF3/EF4, 2 AM and 2 PM, 800 m
wide) with ML's calibrated params: all modes exit 0, and every `simulateDetailed`
run has cell deaths summing to the town total. Runtimes are 82–121 ms per
scenario (morganton 13,595 buildings, lumberton 14,551, chapel_hill 21,065).
Null `hand_m` is read as "no flood data" and is never used by tornado scenarios.

Proposed showcase storm: `sim/scenarios/lumberton_tornado.json`, a SW-to-NE
path (12.4 km) through Lumberton's two largest mobile-home clusters, with
width = ML's EF3 median (640.1 m, `ml/exports/tornado_width_by_ef.json`).

| Storm | Expected | p05–p95 | MH share | Deep-red cells |
|---|---|---|---|---|
| EF3, 2 AM | 18.9 | 12–27 | 99% | 17 |
| EF3, 2 PM | 9.1 | 4–14 | 95% | 12 |
| EF4 (965.6 m), 2 AM | 44.0 | 34–56 | 90% | 40 |
| EF4 (965.6 m), 2 PM | 29.6 | 21–38 | 59% | 48 |

## Verification and smoke test

```sh
npm test --prefix sim
npm run smoke --prefix sim
npm run benchmark --prefix sim
```

Smoke creates 200 synthetic buildings spanning all nine classes in a fresh
temporary directory, then runs the actual Illinois training scenario
`bt_2021_996712` in simulate mode. It prints the result and a complete rerun
command; generated files remain available for inspection. Its cell identifier
is an opaque fixture, not geographic H3 data. This verifies the CLI pipeline,
not the accuracy of the historical prediction or the scene renderer.

Benchmark times one new expected-mode CLI process with 50 distinct synthetic
places × 3,000 buildings. Timing includes reads, validation, computation, and
stdout; fixture generation is excluded. It reports the machine and elapsed
time, fails if the run exceeds 3 seconds, and removes only its own temporary
fixtures. The OS file cache is not cleared, so this is not a cold-disk test.

To run the same scenario on the real Structures place once it is available:

```sh
node sim/dist/cli.js --scenario sim/tests/fixtures/bt_2021_996712.scenario.json --places data/backtest/places --params sim/params/sim_params.default.json --mode simulate
```

The fixture path/width/hour were copied from ML's training record; the 10-minute
warning, 500 runs, and seed 42 match its scenario producer. No held-out results
were used to tune defaults.

Verified 2026-09-26 against a real `write_place_lite` folder from Structures
(`places/phase-1` @ 25c3c6d): the `bt_2021_996712` path buffered by
width/2 + 1 km gave 1,266 NSI buildings, 345 building-only cells, `[]`
crossings, and empty `streams`/`roads`. Expected and simulate modes both
exited 0 with ordered output. With uncalibrated defaults the recorded scenario
gives 0.0053 expected deaths and 271 people exposed; the 6 real deaths were in
the Amazon DLI4 warehouse, which has no NSI record (ML excludes this storm).

Also verified on real folders: `bt_2024_1181735` (Arkansas EF3, 3-point path,
03:00, 1,528 buildings, `footprint`/`hand_m`/cell `ground_elev_m` all null,
`crossings.json` `[]`) runs in both modes, giving 0.34 expected deaths with
uncalibrated defaults against 4 recorded. Worst-case load: 50 scenarios, each on its own copy of
Soham's Joplin box (25,277 buildings each, 1.26M total), took 1.61 s in
expected mode and 3.16 s in simulate mode, wall time including startup
(Node v22.6.0, Apple M4 Pro).

The tornado engine does not read `footprint`, `hand_m`, `ground_elev_m`, or
`firmzone`, so nulls there are fine. When flood logic lands, `firmzone ==
"AREA NOT INCLUDED"` must be treated as no zone.
