"""Hurricane mode: damage and displacement (reference implementation for the sim engine).

  python ml/hurricane_damage.py      -> ml/exports/hurricane_damage_reference.json

Definitions (the game uses exactly these):
  gust_b          max 3-s gust at building b over the storm (ml/hurricane_wind.py).
  P(level >= k)   lognormal fragility: Phi( ln(gust_b / T[cls][k-1]) / BETA ), T = wind.damage_thresholds_mph,
                  k = 1..4. BETA = 0.15 (EF damage-indicator bounds imply ~0.10; widened for hurricane duration).
  residents_b     pop_night_u65 + pop_night_o65 for MH, RES_WOOD, RES_MASONRY, MULTI (people are home in a hurricane).
  displaced_b     residents_b * P(level >= 2)   ("major damage": roof deck or walls compromised, home unlivable)
  destroyed_b     residents_b * P(level >= 3)
  deaths_b        residents_b * exp(a + b * gust_b) * class_factor   (ml/exports/hurricane_mortality.json)

Map (per H3 cell, residents only):
  share = sum(displaced) / sum(residents). Not drawn if residents == 0 or share < 1%.
  Bands: low < 10%, moderate 10-40%, severe 40-70%, extreme >= 70% (hatched). Height = displaced people.
  Cells with < 5 residents: outline only.

Shelters (existing buildings converted to FEMA P-361 hurricane safe rooms):
  eligible SCHOOL, WORSHIP, COMMERCIAL, BIGROOF; hardened area = 25% of footprint_sqft;
  capacity = hardened / 20 sq ft (P-361 hurricane occupant density), clamped 25-1,000;
  cost = capacity x 20 sq ft x $300 = $6,000 per person (the same $300/sq ft as the tornado room, $1,500 per person at 5 sq ft).
  Need per person: 1.0 if from a destroyed home, 0.5 if major damage only (need_b = destroyed_b + 0.5 * (displaced_b - destroyed_b)).
  A shelter serves people within REACH_KM (they drive there before landfall), nearest first, capacity-limited,
  nobody counted twice. Score = weighted people sheltered (need served). Deaths averted are shown too, but are tiny.
"""
import json
import math
import sys
from collections import defaultdict

import numpy as np

import hurricane_wind as hw
from common import EXPORTS, ROOT, write_json

BETA = 0.15
RES = ("MH", "RES_WOOD", "RES_MASONRY", "MULTI")
ELIGIBLE = ("SCHOOL", "WORSHIP", "COMMERCIAL", "BIGROOF")
BANDS = {"moderate": 0.10, "severe": 0.40, "extreme": 0.70}
MIN_SHARE, MIN_RESIDENTS = 0.01, 5
HARDENED_SHARE, SQFT_PER_PERSON, COST_PER_SQFT = 0.25, 20, 300
CAP_MIN, CAP_MAX = 25, 1000
REACH_KM = 3.0
MAJOR_WEIGHT = 0.5


def phi(x):
    return 0.5 * (1 + np.vectorize(math.erf)(x / math.sqrt(2)))


def building_results(buildings, track, params, mortality):
    lon = [b["lon"] for b in buildings]; lat = [b["lat"] for b in buildings]
    gust = hw.max_gust_mph(track, lon, lat)
    T = params["wind"]["damage_thresholds_mph"]
    E = mortality["engine"]
    res = np.array([b["cls"] in RES for b in buildings])
    residents = np.array([b["pop_night_u65"] + b["pop_night_o65"] for b in buildings], float) * res
    p = np.array([[phi(np.log(g / T[b["cls"]][k]) / BETA) for k in range(4)] for b, g in zip(buildings, gust)])  # P(level >= k+1)
    displaced = residents * p[:, 1]
    destroyed = residents * p[:, 2]
    cf = np.array([E["class_factor"]["MH" if b["cls"] == "MH" else "other"] for b in buildings])
    deaths = residents * np.exp(E["a"] + E["b_per_mph"] * gust) * cf
    return {"gust": gust, "residents": residents, "p": p, "displaced": displaced, "destroyed": destroyed, "deaths": deaths}


def band(share):
    return "extreme" if share >= BANDS["extreme"] else "severe" if share >= BANDS["severe"] else "moderate" if share >= BANDS["moderate"] else "low"


def cells(buildings, r):
    agg = defaultdict(lambda: [0.0, 0.0])
    for b, res, dis in zip(buildings, r["residents"], r["displaced"]):
        agg[b["h3"]][0] += res; agg[b["h3"]][1] += dis
    out = {}
    for h, (res, dis) in agg.items():
        if res <= 0 or dis / res < MIN_SHARE:
            continue
        out[h] = {"residents": res, "displaced": dis, "share": dis / res,
                  "band": "sparse" if res < MIN_RESIDENTS else band(dis / res)}
    return out


def shelter_candidates(buildings, r, footprints, top=15):
    lon = np.array([b["lon"] for b in buildings]); lat = np.array([b["lat"] for b in buildings])
    kx, ky = 111.32 * np.cos(np.radians(lat.mean())), 110.54
    X, Y = lon * kx, lat * ky
    need = r["destroyed"] + MAJOR_WEIGHT * (r["displaced"] - r["destroyed"])
    people = r["displaced"]
    rows = []
    for i, b in enumerate(buildings):
        f = footprints.get(b["id"])
        if b["cls"] not in ELIGIBLE or not f or f != f:
            continue
        cap = int(min(CAP_MAX, max(CAP_MIN, HARDENED_SHARE * f / SQFT_PER_PERSON)))
        hardened = cap * SQFT_PER_PERSON                                  # cost follows the space actually built
        d = np.hypot(X - X[i], Y - Y[i])
        near = np.flatnonzero((d <= REACH_KM) & (people > 0))
        left, served_people, served_need = float(cap), 0.0, 0.0
        for j in near[np.argsort(d[near])]:
            if left <= 0:
                break
            take = min(people[j], left)
            served_people += take; served_need += take * need[j] / people[j]; left -= take
        rows.append({"id": b["id"], "cls": b["cls"], "lon": b["lon"], "lat": b["lat"], "footprint_sqft": int(f), "capacity": cap,
                     "cost_usd": int(round(hardened * COST_PER_SQFT)), "people_sheltered_alone": round(served_people, 1),
                     "need_served_alone": round(served_need, 2)})
    rows.sort(key=lambda r_: -r_["need_served_alone"])
    return rows[:top], len(rows)


