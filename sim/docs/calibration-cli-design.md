# Calibration CLI: first implementation chunk

Status: approved by the ML lead, 2026-09-26, with the confirmations below.
The originally proposed choices in this document are accepted for this chunk.

## Objective and boundary

Unblock the ML lead's Python calibration loop with a TypeScript tornado
engine and Node CLI. Support deterministic expectations and seeded simulation
on Structures' lightweight backtest places. Keep the engine browser-independent
so the game can later import the same functions in a worker.

Proposed first-chunk boundary: tornadoes without protections. Reject flood
scenarios and nonempty protections explicitly until their subsequent chunks.
This is a subset of Simulation Phase 1, not completion of the role protocol.
The first chunk does not implement vehicle exposure: VEHICLE is present in the
parameter schema and result keys, but returns zero for these tornado scenarios.

Work stays in `sim/`. Do not modify `ml/`, `places/`, web infrastructure, or
ML-owned `sim/params/sim_params.json`. Proposed execution is in the existing
clean `mahil` branch, implementing directly in this session. Commit and push
each verified implementation chunk as requested by the user.

## Confirmed requirements

- Node observed locally: v22.6.0. Proposed supported runtime: Node 22.
- `sim/cli.ts` is the source entry point; the calibration entry point is built JS.
- Batch input is JSONL; successful output is one JSON object per input record,
  in order, with `place_id` in every result. Diagnostics go to stderr.
- `--params` accepts any absolute or working-directory-relative file path.
  The caller can select candidates in `ml/work/` or the final calibrated file.
- Expected output contains `place_id`, `expected_deaths`, `by_class`, and
  `people_exposed` (current occupants of buildings with damage level >= 1).
  No sampling, cell aggregation, or building probability maps in expected mode.
- Simulate output includes deterministic expectations and seeded p05/p95.
- Batch target: 50 scenarios, each with up to several thousand buildings,
  under 3 seconds including process startup and input reads on the test machine.
  Report measured timing, rather than promising it before measurement.
- Lightweight places can have no streams or roads, no crossings, and only
  building-containing cells. Tornado calculations do not require flood terrain.
- Paths are lon/lat polylines, not just two endpoints: the ML list contains
  paths with up to five points.
- Class multipliers are MH; RES = RES_WOOD/RES_MASONRY/MULTI;
  PUBLIC = SCHOOL/WORSHIP/COMMERCIAL/BIGROOF; and VEHICLE.
- User approved a fixed multiplier of 1 for OTHER, an exponential warning
  factor, and all nine building classes plus VEHICLE as output keys.

## Proposed command contract

Install and build from the repository root:

```sh
npm ci --prefix sim
npm run build --prefix sim
```

Calibration, without TypeScript-loader startup on every call:

```sh
node sim/dist/cli.js --batch ml/work/scenarios.jsonl --places data/backtest/places --params ml/work/candidate.json --mode expected
```

Development entry point, using the locally pinned tsx dependency:

```sh
./sim/node_modules/.bin/tsx sim/cli.ts --batch ml/work/scenarios.jsonl --places data/backtest/places --params ml/work/candidate.json --mode expected
```

Single scenario:

```sh
node sim/dist/cli.js --scenario data/backtest/scenarios/bt_2021_996712.json --places data/backtest/places --params sim/params/sim_params.default.json --mode simulate
```

Require explicit `--params` and `--mode` to prevent accidental calibration
against the wrong file or execution mode. For each scenario, read
`<places>/<place_id>/buildings.json`. Expected mode needs no scene geometry;
simulation can aggregate buildings by their supplied H3 IDs. The first CLI
does not consume the still-unspecified geometry fields in `cells.json`.

Proposed error policy: preflight the entire batch before producing results;
malformed JSON, missing places, invalid values, or unsupported scenarios produce
a nonzero exit code and a contextual stderr diagnostic. Never silently skip a
row or substitute zero for a failed scenario. Preserve duplicate place IDs and
input order. Cache each distinct place within one invocation.

