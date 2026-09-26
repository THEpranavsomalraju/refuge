"""USACE National Structure Inventory (NSI) access and conversion to Refuge building records.

Three public functions, shared by the featured-place pipeline and the ML backtest:

    fetch_buildings(area)                       raw NSI structures as a GeoDataFrame
    to_building_records(raw)                    records in the buildings.json format
    write_place_lite(area, place_id, out_dir)   minimal place folder for the sim CLI

`area` is either a bbox tuple (min_lon, min_lat, max_lon, max_lat) in WGS84 or a
shapely Polygon / MultiPolygon in WGS84.

Importing this module has no side effects. Run it as a script for a quick check:

    python places/fetch_nsi.py -94.60 37.02 -94.40 37.10
"""

from __future__ import annotations

import gzip
import json
import logging
import math
import os
import time
from collections import Counter
from pathlib import Path

import geopandas as gpd
import h3
import numpy as np
import requests
import shapely
from shapely.geometry import Polygon, box

log = logging.getLogger(__name__)

NSI_URL = "https://nsi.sec.usace.army.mil/nsiapi/structures"

# Cache lives in the repo's gitignored data/ folder.
CACHE_DIR = Path(__file__).resolve().parent.parent / "data" / "cache" / "nsi"

# Queries are split into tiles on a fixed global grid, so overlapping areas reuse cached tiles.
TILE_DEG = 0.05

MAX_TRIES = 4
TIMEOUT_S = 120

H3_RES = 10
FT_TO_M = 0.3048

# COM, IND and GOV buildings whose footprint (ftprntsqft, the whole building, not the
# tenant's sqft) is at least this large, with at most this many stories, become BIGROOF.
BIGROOF_MIN_FOOTPRINT_SQFT = 20_000
BIGROOF_MAX_STORIES = 2

# NSI public fields, used to give an empty result the same columns as a full one.
NSI_FIELDS = [
    "fd_id", "bid", "x", "y", "cbfips", "st_damcat", "occtype", "bldgtype", "source",
    "sqft", "ftprntid", "ftprntsrc", "ftprntsqft", "bldheight", "found_type", "found_ht",
    "num_story", "resunits", "val_struct", "val_cont", "val_vehic", "fullrep", "depindex",
    "med_yr_blt", "pop2amu65", "pop2amo65", "pop2pmu65", "pop2pmo65", "students",
    "o65disable", "u65disable", "firmzone", "zone_sub", "static_bfe", "grnd_elv_m",
    "ground_elv", "usastrucid", "novehprob", "vehperunit", "pctlowclr", "creprcnt", "crerank",
]

# Key order of one record in buildings.json (REFUGE_overview.md, format 1).
RECORD_KEYS = [
    "id", "lon", "lat", "h3", "cbfips", "footprint", "occtype", "cls", "stories",
    "basement", "ground_elev_m", "first_floor_ht_m", "hand_m", "firmzone",
    "pop_night_u65", "pop_night_o65", "pop_day_u65", "pop_day_o65",
]


# ---------------------------------------------------------------------------
# fetch_buildings
# ---------------------------------------------------------------------------

def fetch_buildings(area, cache_dir: Path | str | None = None) -> gpd.GeoDataFrame:
    """Return every NSI structure inside `area` as a GeoDataFrame of points (EPSG:4326).

    Parameters
    ----------
    area : tuple or shapely Polygon/MultiPolygon
        (min_lon, min_lat, max_lon, max_lat) in WGS84, or a polygon in WGS84.
    cache_dir : path, optional
        Where tile responses are cached. Defaults to <repo>/data/cache/nsi/.

    Returns
    -------
    GeoDataFrame with every raw NSI field (fd_id, occtype, bldgtype, found_type, sqft,
    ftprntsqft, grnd_elv_m, pop2amu65, ...) plus a point `geometry`. One row per fd_id.
    An area with no structures returns an empty frame with the same columns.

    Notes
    -----
    The area is split into TILE_DEG tiles on a fixed grid. Each tile is fetched once,
    cached as gzipped GeoJSON, and reused on later calls, so repeat calls make no
    network requests. Failed requests retry with backoff on timeouts and 5xx errors.
    """
    poly = _to_polygon(area)
    cache = Path(cache_dir) if cache_dir is not None else CACHE_DIR
    cache.mkdir(parents=True, exist_ok=True)

    features = []
    for tile in _tiles_for(poly):
        features.extend(_get_tile(tile, cache))

    if not features:
        return _empty_frame()

    gdf = gpd.GeoDataFrame.from_features(features, crs="EPSG:4326")
    gdf = gdf.drop_duplicates(subset="fd_id").reset_index(drop=True)
    gdf = gdf[shapely.covers(poly, gdf.geometry.values)].reset_index(drop=True)
    for col in NSI_FIELDS:
        if col not in gdf.columns:
            gdf[col] = None
    return gdf


