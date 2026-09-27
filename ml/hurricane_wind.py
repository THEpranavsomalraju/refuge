"""Hurricane wind field from NOAA HURDAT2 (reference implementation for the sim engine).

  python ml/hurricane_wind.py        # category defaults + reference test cases -> ml/exports/hurricane_reference.json

Model (one formula, used for past storms and user-drawn future tracks):
  1. Track points: center, max 1-min sustained wind Vmax (kt, over water/open exposure), radius of max
     wind RMW (km) and Holland B. HURDAT2 gives Vmax every 6 h; RMW since 2021 (else a regression fit on
     2021-2025 records); B is fitted per point to the recorded 34/50/64-kt wind radii (default 1.5).
  2. Points are interpolated to 10-minute steps. Forward motion Vt comes from the track itself.
  3. Symmetric Holland (1980) profile scaled so the peak equals Vmax - 0.5 Vt, plus a motion term
     0.5 Vt cos(angle from the right of the heading). The right side peaks at Vmax, as HURDAT records it.
  4. Surface conversion at a building: x LAND_FACTOR (over-water to over-land 1-min wind) x GUST_FACTOR
     (1-min sustained to 3-s gust, since the damage thresholds are gust speeds). Model constants from
     WMO wind-averaging guidance (Harper et al. 2010).
  5. Each building keeps the maximum gust over the storm's passage.
"""
import json
import math
from datetime import datetime
from pathlib import Path

import numpy as np

from common import EXPORTS, ROOT, write_json

HURDAT = ROOT / "data" / "raw" / "hurdat" / "hurdat2_atlantic.txt"
KT_TO_MPH, NM_TO_KM = 1.15078, 1.852
LAND_FACTOR = 0.80
GUST_FACTOR = 1.30
STEP_H = 1 / 6
B_DEFAULT, B_MIN, B_MAX = 1.5, 0.8, 2.5
R_EARTH_KM = 6371.0088
# Saffir-Simpson categories, 1-min sustained kt
CATEGORY_KT = {1: (64, 82), 2: (83, 95), 3: (96, 112), 4: (113, 136), 5: (137, 160)}


# ---------------- HURDAT2 ----------------

def parse_hurdat(path=HURDAT):
    storms, cur = {}, None
    for line in Path(path).read_text().splitlines():
        f = [x.strip() for x in line.split(",")]
        if f[0][:2].isalpha() and len(f[0]) == 8:          # header: AL142018, MICHAEL, 38,
            cur = {"id": f[0], "name": f[1], "points": []}
            storms[f[0]] = cur
            continue
        if len(f) < 8 or cur is None:
            continue
        lat = float(f[4][:-1]) * (1 if f[4][-1] == "N" else -1)
        lon = float(f[5][:-1]) * (-1 if f[5][-1] == "W" else 1)
        radii = [int(x) for x in f[8:20]] if len(f) >= 20 else [-999] * 12
        rmw = int(f[20]) if len(f) > 20 and f[20] not in ("", "-999") else None
        cur["points"].append({"date": f[0], "time": f[1], "record": f[2], "status": f[3], "lat": lat, "lon": lon,
                              "vmax_kt": int(f[6]), "pmin": int(f[7]), "r34": radii[0:4], "r50": radii[4:8], "r64": radii[8:12],
                              "rmw_nm": rmw if rmw and rmw > 0 else None})
    return storms


def find_storm(storms, name, year):
    for s in storms.values():
        if s["name"] == name.upper() and s["id"].endswith(str(year)):
            return s
    raise KeyError(f"{name} {year} not in HURDAT2")


# ---------------- profile ----------------

def holland(r_km, vpeak, rmw_km, B):
    """Symmetric Holland profile normalized so V(rmw) = vpeak."""
    x = (rmw_km / np.maximum(r_km, 0.1)) ** B
    return vpeak * np.sqrt(x * np.exp(1 - x))


def fit_B(vmax_kt, rmw_km, pt):
    """B that best reproduces the recorded mean 34/50/64-kt radii (outer radius where wind = threshold)."""
    obs = []
    for thr, key in ((34, "r34"), (50, "r50"), (64, "r64")):
        q = [v for v in pt[key] if v and v > 0]
        if q and vmax_kt > thr:
            obs.append((thr, np.mean(q) * NM_TO_KM))
    if not obs:
        return B_DEFAULT
    best, err_best = B_DEFAULT, np.inf
    for B in np.arange(B_MIN, B_MAX + 1e-9, 0.05):
        err = 0.0
        for thr, r_obs in obs:
            r = np.linspace(rmw_km, 1000, 4000)
            v = holland(r, vmax_kt, rmw_km, B)
            r_mod = r[np.argmax(v < thr)] if (v < thr).any() else 1000
            err += (math.log(r_mod) - math.log(r_obs)) ** 2
        if err < err_best:
            best, err_best = float(B), err
    return round(best, 2)


