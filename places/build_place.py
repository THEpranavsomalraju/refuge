"""Build a featured place folder for any U.S. city.

    python -m places.build_place "Lumberton, North Carolina, USA" --place-id lumberton
    python -m places.build_place "Wilmington, North Carolina, USA" --place-id wilmington --max-buildings 13000

Steps:
  1. City limits from OpenStreetMap; the place is the bounding rectangle of the limits.
  2. If --max-buildings is set and the rectangle holds more, keep the square that holds
     the most people at night with at most that many buildings.
  3. Buildings from fetch_buildings + to_building_records (same conversion as the backtest).
  4. Footprints: the OSM building outline each NSI point falls inside, simplified. Buildings
     without one get NSI's own building box (decoded from `bid`) scaled to NSI's footprint
     area (ftprntsqft); if `bid` is empty, a square of that area.
  5. Writes places/<place_id>/ buildings.json, cells.json (every H3 cell in the rectangle,
     empty ones included), place.json, crossings.json ([] until Phase 2).
"""

from __future__ import annotations

import argparse
import json
import logging
import math
import time
from collections import Counter
from pathlib import Path

import geopandas as gpd
import h3
import numpy as np
import osmnx as ox
from openlocationcode import openlocationcode as olc
from osmnx._errors import InsufficientResponseError
from shapely.geometry import Point, Polygon, box

from places.fetch_nsi import (
    H3_RES,
    cells_from_records,
    fetch_buildings,
    place_record,
    summarize,
    to_building_records,
    write_json,
)

log = logging.getLogger(__name__)

PLACES_DIR = Path(__file__).resolve().parent
OSM_CACHE_DIR = PLACES_DIR.parent / "data" / "cache" / "osmnx"

SQFT_TO_M2 = 0.09290304
SIMPLIFY_M = 2.0          # outline simplification tolerance, meters
WINDOW_BIN_M = 100        # grid resolution for the most-populous-square search
FOOTPRINT_DECIMALS = 5    # ~1 m; footprint shapes are only drawn, never measured


def build_place(query: str, place_id: str, max_buildings: int | None = None,
                out_dir: Path | str = PLACES_DIR) -> Path:
    """Build places/<place_id>/ for the city named by `query` and return the folder."""
    _configure_osmnx()

    limits = ox.geocode_to_gdf(query)
    rect = box(*limits.geometry.iloc[0].bounds)

    raw = fetch_buildings(rect)
    if max_buildings is not None and len(raw) > max_buildings:
        rect = densest_square(raw, max_buildings)
        raw = fetch_buildings(rect)

    records = to_building_records(raw)
    stats = attach_footprints(records, raw, rect)

    cover = h3.geo_to_cells(rect, H3_RES)
    cells = cells_from_records(records, extra_cells=cover)

    folder = Path(out_dir) / place_id
    folder.mkdir(parents=True, exist_ok=True)
    write_json(folder / "buildings.json", records)
    write_json(folder / "cells.json", cells)
    write_json(folder / "place.json", place_record(rect, place_id, records, name=query))
    write_json(folder / "crossings.json", [])

    log.info("footprints: %s", stats)
    return folder


def _configure_osmnx():
    ox.settings.cache_folder = str(OSM_CACHE_DIR)
    ox.settings.use_cache = True
    ox.settings.log_console = False


# ---------------------------------------------------------------------------
# Most populous square
# ---------------------------------------------------------------------------

