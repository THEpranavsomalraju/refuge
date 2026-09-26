"""Package the historical disasters for the game's "replay a past disaster" mode.

  python ml/past_events.py

For each event: the NWS Damage Assessment Toolkit surveyed track (the real curved path), EF rating,
width, local hour, NOAA recorded deaths and where they happened, a bbox for Structures' build_place,
and NOAA's narrative. Writes ml/past_events/<id>.json (committed; the game hardcodes these scenarios).

Chosen because the calibrated simulator's range on the surveyed track contains the recorded deaths:
  Estill, SC 2020 EF4:      4.3 expected (1-8) vs 5 recorded
  Valley View, TX 2024 EF3: 3.7 expected (1-7) vs 7 recorded
NC tornado candidates replayed poorly (Brunswick 2021: 0.08 vs 3, deaths in houses; Bertie 2020: 0.3 vs 2);
Raleigh 2011 has no surveyed track. Helene / Morganton joins as the flood replay after the flood check.
"""
import json

import numpy as np
import polars as pl
import requests

from common import PROCESSED, ROOT
from heatmap_bands import building_expected

LITE_PLACES = ROOT / "data" / "past_places"  # corridor buildings from write_place_lite (see calibrate.prepare)

DAT = "https://services.dat.noaa.gov/arcgis/rest/services/nws_damageassessmenttoolkit/DamageViewer/FeatureServer/1/query"
OUT = ROOT / "ml" / "past_events"
WARNING_MIN = 10  # same fixed assumption as calibration and the backtest
BBOX_PAD_DEG = 0.02  # ~2 km around the damage corridor
FOCUS_HALF_M = 4000   # focus box = the 8 x 8 km window holding the most simulated deaths (a playable 3D town)

# NOAA event ids come from the stitched backtest list, so every county segment of the tornado is included.
EVENTS = {
    "estill_sc_2020": {"title": "Estill, South Carolina", "backtest_id": "bt_2020_889068", "short": "EF4 tornado, April 13, 2020, 6:10 AM"},
    "valley_view_tx_2024": {"title": "Valley View, Texas", "backtest_id": "bt_2024_1182278", "short": "EF3 tornado, May 25, 2024, 9:39 PM"},
}


def surveyed_track(rows):
    """The DAT line for this storm: same date window, inside the NOAA endpoints' box, most fatalities."""
    lons = rows["begin_lon"].to_list() + rows["end_lon"].to_list()
    lats = rows["begin_lat"].to_list() + rows["end_lat"].to_list()
    d0 = rows["begin_time"].min().date()
    where = f"stormdate >= TIMESTAMP '{d0} 00:00:00' - INTERVAL '1' DAY AND stormdate <= TIMESTAMP '{d0} 00:00:00' + INTERVAL '2' DAY"
    r = requests.get(DAT, params={"where": where, "geometry": f"{min(lons) - .05},{min(lats) - .05},{max(lons) + .05},{max(lats) + .05}",
                                  "geometryType": "esriGeometryEnvelope", "inSR": 4326, "spatialRel": "esriSpatialRelIntersects",
                                  "outFields": "*", "returnGeometry": "true", "outSR": 4326, "f": "json"}, timeout=60).json()
    feats = sorted(r.get("features", []), key=lambda f: -(f["attributes"].get("fatalities") or 0))
    if not feats:
        raise RuntimeError("no surveyed track found")
    f = feats[0]
    return f["attributes"], [[round(x, 5), round(y, 5)] for part in f["geometry"]["paths"] for x, y in part]


