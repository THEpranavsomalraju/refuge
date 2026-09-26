"""Calibrate the simulator's lethality knobs on historical tornadoes, then backtest.

  python ml/calibrate.py prepare    # place folders via Structures' write_place_lite (cached)
  python ml/calibrate.py fit        # fit knobs on split=train, writes ml/work/calibrated_params.json
  python ml/calibrate.py backtest   # split=test: calibrated vs default params vs national model -> backtest.json

Free knobs (log scale, inside the bounds agreed with Simulation):
  lethality_multiplier MH, RES, PUBLIC; modifiers night, basement.
Fixed: VEHICLE (no crossings in tornado places), over65, warning_per_min (every storm uses the
same placeholder warning time, so it cannot be fit).

Objective on the train storms (each weighted by its sampling weight):
  mean weighted Poisson deviance(recorded deaths, sim expected deaths)
  + LAMBDA_MIX * KL(location model mix || sim mix) over MH / RES / PUBLIC
  + LAMBDA_PRIOR * sum(log(multiplier)^2)      keeps multipliers near 1 unless the data says otherwise
"""
import hashlib
import json
import os
import pickle
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
import polars as pl
from scipy import optimize, stats

from common import EXPORTS, PROCESSED, ROOT, WORK, write_json

TORNADOES = ROOT / "ml" / "backtest" / "tornadoes.json"
PLACES = ROOT / "data" / "backtest" / "places"
# env overrides are only for testing the loop against a mock CLI
SIM_CLI = os.environ.get("REFUGE_SIM_CLI", str(ROOT / "sim" / "dist" / "cli.js"))
DEFAULT_PARAMS = Path(os.environ.get("REFUGE_DEFAULT_PARAMS", ROOT / "sim" / "params" / "sim_params.default.json"))
CALIBRATED = WORK / "calibrated_params.json"

# name: (path in params json, lower, upper)
KNOBS = {
    "MH": (("lethality_multiplier", "MH"), 0.05, 20),
    "RES": (("lethality_multiplier", "RES"), 0.05, 20),
    "PUBLIC": (("lethality_multiplier", "PUBLIC"), 0.05, 20),
    "night": (("modifiers", "night"), 1, 4),
    "basement": (("modifiers", "basement"), 0.05, 1),
}
MULTIPLIERS = ["MH", "RES", "PUBLIC"]
LAMBDA_MIX = 0.5
LAMBDA_PRIOR = 0.01
BUFFER_M = 1000  # corridor = path buffered by width/2 + this

# sim building classes -> NOAA death location classes
SIM_TO_NOAA = {"MH": "MH", "RES_WOOD": "RES", "RES_MASONRY": "RES", "MULTI": "RES",
               "SCHOOL": "PUBLIC", "WORSHIP": "PUBLIC", "COMMERCIAL": "PUBLIC", "BIGROOF": "PUBLIC"}
MIX_CLASSES = ["MH", "RES", "PUBLIC"]


def load_storms(split=None):
    t = [r for r in json.loads(TORNADOES.read_text())["tornadoes"] if not r["excluded"]]
    return [r for r in t if split is None or r["split"] == split]


# ---------- prepare ----------

def corridor(path, width_m):
    """Path buffered by width/2 + BUFFER_M, done in a local metric projection."""
    from shapely.geometry import LineString
    from shapely.ops import transform

    lat0 = np.mean([p[1] for p in path])
    kx, ky = 111_320 * np.cos(np.radians(lat0)), 110_540
    line = LineString(path)
    to_m = transform(lambda x, y: (np.asarray(x) * kx, np.asarray(y) * ky), line)
    buf = to_m.buffer(width_m / 2 + BUFFER_M)
    return transform(lambda x, y: (np.asarray(x) / kx, np.asarray(y) / ky), buf)


def prepare():
    sys.path.insert(0, str(ROOT))
    from places.fetch_nsi import write_place_lite

    PLACES.mkdir(parents=True, exist_ok=True)
    for i, s in enumerate(load_storms(), 1):
        out = PLACES / s["place_id"]
        if (out / "buildings.json").exists():
            continue
        t0 = time.time()
        write_place_lite(corridor(s["path"], s["width_m"]), s["place_id"], out_dir=PLACES)
        n = len(json.loads((out / "buildings.json").read_text()))
        print(f"  [{i}] {s['place_id']}: {n:,} buildings in {time.time() - t0:.1f}s")
    print(f"place folders ready in {PLACES.relative_to(ROOT)}/")


