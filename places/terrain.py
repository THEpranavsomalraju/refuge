"""Elevation, streams, and height above nearest drainage (hand_m) for a featured place.

All elevations come from one DEM (USGS 3DEP, 10 m), so building ground elevation,
stream elevation, cell elevation, and the baked terrain for the 3D scene agree.

    terrain = load_terrain(rect)
    add_terrain(records, cells, rect, folder, terrain) -> dict for place.json

Streams are NHDPlus medium resolution (named creeks and rivers). hand_m is the simple
nearest-stream version: building ground elevation minus the elevation of the nearest
stream point, clipped at 0.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from pathlib import Path

# HyRiver caches web responses; keep that cache in the repo's gitignored data/ folder.
_CACHE = Path(__file__).resolve().parent.parent / "data" / "cache" / "hyriver"
_CACHE.mkdir(parents=True, exist_ok=True)
os.environ.setdefault("HYRIVER_CACHE_NAME", str(_CACHE / "aiohttp_cache.sqlite"))

import geopandas as gpd  # noqa: E402
import numpy as np  # noqa: E402
import py3dep  # noqa: E402
import pynhd  # noqa: E402
import shapely  # noqa: E402
import xarray as xr  # noqa: E402
from pyproj import Transformer  # noqa: E402
from scipy.spatial import cKDTree  # noqa: E402
from shapely.geometry import Polygon  # noqa: E402

log = logging.getLogger(__name__)

DEM_RES_M = 10
STREAM_MARGIN_M = 2000     # streams just outside the rectangle still count as "nearest"
STREAM_STEP_M = 10         # stream lines are sampled every 10 m
TERRAIN_MAX_SIDE = 512     # baked terrain grid, samples along the longer side
LINE_SIMPLIFY_M = 5        # stream lines drawn in the scene
LINE_DECIMALS = 5


@dataclass
class Terrain:
    """DEM, stream lines, and the local UTM CRS for one place, loaded once and shared."""
    dem: xr.DataArray
    streams: gpd.GeoDataFrame
    utm: object


def load_terrain(rect: Polygon, streams: bool = True) -> Terrain:
    """3DEP DEM and (unless streams=False) NHDPlus MR streams for `rect` plus
    STREAM_MARGIN_M, cached by HyRiver. Without streams, hand_m stays null."""
    utm = gpd.GeoSeries([rect], crs="EPSG:4326").estimate_utm_crs()
    fetch_area = gpd.GeoSeries([rect], crs=4326).to_crs(utm).buffer(STREAM_MARGIN_M).to_crs(4326).iloc[0]
    dem = py3dep.get_dem(fetch_area.bounds, resolution=DEM_RES_M)
    streams = fetch_streams(fetch_area.bounds) if streams else gpd.GeoDataFrame(geometry=[], crs=4326)
    return Terrain(dem=dem, streams=streams, utm=utm)


def add_terrain(records: list[dict], cells: list[dict], rect: Polygon, folder: Path,
                terrain: Terrain) -> dict:
    """Fill ground_elev_m and hand_m on records, ground_elev_m on cells, write terrain.bin.

    Returns {"terrain_source": {...}, "streams": [[[lon, lat], ...], ...]} for place.json.
    """
    dem, streams, utm = terrain.dem, terrain.streams, terrain.utm

    # Buildings and cells: DEM at their point.
    b_lon = np.array([r["lon"] for r in records])
    b_lat = np.array([r["lat"] for r in records])
    ground = sample_dem(dem, b_lon, b_lat)
    for r, z in zip(records, ground):
        r["ground_elev_m"] = _round(z)

    c_lon = np.array([c["center"][0] for c in cells])
    c_lat = np.array([c["center"][1] for c in cells])
    for c, z in zip(cells, sample_dem(dem, c_lon, c_lat)):
        c["ground_elev_m"] = _round(z)

    # hand_m: ground minus the elevation of the nearest stream point.
    if len(streams):
        s_lon, s_lat = stream_points(streams, utm)
        s_z = sample_dem(dem, s_lon, s_lat)
        ok = np.isfinite(s_z)
        to_utm = Transformer.from_crs(4326, utm, always_xy=True)
        sx, sy = to_utm.transform(s_lon[ok], s_lat[ok])
        bx, by = to_utm.transform(b_lon, b_lat)
        dist, idx = cKDTree(np.column_stack([sx, sy])).query(np.column_stack([bx, by]))
        hand = np.clip(ground - s_z[ok][idx], 0, None)
        for r, h in zip(records, hand):
            r["hand_m"] = _round(h)
        log.info("hand_m: median %.1f m, nearest stream median %.0f m", np.nanmedian(hand), np.median(dist))
    else:
        log.info("no streams for this place; hand_m stays null")

    terrain = bake_terrain(dem, rect, folder / "terrain.bin")
    return {"terrain_source": terrain, "streams": stream_lines(streams, rect, utm)}


def fetch_streams(bounds) -> gpd.GeoDataFrame:
    """NHDPlus medium-resolution flowlines in `bounds` (WGS84), lines only."""
    try:
        fl = pynhd.WaterData("nhdflowline_network").bybox(tuple(bounds))
    except Exception as e:  # the service returns an error when the box has no flowlines
        log.warning("no NHDPlus flowlines returned: %s", e)
        return gpd.GeoDataFrame(geometry=[], crs=4326)
    fl = fl.to_crs(4326)
    fl = fl[fl.geometry.notna() & ~fl.geometry.is_empty]
    return fl.explode(index_parts=False).reset_index(drop=True)


def stream_points(streams: gpd.GeoDataFrame, utm) -> tuple[np.ndarray, np.ndarray]:
    """Points every STREAM_STEP_M along all stream lines, as (lon, lat) arrays."""
    lines = streams.to_crs(utm).geometry.values
    dense = shapely.segmentize(lines, STREAM_STEP_M)
    xy = shapely.get_coordinates(dense)
    to_wgs = Transformer.from_crs(utm, 4326, always_xy=True)
    lon, lat = to_wgs.transform(xy[:, 0], xy[:, 1])
    return np.asarray(lon), np.asarray(lat)


def sample_dem(dem: xr.DataArray, lon: np.ndarray, lat: np.ndarray) -> np.ndarray:
    """Bilinear DEM value (m) at each lon/lat; NaN outside the DEM."""
    if len(lon) == 0:
        return np.array([])
    to_dem = Transformer.from_crs(4326, dem.rio.crs, always_xy=True)
    x, y = to_dem.transform(lon, lat)
    vals = dem.interp(x=xr.DataArray(x, dims="p"), y=xr.DataArray(y, dims="p"), method="linear")
    return np.asarray(vals.values, dtype=float)


def bake_terrain(dem: xr.DataArray, rect: Polygon, path: Path) -> dict:
    """Write a lon/lat grid of elevations over `rect` as little-endian float32.

    Row-major, first row = north edge, first column = west edge; rows and columns include
    both edges of the rectangle.
    """
    min_lon, min_lat, max_lon, max_lat = rect.bounds
    mid_lat = np.radians((min_lat + max_lat) / 2)
    w_m = (max_lon - min_lon) * 111_320 * np.cos(mid_lat)
    h_m = (max_lat - min_lat) * 110_900
    if w_m >= h_m:
        width, height = TERRAIN_MAX_SIDE, max(2, round(TERRAIN_MAX_SIDE * h_m / w_m))
    else:
        width, height = max(2, round(TERRAIN_MAX_SIDE * w_m / h_m)), TERRAIN_MAX_SIDE

    lons = np.linspace(min_lon, max_lon, width)
    lats = np.linspace(max_lat, min_lat, height)
    glon, glat = np.meshgrid(lons, lats)
    z = sample_dem(dem, glon.ravel(), glat.ravel())
    if np.isnan(z).any():
        z = np.where(np.isnan(z), np.nanmin(z), z)

    path.write_bytes(z.astype("<f4").tobytes())
    return {
        "file": path.name,
        "format": "float32-le, row-major, first row north, first column west",
        "width": int(width),
        "height": int(height),
        "bbox": [round(v, 6) for v in rect.bounds],
        "min_m": _round(float(z.min())),
        "max_m": _round(float(z.max())),
        "source": f"USGS 3DEP {DEM_RES_M} m, resampled",
    }


def stream_lines(streams: gpd.GeoDataFrame, rect: Polygon, utm) -> list:
    """Stream lines clipped to `rect` and simplified, as [[[lon, lat], ...], ...]."""
    if not len(streams):
        return []
    clipped = streams.clip(rect)
    clipped = clipped[~clipped.geometry.is_empty]
    simple = clipped.to_crs(utm).simplify(LINE_SIMPLIFY_M).to_crs(4326)
    out = []
    for geom in simple.explode(index_parts=False):
        if geom.geom_type != "LineString" or len(geom.coords) < 2:
            continue
        out.append([[round(x, LINE_DECIMALS), round(y, LINE_DECIMALS)] for x, y in geom.coords])
    return out


def _round(v, nd=2):
    return None if v is None or not np.isfinite(v) else round(float(v), nd)
