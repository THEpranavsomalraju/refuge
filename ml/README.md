# ml/

National risk + location models trained on NOAA Storm Events deaths, calibration of `sim/params/sim_params.json`, backtest on historical tornadoes, and landing page data.

## Setup

```bash
python3.12 -m venv ml/.venv
ml/.venv/bin/pip install -r ml/requirements.txt
```

Optional: put `CENSUS_API_KEY=...` in `ml/.env` (gitignored). Without it, county features come from SVI 2022, which already includes ACS 2018-2022 counts.

## Run

```bash
ml/.venv/bin/python ml/download.py       # raw files -> data/raw/  (~300 MB, cached)
ml/.venv/bin/python ml/build_tables.py   # -> data/processed/*.parquet
ml/.venv/bin/python ml/check_phase1.py   # sanity checks
```

## Tables (data/processed/, not in git)

| File | Rows | Notes |
|---|---|---|
| `events.parquet` | one per NOAA event, 1996-2025 | tornadoes are one row per county segment |
| `fatalities.parquet` | one per death | `location_class` in MH, RES, PUBLIC, VEHICLE, WATER, OUTDOOR, OTHER |
| `county_features.parquet` | one per county | mh_share, age65_share, noveh_share, pop_density, svi |
| `narratives.parquet` | tornado + flash flood events | NOAA event and episode text |

## Conventions shared with the rest of the team

- **hour** is local clock time (0-23), same as the scenario `hour` field. NOAA stores local standard time, so we convert with real DST rules. The original is kept as `hour_lst`.
- **county_fips** is a 5 character string, for example `"37021"`.
- **widths**: NOAA gives yards (`tor_width_yd`). `tor_width_m` matches the scenario `width_m`.
- **Death location classes** vs simulator building classes (used for calibration):

| NOAA class | sim `cls` / `by_class` keys |
|---|---|
| MH | MH |
| RES | RES_WOOD, RES_MASONRY, MULTI |
| PUBLIC | SCHOOL, WORSHIP, COMMERCIAL, BIGROOF |
| VEHICLE | VEHICLE |
| OUTDOOR, WATER, OTHER | no match (sim `OTHER` buildings too), left out of the location mix penalty |
