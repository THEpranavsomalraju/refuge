"""Pick the historical tornadoes for calibration and the backtest, and write sim scenarios.

  python ml/backtest_select.py

1. Stitch NOAA county segments back into whole tornadoes (end of one segment meets the start
   of the next within a few km and minutes, same episode).
2. Eligible: 2015-2025 (closer to the NSI 2025 building/population vintage), EF1+, begin/end
   coordinates and width on every segment, 1-80 km long, and it hit something (a death, an
   injury, or >= $250k damage).
3. Stratified sample: 40 fatal + 40 non-fatal, at most 6 per state. Each tornado carries
   weight = 1 / (selection probability of its stratum) so calibration stays representative.
4. Split: 30 held out (15 fatal, 15 non-fatal), 50 for calibration. Never tune on the 30.

Outputs
  ml/backtest/tornadoes.json               committed list with split, weight, path, recorded deaths
  data/backtest/scenarios/<place_id>.json  scenario files for sim/cli.ts
"""
import json

import numpy as np
import polars as pl

from common import PROCESSED, ROOT, STATE_FIPS_US, write_json

SEED = 2026
YEAR_MIN = 2015
N_PER_STRATUM = 40
N_TEST_PER_STRATUM = 15
MAX_PER_STATE = 6
MIN_DAMAGE_USD = 250_000
MAX_LENGTH_KM = 80
LINK_KM = 3.0          # segment end -> next segment start
LINK_MINUTES = (-2, 10)
# Placeholder until per-storm lead times from the IEM warning archive are wired in; stated in METHODS.md.
WARNING_MIN_DEFAULT = 10

# Storms kept in the list but left out of calibration/backtest scoring, with the reason (stated in METHODS.md).
EXCLUDE = {
    "bt_2021_996712": "All 6 deaths were in the Amazon DLI4 warehouse, which has no NSI record (Structures checked OSM).",
}

OUT_LIST = ROOT / "ml" / "backtest" / "tornadoes.json"
OUT_SCEN = ROOT / "data" / "backtest" / "scenarios"


def haversine_km(lat1, lon1, lat2, lon2):
    lat1, lon1, lat2, lon2 = map(np.radians, (lat1, lon1, lat2, lon2))
    a = np.sin((lat2 - lat1) / 2) ** 2 + np.cos(lat1) * np.cos(lat2) * np.sin((lon2 - lon1) / 2) ** 2
    return 6371.0 * 2 * np.arcsin(np.sqrt(a))


def stitch(seg):
    """Union segments into whole tornadoes. Returns seg with a tornado_id column."""
    seg = seg.sort("episode_id", "begin_time")
    ids = seg["event_id"].to_list()
    parent = {i: i for i in ids}

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    links = 0
    for _, g in seg.group_by("episode_id"):
        if g.height < 2:
            continue
        r = g.to_dict(as_series=False)
        bt = np.array(r["begin_time"], dtype="datetime64[m]")
        et = np.array(r["end_time"], dtype="datetime64[m]")
        blat, blon = np.array(r["begin_lat"], float), np.array(r["begin_lon"], float)
        elat, elon = np.array(r["end_lat"], float), np.array(r["end_lon"], float)
        for a in range(g.height):
            gap = (bt - et[a]).astype(int)
            dist = haversine_km(elat[a], elon[a], blat, blon)
            ok = (gap >= LINK_MINUTES[0]) & (gap <= LINK_MINUTES[1]) & (dist <= LINK_KM)
            ok[a] = False
            if ok.any():
                b = int(np.argmin(np.where(ok, dist, np.inf)))
                parent[find(r["event_id"][b])] = find(r["event_id"][a])
                links += 1
    seg = seg.with_columns(tornado_id=pl.Series([find(i) for i in ids]))
    return seg, links


