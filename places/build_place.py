"""Build a place folder for any U.S. city.

    python -m places.build_place "Lumberton, North Carolina, USA" --place-id lumberton --area rural
    python -m places.build_place "Wilmington, North Carolina, USA" --place-id wilmington_north_carolina \\
        --area urban --max-buildings 20000 --out-dir data/places

The build service (places/server.py) calls build_place() for cities typed into the app.

Steps:
  1. City limits from OpenStreetMap; the place is the bounding rectangle of the limits.
  2. If --max-buildings is set and the rectangle holds more, keep the square that holds
     the most people at night with at most that many buildings.
  3. Buildings from fetch_buildings + to_building_records (same conversion as the backtest).
  4. Footprints: the OSM building outline each NSI point falls inside, simplified. Buildings
     without one get NSI's own building box (decoded from `bid`) scaled to NSI's footprint
     area (ftprntsqft); if `bid` is empty, a square of that area.
  5. Terrain (terrain.py): 3DEP ground elevation for buildings and cells, NHD streams,
     hand_m, a baked terrain.bin for the 3D scene, and stream lines for place.json.
  6. Writes places/<place_id>/ buildings.json, cells.json (every H3 cell in the rectangle,
     empty ones included), place.json, terrain.bin, crossings.json ([] until roads are in).
"""

from __future__ import annotations

import argparse
import json
import logging
import math
import time
from collections import Counter
from contextlib import contextmanager
from pathlib import Path

import geopandas as gpd
import h3
import numpy as np
import osmnx as ox
from openlocationcode import openlocationcode as olc
import requests
from osmnx._errors import InsufficientResponseError, ResponseStatusCodeError
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
from places.roads import empty_roads, fetch_roads, find_crossings, load_traffic, road_lines
from places.terrain import add_terrain, load_terrain

log = logging.getLogger(__name__)

PLACES_DIR = Path(__file__).resolve().parent
OSM_CACHE_DIR = PLACES_DIR.parent / "data" / "cache" / "osmnx"

SQFT_TO_M2 = 0.09290304
SIMPLIFY_M = 2.0          # outline simplification tolerance, meters
WINDOW_BIN_M = 100        # grid resolution for the most-populous-square search
FOOTPRINT_DECIMALS = 5    # ~1 m; footprint shapes are only drawn, never measured


# Cities built on demand (build service) go here; featured towns live in places/.
GENERATED_DIR = PLACES_DIR.parent / "data" / "places"
DEFAULT_MAX_BUILDINGS = 20_000
# Night population per km2 of the town rectangle above which a city is suggested as urban.
# Our towns: Morganton 202, Lumberton 173, Chapel Hill 1,023.
URBAN_DENSITY_PER_KM2 = 500
# Places larger than this (km2) list only cells that contain buildings, so cells.json stays
# small (a 1,300 km2 storm-path box would otherwise need about 90,000 cells).
FULL_CELLS_MAX_KM2 = 250

STEPS = ["city limits", "buildings", "footprints", "elevation and streams",
         "roads and crossings", "cells", "writing files"]