def focus_bbox(pid, scen):
    """8 x 8 km window with the most expected deaths from the calibrated sim on the surveyed track."""
    bfile = LITE_PLACES / pid / "buildings.json"
    if not bfile.exists():
        return None, None
    b = json.loads(bfile.read_text())
    params = json.loads((ROOT / "sim" / "params" / "sim_params.json").read_text())
    ed, _ = building_expected(b, scen, params)
    lon = np.array([x["lon"] for x in b]); lat = np.array([x["lat"] for x in b])
    kx, ky = 111320 * np.cos(np.radians(lat.mean())), 110540
    x, y = lon * kx, lat * ky
    best, best_i = -1.0, 0
    for i in np.flatnonzero(ed > 0):
        inside = (np.abs(x - x[i]) <= FOCUS_HALF_M) & (np.abs(y - y[i]) <= FOCUS_HALF_M)
        total = ed[inside].sum()
        if total > best:
            best, best_i = total, i
    dlon, dlat = FOCUS_HALF_M / kx, FOCUS_HALF_M / ky
    box = [round(lon[best_i] - dlon, 4), round(lat[best_i] - dlat, 4), round(lon[best_i] + dlon, 4), round(lat[best_i] + dlat, 4)]
    return box, round(float(best / ed.sum()), 3)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    ev = pl.read_parquet(PROCESSED / "events.parquet")
    fat = pl.read_parquet(PROCESSED / "fatalities.parquet")
    narr = pl.read_parquet(PROCESSED / "narratives.parquet")
    backtest = {r["place_id"]: r for r in json.loads((ROOT / "ml" / "backtest" / "tornadoes.json").read_text())["tornadoes"]}
    for pid, cfg in EVENTS.items():
        cfg["event_ids"] = backtest[cfg["backtest_id"]]["noaa_event_ids"]
        rows = ev.filter(pl.col("event_id").is_in(cfg["event_ids"])).sort("begin_time")
        if rows.height != len(cfg["event_ids"]):
            raise RuntimeError(f"{pid}: expected {len(cfg['event_ids'])} NOAA rows, got {rows.height}")
        first = rows.row(0, named=True)
        attrs, path = surveyed_track(rows)
        ef = int(attrs["efscale"][-1]) if str(attrs.get("efscale", "")).startswith("EF") else int(rows["ef_rating"].max())
        width_m = round((attrs.get("width") or rows["tor_width_yd"].max()) * 0.9144, 1)
        deaths = int(rows["deaths_direct"].sum())
        f = fat.filter(pl.col("event_id").is_in(cfg["event_ids"]) & (pl.col("fatality_type") == "D"))
        lon = [p[0] for p in path]; lat = [p[1] for p in path]
        text = [n for n in narr.filter(pl.col("event_id").is_in(cfg["event_ids"]))["event_narrative"].to_list() if n]
        doc = {
            "id": pid, "title": cfg["title"], "subtitle": cfg["short"], "hazard": "tornado",
            "date_local": str(first["begin_time_local"]), "state": first["state"].title(),
            "counties": sorted({c for c in rows["county_fips"].to_list() if c}),
            "recorded": {"deaths_direct": deaths, "injuries_direct": int(rows["injuries_direct"].sum()),
                         "death_locations": dict(f.group_by("location_raw").len().iter_rows()),
                         "source": "NOAA Storm Events", "noaa_event_ids": cfg["event_ids"]},
            "scenario": {"place_id": pid, "hazard": "tornado", "ef": ef, "path": path, "width_m": width_m, "flood_height_m": None,
                         "hour": int(first["hour"]), "warning_min": WARNING_MIN, "protections": [], "runs": 500, "seed": 42},
            "path_source": {"name": "NWS Damage Assessment Toolkit surveyed track", "points": len(path),
                            "length_mi": attrs.get("length"), "max_width_yd": attrs.get("width"), "efscale": attrs.get("efscale"),
                            "fatalities": attrs.get("fatalities")},
            "bbox_for_build_place": [round(min(lon) - BBOX_PAD_DEG, 4), round(min(lat) - BBOX_PAD_DEG, 4),
                                     round(max(lon) + BBOX_PAD_DEG, 4), round(max(lat) + BBOX_PAD_DEG, 4)],
            "noaa_narrative": text,
            "notes": ["Width is the surveyed maximum, applied along the whole path.",
                      f"Warning time is the fixed {WARNING_MIN}-minute assumption used everywhere, not this storm's actual lead time.",
                      "Buildings and populations are today's NSI records, not the town as it was on the storm date."],
        }
        doc["focus_bbox_for_build_place"], doc["focus_share_of_simulated_deaths"] = focus_bbox(pid, doc["scenario"])
        doc["build_bbox"] = doc["focus_bbox_for_build_place"] or doc["bbox_for_build_place"]   # the box Structures builds
        (OUT / f"{pid}.json").write_text(json.dumps(doc, indent=1))
        print(f"  wrote ml/past_events/{pid}.json: EF{ef}, {len(path)} path points, width {width_m} m, hour {first['hour']}, "
              f"deaths {deaths} {doc['recorded']['death_locations']}, bbox {doc['bbox_for_build_place']}")


if __name__ == "__main__":
    main()