def rmw_regression(storms):
    """ln(RMW km) = a + b * Vmax + c * lat, fit on HURDAT2 points that record RMW (2021+) at hurricane strength."""
    X, y = [], []
    for s in storms.values():
        for p in s["points"]:
            if p["rmw_nm"] and p["vmax_kt"] >= 64 and p["status"] == "HU":
                X.append([1, p["vmax_kt"], abs(p["lat"])]); y.append(math.log(p["rmw_nm"] * NM_TO_KM))
    coef, *_ = np.linalg.lstsq(np.array(X, float), np.array(y), rcond=None)
    return [round(float(c), 6) for c in coef], len(y)


def rmw_estimate(coef, vmax_kt, lat):
    return float(math.exp(coef[0] + coef[1] * vmax_kt + coef[2] * abs(lat)))


def storm_track(storm, coef, t0=None, t1=None):
    """Track points [lon, lat, vmax_kt, rmw_km, B, time_h] for a HURDAT2 storm (optionally a date window)."""
    out = []
    base = None
    for p in storm["points"]:
        stamp = p["date"] + p["time"]
        if (t0 and stamp < t0) or (t1 and stamp > t1):
            continue
        h = datetime.strptime(stamp, "%Y%m%d%H%M").timestamp() / 3600
        base = h if base is None else base
        rmw = p["rmw_nm"] * NM_TO_KM if p["rmw_nm"] else rmw_estimate(coef, max(p["vmax_kt"], 34), p["lat"])
        out.append([p["lon"], p["lat"], p["vmax_kt"], round(rmw, 1), fit_B(p["vmax_kt"], rmw, p), round(h - base, 2)])
    return out


# ---------------- wind at buildings ----------------

def _xy(lon, lat, lat0):
    return (np.radians(lon) * np.cos(np.radians(lat0)) * R_EARTH_KM, np.radians(lat) * R_EARTH_KM)


def max_gust_mph(track, lon, lat):
    """Max 3-s gust (mph) at each point over the storm's passage. track rows: [lon, lat, vmax_kt, rmw_km, B, time_h]."""
    lon = np.asarray(lon, float); lat = np.asarray(lat, float)
    T = np.array(track, float)
    lat0 = float(np.mean(T[:, 1]))
    steps = np.arange(T[0, 5], T[-1, 5] + 1e-9, STEP_H)
    cols = {k: np.interp(steps, T[:, 5], T[:, i]) for i, k in enumerate(["lon", "lat", "vmax", "rmw", "B"])}
    cx, cy = _xy(cols["lon"], cols["lat"], lat0)
    vx = np.gradient(cx, steps); vy = np.gradient(cy, steps)            # km/h
    vt_kt = np.hypot(vx, vy) / NM_TO_KM
    heading = np.arctan2(vy, vx)
    px, py = _xy(lon, lat, lat0)
    best = np.zeros(lon.shape)
    for k in range(len(steps)):
        dx, dy = px - cx[k], py - cy[k]
        r = np.hypot(dx, dy)
        vpeak = max(cols["vmax"][k] - 0.5 * vt_kt[k], 0)
        v = holland(r, vpeak, cols["rmw"][k], cols["B"][k])
        right = heading[k] - np.pi / 2                                    # right of motion (northern hemisphere)
        v = v + 0.5 * vt_kt[k] * np.cos(np.arctan2(dy, dx) - right) * np.minimum(1, v / max(vpeak, 1e-6))
        best = np.maximum(best, v)
    return best * LAND_FACTOR * GUST_FACTOR * KT_TO_MPH


def category_defaults(storms, coef):
    """Typical RMW and B per category, from HURDAT2 2021-2025 hurricane points that record RMW and radii."""
    rows = {c: [] for c in CATEGORY_KT}
    for s in storms.values():
        for p in s["points"]:
            if not p["rmw_nm"] or p["status"] != "HU":
                continue
            for c, (lo, hi) in CATEGORY_KT.items():
                if lo <= p["vmax_kt"] <= hi:
                    rmw = p["rmw_nm"] * NM_TO_KM
                    rows[c].append((rmw, fit_B(p["vmax_kt"], rmw, p)))
    out = {}
    for c, (lo, hi) in CATEGORY_KT.items():
        r = np.array(rows[c]) if rows[c] else np.array([[rmw_estimate(coef, (lo + hi) / 2, 30), B_DEFAULT]])
        out[c] = {"vmax_kt": round((lo + min(hi, 160)) / 2), "rmw_km": round(float(np.median(r[:, 0])), 1),
                  "B": round(float(np.median(r[:, 1])), 2), "n_points": len(rows[c])}
    return out