def _to_polygon(area):
    if isinstance(area, (tuple, list)) and len(area) == 4:
        min_lon, min_lat, max_lon, max_lat = map(float, area)
        if not (min_lon < max_lon and min_lat < max_lat):
            raise ValueError(f"bbox must be (min_lon, min_lat, max_lon, max_lat), got {area}")
        return box(min_lon, min_lat, max_lon, max_lat)
    if isinstance(area, shapely.Geometry) and area.geom_type in ("Polygon", "MultiPolygon"):
        return area
    raise TypeError("area must be a (min_lon, min_lat, max_lon, max_lat) tuple or a shapely Polygon")


def _tiles_for(poly):
    """Grid-aligned tile indices (ix, iy) whose squares intersect `poly`."""
    min_lon, min_lat, max_lon, max_lat = poly.bounds
    ix0, ix1 = math.floor(min_lon / TILE_DEG), math.floor(max_lon / TILE_DEG)
    iy0, iy1 = math.floor(min_lat / TILE_DEG), math.floor(max_lat / TILE_DEG)
    for ix in range(ix0, ix1 + 1):
        for iy in range(iy0, iy1 + 1):
            if poly.intersects(_tile_box(ix, iy)):
                yield ix, iy


def _tile_box(ix, iy):
    return box(ix * TILE_DEG, iy * TILE_DEG, (ix + 1) * TILE_DEG, (iy + 1) * TILE_DEG)


def _get_tile(tile, cache: Path) -> list:
    ix, iy = tile
    path = cache / f"tile_{TILE_DEG}_{ix}_{iy}.json.gz"
    if path.exists():
        with gzip.open(path, "rt", encoding="utf-8") as f:
            return json.load(f)

    features = _request_tile(_tile_box(ix, iy))
    tmp = path.with_suffix(".tmp")
    with gzip.open(tmp, "wt", encoding="utf-8") as f:
        json.dump(features, f)
    os.replace(tmp, path)
    return features


def _request_tile(tile_box) -> list:
    # The NSI bbox parameter is a closed polygon ring: lon,lat,lon,lat,...
    ring = ",".join(f"{x:.6f},{y:.6f}" for x, y in tile_box.exterior.coords)
    params = {"bbox": ring, "fmt": "fc"}
    for attempt in range(1, MAX_TRIES + 1):
        try:
            r = requests.get(NSI_URL, params=params, timeout=TIMEOUT_S)
            if r.status_code >= 500:
                raise requests.HTTPError(f"NSI returned {r.status_code}")
            r.raise_for_status()
            body = r.json() if r.content.strip() else None
            return (body or {}).get("features") or []
        except (requests.Timeout, requests.ConnectionError, requests.HTTPError) as e:
            is_client_error = (
                isinstance(e, requests.HTTPError)
                and e.response is not None
                and e.response.status_code < 500
            )
            if is_client_error or attempt == MAX_TRIES:
                raise
            wait = 2 ** attempt
            log.warning("NSI request failed (%s), retry %d/%d in %ds", e, attempt, MAX_TRIES - 1, wait)
            time.sleep(wait)


def _empty_frame() -> gpd.GeoDataFrame:
    return gpd.GeoDataFrame({c: [] for c in NSI_FIELDS}, geometry=gpd.GeoSeries([], crs="EPSG:4326"))


