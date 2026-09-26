# places/ — Structures pipeline

Owner: Structures and 3D (@soham-patki). Read `REFUGE_overview.md` first.

This folder turns real building, road, stream, and terrain data into one folder of JSON files per featured place. Those files, plus the Python functions in `fetch_nsi.py`, are the only things other parts of Refuge use from here. The overview says only this role edits `places/`.

> **Status:** `fetch_nsi.py` and `build_place.py` are done. The three featured places are built with buildings, footprints, and full `cells.json`. Streams, `hand_m`, roads, crossings, and 3DEP elevation come in Phase 2. Anything marked **TBD** is undecided. Anything marked **proposed** still needs sign-off from the teammate who reads it.

## Featured places

| `place_id` | City (OSM city limits → bounding rectangle) | Buildings | MH | Night / day pop | Cells (empty) |
|---|---|---|---|---|---|
| `morganton` | Morganton, NC (Burke, 37023). Western NC, flood | 13,595 | 934 (6.9%) | 27,739 / 35,988 | 10,111 (5,977) |
| `lumberton` | Lumberton, NC (Robeson, 37155). Eastern NC, mobile homes, tornado | 14,551 | 1,641 (11.3%) | 31,629 / 39,109 | 13,841 (9,821) |
| `chapel_hill` | Chapel Hill, NC (Orange, 37135) | 21,065 | 56 (0.3%) | 95,189 / 130,258 | 6,902 (2,594) |

Each place is the tidy rectangle around the official city limits, so it includes the outskirts. The pipeline works for any U.S. city. These three are just prebuilt, so the demo never waits on a download.

---

## Who uses what

| Consumer | Uses | How |
|---|---|---|
| Simulation engine (`sim/core/`, `sim/cli.ts`) | `places/<place_id>/buildings.json`, `crossings.json` | Loads the place folder. Uses `cls`, `basement`, `stories`, `first_floor_ht_m`, `hand_m`, populations, `h3`. |
| Simulation `aggregateCells` | `h3` on every building and crossing | Groups deaths and people by H3 cell. |
| 3D scene (`web/src/scene/`) | `place.json`, `buildings.json`, `cells.json` | Draws terrain, buildings, roads, streams, and risk-map hexagons. |
| ML lead (`ml/`) | `write_place_lite` (and `fetch_buildings`, `to_building_records`) | Builds throwaway place folders along historical tornado paths for the backtest, in `data/backtest/places/`. |

Nothing in this folder imports from `sim/`, `ml/`, or `web/`. The dependency only runs one way: other folders use this one.

---

## `fetch_nsi.py`: shared by featured places and the backtest

```python
from places.fetch_nsi import fetch_buildings, to_building_records, write_place_lite

raw = fetch_buildings(area)               # raw NSI GeoDataFrame, every NSI field + point geometry
records = to_building_records(raw)        # list of dicts in the buildings.json format
folder = write_place_lite(area, "bt_2021_996712", "data/backtest/places")
```

- `area` is a bbox tuple `(min_lon, min_lat, max_lon, max_lat)` or a shapely Polygon / MultiPolygon, in WGS84.
- Importing has no side effects. As a script, `python places/fetch_nsi.py MIN_LON MIN_LAT MAX_LON MAX_LAT` prints counts per class and population totals.
- **Tiling:** areas are split into 0.05° tiles on a fixed global grid. Only tiles that touch the area are fetched, and the results are deduped on `fd_id` and clipped to the area.
- **Cache:** each tile is stored as gzipped GeoJSON in `data/cache/nsi/` (gitignored), so repeat calls make no network requests.
- **Retries:** timeouts, connection errors, and 5xx responses retry 4 times with backoff. An area with no buildings returns an empty frame with the same columns.
- There is **one** conversion (`to_building_records`). The featured-place pipeline and the backtest both call it, so the two can't drift apart.

### Class mapping (`classify`)

| NSI `occtype` | Condition | `cls` |
|---|---|---|
| `RES2` | | `MH` |
| `RES1*` | `bldgtype` M (masonry) or C (concrete) | `RES_MASONRY` |
| `RES1*` | otherwise (W wood, S steel, …) | `RES_WOOD` |
| `RES3*`, `RES4` hotel, `RES5` dorm, `RES6` nursing home | | `MULTI` |
| `EDU*` | | `SCHOOL` |
| `REL*` | | `WORSHIP` |
| `COM*`, `IND*`, `GOV*` | footprint `ftprntsqft` ≥ 20,000 **and** `num_story` ≤ 2 | `BIGROOF` |
| `COM*`, `IND*`, `GOV*` | otherwise (including missing footprint or stories) | `COMMERCIAL` |
| `AGR1` | night population > 0 (farmhouses) | `RES_WOOD` |
| anything else | | `OTHER` (in practice, empty farm buildings) |