def build_place(query: str, place_id: str, area: str | None = None, max_buildings: int | None = None,
                out_dir: Path | str = PLACES_DIR, traffic_path: Path | str | None = None,
                progress=None, bbox: tuple | None = None, flood: bool = True,
                kind: str = "featured") -> Path:
    """Build <out_dir>/<place_id>/ for the city named by `query` and return the folder.

    `bbox` (min_lon, min_lat, max_lon, max_lat) uses that box instead of geocoding the city
    limits; `query` is then only the display name. `flood=False` skips streams, hand_m, and
    crossings (tornado/hurricane only) but keeps the 3DEP ground. `area` ("rural"/"urban")
    picks crossing traffic and is only needed when flood=True. `kind` is recorded in the
    index ("featured", "past_event", "generated").
    `progress(step)` is called with each name in STEPS as the build reaches it.
    The place is also added to <out_dir>/index.json.
    """
    if flood and area not in ("rural", "urban"):
        raise ValueError('area must be "rural" or "urban" when flood layers are built')
    say = progress or (lambda step: None)
    traffic = load_traffic(traffic_path) if flood else None
    _configure_osmnx()

    say("city limits")
    if bbox is not None:
        rect = box(*bbox)
    else:
        limits = ox.geocode_to_gdf(query)
        rect = box(*limits.geometry.iloc[0].bounds)

    say("buildings")
    raw = fetch_buildings(rect)
    trimmed = False
    if max_buildings is not None and len(raw) > max_buildings:
        rect = densest_square(raw, max_buildings)
        raw = fetch_buildings(rect)
        trimmed = True

    records = to_building_records(raw)
    say("footprints")
    stats = attach_footprints(records, raw, rect)

    say("elevation and streams")
    terrain = load_terrain(rect, streams=flood)
    say("roads and crossings")
    try:
        roads = with_overpass_retry(fetch_roads, rect)
        roads_pending = False
    except OverpassUnavailable as e:
        log.warning("roads unavailable (%s); building without roads and crossings", e)
        roads, roads_pending = empty_roads(), True
    crossings = find_crossings(roads, terrain, rect, area, traffic) if flood else []

    say("cells")
    rect_km2 = gpd.GeoSeries([rect], crs=4326).to_crs(gpd.GeoSeries([rect], crs=4326).estimate_utm_crs()).area.iloc[0] / 1e6
    full_cells = rect_km2 <= FULL_CELLS_MAX_KM2
    cover = set(h3.geo_to_cells(rect, H3_RES)) if full_cells else set()
    cover |= {c["h3"] for c in crossings}
    cells = cells_from_records(records, extra_cells=cover)
    if not full_cells:
        log.info("large place (%.0f km2): cells.json lists only cells with buildings", rect_km2)

    say("writing files")
    folder = Path(out_dir) / place_id
    folder.mkdir(parents=True, exist_ok=True)

    # 3DEP ground elevation, hand_m, terrain.bin, stream lines, road lines.
    place = place_record(rect, place_id, records, name=query)
    place.update(add_terrain(records, cells, rect, folder, terrain))
    place["roads"] = road_lines(roads, rect, terrain.utm)

    write_json(folder / "buildings.json", records)
    write_json(folder / "cells.json", cells)
    write_json(folder / "place.json", place)
    write_json(folder / "crossings.json", crossings)
    update_index(Path(out_dir), place, records, crossings, area, trimmed, roads_pending, kind, flood,
                 "full" if full_cells else "buildings")

    log.info("footprints: %s", stats)
    return folder


def slugify(query: str) -> str:
    """'Wilmington, North Carolina, USA' -> 'wilmington_north_carolina'."""
    parts = [p.strip() for p in query.split(",") if p.strip() and p.strip().lower() not in ("usa", "us", "united states")]
    return "_".join("".join(ch if ch.isalnum() else "_" for ch in p.lower()).strip("_") for p in parts)


def update_index(out_dir: Path, place: dict, records: list, crossings: list, area: str | None, trimmed: bool,
                 roads_pending: bool = False, kind: str = "featured", flood: bool = True,
                 cells: str = "full"):
    """Add or replace this place in <out_dir>/index.json (what the app's place picker lists)."""
    path = out_dir / "index.json"
    index = json.loads(path.read_text(encoding="utf-8")) if path.exists() else []
    index = [e for e in index if e["place_id"] != place["place_id"]]
    index.append({
        "place_id": place["place_id"],
        "name": place["name"],
        "county_fips": place["county_fips"],
        "bbox": place["bbox"],
        "center": place["center"],
        "buildings": len(records),
        "crossings": len(crossings),
        "pop_night": sum(r["pop_night_u65"] + r["pop_night_o65"] for r in records),
        "kind": kind,
        "flood_layers": flood,
        # "full": every cell in the box (empty ones included); "buildings": only cells with buildings.
        "cells": cells,
        "area": area,
        "trimmed": trimmed,
        # OSM was down during the build: no roads or crossings yet. Rebuilding the place
        # later fills them in (NSI, 3DEP, and NHD downloads are cached, so it is quick).
        "roads_pending": roads_pending,
        "built": time.strftime("%Y-%m-%d %H:%M"),
    })
    index.sort(key=lambda e: e["place_id"])
    path.write_text(json.dumps(index, indent=1), encoding="utf-8")


