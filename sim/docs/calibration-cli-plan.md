# Calibration CLI implementation plan

> Execute directly with superpowers:executing-plans and test-driven development.

**Goal:** Deliver the approved tornado calibration CLI and push its verified source.
**Architecture:** Pure TypeScript core; Node-only file loading and argument parsing
at the CLI boundary; committed JSON defaults and no runtime dependencies.
**Tech stack:** Node 22, TypeScript 5.9.3, tsx 4.23.15, Node's test runner.
**Spec:** `sim/docs/calibration-cli-design.md`, updated with ML's final approval.

## Global constraints

- Edit only `sim/`; preserve ML-owned `sim/params/sim_params.json`.
- Night = 20:00–05:59 local clock time; no timezone conversion.
- Hard bounds: multipliers 0.05–20, night 1–4, basement 0.05–1,
  warning_per_min 0–0.1, over65 1–3.
- No flood, protections, or vehicle exposure in this first chunk.
- Expected mode does no sampling or cell aggregation.
- Commit and push on the existing `mahil` branch after verification.

## Review focus

1. A bad later batch record must not leave earlier results on stdout.
2. Fractional age populations must preserve expected deaths in sampling.
3. Multi-segment paths and points beyond endpoints must use finite segments.
4. Candidate params outside sim/ must be read without mutating defaults.
5. Unsupported hazard/protections must fail instead of producing partial risk.

## Task 1: Public contract and validation tests

Files: `sim/package.json`, `sim/package-lock.json`, `sim/tsconfig.json`,
`sim/tests/cli.test.mjs`, `sim/tests/helpers.mjs`.
Consumes: JSON scenarios/buildings/params from the approved design.
Produces: executable assertions against `node sim/dist/cli.js`.

- [x] Write tests using temporary place folders, candidate parameter paths,
  and spawned CLI processes. For a center-line MH with 2 under-65 and 1 over-65
  night occupants, no warning or basement, assert expected deaths = 0.2625
  and people_exposed = 3. Assert ten class keys and no cell/building map.

```js
assert.equal(result.status, 0, result.stderr);
assert.ok(Math.abs(JSON.parse(result.stdout).expected_deaths - 0.2625) < 1e-12);
```

- [x] Run `node --test sim/tests/cli.test.mjs` before the CLI exists.
  Expected: failure because the CLI cannot return a successful result.
- [x] Add pure types and strict boundary validation in `sim/core/types.ts`,
  `sim/validation.ts`; defaults in `sim/params/sim_params.default.json`.
  Expose `parseParams(unknown): SimParams`,
  `parseScenario(unknown): TornadoScenario`, and
  `parseBuildings(unknown): Building[]`.

## Task 2: Pure engine and seeded simulation

Files: `sim/core/geometry.ts`, `sim/core/engine.ts`, `sim/core/random.ts`,
`sim/core/index.ts`, `sim/tests/core.test.mjs`.
Consumes: validated `TornadoScenario`, `Place`, and `SimParams` from Task 1.
Produces: `expected(scenario, place, params): ExpectedResult` and
`simulate(scenario, place, params): SimulationResult`.

- [x] Add failing tests for night boundaries, age clamping, class grouping,
  warning/basement effects, finite polyline distance, and fractional sampling.
- [x] Implement wind = peak * max(0, 1 - distance / (width_m / 2)), threshold
  damage, and separate under-/over-65 probabilities. Accumulate deterministic
  class totals and damage-positive population in one building pass.
- [x] Implement seeded independent sampling and nearest-rank percentiles:

```js
const p05 = sorted[Math.ceil(0.05 * sorted.length) - 1];
const p95 = sorted[Math.ceil(0.95 * sorted.length) - 1];
```

- [x] Run `npm test --prefix sim` after the CLI from Task 3 is connected.
  Expected: all core and CLI contract tests pass.

## Task 3: CLI integration, handoff, and performance

Files: `sim/cli.ts`, `sim/io.ts`, `sim/README.md`,
`sim/params/sim_params.sources.md`, `sim/tests/fixtures/`,
`sim/scripts/benchmark.mjs`, `sim/scripts/make-smoke-place.mjs`.
Consumes: Task 1 parsers and Task 2 engine exports.
Produces: built `sim/dist/cli.js`, a synthetic lightweight place generator,
the historical training scenario fixture, and measured batch timing.

- [x] Read scenarios and params, preflight unique places, then evaluate all
  rows in order before writing JSONL. Errors use stderr and exit code 1.
- [x] Verify `--scenario`, `--batch`, `--places`, `--params`, `--mode`, help,
  missing/unknown arguments, malformed JSON, and no partial output on errors.
- [x] Generate a 200-building synthetic lightweight place for the approved
  historical Illinois scenario with empty crossings/roads/streams.
- [x] Run `npm ci --prefix sim`, `npm test --prefix sim`, then
  `npm run smoke --prefix sim` and `npm run benchmark --prefix sim`.
  Expected: clean build, passing tests, valid CLI result, 50 scenario results
  under 3 seconds with 3,000 buildings per distinct synthetic place.
- [x] Check the browser core with a DOM/ES library typecheck excluding Node
  types and imports; document the separate full risk-map chunk.
- [x] Review source and ownership diff. Commit, push `mahil`, and report the
  remote commit and exact smoke/calibration commands.

## Execution record

User approval covers this chunk, its model choices, direct execution on mahil,
and pushing finished work. Task interfaces agree: parsers produce core input
types; CLI consumes the same exports as the tests. Progress is recorded here
instead of a root-level scratch directory to honor folder ownership.

- Task 1: complete; initial public CLI assertion failed before implementation.
- Task 2: complete; initial core assertion failed before implementation;
  full implemented suite passed 30/30.
- Task 3: complete; clean lockfile install and rebuild passed; smoke returned
  expected deaths 2.66269662342904, people_exposed 800, p05 0, p95 5 on
  200 synthetic buildings. No real-place accuracy claim is made.
- Performance: 50 distinct synthetic places x 3,000 buildings, 205 ms including
  startup, file reads, validation, calculation, and stdout; Node v22.6.0 on
  Apple M4 Pro, macOS arm64. OS cache not cleared.
- Final independent review: no Critical, Important, or Minor findings;
  reviewer independently ran the 30 tests successfully. CodeRabbit was not
  installed, so this was an independent source and test review.
- Review scope confirmed: empirical lethality validity and real Structures
  compatibility await calibration and actual producer files; flood, vehicle
  exposure, protections, and cell aggregation remain later approved chunks.
- Delivery: source-only commit and push requested; the handoff message records
  the final commit and remote verification. No generated dist/ files included.
