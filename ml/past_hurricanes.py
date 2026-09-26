"""Package past hurricanes for "replay a past disaster" (hurricane damage mode).

  python ml/past_hurricanes.py /path/to/places-checkout

Each event: the real HURDAT2 track (hurricane scenario rows [lon, lat, vmax_kt, rmw_km, B, time_h]), the town bbox for
Structures' build_place, NOAA's recorded deaths and property damage for the forecast zones covering the town, and the
reference result from ml/hurricane_damage.py on today's NSI buildings. Writes ml/past_events/<id>.json.
"""
import json
import os
import sys

import polars as pl

import hurricane_damage as hd
import hurricane_wind as hw
from common import PROCESSED, ROOT

OUT = ROOT / "ml" / "past_events"
LITE = ROOT / "data" / "past_places"
EVENTS = {
    "michael_mexico_beach_2018": {
        "title": "Mexico Beach, Florida", "subtitle": "Hurricane Michael, Category 5 landfall, October 10, 2018, about 1:30 PM",
        "storm": ("MICHAEL", 2018), "window": ("201810101200", "201810110600"), "hour": 13,
        "bbox": [-85.47, 29.90, -85.33, 29.99], "state": "FLORIDA", "zones": ["COASTAL BAY", "COASTAL GULF"],
        "dates": ("2018-10-09", "2018-10-12")},
    "florence_wilmington_2018": {
        "title": "Wilmington, North Carolina", "subtitle": "Hurricane Florence, Category 1 landfall, September 14, 2018, about 7:15 AM",
        "storm": ("FLORENCE", 2018), "window": ("201809140000", "201809151200"), "hour": 7,
        "bbox": [-77.975, 34.19, -77.885, 34.26], "state": "NORTH CAROLINA", "zones": ["INLAND NEW HANOVER", "COASTAL NEW HANOVER"],
        "dates": ("2018-09-13", "2018-09-17")},
}
HURRICANE_TYPES = ["Hurricane (Typhoon)", "Tropical Storm", "High Wind", "Strong Wind", "Storm Surge/Tide"]


def recorded(cfg):
    ev = pl.read_parquet(PROCESSED / "events.parquet").filter(
        (pl.col("state") == cfg["state"]) & pl.col("cz_name").is_in(cfg["zones"]) & pl.col("event_type").is_in(HURRICANE_TYPES)
        & pl.col("begin_time").dt.date().cast(pl.Utf8).is_between(pl.lit(cfg["dates"][0]), pl.lit(cfg["dates"][1])))
    return {"deaths_direct": int(ev["deaths_direct"].sum()), "deaths_indirect": int(ev["deaths_indirect"].sum()),
            "property_damage_usd": float(ev["damage_property_usd"].fill_null(0).sum()),
            "by_event_type": {r["event_type"]: {"deaths_direct": r["d"], "property_damage_usd": r["dmg"]} for r in
                              ev.group_by("event_type").agg(d=pl.col("deaths_direct").sum(), dmg=pl.col("damage_property_usd").fill_null(0).sum()).iter_rows(named=True)},
            "zones": cfg["zones"], "source": "NOAA Storm Events", "noaa_event_ids": ev["event_id"].to_list()}


def main():
    sys.path.insert(0, sys.argv[1])
    from places.fetch_nsi import fetch_buildings, write_place_lite
    params = json.loads((ROOT / "sim/params/sim_params.json").read_text())
    mortality = json.loads((ROOT / "ml/exports/hurricane_mortality.json").read_text())
    storms = hw.parse_hurdat(); coef, _ = hw.rmw_regression(storms)
    OUT.mkdir(parents=True, exist_ok=True)
    for pid, cfg in EVENTS.items():
        if not (LITE / pid / "buildings.json").exists():
            write_place_lite(tuple(cfg["bbox"]), pid, LITE)
        b = json.loads((LITE / pid / "buildings.json").read_text())
        fp = {f"nsi_{int(r.fd_id)}": r.ftprntsqft for r in fetch_buildings(tuple(cfg["bbox"])).itertuples()}
        track = hw.storm_track(hw.find_storm(storms, *cfg["storm"]), coef, *cfg["window"])
        sim = hd.summarize(cfg["title"], b, track, params, mortality, fp)
        doc = {"id": pid, "title": cfg["title"], "subtitle": cfg["subtitle"], "hazard": "hurricane",
               "recorded": recorded(cfg),
               "scenario": {"place_id": pid, "hazard": "hurricane", "track": track, "hour": cfg["hour"], "protections": [],
                            "runs": 500, "seed": 42},
               "track_source": {"name": "NOAA HURDAT2 best track", "storm": f"{cfg['storm'][0]} {cfg['storm'][1]}",
                                "window_utc": cfg["window"], "points": len(track)},
               "bbox_for_build_place": cfg["bbox"], "build_bbox": cfg["bbox"],
               "reference_result": {k: sim[k] for k in ("residents", "gust_mph_p10_p50_p90", "displaced", "destroyed",
                                                          "expected_deaths", "band_counts", "by_class")},
               "reference_shelters": sim.get("shelter_candidates", [])[:5],
               "notes": ["Hurricane mode shows wind damage and displacement. Storm surge, rain flooding and falling trees are not modeled.",
                         "Recorded deaths and property damage are NOAA totals for the forecast zones listed, which are larger than the town box.",
                         "Buildings and populations are today's NSI records."]}
        (OUT / f"{pid}.json").write_text(json.dumps(doc, indent=1))
        r = doc["recorded"]
        print(f"{pid}: {len(track)} track points | sim: residents {sim['residents']:,}, displaced {sim['displaced']:,.0f}, destroyed "
              f"{sim['destroyed']:,.0f}, gust {sim['gust_mph_p10_p50_p90']} | NOAA: deaths {r['deaths_direct']} direct, "
              f"${r['property_damage_usd'] / 1e6:,.0f}M property damage {list(r['by_event_type'])}")


if __name__ == "__main__":
    main()