def suggest_place(query: str, max_buildings: int = DEFAULT_MAX_BUILDINGS) -> dict:
    """What building `query` would produce, before building it: size, density, and the
    suggested traffic area. Fetches NSI for the rectangle (cached, reused by the build)."""
    _configure_osmnx()
    limits = ox.geocode_to_gdf(query)
    row = limits.iloc[0]
    rect = box(*row.geometry.bounds)
    raw = fetch_buildings(rect)
    km2 = gpd.GeoSeries([rect], crs=4326).to_crs(gpd.GeoSeries([rect], crs=4326).estimate_utm_crs()).area.iloc[0] / 1e6
    night = int((raw["pop2amu65"].fillna(0) + raw["pop2amo65"].fillna(0)).sum()) if len(raw) else 0
    density = night / km2 if km2 else 0.0
    return {
        "query": query,
        "place_id": slugify(query),
        "display_name": row.get("display_name"),
        "bbox": [round(v, 6) for v in rect.bounds],
        "area_km2": round(km2, 1),
        "buildings": len(raw),
        "pop_night": night,
        "density_per_km2": round(density),
        "suggested_area": "urban" if density >= URBAN_DENSITY_PER_KM2 else "rural",
        "will_trim_to": max_buildings if len(raw) > max_buildings else None,
    }


def _configure_osmnx():
    ox.settings.cache_folder = str(OSM_CACHE_DIR)
    ox.settings.use_cache = True
    ox.settings.log_console = False


# Overpass (OSM) servers. The main server comes first so responses already in the osmnx
# cache (keyed by server URL and query text) are reused without a request.
OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api",
    "https://overpass.private.coffee/api",
]
OVERPASS_TRIES = 4
# Wait at most this long to open a connection. The server name has several addresses;
# when one stops answering, the connection moves on to the next address after this long
# instead of waiting the full osmnx timeout (which also stays in the query text, so the
# cache keeps matching).
OVERPASS_CONNECT_S = 10
# Retries split each query into tiles of about 4 x 4 km with a shorter server timeout.
RETRY_TILE_AREA_M2 = 16_000_000
RETRY_TIMEOUT_S = 90


@contextmanager
def _short_connect_timeout():
    """Give osmnx's requests a (connect, read) timeout while an Overpass query runs."""
    orig_get, orig_post = requests.get, requests.post

    def wrap(fn):
        def call(*args, timeout=None, **kwargs):
            if isinstance(timeout, (int, float)):
                timeout = (OVERPASS_CONNECT_S, timeout)
            return fn(*args, timeout=timeout, **kwargs)
        return call

    requests.get, requests.post = wrap(orig_get), wrap(orig_post)
    try:
        yield
    finally:
        requests.get, requests.post = orig_get, orig_post


class OverpassUnavailable(RuntimeError):
    """Every Overpass attempt failed; the caller falls back instead of stopping the build."""