def main():
    storms = parse_hurdat()
    coef, n = rmw_regression(storms)
    cats = category_defaults(storms, coef)
    print(f"HURDAT2: {len(storms)} storms; RMW regression on {n} points: ln(RMW km) = {coef[0]} + {coef[1]} Vmax + {coef[2]} |lat|")
    for c, v in cats.items():
        print(f"  Cat {c}: Vmax {v['vmax_kt']} kt, RMW {v['rmw_km']} km, B {v['B']} (from {v['n_points']} points)")

    # reference cases for the TypeScript port: a straight synthetic track + a real HURDAT2 segment
    cases = []
    syn = [[-79.30, 34.40, cats[2]["vmax_kt"], cats[2]["rmw_km"], cats[2]["B"], 0.0],
           [-78.80, 34.90, cats[2]["vmax_kt"], cats[2]["rmw_km"], cats[2]["B"], 4.0]]
    pts = [[-79.05, 34.65], [-79.00, 34.70], [-79.20, 34.55], [-78.90, 34.60], [-79.40, 34.80]]
    g = max_gust_mph(syn, [p[0] for p in pts], [p[1] for p in pts])
    cases.append({"name": "synthetic Cat 2 crossing Lumberton area", "track": syn, "points": pts, "max_gust_mph": [round(float(x), 3) for x in g]})
    michael = storm_track(find_storm(storms, "MICHAEL", 2018), coef, "201810101200", "201810110000")
    mpts = [[-85.41, 29.94], [-85.66, 30.16], [-85.20, 30.10], [-84.90, 30.70]]
    g = max_gust_mph(michael, [p[0] for p in mpts], [p[1] for p in mpts])
    cases.append({"name": "Michael 2018 landfall segment (HURDAT2)", "track": michael, "points": mpts, "max_gust_mph": [round(float(x), 3) for x in g]})
    for cse in cases:
        print(f"  {cse['name']}: gusts mph {cse['max_gust_mph']}")

    write_json(EXPORTS / "hurricane_reference.json", {
        "note": ("Reference for the sim engine's hurricane wind field. Track rows: [lon, lat, vmax_kt, rmw_km, B, time_h]. "
                 "See ml/hurricane_wind.py for the exact formula. Port must reproduce max_gust_mph to rounding."),
        "constants": {"LAND_FACTOR": LAND_FACTOR, "GUST_FACTOR": GUST_FACTOR, "KT_TO_MPH": KT_TO_MPH, "STEP_H": STEP_H,
                      "motion_asymmetry": "0.5 * Vt * cos(angle from right of heading) * min(1, V/Vpeak); Vpeak = Vmax - 0.5 Vt",
                      "earth_radius_km": R_EARTH_KM, "projection": "local equirectangular at the track's mean latitude"},
        "rmw_regression": {"coef": coef, "form": "ln(RMW km) = a + b*Vmax_kt + c*|lat|", "n_points": n},
        "category_defaults": cats,
        "cases": cases,
    })


if __name__ == "__main__":
    main()


# ---------------- deaths at buildings (hurricane rules) ----------------
CALIBRATION_GROUP = {"MH": "MH", "RES_WOOD": "RES", "RES_MASONRY": "RES", "MULTI": "RES", "SCHOOL": "PUBLIC",
                     "WORSHIP": "PUBLIC", "COMMERCIAL": "PUBLIC", "BIGROOF": "PUBLIC", "OTHER": None}


def expected_deaths(buildings, track, params, scale=1.0):
    """Per-building expected deaths for a hurricane: max gust -> damage level -> lethality_by_damage x class
    multiplier x basement x scale, over-65 modifier as in the engine. People are at home (night population);
    no warning decay and no night modifier (warnings come days ahead; that effect belongs in `scale`)."""
    gust = max_gust_mph(track, [b["lon"] for b in buildings], [b["lat"] for b in buildings])
    m = params["modifiers"]
    out = np.zeros(len(buildings))
    for i, b in enumerate(buildings):
        dmg = sum(gust[i] >= t for t in params["wind"]["damage_thresholds_mph"][b["cls"]])
        if dmg == 0:
            continue
        g = CALIBRATION_GROUP[b["cls"]]
        p = (params["lethality_by_damage"][b["cls"]][dmg] * (1 if g is None else params["lethality_multiplier"][g])
             * (m["basement"] if b["basement"] else 1) * scale)
        out[i] = b["pop_night_u65"] * min(1, p) + b["pop_night_o65"] * min(1, p * m["over65"])
    return out, gust