## Input and teammate compatibility

The historical catalog at `origin/ml/phase-3:ml/backtest/tornadoes.json` is a
JSON object with `selection` and `tornadoes`, not a scenario or JSONL file.
ML's `backtest_select.py` already writes fully formed scenarios under
`data/backtest/scenarios/`. Use those records for batch JSONL. A test fixture
will use the training event `bt_2021_996712`, with its actual two-point path,
EF3, width 274.3 m, hour 20, and the producer's warning default of 10 minutes.
Its synthetic place must be clearly labeled synthetic; it is not a real
historical validation or an observed-fatality prediction test.

Simulation reads the provided `cls` unchanged. The Structures team's decisions
about NSI classification, BIGROOF area threshold, and flood elevation sources
belong upstream. Unknown classes cause an error instead of being silently
recategorized. Tests will include all nine defined classes.

ML's README says to exclude OUTDOOR, WATER, and OTHER from the location-mix
penalty. The engine will not invent populations for those unmodeled exposures.
It will still return expected deaths for buildings explicitly classed OTHER.

## Confirmed night convention

Night is 20:00–05:59 local clock time for both population selection and the
night modifier. ML already converts NOAA standard time with DST rules; the
engine must not perform an additional timezone conversion. This supersedes
the earlier 18:00 proposal. Store the fixed hours in the parameter file and
test both boundary hours.

## Proposed uncalibrated lethality model

For each age group, start with the class's probability for damage level 0–4,
multiply by its calibration group multiplier, the night multiplier if selected,
the basement multiplier if present, and the warning factor. Apply `over65`
only to the over-65 group. Clamp each group's probability to [0,1], then sum
population times probability. This avoids clamping an age-averaged probability
instead of the individual-group probabilities.

Approved warning formula: `exp(-warning_per_min * warning_min)`.
Require finite, nonnegative warning minutes. Warning is multiplicative and
does not change the underlying building damage.

Approved initial defaults and hard validation bounds:

| Parameter | Initial value | Hard bounds |
|---|---:|---:|
| Each MH/RES/PUBLIC/VEHICLE multiplier | 1 | 0.05–20 |
| Night modifier | 1.5 | 1–4 |
| Basement modifier | 0.25 | 0.05–1 |
| Warning coefficient, per minute | 0.02 | 0–0.1 |
| Over-65 modifier | 1.5 | 1–3 |

Proposed per-occupant base probabilities for damage levels 0,1,2,3,4 are
`[0, 0.00001, 0.0001, 0.005, 0.05]`, initially the same for every class.
Class differences initially arise from damage thresholds and later from fitted
group multipliers. These numbers and bounds are engineering judgment for
initialization, not measured lethality estimates or literature-derived bounds.
Document that distinction for every entry in `sim_params.sources.md`.

The parser enforces these hard bounds inclusively and rejects nonfinite values.
Base probabilities must be in [0,1], start at zero, and be nondecreasing with
damage. ML fits MH, RES, PUBLIC, night, and basement; VEHICLE, warning_per_min,
and over65 remain fixed for the current training run. Regularization and any
PUBLIC/RES parameter tying belong to the ML optimizer, not this engine.

VEHICLE cannot be fitted from a tornado-only run with empty crossings.
Constant warning minutes also do not identify the warning coefficient
independently of class multipliers; keep warning fixed for this calibration.

## Proposed tornado intensity and damage choices

Use nearest distance to every segment of the supplied polyline, measured in
meters. `width_m` denotes total path width, so radius is width/2. Proposed
profile: peak speed times `max(0, 1 - distance/radius)`. Outside the path,
intensity is zero. This simplified spatial profile is a model choice, not
an observed wind field reconstructed from NOAA records.