BIGROOF uses `ftprntsqft` (the building's footprint), not `sqft`. `sqft` is the floor area of one tenant, and several tenants can share a single footprint, such as the stores in a mall.

### Other fields

| Field | Source |
|---|---|
| `id` | `"nsi_" + fd_id` (deterministic; joins back to the raw frame) |
| `h3` | H3 resolution 10, `h3` v4 `latlng_to_cell(lat, lon, 10)` |
| `basement` | `found_type == "B"` |
| `first_floor_ht_m` | `found_ht` (feet) × 0.3048 |
| `ground_elev_m` | NSI `grnd_elv_m` (meters). Featured places replace it with 3DEP, from the same DEM as the streams, so `hand_m` stays consistent. |
| `firmzone` | Raw NSI string, including `"AREA NOT INCLUDED"` |
| `pop_night_*` / `pop_day_*` | NSI `pop2amu65`, `pop2amo65`, `pop2pmu65`, `pop2pmo65` |
| `footprint`, `hand_m` | `null` here; filled in by the featured-place pipeline |

### Tested areas
Counts are per class. Population is at night.

| Area | Buildings | Classes | Night pop |
|---|---|---|---|
| Joplin MO `(-94.60, 37.02, -94.40, 37.10)` | 25,277 | RES_WOOD 15,262 · MULTI 2,921 · RES_MASONRY 2,914 · COMMERCIAL 2,535 · OTHER 904 · BIGROOF 357 · WORSHIP 188 · MH 107 · SCHOOL 89 | 57,224 |
| Edwardsville IL, `bt_2021_996712` path buffered by width/2 + 1 km | 1,269 | RES_WOOD 421 · RES_MASONRY 393 · COMMERCIAL 242 · MULTI 145 · OTHER 20 · BIGROOF 19 · SCHOOL 17 · WORSHIP 12 | 5,508 |
| Robeson County NC (county records only) | 59,288 | 16% MH | 115,012 (2020 Census about 116,500) |

Known NSI gap: the Amazon DLI4 warehouse in Edwardsville, where all 6 deaths of the 2021 tornado happened, has no NSI record.

---

## `build_place.py`: featured places for any U.S. city

```bash
python -m places.build_place "Lumberton, North Carolina, USA" --place-id lumberton
python -m places.build_place "Some Big City, State, USA" --place-id big_city --max-buildings 13000
```

1. **Area:** the city limits come from OpenStreetMap (osmnx geocoding). The place is the bounding rectangle of those limits.
2. **Large cities:** with `--max-buildings N`, if the rectangle holds more than N buildings, the script keeps the square holding the most people at night with at most N buildings.
3. **Buildings:** `fetch_buildings` → `to_building_records`, the same conversion the backtest uses.
4. **Footprints** (for drawing only; the exact shape doesn't matter, color by `cls` tells the types apart):
   1. The OSM building outline the NSI point falls inside, simplified to 2 m and stored with 5 decimals (about 1 m).
   2. Otherwise, NSI's own building box: the UBID in NSI's `bid` field decodes to the building's real bounding box, which is scaled to NSI's footprint area (`ftprntsqft`), keeping its center and proportions. Needs the small `openlocationcode` package.
   3. Otherwise (empty `bid`), a square with the `ftprntsqft` area.
   - An outline that becomes invalid after simplifying is replaced by its convex hull.
   - OSM coverage: Morganton 41%, Lumberton 33%, Chapel Hill 92%. Almost all the rest get the NSI box; squares are 1–3%.
5. **Writes** `buildings.json`, `cells.json` (every H3 cell in the rectangle, empty ones included), `place.json`, and `crossings.json` (`[]` until Phase 2).

A rebuild with a warm cache takes 5–10 s. A new city's first build takes 30–90 s while NSI and OSM download. OSM responses are cached in `data/cache/osmnx/`.

---

## Output files (one folder per place)

```
places/<place_id>/
  buildings.json   frozen format (overview §1)
  crossings.json   frozen format (overview §2) + proposed "h3" key   Phase 2
  cells.json       proposed format (below)
  place.json       proposed keys (below)
```

### Placeholder rule
Every key in a format is always written. A field that isn't computed yet is `null`. Keys never go missing, so readers can depend on the shape from day one, and a `null` shows exactly what is still pending.

| Field | File | Filled in | Until then |
|---|---|---|---|
| `hand_m` | buildings.json | Phase 2 (streams + 3DEP) | `null` → no flood data (not 0) |
| `footprint` | buildings.json | `build_place.py` (featured places) | `null` in backtest folders |
| `ground_elev_m` | cells.json | featured pipeline (3DEP) | `null` in backtest folders |
| `cars_per_hour` | crossings.json | Phase 2 | `null` |

### `buildings.json` (frozen, overview §1)
One record per NSI structure, keys in this order: `id`, `lon`, `lat`, `h3`, `cbfips`, `footprint`, `occtype`, `cls`, `stories`, `basement`, `ground_elev_m`, `first_floor_ht_m`, `hand_m`, `firmzone`, `pop_night_u65`, `pop_night_o65`, `pop_day_u65`, `pop_day_o65`.

### `cells.json` (**proposed**, needs Simulation sign-off)
```json
[{
  "h3": "8a2640c34807fff",
  "center": [-90.016728, 38.760356],
  "boundary": [[-90.016731, 38.759673], "... 6 corners, first point not repeated"],
  "ground_elev_m": 612.3,
  "pop_night": 38,
  "pop_day": 21
}]
```
- **Featured places:** every H3 resolution-10 cell covering the whole map, including empty ones. The scene draws empty cells uncolored, and Simulation marks them `band: "empty"`.
- **Backtest folders (`write_place_lite`):** only cells that contain a building.
- `pop_night` / `pop_day` are the sums of building populations. They're for display only; Simulation computes cell people itself (buildings plus crossing drivers).
- Every `h3` in `buildings.json` and `crossings.json` appears in `cells.json`.

### `crossings.json` (frozen, overview §2), Phase 2
Low-water crossings: points where a road line crosses a stream line and the road sits within a few meters of the stream. **Proposed:** add an `"h3"` key so Simulation can count drivers per cell. In the 3D scene, vehicles are static props, not animated.

`cars_per_hour[h] = daily_volume_by_osm_tag[area][highway] × curves[curve].share[h]`, from `ml/exports/traffic_by_hour.json`:
- the two small towns use `area = "rural"` and `curve = "weekday_rural"`
- Chapel Hill uses `"urban"` and `"weekday_urban"`

### `place.json` (**proposed** keys)
`place_id`, `name` (the geocoding query; `null` in backtest folders), `county_fips` (the most common county, taken from the buildings' `cbfips[:5]`), `bbox` `[min_lon, min_lat, max_lon, max_lat]`, `center` `[lon, lat]`, `camera` (`null` until Phase 2), `terrain_source` (`null` until Phase 2), `streams`, `roads` (empty until Phase 2, and always empty in backtest folders).

---

## Setup

```bash
python -m venv places/.venv
places/.venv/Scripts/python -m pip install -r places/requirements.txt   # Windows
# places/.venv/bin/python -m pip install -r places/requirements.txt     # macOS/Linux
```

| File | Contents | Who installs it |
|---|---|---|
| `requirements-core.txt` | requests, geopandas, shapely, pyproj, numpy, h3 | ML lead (enough for `fetch_nsi.py`) |
| `requirements.txt` | core + py3dep, pynhd, osmnx, openlocationcode | full place pipeline |

Raw downloads and caches go in `data/` at the repo root (gitignored), never in `places/`.

## Pipeline files

| File | Phase | Status |
|---|---|---|
| `fetch_nsi.py` | 1 | done |
| `build_place.py` | 1–2 | buildings, footprints, cells done; streams, `hand_m`, roads, crossings, 3DEP in Phase 2 |
| `validate.py` | 3 | to do |

---

## Merge rules for this folder
- Only `places/`, `web/src/scene/`, and `web/src/landing/` are edited from this role. Other folders need the owner's OK first.
- Work happens on the `places/phase-N` branches, through a PR into `main`.
- Frozen formats (`buildings.json`, `crossings.json`) don't change without telling the team. Any change gets tested against the Simulation engine the same hour.
- No file over 20 MB, no `.env`, no raw data committed.
- The scene API that Simulation calls (`setBuildingGlow`, `setWaterLevel`, `showTornadoPath`, `placeProtection`, `onBuildingClick`, `onCellHover`, `showRiskMap`, `showDifference`, `showSwipeCompare`, `hideRiskMap`) lives in `web/src/scene/` and will be documented there.

## Open decisions
- [x] Featured places: Morganton, Lumberton, Chapel Hill (city-limit rectangles)
- [x] Footprint source: OSM via osmnx, then the NSI UBID box, then a square
- [ ] `cells.json`, `place.json` keys, and the crossings `h3` key (Simulation)
- [ ] Simulation CLI runs on a `write_place_lite` folder (Simulation)
