# Default parameter provenance

These are **uncalibrated starting parameters**, approved by the ML lead on
2026-09-26. Damage indicators supply engineering wind estimates. They do not
supply occupant death probabilities. Lethality defaults and fitting bounds
below are explicit model initialization choices, not measured risks.

## Wind parameters (mph)

The [NWS EF scale](https://www.weather.gov/oun/efscale) gives EF0–EF4 bands
65–85, 86–110, 111–135, 136–165, and 166–200 mph. Their midpoints produce
`peak_mph_by_ef[0..4] = [75,98,123,150.5,183]`. EF5 is open-ended above
200 mph: the value **225** is a user-approved provisional model choice.
An EF category is a damage-based estimate, not a measured peak at every
building. A single peak along the whole path is a simplification.

Each four-number array below is taken from the expected-speed column in the
linked NWS indicator table. Choosing which DoDs represent our four severity
levels, and using proxies for broad inventory classes, are model choices.

| Parameter class | Thresholds | Indicator; DoDs | Qualification |
|---|---|---|---|
| MH | 61,89,105,127 | [MHSW](https://www.weather.gov/images/oun/efscale/MHSW.jpg); 1,4,6,9 | Single-wide proxy for all manufactured homes |
| RES_WOOD | 65,97,170,200 | [FR12](https://www.weather.gov/images/oun/efscale/FR12.jpg); 1,4,9,10 | Residential construction proxy |
| RES_MASONRY | 65,121,156,180 | [MAM](https://www.weather.gov/images/oun/efscale/MAM.jpg); 1,4,6,7 | Masonry apartment/motel proxy, not a house-specific curve |
| MULTI | 76,124,158,180 | [ACT](https://www.weather.gov/images/oun/efscale/ACT.jpg); 1,3,5,6 | Low-rise proxy; final state is almost total destruction of top two stories |
| SCHOOL | 65,125,153,176 | [ES](https://www.weather.gov/images/oun/efscale/ES.jpg); 1,7,9,10 | Elementary-school proxy |
| WORSHIP | 65,124,144,157 | [SPB](https://www.weather.gov/images/oun/efscale/SPB.jpg); 1,7,8,9 | Small-professional-building proxy; worship-specific behavior is unresolved |
| COMMERCIAL | 65,124,144,157 | [SPB](https://www.weather.gov/images/oun/efscale/SPB.jpg); 1,7,8,9 | Small-professional-building proxy |
| BIGROOF | 68,117,137,158 | Per-level median of [LIRB](https://www.weather.gov/images/oun/efscale/LIRB.jpg) 1,4,6,7 (68,122,137,173); [WHB](https://www.weather.gov/images/oun/efscale/WHB.jpg) 1,5,6,7 (68,114,124,158); [MBS](https://www.weather.gov/images/oun/efscale/MBS.jpg) 1,4,7,8 (67,117,143,155) | BIGROOF = COM/IND/GOV with footprint ≥ 20,000 sqft and ≤ 2 stories (retail, warehouses, factories, arenas); approved 2026-09-26 |
| OTHER | 65,97,170,200 | [FR12](https://www.weather.gov/images/oun/efscale/FR12.jpg); 1,4,9,10 | Explicit fallback proxy, not inferred construction |

Sources inspected 2026-09-26. Levels 1–4 are internal ordered severity steps;
level 4 is **not literal sweep-away for every class**. These reductions do not
model construction variability, uncertain wind estimates, or structural failure
correlations. A mansion, hospital, and high-rise need more specific indicators
than the current broad inventory classes allow.

`wind.profile = "linear"`: approved simplified taper from the centerline peak
to zero at radius `width_m / 2`. Distance is the nearest point on the finite
great-circle polyline, with rounded end caps and a spherical mean Earth radius
of 6,371,008.8 m. This is not a physical vortex reconstruction. Width must be
provided by the scenario; no fabricated width is substituted. ML's
`ml/exports/tornado_width_by_ef.json` is reserved for later default-scenario
generation and is not a runtime dependency of this CLI.

## Lethality and hard limits

| JSON parameter | Default | Hard bounds | Provenance |
|---|---:|---:|---|
| lethality_multiplier.MH | 1 | 0.05–20 | Neutral initialization; ML-approved fit constraint |
| lethality_multiplier.RES | 1 | 0.05–20 | Neutral initialization; ML-approved fit constraint |
| lethality_multiplier.PUBLIC | 1 | 0.05–20 | Neutral initialization; ML-approved fit constraint |
| lethality_multiplier.VEHICLE | 1 | 0.05–20 | Reserved; no vehicle exposure in tornado-only chunk |
| modifiers.night | 1.5 | 1–4 | Provisional model choice, fitted by ML |
| modifiers.basement | 0.25 | 0.05–1 | Provisional model choice, fitted by ML |
| modifiers.warning_per_min | 0.02 | 0–0.1 | Provisional exponential coefficient, fixed in current calibration |
| modifiers.over65 | 1.5 | 1–3 | Provisional age multiplier, fixed in current calibration |

For **every** class in `lethality_by_damage`, the level-0 through level-4
probabilities `[0,0.00001,0.0001,0.005,0.05]` are approved provisional starting
values, not extracted from NWS, Hazus, or a mortality study. Zero at level 0
is the model's no-damage/no-death convention; it omits deaths from hazards
that do not damage the building. The other four values allow fitting to start
with increasing lethality. Valid base probabilities are nondecreasing in [0,1].

MH has its own multiplier. RES covers RES_WOOD, RES_MASONRY, MULTI. PUBLIC
covers SCHOOL, WORSHIP, COMMERCIAL, BIGROOF. OTHER has a fixed multiplier of 1.
VEHICLE is always zero in these tornado results and cannot be identified by
the tornado training set. Warning is `exp(-warning_per_min * warning_min)`;
all historical storms currently have 10 placeholder warning minutes, so ML
holds this coefficient fixed. Keeping `over65` fixed and regularizing fitted
multipliers are ML's fitting choices. The engine never applies a fit penalty.

`night_hours = [20,21,22,23,0,1,2,3,4,5]` is the agreed ML convention from
`ml/patterns.py`, confirmed by the ML lead. It selects both population counts
and the night modifier. Local clock `hour` is already DST-adjusted upstream.

## Reserved heatmap parameters

`risk_bands.yellow = 0.0001`, `red = 0.01`, `deep_red = 0.1`, and
`min_cell_people = 5` come from `REFUGE_overview.md` and `ROLE_simulation.md`.
They are initial presentation choices awaiting calibration. The CLI validates
their ordering but does not render or aggregate cells in this chunk.

## Reproducibility constants and limits

`schema_version = 1` is this file contract's version, not a scientific value.
Scenario defaults `runs = 500` and `seed = 42` come from the overview's example
and the role's sampling requirement. Sampling uses Mulberry32 uint32 arithmetic
and independent Bernoulli trials by building/age group. A fractional modeled
occupant contributes one Bernoulli trial with probability equal to the fraction
times death probability, preserving the deterministic expectation.

p05 and p95 are nearest-rank percentiles (0.05 and 0.95) of simulated integer
death totals. They describe randomness conditional on fixed model inputs, not
uncertainty in parameters, exposure estimates, damage thresholds, or the
historical building inventory. Repeated seeds require the same building order.

## Class ranking check (2026-09-26, decision: keep one shared lethality table)

ML observed that with the calibrated params (MH 1.02, RES 1.66) the riskiest
EF4 cells can be apartments (MULTI) rather than mobile homes. Cause: at the EF4
centerline every class reaches damage level 4, so per-person risk is
0.05 x group multiplier, and RES > MH after fitting.

Averaged across the whole damage swath (uniform lateral position, 2 AM, 10 min
warning, no basements), the calibrated model gives MH/RES_WOOD per-person risk
ratios of 1.7 (EF1), 19 (EF2), 138 (EF3), 25 (EF4), 2.2 (EF5). Published US
estimates are 10–20x ([Fricker & Friesenhahn 2022](https://journals.ametsoc.org/view/journals/wcas/14/1/WCAS-D-21-0028.1.xml);
[Sutter & Simmons 2010](https://link.springer.com/article/10.1007/s11069-009-9416-x)),
so the model already matches or exceeds them. Raising the MH top level to 0.15
would give up to 427x. On the real `bt_2024_1181735` town (97 mobile homes),
the four riskiest cells at both EF3 and EF4 are mobile-home cells. MULTI only
ranks first where apartments sit on an EF4 centerline. Methods note: at the core
of a violent tornado every class is destroyed and ranks by its fitted multiplier.

## Flood and vehicle defaults (approved 2026-09-26, uncalibrated)

Depth above the first floor = `flood_height_m - hand_m - first_floor_ht_m`
(`first_floor_ht_m` null counts as 0). `flood_height_m` is one water height
above the nearest stream for the whole place (HAND approach), a
simplification: real stages vary by reach. Buildings or crossings with null
`hand_m` (or null `cars_per_hour`) are skipped and counted in `no_flood_data`.

| Parameter | Value | Source / reasoning |
|---|---|---|
| `flood.lethality_by_damage` | 0, 0, 0.0001, 0.10, 0.90 | LifeSim lethality zones (McClelland & Bowles 2002, via [USACE LifeSim overview](https://www.researchgate.net/publication/228729916_LIFESim_A_Tool_for_Estimating_and_Reducing_Life-Loss_Resulting_from_Dam_and_Levee_Failures)): safe ≈ 0, compromised ≈ 10% (range 0–50%), chance ≈ 90% (range 50–100%). Level 3 = compromised, level 4 = chance. |
| `flood.damage_thresholds_m` (non-MH) | 0, 0.9, 1.5, 2.4 | Water on the floor; waist; shoulder height indoors (LifeSim's compromised example); over head height on a one-story floor (chance). |
| `flood.damage_thresholds_m.MH` | 0, 0.1, 0.2, 0.3 | [FEMA P-85](https://www.fema.gov/sites/default/files/2020-08/fema_p85.pdf) p. 97: "Flood depths of only 4 to 5 inches above the lowest floor can be capable of floating unsecured manufactured homes off their foundations." Chance level set at ~1 ft, allowing that many homes are anchored (NSI does not record anchoring). |
| `flood.story_height_m` | 3.0 | Levels 3–4 rise one story per story above the first: occupants move upstairs (LifeSim: second floors are typically safe). Not applied to MH. |
| `vehicle.depth_thresholds_m` | 0.15, 0.3, 0.6 | [NWS Turn Around Don't Drown](https://www.weather.gov/safety/flood-turn-around-dont-drown): 6 in knocks over an adult, 12 in carries away most cars, 2 ft carries away SUVs and trucks. |
| `vehicle.lethality_by_depth` | 0, 0.01, 0.10, 0.30 | Model choice anchored to the NWS depths; a floated car is less lethal than LifeSim's chance zone because many occupants escape. Uncalibrated. |
| `vehicle.attempt_prob` | 0.27 | Share of drivers who would drive through moving water deeper than 30 cm (UK driver survey, Environment Agency/AA). |
| `vehicle.occupancy` | 1.67 | People per vehicle trip, [NHTS 2017](https://nhts.ornl.gov/assets/2017_nhts_summary_travel_trends.pdf). |
| `vehicle.exposure_hours` | 1 | Drivers arriving during the scenario hour. |

Drivers at a crossing = `cars_per_hour[hour] x exposure_hours x occupancy`;
each dies with `attempt_prob x lethality_by_depth[level] x VEHICLE multiplier x
night x warning`. Flood does **not** use the tornado class multipliers or the
basement modifier (they were fit to wind, and basements do not protect from
water). It keeps night, warning, over65, and the VEHICLE multiplier.
