"""Rank existing buildings as tornado shelters for one storm (reference for Simulation's plan phase).

  python ml/shelter_candidates.py --place-dir /path/to/places/lumberton --scenario /path/to/lumberton_tornado.json

Implements the shelter rule in sim/params/protections.json with the calibrated params: capacity from footprint (FEMA P-361,
5 sq ft per person, 25% of the footprint hardened), $1,500 per person, mobile-home residents within walking
reach go at 30% compliance, nearest first. "Lives saved alone" is each building converted on its own.
Footprints come from the raw NSI frame until buildings.json carries footprint_sqft.
Writes ml/exports/shelter_candidates_<place>.json.
"""
import argparse
import json
import sys

import numpy as np

from common import EXPORTS, ROOT, write_json
from heatmap_bands import building_expected

ELIGIBLE = {"SCHOOL", "WORSHIP", "COMMERCIAL", "BIGROOF"}
SQFT_PER_PERSON = 5
HARDENED_SHARE = 0.25
CAP_MIN, CAP_MAX = 50, 1000
COST_PER_PERSON = 1500
COMPLIANCE = 0.30
WALK_MPS, MOBILIZE_MIN = 1.07, 5
TOP = 25


def footprints(record_ids, bbox):
    fp = {}
    try:
        sys.path.insert(0, str(ROOT))
        from places.fetch_nsi import fetch_buildings
        for r in fetch_buildings(tuple(bbox)).itertuples():
            fp[f"nsi_{int(r.fd_id)}"] = r.ftprntsqft
    except ImportError:
        pass
    return fp


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--place-dir", required=True)
    ap.add_argument("--scenario", required=True)
    ap.add_argument("--places-root", help="checkout containing places/fetch_nsi.py, until it is merged")
    a = ap.parse_args()
    if a.places_root:
        sys.path.insert(0, a.places_root)
    b = json.load(open(f"{a.place_dir}/buildings.json"))
    meta = json.load(open(f"{a.place_dir}/place.json"))
    scen = json.load(open(a.scenario))
    params = json.loads((ROOT / "sim" / "params" / "sim_params.json").read_text())

    ed, ppl = building_expected(b, scen, params)
    fp = {x["id"]: x["footprint_sqft"] for x in b if x.get("footprint_sqft")} or footprints([x["id"] for x in b], meta["bbox"])
    reach = WALK_MPS * max(0, scen["warning_min"] - MOBILIZE_MIN) * 60
    lon = np.array([x["lon"] for x in b]); lat = np.array([x["lat"] for x in b])
    kx, ky = 111320 * np.cos(np.radians(lat.mean())), 110540
    X, Y = lon * kx, lat * ky
    is_mh = np.array([x["cls"] == "MH" for x in b])
    risk = np.where(ppl > 0, ed / np.maximum(ppl, 1), 0)

    rows, sites = [], set()
    for i, x in enumerate(b):
        f = fp.get(x["id"])
        if x["cls"] not in ELIGIBLE or not f or f != f:
            continue
        # NSI can list one building as several records at the same point with the same footprint;
        # they share one floor, so only the first counts (same rule as sim/core/protections.ts).
        site = (f"{x['lon']:.6f}", f"{x['lat']:.6f}", f)
        if site in sites:
            continue
        sites.add(site)
        cap = int(min(CAP_MAX, max(CAP_MIN, f * HARDENED_SHARE / SQFT_PER_PERSON)))
        d = np.hypot(X - X[i], Y - Y[i])
        near = np.flatnonzero(is_mh & (d <= reach) & (np.arange(len(b)) != i))
        left, saved = cap - ppl[i], ed[i]                      # own occupants sheltered first
        for j in near[np.argsort(d[near])]:
            if left <= 0:
                break
            take = min(ppl[j] * COMPLIANCE, left)
            saved += take * risk[j]; left -= take
        rows.append({"id": x["id"], "cls": x["cls"], "lon": x["lon"], "lat": x["lat"], "footprint_sqft": int(f), "capacity": cap,
                     "cost_usd": cap * COST_PER_PERSON, "mh_homes_in_reach": int(len(near)), "mh_residents_in_reach": int(ppl[near].sum()),
                     "lives_saved_alone": round(float(saved), 3)})
    rows.sort(key=lambda r: -r["lives_saved_alone"])
    ceiling = float(ed[is_mh].sum() * COMPLIANCE + sum(ed[i] for i, x in enumerate(b) if x["cls"] in ELIGIBLE))
    out = {"place": meta["place_id"], "scenario": {k: scen[k] for k in ("ef", "hour", "width_m", "warning_min")},
           "baseline_expected_deaths": round(float(ed.sum()), 3), "reach_m": round(reach), "compliance": COMPLIANCE,
           "ceiling_lives_saved": round(ceiling, 2), "eligible_with_footprint": len(rows),
           "eligible_near_mobile_homes": sum(1 for r in rows if r["mh_homes_in_reach"] > 0), "top": rows[:TOP]}
    path = EXPORTS / f"shelter_candidates_{meta['place_id']}.json"
    write_json(path, out)
    print(f"baseline {out['baseline_expected_deaths']}, ceiling ~{out['ceiling_lives_saved']} lives, {out['eligible_near_mobile_homes']} "
          f"of {len(rows)} eligible buildings near mobile homes; best: " +
          "; ".join(f"{r['cls']} cap {r['capacity']} ${r['cost_usd']:,} saves {r['lives_saved_alone']}" for r in rows[:3]))


if __name__ == "__main__":
    main()