# ---------- running the sim ----------

def params_with(knobs):
    p = json.loads(DEFAULT_PARAMS.read_text())
    for name, value in knobs.items():
        (section, key), _, _ = KNOBS[name]
        p[section][key] = float(value)
    return p


def run_sim(params, storms, mode="expected"):
    """One batch call of sim/cli.js. Returns {place_id: result}."""
    WORK.mkdir(parents=True, exist_ok=True)
    blob = json.dumps(params, sort_keys=True)
    ppath = WORK / f"candidate_{hashlib.md5(blob.encode()).hexdigest()[:10]}.json"
    ppath.write_text(blob)
    batch = WORK / f"scenarios_{mode}.jsonl"
    with open(batch, "w") as f:
        for s in storms:
            scen = json.loads((ROOT / "data" / "backtest" / "scenarios" / f"{s['place_id']}.json").read_text())
            f.write(json.dumps(scen) + "\n")
    cmd = ["node", str(SIM_CLI), "--batch", str(batch), "--places", str(PLACES), "--params", str(ppath), "--mode", mode]
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0:
        raise RuntimeError(f"sim CLI failed ({res.returncode}):\n{res.stderr[-2000:]}")
    out = {}
    for line in res.stdout.splitlines():
        if line.strip():
            r = json.loads(line)
            out[r["place_id"]] = r
    missing = [s["place_id"] for s in storms if s["place_id"] not in out]
    if missing:
        raise RuntimeError(f"sim CLI returned no result for {missing[:5]}")
    return out


def noaa_mix(by_class):
    m = {c: 0.0 for c in MIX_CLASSES}
    for cls, v in by_class.items():
        if cls in SIM_TO_NOAA:
            m[SIM_TO_NOAA[cls]] += v
    return m


# ---------- objective ----------

def poisson_dev(y, mu):
    mu = np.clip(mu, 1e-9, None)
    return 2 * (np.where(y > 0, y * np.log(np.where(y > 0, y, 1) / mu), 0.0) - (y - mu))


def location_target(storms):
    """Location model mix for these storms, weighted by weight * recorded deaths, over MH/RES/PUBLIC."""
    with open(WORK / "location_model.pkl", "rb") as f:
        lm = pickle.load(f)
    cf = pl.read_parquet(PROCESSED / "county_features.parquet")
    feats = dict(cf.select("county_fips", pl.struct("mh_share", "age65_share", "noveh_share", "pop_density", "svi")
                           .alias("f")).iter_rows())
    med = {c: cf[c].median() for c in ["mh_share", "age65_share", "noveh_share", "pop_density", "svi"]}
    total = np.zeros(len(MIX_CLASSES))
    for s in storms:
        if s["deaths"] == 0:
            continue
        c = feats.get(s["county_fips"][0]) or med
        row = {"is_tornado": 1, "ef_rating": s["ef"], "ef_missing": 0,
               "log_length": np.log1p(s["length_km"] / 1.609344), "log_width": np.log1p(s["width_m"] / 0.9144),
               "hour_sin": np.sin(s["hour"] * 2 * np.pi / 24), "hour_cos": np.cos(s["hour"] * 2 * np.pi / 24),
               "is_night": int(s["hour"] >= 20 or s["hour"] < 6),
               "month_sin": np.sin(s["month"] * 2 * np.pi / 12), "month_cos": np.cos(s["month"] * 2 * np.pi / 12),
               "mh_share": c["mh_share"], "age65_share": c["age65_share"], "noveh_share": c["noveh_share"],
               "log_pop_density": np.log1p(c["pop_density"]), "svi": c["svi"]}
        p = lm["model"].predict_proba(np.array([[row[f] for f in lm["features"]]]))[0]
        probs = dict(zip([lm["classes"][i] for i in lm["model"][-1].classes_], p))
        q = np.array([probs.get(k, 0.0) for k in MIX_CLASSES])
        total += s["weight"] * s["deaths"] * q / q.sum()
    return total / total.sum()