def with_overpass_retry(fn, *args):
    """Call an osmnx Overpass query, retrying on timeouts, dropped connections, and
    busy-server responses.

    Attempt 1 uses the main server and osmnx defaults, so earlier cached responses match.
    Later attempts start with the mirror and split the query into small tiles
    (RETRY_TILE_AREA_M2) with a shorter timeout: busy servers answer small queries.
    Raises OverpassUnavailable when every attempt fails.
    """
    last = None
    defaults = (ox.settings.max_query_area_size, ox.settings.requests_timeout)
    try:
        with _short_connect_timeout():
            for attempt in range(1, OVERPASS_TRIES + 1):
                if attempt == 1:
                    ox.settings.overpass_url = OVERPASS_ENDPOINTS[0]
                else:
                    # retries start on the mirror, then alternate: 2 mirror, 3 main, 4 mirror
                    ox.settings.overpass_url = OVERPASS_ENDPOINTS[(attempt - 1) % len(OVERPASS_ENDPOINTS)]
                    ox.settings.max_query_area_size = RETRY_TILE_AREA_M2
                    ox.settings.requests_timeout = RETRY_TIMEOUT_S
                try:
                    return fn(*args)
                except (requests.exceptions.ConnectionError, requests.exceptions.Timeout,
                        ResponseStatusCodeError) as e:
                    last = e
                    log.warning("Overpass %s failed on attempt %d of %d (%s: %s)",
                                ox.settings.overpass_url, attempt, OVERPASS_TRIES,
                                type(e).__name__, str(e)[:120])
                    if attempt < OVERPASS_TRIES:
                        time.sleep(min(20, 2 ** attempt))
        raise OverpassUnavailable(f"{type(last).__name__}: {last}")
    finally:
        ox.settings.overpass_url = OVERPASS_ENDPOINTS[0]
        ox.settings.max_query_area_size, ox.settings.requests_timeout = defaults


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

    try:
        outlines = with_overpass_retry(osm_building_outlines, rect).to_crs(utm)
    except OverpassUnavailable as e:
        log.warning("OSM outlines unavailable (%s); every building uses its NSI box", e)
        outlines = gpd.GeoDataFrame(geometry=[], crs=utm)
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
    p.add_argument("--area", choices=["rural", "urban"], default=None,
                   help="traffic volumes and hourly curve for crossings (needed unless --no-flood)")
    p.add_argument("--bbox", nargs=4, type=float, metavar=("MIN_LON", "MIN_LAT", "MAX_LON", "MAX_LAT"),
                   help="build this box instead of the city limits (query is then the display name)")
    p.add_argument("--no-flood", action="store_true", help="skip streams, hand_m, and crossings; keep the 3DEP ground")
    p.add_argument("--kind", default="featured", choices=["featured", "past_event", "generated"])
    p.add_argument("--max-buildings", type=int, default=None)
    p.add_argument("--traffic", default=None,
                   help="path to traffic_by_hour.json (default ml/exports/traffic_by_hour.json)")
    p.add_argument("--out-dir", default=str(PLACES_DIR),
                   help="where to write <place_id>/ (default places/; on-demand cities use data/places)")
    args = p.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(message)s")
    t0 = time.time()
    folder = build_place(args.query, args.place_id, args.area, args.max_buildings,
                         out_dir=args.out_dir, traffic_path=args.traffic,
                         progress=lambda step: log.info("step: %s", step),
                         bbox=tuple(args.bbox) if args.bbox else None, flood=not args.no_flood,
                         kind=args.kind)

    recs = json.loads((folder / "buildings.json").read_text())
    cells = json.loads((folder / "cells.json").read_text())
    place = json.loads((folder / "place.json").read_text())
    print(json.dumps(summarize(recs), indent=1))
    print("cells", len(cells), "| empty", sum(1 for c in cells if c["pop_night"] == 0 and c["pop_day"] == 0))
    print("place", json.dumps({k: v for k, v in place.items() if k != "streams"}))
    print("streams", len(place["streams"]), "lines | roads", len(place["roads"]), "lines")
    print("crossings", len(json.loads((folder / "crossings.json").read_text())))
    print("sizes KB", {f.name: round(f.stat().st_size / 1024) for f in sorted(folder.glob("*.json"))})
    print(f"{time.time() - t0:.1f}s")