def summarize(name, buildings, track, params, mortality, footprints=None):
    r = building_results(buildings, track, params, mortality)
    c = cells(buildings, r)
    counts = {k: sum(1 for v in c.values() if v["band"] == k) for k in ("low", "moderate", "severe", "extreme", "sparse")}
    out = {"name": name, "track": track, "residents": round(float(r["residents"].sum())),
           "gust_mph_p10_p50_p90": [round(float(x), 1) for x in np.percentile(r["gust"], [10, 50, 90])],
           "displaced": round(float(r["displaced"].sum()), 1), "destroyed": round(float(r["destroyed"].sum()), 1),
           "expected_deaths": round(float(r["deaths"].sum()), 4), "cells_drawn": len(c), "band_counts": counts,
           "by_class": {cls: {"residents": round(float(r["residents"][[b["cls"] == cls for b in buildings]].sum())),
                              "displaced": round(float(r["displaced"][[b["cls"] == cls for b in buildings]].sum()), 1),
                              "destroyed": round(float(r["destroyed"][[b["cls"] == cls for b in buildings]].sum()), 1)} for cls in RES},
           "sample_buildings": [{"id": b["id"], "cls": b["cls"], "gust_mph": round(float(r["gust"][i]), 3),
                                 "p_level_ge": [round(float(x), 5) for x in r["p"][i]], "displaced": round(float(r["displaced"][i]), 5)}
                                for i, b in list(enumerate(buildings))[::max(1, len(buildings) // 8)][:8]]}
    if footprints:
        out["shelter_candidates"], out["eligible_shelters"] = shelter_candidates(buildings, r, footprints)
    return out


def main():
    sp = sys.argv[1] if len(sys.argv) > 1 else None                  # checkout with places/ (Lumberton + fetch_nsi)
    params = json.loads((ROOT / "sim/params/sim_params.json").read_text())
    mortality = json.loads((EXPORTS / "hurricane_mortality.json").read_text())
    ref = json.loads((EXPORTS / "hurricane_reference.json").read_text())
    cats = {int(k): v for k, v in ref["category_defaults"].items()}
    storms = hw.parse_hurdat(); coef, _ = hw.rmw_regression(storms)
    cases = []
    if sp:
        sys.path.insert(0, sp)
        from places.fetch_nsi import fetch_buildings
        lum = json.load(open(f"{sp}/places/lumberton/buildings.json"))
        meta = json.load(open(f"{sp}/places/lumberton/place.json"))
        fp = {x["id"]: x["footprint_sqft"] for x in lum if x.get("footprint_sqft")} or \
            {f"nsi_{int(r.fd_id)}": r.ftprntsqft for r in fetch_buildings(tuple(meta["bbox"])).itertuples()}
        for cat in (1, 2, 3, 4):
            c = cats[cat]
            track = [[-79.35, 34.35, c["vmax_kt"], c["rmw_km"], c["B"], 0.0], [-78.75, 34.95, c["vmax_kt"], c["rmw_km"], c["B"], 4.0]]
            cases.append(summarize(f"Lumberton, Category {cat}, eye through town", lum, track, params, mortality, fp))
    mb = json.load(open(ROOT / "data/past_places/michael_mexico_beach_2018/buildings.json"))
    track = hw.storm_track(hw.find_storm(storms, "MICHAEL", 2018), coef, "201810101200", "201810110600")
    cases.append(summarize("Michael 2018, Mexico Beach", mb, track, params, mortality))
    for cse in cases:
        print(f"{cse['name']}: gust {cse['gust_mph_p10_p50_p90']} mph | residents {cse['residents']:,}, displaced {cse['displaced']:,.0f}, "
              f"destroyed {cse['destroyed']:,.0f}, deaths {cse['expected_deaths']} | cells {cse['band_counts']}")
        if cse.get("shelter_candidates"):
            s = cse["shelter_candidates"][:3]
            print("   best shelters: " + "; ".join(f"{x['cls']} cap {x['capacity']} ${x['cost_usd']:,} need {x['need_served_alone']}" for x in s))
    write_json(EXPORTS / "hurricane_damage_reference.json", {
        "note": "Reference for hurricane mode. Definitions are in ml/hurricane_damage.py; the engine must reproduce these to rounding.",
        "constants": {"BETA": BETA, "residential_classes": RES, "bands": BANDS, "min_share_drawn": MIN_SHARE, "min_residents": MIN_RESIDENTS,
                      "shelter": {"eligible": ELIGIBLE, "hardened_share": HARDENED_SHARE, "sqft_per_person": SQFT_PER_PERSON,
                                  "cost_per_sqft": COST_PER_SQFT, "capacity_min_max": [CAP_MIN, CAP_MAX], "reach_km": REACH_KM,
                                  "major_damage_weight": MAJOR_WEIGHT}},
        "cases": cases,
    })


if __name__ == "__main__":
    main()