class Objective:
    def __init__(self, storms):
        self.storms = storms
        self.y = np.array([s["deaths"] for s in storms], float)
        self.w = np.array([s["weight"] for s in storms], float)
        self.target = location_target(storms)
        self.cache, self.log = {}, []

    def parts(self, knobs):
        res = run_sim(params_with(knobs), self.storms)
        mu = np.array([res[s["place_id"]]["expected_deaths"] for s in self.storms], float)
        dev = float(np.sum(self.w * poisson_dev(self.y, mu)) / self.w.sum())
        mix = np.zeros(len(MIX_CLASSES))
        for s in self.storms:
            m = noaa_mix(res[s["place_id"]]["by_class"])
            mix += s["weight"] * np.array([m[c] for c in MIX_CLASSES])
        sim_mix = (mix + 1e-9) / (mix + 1e-9).sum()
        kl = float(np.sum(self.target * np.log(self.target / sim_mix)))
        prior = float(sum(np.log(knobs[k]) ** 2 for k in MULTIPLIERS))
        return {"deviance": dev, "kl_mix": kl, "prior": prior,
                "total": dev + LAMBDA_MIX * kl + LAMBDA_PRIOR * prior,
                "sim_mix": dict(zip(MIX_CLASSES, sim_mix.round(4).tolist())), "mu": mu}

    def __call__(self, x):
        knobs = {k: float(np.exp(v)) for k, v in zip(KNOBS, x)}
        key = tuple(np.round(x, 4))
        if key not in self.cache:
            p = self.parts(knobs)
            self.cache[key] = p["total"]
            self.log.append({**{k: round(v, 4) for k, v in knobs.items()},
                             **{k: round(p[k], 5) for k in ["deviance", "kl_mix", "prior", "total"]}})
            if len(self.log) % 10 == 1:
                print(f"  eval {len(self.log):>4}: total {p['total']:.4f}  dev {p['deviance']:.4f}  kl {p['kl_mix']:.4f}  "
                      + " ".join(f"{k}={v:.3g}" for k, v in knobs.items()))
        return self.cache[key]


def default_knobs():
    p = json.loads(DEFAULT_PARAMS.read_text())
    return {name: float(p[sec][key]) for name, ((sec, key), _, _) in KNOBS.items()}


def fit():
    storms = load_storms("train")
    obj = Objective(storms)
    start = default_knobs()
    print(f"train storms: {len(storms)}, recorded deaths {int(obj.y.sum())}, target mix "
          + ", ".join(f"{c} {v:.0%}" for c, v in zip(MIX_CLASSES, obj.target)))
    before = obj.parts(start)
    print(f"default params: total {before['total']:.4f}  dev {before['deviance']:.4f}  kl {before['kl_mix']:.4f}  "
          f"expected {before['mu'].sum():.1f} vs recorded {obj.y.sum():.0f}")

    bounds = [(np.log(lo), np.log(hi)) for _, lo, hi in KNOBS.values()]
    x0 = np.clip(np.log(list(start.values())), [b[0] for b in bounds], [b[1] for b in bounds])
    t0 = time.time()
    r = optimize.minimize(obj, x0, method="Powell", bounds=bounds, options={"maxfev": 400, "xtol": 1e-3, "ftol": 1e-4})
    knobs = {k: float(np.exp(v)) for k, v in zip(KNOBS, r.x)}
    after = obj.parts(knobs)
    print(f"fit done in {time.time() - t0:.0f}s, {len(obj.log)} sim calls, converged={r.success}")
    for k, v in knobs.items():
        _, lo, hi = KNOBS[k]
        edge = "  <- at bound" if np.isclose(v, lo, rtol=0.01) or np.isclose(v, hi, rtol=0.01) else ""
        print(f"  {k:9s} {start[k]:.3g} -> {v:.3g}   bounds [{lo}, {hi}]{edge}")
    print(f"calibrated: dev {after['deviance']:.4f}  kl {after['kl_mix']:.4f}  expected {after['mu'].sum():.1f} "
          f"vs recorded {obj.y.sum():.0f}  sim mix {after['sim_mix']}")

    WORK.mkdir(parents=True, exist_ok=True)
    CALIBRATED.write_text(json.dumps(params_with(knobs), indent=1))
    write_json(WORK / "calibration_fit.json", {
        "knobs_default": start, "knobs_calibrated": knobs,
        "bounds": {k: [lo, hi] for k, (_, lo, hi) in KNOBS.items()},
        "lambda_mix": LAMBDA_MIX, "lambda_prior": LAMBDA_PRIOR, "target_mix": dict(zip(MIX_CLASSES, obj.target.tolist())),
        "train": {"storms": len(storms), "recorded_deaths": int(obj.y.sum()),
                  "default": {k: before[k] for k in ["deviance", "kl_mix", "total", "sim_mix"]},
                  "calibrated": {k: after[k] for k in ["deviance", "kl_mix", "total", "sim_mix"]}},
        "optimizer": {"method": "Powell", "evals": len(obj.log), "converged": bool(r.success)},
        "trace": obj.log,
    })