# ---------------------------------------------------------------------------
# to_building_records
# ---------------------------------------------------------------------------

def classify(
    occtype: str,
    bldgtype: str | None,
    ftprntsqft: float | None,
    stories: float | None,
    pop_night: int,
) -> str:
    """Map an NSI occupancy type to a Refuge `cls` value.

    RES2 -> MH; RES1 masonry (M) or concrete (C) -> RES_MASONRY, other RES1 -> RES_WOOD;
    RES3*, RES4 (hotels), RES5 (dorms), RES6 (nursing homes) -> MULTI; EDU* -> SCHOOL; REL* -> WORSHIP;
    COM*, IND*, GOV* with footprint >= BIGROOF_MIN_FOOTPRINT_SQFT and stories <=
    BIGROOF_MAX_STORIES -> BIGROOF, otherwise COMMERCIAL (missing footprint or stories ->
    COMMERCIAL); AGR1 with night population > 0 (farmhouses) -> RES_WOOD;
    everything else -> OTHER.
    """
    occ = (occtype or "").upper()
    if occ.startswith("RES2"):
        return "MH"
    if occ.startswith("RES1"):
        return "RES_MASONRY" if (bldgtype or "").upper() in ("M", "C") else "RES_WOOD"
    if occ.startswith(("RES3", "RES4", "RES5", "RES6")):
        return "MULTI"
    if occ.startswith("EDU"):
        return "SCHOOL"
    if occ.startswith("REL"):
        return "WORSHIP"
    if occ.startswith(("COM", "IND", "GOV")):
        if (
            ftprntsqft is not None
            and stories is not None
            and ftprntsqft >= BIGROOF_MIN_FOOTPRINT_SQFT
            and stories <= BIGROOF_MAX_STORIES
        ):
            return "BIGROOF"
        return "COMMERCIAL"
    if occ.startswith("AGR1") and pop_night > 0:
        return "RES_WOOD"
    return "OTHER"


def to_building_records(raw: gpd.GeoDataFrame) -> list[dict]:
    """Convert raw NSI rows (from fetch_buildings) to buildings.json records.

    Every key of the shared format is always present. Fields not computed here are None
    (null in JSON): `footprint` and `hand_m` come from the full place pipeline.
    `ground_elev_m` is NSI's grnd_elv_m; the featured-place pipeline replaces it with 3DEP.
    `id` is "nsi_<fd_id>", so records join back to the raw frame on id.
    """
    records = []
    for row in raw.itertuples(index=False):
        lon, lat = row.geometry.x, row.geometry.y
        rec = {
            "id": f"nsi_{int(row.fd_id)}",
            "lon": round(lon, 6),
            "lat": round(lat, 6),
            "h3": h3.latlng_to_cell(lat, lon, H3_RES),
            "cbfips": _str_or_none(row.cbfips),
            "footprint": None,
            "occtype": row.occtype,
            "cls": classify(
                row.occtype,
                _str_or_none(row.bldgtype),
                _num_or_none(row.ftprntsqft),
                _num_or_none(row.num_story),
                _int_or_zero(row.pop2amu65) + _int_or_zero(row.pop2amo65),
            ),
            "stories": _int_or_none(row.num_story),
            "basement": _str_or_none(row.found_type) == "B",
            "ground_elev_m": _round_or_none(row.grnd_elv_m, 2),
            "first_floor_ht_m": _round_or_none(_scale(row.found_ht, FT_TO_M), 2),
            "hand_m": None,
            "firmzone": _str_or_none(row.firmzone),
            "pop_night_u65": _int_or_zero(row.pop2amu65),
            "pop_night_o65": _int_or_zero(row.pop2amo65),
            "pop_day_u65": _int_or_zero(row.pop2pmu65),
            "pop_day_o65": _int_or_zero(row.pop2pmo65),
        }
        records.append(rec)
    return records


def _is_missing(v):
    return v is None or (isinstance(v, float) and math.isnan(v))


def _str_or_none(v):
    return None if _is_missing(v) or v == "" else str(v)