def densest_square(raw: gpd.GeoDataFrame, max_buildings: int) -> Polygon:
    """Square (WGS84) holding the most night population with at most `max_buildings`."""
    utm = raw.estimate_utm_crs()
    pts = raw.to_crs(utm)
    x, y = pts.geometry.x.values, pts.geometry.y.values
    pop = (raw.pop2amu65.fillna(0) + raw.pop2amo65.fillna(0)).values

    x0, y0 = x.min(), y.min()
    nx = int((x.max() - x0) // WINDOW_BIN_M) + 1
    ny = int((y.max() - y0) // WINDOW_BIN_M) + 1
    ix = ((x - x0) // WINDOW_BIN_M).astype(int)
    iy = ((y - y0) // WINDOW_BIN_M).astype(int)
    count_grid = np.zeros((nx, ny))
    pop_grid = np.zeros((nx, ny))
    np.add.at(count_grid, (ix, iy), 1)
    np.add.at(pop_grid, (ix, iy), pop)

    def integral(g):
        s = np.zeros((g.shape[0] + 1, g.shape[1] + 1))
        s[1:, 1:] = g.cumsum(0).cumsum(1)
        return s

    sc, sp = integral(count_grid), integral(pop_grid)
    best = None  # (pop, k, i, j)
    for k in range(1, max(nx, ny) + 1):
        kx, ky = min(k, nx), min(k, ny)
        cnt = sc[kx:, ky:] - sc[:-kx, ky:] - sc[kx:, :-ky] + sc[:-kx, :-ky]
        pp = sp[kx:, ky:] - sp[:-kx, ky:] - sp[kx:, :-ky] + sp[:-kx, :-ky]
        pp = np.where(cnt <= max_buildings, pp, -1)
        if pp.max() < 0:
            break
        i, j = np.unravel_index(pp.argmax(), pp.shape)
        if best is None or pp[i, j] > best[0]:
            best = (pp[i, j], k, i, j)

    _, k, i, j = best
    square = box(x0 + i * WINDOW_BIN_M, y0 + j * WINDOW_BIN_M,
                 x0 + (i + k) * WINDOW_BIN_M, y0 + (j + k) * WINDOW_BIN_M)
    return gpd.GeoSeries([square], crs=utm).to_crs("EPSG:4326").iloc[0].envelope


# ---------------------------------------------------------------------------
# Footprints
# ---------------------------------------------------------------------------

def osm_building_outlines(rect: Polygon) -> gpd.GeoDataFrame:
    """OSM building polygons inside `rect` (cached by osmnx)."""
    _configure_osmnx()
    try:
        feats = ox.features_from_bbox(rect.bounds, tags={"building": True})
    except InsufficientResponseError:
        return gpd.GeoDataFrame(geometry=[], crs="EPSG:4326")
    feats = feats[feats.geometry.geom_type.isin(["Polygon", "MultiPolygon"])]
    feats = feats[["geometry"]].explode(index_parts=False).reset_index(drop=True)
    return feats.set_crs("EPSG:4326", allow_override=True)


def attach_footprints(records: list[dict], raw: gpd.GeoDataFrame, rect: Polygon) -> dict:
    """Fill `footprint` on every record in place. Returns match counts."""
    if not records:
        return {"osm": 0, "square": 0}

    utm = raw.estimate_utm_crs()
    pts = gpd.GeoDataFrame(
        {"i": range(len(records))},
        geometry=[Point(r["lon"], r["lat"]) for r in records],
        crs="EPSG:4326",
    ).to_crs(utm)

    outlines = osm_building_outlines(rect).to_crs(utm)
    outlines["area"] = outlines.area
    outlines["geometry"] = outlines.simplify(SIMPLIFY_M, preserve_topology=True)

    # A point inside several outlines takes the largest one.
    hits = gpd.sjoin(pts, outlines, how="inner", predicate="within")
    hits = hits.sort_values("area", ascending=False).drop_duplicates("i")
    outline_for = dict(zip(hits["i"], hits["index_right"]))

    osm_wgs = outlines.geometry.to_crs("EPSG:4326")
    for k, j in list(outline_for.items()):
        ring = _ring(osm_wgs.iloc[j])
        if ring is None:
            del outline_for[k]  # too small to draw; falls through to the NSI box below
        else:
            records[k]["footprint"] = ring

    # No OSM outline: NSI's building box (from the UBID in `bid`) scaled to NSI's footprint
    # area, keeping its center and proportions. No usable bid: a square of that area.
    missing = [k for k in range(len(records)) if k not in outline_for]
    sqft = raw["ftprntsqft"].to_numpy(dtype=float, na_value=np.nan)
    bids = raw["bid"].tolist()
    ubid_boxes = gpd.GeoSeries([ubid_box(bids[k]) for k in missing], crs="EPSG:4326").to_crs(utm)

    shapes, n_ubid, n_square = [], 0, 0
    for k, ub in zip(missing, ubid_boxes):
        area_m2 = (sqft[k] if np.isfinite(sqft[k]) and sqft[k] > 0 else 1.0) * SQFT_TO_M2
        if ub is not None and not ub.is_empty:
            minx, miny, maxx, maxy = ub.bounds
            cx, cy, w, h = (minx + maxx) / 2, (miny + maxy) / 2, maxx - minx, maxy - miny
            s = math.sqrt(area_m2 / (w * h))
            w, h = w * s, h * s
            n_ubid += 1
        else:
            c = pts.geometry.iloc[k]
            cx, cy = c.x, c.y
            w = h = math.sqrt(area_m2)
            n_square += 1
        shapes.append(box(cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2))

    for k, shape in zip(missing, gpd.GeoSeries(shapes, crs=utm).to_crs("EPSG:4326")):
        # A box too small to survive rounding keeps full precision instead.
        records[k]["footprint"] = _ring(shape) or [
            [round(x, 7), round(y, 7)] for x, y in list(shape.exterior.coords)[:-1]
        ]

    n = len(records)
    return {"osm": len(outline_for), "ubid_box": n_ubid, "square": n_square,
            "osm_share": round(len(outline_for) / n, 3), "ubid_share": round(n_ubid / n, 3)}


def ubid_box(bid) -> Polygon | None:
    """Axis-aligned footprint bounding box (WGS84) from an NSI `bid` (UBID), or None.

    UBID format: '<Open Location Code of the centroid>-<N>-<E>-<S>-<W>', where N/E/S/W are
    how many grid cells (the size of the centroid code's cell) the box extends each way.
    """
    if not isinstance(bid, str) or bid.count("-") < 4:
        return None
    try:
        code, n, e, s, w = bid.rsplit("-", 4)
        a = olc.decode(code)
    except ValueError:
        return None
    dh = a.latitudeHi - a.latitudeLo
    dw = a.longitudeHi - a.longitudeLo
    return box(a.longitudeLo - int(w) * dw, a.latitudeLo - int(s) * dh,
               a.longitudeHi + int(e) * dw, a.latitudeHi + int(n) * dh)


def _ring(poly: Polygon) -> list | None:
    """Exterior ring as [[lon, lat], ...] without repeating the first point.

    If simplifying or rounding made the ring invalid (self-crossing), use its convex hull,
    which is always valid and looks the same at map scale. Returns None if even the hull
    collapses (tiny outlines, after rounding).
    """
    coords = _rounded(list(poly.exterior.coords)[:-1])
    if _usable(coords):
        return [list(c) for c in coords]
    hull = Polygon(poly.exterior.coords).convex_hull
    if hull.geom_type != "Polygon":
        return None
    coords = _rounded(list(hull.exterior.coords)[:-1])
    return [list(c) for c in coords] if _usable(coords) else None


def _rounded(coords):
    return [(round(x, FOOTPRINT_DECIMALS), round(y, FOOTPRINT_DECIMALS)) for x, y in coords]


def _usable(coords) -> bool:
    if len(set(coords)) < 3:
        return False
    p = Polygon(coords)
    return p.is_valid and p.area > 0


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    p = argparse.ArgumentParser(description="Build places/<place_id>/ for a U.S. city.")
    p.add_argument("query", help='City name for OSM geocoding, e.g. "Lumberton, North Carolina, USA"')
    p.add_argument("--place-id", required=True)
    p.add_argument("--max-buildings", type=int, default=None)
    args = p.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(message)s")
    t0 = time.time()
    folder = build_place(args.query, args.place_id, args.max_buildings)

    recs = json.loads((folder / "buildings.json").read_text())
    cells = json.loads((folder / "cells.json").read_text())
    place = json.loads((folder / "place.json").read_text())
    print(json.dumps(summarize(recs), indent=1))
    print("cells", len(cells), "| empty", sum(1 for c in cells if c["pop_night"] == 0 and c["pop_day"] == 0))
    print("place", json.dumps(place))
    print("sizes KB", {f.name: round(f.stat().st_size / 1024) for f in sorted(folder.glob("*.json"))})
    print(f"{time.time() - t0:.1f}s")