# ---------- backtest ----------

def summarize(y, mu, lo, hi, w):
    return {
        "recorded_deaths": int(y.sum()), "predicted_deaths": round(float(mu.sum()), 2),
        "total_error": round(float(mu.sum() - y.sum()), 2),
        "mean_abs_error_per_storm": round(float(np.mean(np.abs(mu - y))), 3),
        "spearman": round(float(stats.spearmanr(mu, y).statistic), 3),
        "coverage_p05_p95": round(float(np.mean((y >= lo) & (y <= hi))), 3),
        "weighted_poisson_deviance": round(float(np.sum(w * poisson_dev(y, mu)) / w.sum()), 4),
    }


def backtest():
    storms = load_storms("test")
    y = np.array([s["deaths"] for s in storms], float)
    w = np.array([s["weight"] for s in storms], float)
    methods = {}

    for name, params in [("calibrated", json.loads(CALIBRATED.read_text())),
                         ("default_params", json.loads(DEFAULT_PARAMS.read_text()))]:
        res = run_sim(params, storms, mode="simulate")
        methods[name] = {s["place_id"]: (res[s["place_id"]]["expected_deaths"], res[s["place_id"]]["p05"],
                                         res[s["place_id"]]["p95"]) for s in storms}

    # national risk model alone: out-of-fold predictions summed over the storm's county segments,
    # with a Poisson 5-95% range
    oof = dict(pl.read_parquet(WORK / "risk_oof.parquet").iter_rows())
    methods["national_model"] = {}
    for s in storms:
        mu = sum(oof.get(e, 0.0) for e in s["noaa_event_ids"])
        methods["national_model"][s["place_id"]] = (mu, stats.poisson.ppf(0.05, mu), stats.poisson.ppf(0.95, mu))

    out = {"note": ("Held-out historical tornadoes (never used in calibration). Recorded = NOAA direct deaths. "
                    "p05-p95 from 500 sim runs; for the national model, a Poisson range around its prediction."),
           "storms": [], "summary": {}}
    for name, m in methods.items():
        mu = np.array([m[s["place_id"]][0] for s in storms])
        lo = np.array([m[s["place_id"]][1] for s in storms])
        hi = np.array([m[s["place_id"]][2] for s in storms])
        out["summary"][name] = summarize(y, mu, lo, hi, w)
        print(f"  {name:15s} " + "  ".join(f"{k} {v}" for k, v in out["summary"][name].items()))
    for s in storms:
        out["storms"].append({
            "place_id": s["place_id"], "year": s["year"], "state": s["state"], "ef": s["ef"], "hour": s["hour"],
            "recorded": s["deaths"],
            **{name: {"expected": round(float(m[s["place_id"]][0]), 3), "p05": float(m[s["place_id"]][1]),
                      "p95": float(m[s["place_id"]][2])} for name, m in methods.items()},
        })
    write_json(EXPORTS / "backtest.json", out)


if __name__ == "__main__":
    steps = {"prepare": prepare, "fit": fit, "backtest": backtest}
    if len(sys.argv) != 2 or sys.argv[1] not in steps:
        sys.exit(f"usage: python ml/calibrate.py {'|'.join(steps)}")
    steps[sys.argv[1]]()
