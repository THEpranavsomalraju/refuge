"""OSM roads and low-water crossings for a featured place.

    roads = fetch_roads(rect)
    crossings = find_crossings(roads, terrain, rect, area, traffic)   # crossings.json records
    lines = road_lines(roads, rect, terrain.utm)                      # place.json "roads"

A low-water crossing is a point where a non-bridge road crosses a stream and the road sits
within MAX_CROSSING_HAND_M of the stream bed. Motorways, trunk roads, and service roads are
never crossings (see NOT_CROSSINGS). The DEM is bare earth: bridge decks are
removed (so bridges are excluded by their OSM tag), but culvert embankments remain, so the
road elevation is the DEM at the crossing and the stream elevation is the lowest DEM value
along the stream within STREAM_BED_RADIUS_M of it.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

import geopandas as gpd
import h3
import numpy as np
import osmnx as ox
import pandas as pd
import shapely
from osmnx._errors import InsufficientResponseError
from scipy.spatial import cKDTree
from shapely.geometry import Polygon

from places.fetch_nsi import H3_RES
from places.terrain import Terrain, sample_dem, stream_points

log = logging.getLogger(__name__)

TRAFFIC_PATH = Path(__file__).resolve().parent.parent / "ml" / "exports" / "traffic_by_hour.json"

MAX_CROSSING_HAND_M = 3.0
STREAM_BED_RADIUS_M = 50
MERGE_RADIUS_M = 30        # crossings of one stream by one road closer than this are one crossing
LINE_SIMPLIFY_M = 5
LINE_DECIMALS = 5

# OSM highway tags fetched, and the traffic class each one uses (ML lead's table keys).
ROAD_CLASS = {
    "motorway": "motorway", "motorway_link": "motorway",
    "trunk": "trunk", "trunk_link": "trunk",
    "primary": "primary", "primary_link": "primary",
    "secondary": "secondary", "secondary_link": "secondary",
    "tertiary": "tertiary", "tertiary_link": "tertiary",
    "unclassified": "unclassified",
    "residential": "residential", "living_street": "residential",
    "service": "service",
}
# Classes never counted as low-water crossings (still drawn): limited-access highways are
# engineered above normal flood levels and can't be gated; service roads are driveways,
# parking-lot lanes, and alleys with few cars.
NOT_CROSSINGS = {"motorway", "trunk", "service"}
# Higher first: when merging nearby crossings, the busier road's class is kept.
CLASS_RANK = ["motorway", "trunk", "primary", "secondary", "tertiary", "unclassified",
              "residential", "service"]


def load_traffic(path: Path | str | None = None) -> dict:
    """The ML lead's traffic_by_hour.json (ml/exports/ by default)."""
    with open(path or TRAFFIC_PATH, encoding="utf-8") as f:
        return json.load(f)


def fetch_roads(rect: Polygon) -> gpd.GeoDataFrame:
    """OSM drivable road lines in `rect` with columns cls, name, bridge (cached by osmnx)."""
    try:
        feats = ox.features_from_bbox(rect.bounds, tags={"highway": list(ROAD_CLASS)})
    except InsufficientResponseError:
        return gpd.GeoDataFrame({"cls": [], "name": [], "bridge": []}, geometry=[], crs=4326)
    feats = feats[feats.geometry.geom_type.isin(["LineString", "MultiLineString"])]
    feats = feats[feats["highway"].isin(ROAD_CLASS)]
    out = gpd.GeoDataFrame(
        {
            "cls": feats["highway"].map(ROAD_CLASS),
            "name": _col(feats, "name").fillna(_col(feats, "ref")),
            "bridge": _col(feats, "bridge").fillna("no").ne("no"),
        },
        geometry=feats.geometry.values,
        crs=4326,
    )
    return out.explode(index_parts=False).reset_index(drop=True)


def _col(df, name):
    return df[name] if name in df.columns else pd.Series(None, index=df.index, dtype=object)