def whole_tornadoes(seg):
    seg = seg.sort("tornado_id", "begin_time")
    return seg.group_by("tornado_id", maintain_order=True).agg(
        n_segments=pl.len(),
        event_ids=pl.col("event_id"),
        episode_id=pl.col("episode_id").first(),
        year=pl.col("year").first(),
        begin_time_local=pl.col("begin_time_local").first(),
        hour=pl.col("hour").first(),
        month=pl.col("month").first(),
        state=pl.col("state").first(),
        states=pl.col("state").unique(),
        county_fips=pl.col("county_fips"),
        ef=pl.col("ef_rating").max(),
        width_m=pl.col("tor_width_m").max(),
        length_km=pl.col("tor_length_km").sum(),
        deaths=pl.col("deaths_direct").sum(),
        injuries=pl.col("injuries_direct").sum(),
        damage_usd=pl.col("damage_property_usd").sum(),
        all_coords=pl.col("has_coords").all(),
        all_width=(pl.col("tor_width_yd") > 0).all(),
        # path = first begin point, then every segment end point, in time order
        start_lon=pl.col("begin_lon").first(),
        start_lat=pl.col("begin_lat").first(),
        end_lons=pl.col("end_lon"),
        end_lats=pl.col("end_lat"),
    )


def sample(eligible, rng):
    picked = []
    for fatal in (True, False):
        pool = eligible.filter((pl.col("deaths") > 0) == fatal)
        order = rng.permutation(pool.height)
        per_state, chosen = {}, []
        for i in order:
            st = pool["state"][int(i)]
            if per_state.get(st, 0) < MAX_PER_STATE:
                per_state[st] = per_state.get(st, 0) + 1
                chosen.append(int(i))
            if len(chosen) == N_PER_STRATUM:
                break
        s = pool[chosen].with_columns(
            stratum=pl.lit("fatal" if fatal else "nonfatal"),
            # inverse selection probability, so weighted sums estimate the eligible population
            weight=pl.lit(pool.height / len(chosen)),
            eligible_in_stratum=pl.lit(pool.height),
        )
        test = set(rng.choice(len(chosen), N_TEST_PER_STRATUM, replace=False).tolist())
        s = s.with_columns(split=pl.Series(["test" if i in test else "train" for i in range(len(chosen))]))
        picked.append(s)
    return pl.concat(picked)