Proposed representative peak speeds, mph for EF0–EF5:
`[75, 98, 123, 150.5, 183, 225]`. EF0–EF4 are midpoints of NWS rating bands;
EF5=225 is an explicit provisional choice because EF5 has no upper bound.
Use the scenario's supplied width. Default widths from ML's export will be
integrated separately when scenario-generation defaults are needed.

Proposed four severity thresholds in mph:

| Class | Thresholds | NWS indicator and selected DoDs |
|---|---|---|
| MH | 61, 89, 105, 127 | MHSW: 1,4,6,9 |
| RES_WOOD | 65, 97, 170, 200 | FR12: 1,4,9,10 |
| RES_MASONRY | 65, 121, 156, 180 | MAM proxy: 1,4,6,7 |
| MULTI | 76, 124, 158, 180 | ACT: 1,3,5,6 |
| SCHOOL | 65, 125, 153, 176 | ES: 1,7,9,10 |
| WORSHIP | 65, 124, 144, 157 | SPB proxy: 1,7,8,9 |
| COMMERCIAL | 65, 124, 144, 157 | SPB proxy: 1,7,8,9 |
| BIGROOF | 68, 117, 137, 158 | median of LIRB 1,4,6,7; WHB 1,5,6,7; MBS 1,4,7,8 |
| OTHER | 65, 97, 170, 200 | FR12 proxy: 1,4,9,10 |

The four-level reduction and the proxy assignments are proposed modeling
choices. NWS damage indicators do not universally have a literal "swept away"
level: approved level 4 means the selected highest-severity state for that
indicator, not literal sweep-away for every construction type.

Primary references, inspected on 2026-09-26:

- [NWS EF rating bands and indicator definitions](https://www.weather.gov/oun/efscale)
- [MHSW](https://www.weather.gov/images/oun/efscale/MHSW.jpg)
- [FR12](https://www.weather.gov/images/oun/efscale/FR12.jpg)
- [MAM](https://www.weather.gov/images/oun/efscale/MAM.jpg)
- [ACT](https://www.weather.gov/images/oun/efscale/ACT.jpg)
- [ES](https://www.weather.gov/images/oun/efscale/ES.jpg)
- [SPB](https://www.weather.gov/images/oun/efscale/SPB.jpg)
- [LIRB](https://www.weather.gov/images/oun/efscale/LIRB.jpg)

## Proposed sampling and verification

Use independent Bernoulli occupant deaths conditional on fixed inputs and
parameters. For fractional modeled population n, sample floor(n) occupants
plus one Bernoulli with probability fractional(n) times death probability;
this preserves n times probability as the expectation. Seeded simulation uses
500 runs by default. Return empirical nearest-rank p05/p95 of integer totals.
The interval represents sampling variability conditional on the model, not
parameter, exposure, or historical-building uncertainty.

Verify class grouping, age-specific probabilities, night boundaries, warning
monotonicity, basement behavior, clamping, multi-segment path geometry, and
zero risk outside the path. Verify arbitrary parameter paths, ordered JSONL,
empty lightweight place fields, malformed-input diagnostics, deterministic
expected mode, reproducible simulation, and unchanged default parameters.

Benchmark a cold CLI call with 50 distinct synthetic places of 3,000 buildings
each. Include file reads and JSON output in timing, and report the runtime and
machine. Run the actual historical training scenario on the synthetic test
place through the public CLI. Once Structures delivers `write_place_lite`,
repeat the same smoke test on its real output before claiming cross-team
end-to-end compatibility.

## Subsequent chunks

1. Full cell contract, risk aggregation, sources, and remaining Phase 1 tests.
2. Flood model and vehicle exposure with agreed duration and driver counts.
3. Real featured places, protections, and game state.
4. Worker, controls, results panel, and scene integration.
5. Optimizer and plan comparison.

Each chunk gets explicit acceptance checks, verification output, and a push
after it is complete. No claim of full Simulation Phase 1 completion follows
from the calibration-only milestone.