def find_crossings(roads: gpd.GeoDataFrame, terrain: Terrain, rect: Polygon, area: str,
                   traffic: dict) -> list[dict]:
    """Low-water crossings as crossings.json records (plus an "h3" key)."""
    streams = terrain.streams
    if not len(roads) or not len(streams):
        return []
    utm = terrain.utm
    r = roads[~roads["bridge"] & ~roads["cls"].isin(NOT_CROSSINGS)].to_crs(utm).reset_index(drop=True)
    s = streams.to_crs(utm).reset_index(drop=True)

    # Every road-stream intersection point.
    pairs = gpd.sjoin(r[["geometry"]], s[["geometry"]], predicate="intersects")
    pts, road_idx, stream_idx = [], [], []
    for ri, si in zip(pairs.index, pairs["index_right"]):
        inter = r.geometry.iloc[ri].intersection(s.geometry.iloc[si])
        for p in shapely.get_parts(inter):
            if p.geom_type == "Point":
                pts.append(p)
                road_idx.append(ri)
                stream_idx.append(si)
    if not pts:
        return []

    # Merge crossings of the same stream closer than MERGE_RADIUS_M, keeping the busiest road.
    rank = np.array([CLASS_RANK.index(r["cls"].iloc[i]) for i in road_idx])
    order = np.argsort(rank, kind="stable")
    xy = np.array([[p.x, p.y] for p in pts])
    tree = cKDTree(xy)
    taken = np.zeros(len(pts), bool)
    keep = []
    for i in order:
        if taken[i]:
            continue
        near = tree.query_ball_point(xy[i], MERGE_RADIUS_M)
        near = [j for j in near if stream_idx[j] == stream_idx[i]]
        taken[near] = True
        keep.append(i)

    # Elevations: road = DEM at the crossing; stream bed = lowest DEM along the stream nearby.
    keep_pts = gpd.GeoSeries([pts[i] for i in keep], crs=utm).to_crs(4326)
    lon, lat = keep_pts.x.values, keep_pts.y.values
    road_z = sample_dem(terrain.dem, lon, lat)

    s_lon, s_lat = stream_points(streams, utm)
    s_z = sample_dem(terrain.dem, s_lon, s_lat)
    to_utm = gpd.GeoSeries(gpd.points_from_xy(s_lon, s_lat), crs=4326).to_crs(utm)
    s_tree = cKDTree(np.column_stack([to_utm.x.values, to_utm.y.values]))
    bed_z = np.array([
        np.nanmin(s_z[idx]) if (idx := s_tree.query_ball_point(xy[i], STREAM_BED_RADIUS_M)) else np.nan
        for i in keep
    ])
    hand = road_z - bed_z

    curve = traffic["curves"][f"weekday_{area}"]["share"]
    volumes = traffic["daily_volume_by_osm_tag"][area]

    out = []
    inside = shapely.covers(rect, keep_pts.values)
    for k, i in enumerate(keep):
        if not inside[k] or not np.isfinite(hand[k]) or hand[k] > MAX_CROSSING_HAND_M:
            continue
        cls = r["cls"].iloc[road_idx[i]]
        name = r["name"].iloc[road_idx[i]]
        daily = volumes[cls]
        out.append({
            "lon": round(float(lon[k]), 6),
            "lat": round(float(lat[k]), 6),
            "h3": h3.latlng_to_cell(float(lat[k]), float(lon[k]), H3_RES),
            "road_name": name if isinstance(name, str) else None,
            "road_class": cls,
            "road_elev_m": round(float(road_z[k]), 2),
            "hand_m": round(float(max(hand[k], 0.0)), 2),
            "cars_per_hour": [round(daily * share, 1) for share in curve],
        })

    out.sort(key=lambda c: (c["lon"], c["lat"]))
    records = [{"id": f"x_{n}", **c} for n, c in enumerate(out)]
    log.info("crossings: %d road-stream intersections, %d after merging, %d low-water (<= %.0f m)",
             len(pts), len(keep), len(records), MAX_CROSSING_HAND_M)
    return records


def road_lines(roads: gpd.GeoDataFrame, rect: Polygon, utm) -> list:
    """Roads clipped to `rect`, simplified, as [{"class": ..., "line": [[lon, lat], ...]}, ...]."""
    if not len(roads):
        return []
    clipped = roads.clip(rect)
    clipped = clipped[~clipped.geometry.is_empty]
    simple = clipped.set_geometry(clipped.to_crs(utm).simplify(LINE_SIMPLIFY_M).to_crs(4326))
    out = []
    for cls, geom in zip(simple["cls"], simple.geometry):
        for part in shapely.get_parts(geom):
            if part.geom_type != "LineString" or len(part.coords) < 2:
                continue
            out.append({"class": cls,
                        "line": [[round(x, LINE_DECIMALS), round(y, LINE_DECIMALS)] for x, y in part.coords]})
    return out