def main():
    ev = pl.read_parquet(PROCESSED / "events.parquet")
    seg = ev.filter((pl.col("event_type") == "Tornado") & pl.col("state_fips").is_in(STATE_FIPS_US)
                    & (pl.col("year") >= YEAR_MIN))
    seg, links = stitch(seg)
    tor = whole_tornadoes(seg)
    marked = seg.filter(pl.col("tor_other_cz_fips").is_not_null())
    linked = marked.join(seg.group_by("tornado_id").len().filter(pl.col("len") > 1), on="tornado_id", how="semi")
    print(f"segments {seg.height:,} -> tornadoes {tor.height:,} ({links} links); "
          f"segments NOAA marks as continuing that got linked: {linked.height}/{marked.height} ({linked.height / max(marked.height, 1):.0%})")

    eligible = tor.filter(
        pl.col("ef").is_not_null() & (pl.col("ef") >= 1) & pl.col("all_coords") & pl.col("all_width")
        & pl.col("length_km").is_between(1, MAX_LENGTH_KM)
        & ((pl.col("deaths") > 0) | (pl.col("injuries") > 0) | (pl.col("damage_usd") >= MIN_DAMAGE_USD))
    )
    print(f"eligible: {eligible.height:,} ({(eligible['deaths'] > 0).sum()} fatal, {(eligible['deaths'] == 0).sum()} non-fatal)")

    chosen = sample(eligible, np.random.default_rng(SEED))
    chosen = chosen.with_columns(place_id=pl.format("bt_{}_{}", pl.col("year"), pl.col("tornado_id")))

    # deaths NOAA places outside buildings (vehicle, outdoors, water, other known). The tornado sim only
    # models people in buildings, so calibration compares against deaths_sim_target = deaths - these.
    fat = pl.read_parquet(PROCESSED / "fatalities.parquet").filter(
        (pl.col("fatality_type") == "D") & ~pl.col("location_unknown")
        & pl.col("location_class").is_in(["VEHICLE", "OUTDOOR", "WATER", "OTHER"]))
    outside = dict(fat.group_by("event_id").len().iter_rows())

    rows = []
    OUT_SCEN.mkdir(parents=True, exist_ok=True)
    for r in chosen.iter_rows(named=True):
        pts = [(r["start_lon"], r["start_lat"])] + list(zip(r["end_lons"], r["end_lats"]))
        path = [[round(lon, 5), round(lat, 5)] for lon, lat in pts]
        # rule: NOAA coordinates must describe the path. Drawn length under half the recorded length
        # (e.g. begin == end) means the sim would put the storm in the wrong place.
        drawn_km = sum(haversine_km(a[1], a[0], b[1], b[0]) for a, b in zip(path, path[1:]))
        if r["place_id"] not in EXCLUDE and drawn_km < 0.5 * r["length_km"]:
            EXCLUDE[r["place_id"]] = (f"NOAA begin/end points give a {drawn_km:.1f} km path vs "
                                      f"{r['length_km']:.1f} km recorded, so the path location is unknown.")
        rows.append({
            "place_id": r["place_id"], "split": r["split"], "stratum": r["stratum"], "weight": round(r["weight"], 4),
            "excluded": r["place_id"] in EXCLUDE, "exclude_reason": EXCLUDE.get(r["place_id"]),
            "year": r["year"], "begin_time_local": str(r["begin_time_local"]), "hour": r["hour"], "month": r["month"],
            "state": r["state"], "states": r["states"], "county_fips": r["county_fips"], "noaa_event_ids": r["event_ids"],
            "ef": r["ef"], "width_m": round(r["width_m"], 1), "length_km": round(r["length_km"], 2),
            "deaths": r["deaths"], "injuries": r["injuries"], "damage_usd": r["damage_usd"],
            "deaths_outside_buildings": sum(outside.get(e, 0) for e in r["event_ids"]),
            "deaths_sim_target": max(r["deaths"] - sum(outside.get(e, 0) for e in r["event_ids"]), 0),
            "path": path,
        })
        scenario = {
            "place_id": r["place_id"], "hazard": "tornado", "ef": r["ef"], "path": path,
            "width_m": round(r["width_m"], 1), "flood_height_m": None, "hour": r["hour"],
            "warning_min": WARNING_MIN_DEFAULT, "protections": [], "runs": 500, "seed": 42,
        }
        (OUT_SCEN / f"{r['place_id']}.json").write_text(json.dumps(scenario, indent=1))

    write_json(OUT_LIST, {
        "note": ("Historical tornadoes for calibration (split=train) and the held-out backtest (split=test). "
                 "weight = eligible tornadoes in stratum / sampled, use it in any sum or loss over tornadoes."),
        "selection": {"years": f"{YEAR_MIN}-2025", "min_ef": 1, "max_length_km": MAX_LENGTH_KM,
                      "impact": f"death, injury, or damage >= ${MIN_DAMAGE_USD:,}", "max_per_state": MAX_PER_STATE,
                      "seed": SEED, "warning_min_default": WARNING_MIN_DEFAULT},
        "tornadoes": rows,
    })
    print(f"  wrote {len(rows)} scenarios to {OUT_SCEN.relative_to(ROOT)}/")
    c = chosen
    print(c.group_by("split", "stratum").agg(n=pl.len(), deaths=pl.col("deaths").sum(), states=pl.col("state").n_unique(),
                                              ef=pl.col("ef").mean().round(2), weight=pl.col("weight").first().round(2)).sort("split", "stratum"))
    print("EF mix:", dict(sorted(c.group_by("ef").len().iter_rows())), " states:", c["state"].n_unique())
    print("hour mix: night (20-5)", c.filter(pl.col("hour").is_in([20, 21, 22, 23, 0, 1, 2, 3, 4, 5])).height, "of", c.height)
    print(c.sort("deaths", descending=True).select("place_id", "split", "state", "ef", "length_km", "width_m", "deaths", "n_segments").head(8))


if __name__ == "__main__":
    main()