def _num_or_none(v):
    return None if _is_missing(v) else float(v)


def _int_or_none(v):
    return None if _is_missing(v) else int(round(float(v)))


def _int_or_zero(v):
    return 0 if _is_missing(v) else int(v)


def _scale(v, k):
    return None if _is_missing(v) else float(v) * k


def _round_or_none(v, nd):
    return None if _is_missing(v) else round(float(v), nd)


# ---------------------------------------------------------------------------
# write_place_lite
# ---------------------------------------------------------------------------

def write_place_lite(area, place_id: str, out_dir: Path | str) -> Path:
    """Write a minimal place folder for the Simulation CLI and return its path.

    out_dir/<place_id>/
        buildings.json   to_building_records(fetch_buildings(area))
        cells.json       every H3 res-10 cell containing a building
                         (h3, center, boundary, ground_elev_m=None, pop_night, pop_day)
        place.json       place_id, county_fips, bbox, center, streams=[], roads=[]
        crossings.json   []
    """
    poly = _to_polygon(area)
    records = to_building_records(fetch_buildings(poly))

    folder = Path(out_dir) / place_id
    folder.mkdir(parents=True, exist_ok=True)

    _write_json(folder / "buildings.json", records)
    _write_json(folder / "cells.json", cells_from_records(records))
    _write_json(folder / "place.json", _place_lite(poly, place_id, records))
    _write_json(folder / "crossings.json", [])
    return folder


def cells_from_records(records: list[dict]) -> list[dict]:
    """One cells.json entry per H3 cell that contains at least one building."""
    night, day = Counter(), Counter()
    for r in records:
        night[r["h3"]] += r["pop_night_u65"] + r["pop_night_o65"]
        day[r["h3"]] += r["pop_day_u65"] + r["pop_day_o65"]
    cells = []
    for cell in sorted(night):
        lat, lon = h3.cell_to_latlng(cell)
        cells.append({
            "h3": cell,
            "center": [round(lon, 6), round(lat, 6)],
            "boundary": [[round(x, 6), round(y, 6)] for y, x in h3.cell_to_boundary(cell)],
            "ground_elev_m": None,
            "pop_night": night[cell],
            "pop_day": day[cell],
        })
    return cells


def _place_lite(poly, place_id, records):
    min_lon, min_lat, max_lon, max_lat = poly.bounds
    counties = Counter(r["cbfips"][:5] for r in records if r["cbfips"])
    return {
        "place_id": place_id,
        "county_fips": counties.most_common(1)[0][0] if counties else None,
        "bbox": [round(min_lon, 6), round(min_lat, 6), round(max_lon, 6), round(max_lat, 6)],
        "center": [round((min_lon + max_lon) / 2, 6), round((min_lat + max_lat) / 2, 6)],
        "streams": [],
        "roads": [],
    }


def _write_json(path: Path, obj):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, separators=(",", ":"))


# ---------------------------------------------------------------------------
# CLI check
# ---------------------------------------------------------------------------

def summarize(records: list[dict]) -> dict:
    """Counts per cls and population totals, for quick sanity checks."""
    return {
        "buildings": len(records),
        "by_cls": dict(Counter(r["cls"] for r in records).most_common()),
        "pop_night": sum(r["pop_night_u65"] + r["pop_night_o65"] for r in records),
        "pop_day": sum(r["pop_day_u65"] + r["pop_day_o65"] for r in records),
        "basement_share": round(float(np.mean([r["basement"] for r in records])), 3) if records else None,
    }


if __name__ == "__main__":
    import argparse

    p = argparse.ArgumentParser(description="Fetch NSI buildings for a bbox and print a summary.")
    p.add_argument("bbox", nargs=4, type=float, metavar=("MIN_LON", "MIN_LAT", "MAX_LON", "MAX_LAT"))
    args = p.parse_args()

    logging.basicConfig(level=logging.INFO)
    t0 = time.time()
    raw = fetch_buildings(tuple(args.bbox))
    recs = to_building_records(raw)
    print(json.dumps(summarize(recs), indent=1))
    print(f"{time.time() - t0:.1f}s")
