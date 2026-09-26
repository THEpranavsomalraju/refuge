"""Check the heatmap risk bands against the cell risk the calibrated simulator produces.

  python ml/heatmap_bands.py

Risk per cell = expected deaths in the cell / people in the cell at the storm's hour (the overview's
definition). The sim CLI's calibration mode returns totals, not cells, so this re-computes expected
mode per building in Python (same formula as sim/core/engine.ts) and checks the per-storm totals
against the CLI before trusting the cells.

Storms: every backtest town (real NSI buildings) on its own path, EF1-EF4 at the NOAA median width
for that rating, at 2 AM and 3 PM, 10 minutes warning.

Decision: with the starting cutoffs (1e-4, 1e-2, 1e-1) deep red never appears, even for an EF4 at night,
and red covers under 10% of storm cells, so the red bands lose meaning. Moving every cutoff down one
decade (still log scale) gives EF1 mostly green, EF2 mostly yellow, EF3 some red, EF4 about a quarter
red or deep red. See CANDIDATES and heatmap_bands.json.

Writes sim/params/sim_params.json = ml/work/calibrated_params.json + the chosen risk_bands.
Output: ml/exports/heatmap_bands.json, ml/figures/cell_risk_distribution.png
"""
import json
import os
import subprocess
from collections import defaultdict

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

from common import EXPORTS, FIGURES, ROOT, WORK, write_json

CALIBRATED = WORK / "calibrated_params.json"
PARAMS = ROOT / "sim" / "params" / "sim_params.json"
CANDIDATES = {
    "start": {"yellow": 1e-4, "red": 1e-2, "deep_red": 1e-1},
    "half_decade_lower": {"yellow": 3e-5, "red": 3e-3, "deep_red": 3e-2},
    "one_decade_lower": {"yellow": 1e-5, "red": 1e-3, "deep_red": 1e-2},
}
CHOSEN = "one_decade_lower"
PLACES = ROOT / "data" / "backtest" / "places"
TORNADOES = ROOT / "ml" / "backtest" / "tornadoes.json"
SIM_CLI = os.environ.get("REFUGE_SIM_CLI", str(ROOT / "sim" / "dist" / "cli.js"))
CALIBRATION_GROUP = {"MH": "MH", "RES_WOOD": "RES", "RES_MASONRY": "RES", "MULTI": "RES", "SCHOOL": "PUBLIC",
                     "WORSHIP": "PUBLIC", "COMMERCIAL": "PUBLIC", "BIGROOF": "PUBLIC", "OTHER": None}
HOURS = [2, 15]
EFS = [1, 2, 3, 4]
WARNING_MIN = 10
R_EARTH = 6_371_008.8


def _ang(lat1, lon1, lat2, lon2):
    h = np.sin((lat2 - lat1) / 2) ** 2 + np.cos(lat1) * np.cos(lat2) * np.sin((lon2 - lon1) / 2) ** 2
    return 2 * np.arcsin(np.sqrt(np.clip(h, 0, 1)))


def _bearing(lat1, lon1, lat2, lon2):
    return np.arctan2(np.sin(lon2 - lon1) * np.cos(lat2),
                      np.cos(lat1) * np.sin(lat2) - np.sin(lat1) * np.cos(lat2) * np.cos(lon2 - lon1))


def distance_to_path(lon, lat, path):
    """Meters to the nearest point of the great-circle polyline, same formula as sim/core/geometry.ts."""
    plon, plat = np.radians(np.asarray(lon, float)), np.radians(np.asarray(lat, float))
    best = np.full(plon.shape, np.inf)
    for (lo1, la1), (lo2, la2) in zip(path, path[1:]):
        slon, slat, elon, elat = map(np.radians, (lo1, la1, lo2, la2))
        length = _ang(slat, slon, elat, elon)
        from_start = _ang(slat, slon, plat, plon)
        if length == 0:
            best = np.minimum(best, from_start)
            continue
        angle = _bearing(slat, slon, plat, plon) - _bearing(slat, slon, elat, elon)
        along = np.arctan2(np.sin(from_start) * np.cos(angle), np.cos(from_start))
        cross = np.abs(np.arcsin(np.clip(np.sin(from_start) * np.sin(angle), -1, 1)))
        d = np.where(along < 0, from_start, np.where(along > length, _ang(elat, elon, plat, plon), cross))
        best = np.minimum(best, d)
    return best * R_EARTH


def building_expected(b, scen, P):
    """Expected deaths per building (same math as sim/core/engine.ts expected mode)."""
    lon = np.array([x["lon"] for x in b]); lat = np.array([x["lat"] for x in b])
    wind = P["wind"]["peak_mph_by_ef"][scen["ef"]] * np.maximum(0, 1 - distance_to_path(lon, lat, scen["path"]) / (scen["width_m"] / 2))
    night = scen["hour"] >= 20 or scen["hour"] < 6
    m = P["modifiers"]
    out = np.zeros(len(b)); people = np.zeros(len(b))
    for i, x in enumerate(b):
        u = x["pop_night_u65"] if night else x["pop_day_u65"]
        o = x["pop_night_o65"] if night else x["pop_day_o65"]
        people[i] = u + o
        dmg = sum(wind[i] >= t for t in P["wind"]["damage_thresholds_mph"][x["cls"]])
        if dmg == 0:
            continue
        g = CALIBRATION_GROUP[x["cls"]]
        p = (P["lethality_by_damage"][x["cls"]][dmg] * (1 if g is None else P["lethality_multiplier"][g])
             * (m["night"] if night else 1) * (m["basement"] if x["basement"] else 1)
             * np.exp(-m["warning_per_min"] * scen["warning_min"]))
        out[i] = u * min(1, p) + o * min(1, p * m["over65"])
    return out, people


def band_of(risk, bands):
    return np.where(risk >= bands["deep_red"], 3, np.where(risk >= bands["red"], 2, np.where(risk >= bands["yellow"], 1, 0)))


def verify_against_cli(storms, P, widths):
    """Run a handful of scenarios through the real CLI and compare totals with the Python version."""
    scen, py = [], []
    for s in storms[:12]:
        sc = {"place_id": s["place_id"], "hazard": "tornado", "ef": 3, "path": s["path"], "width_m": widths[3],
              "flood_height_m": None, "hour": 2, "warning_min": WARNING_MIN, "protections": [], "runs": 500, "seed": 42}
        scen.append(sc)
        b = json.loads((PLACES / s["place_id"] / "buildings.json").read_text())
        py.append(building_expected(b, sc, P)[0].sum())
    batch = WORK / "bands_verify.jsonl"
    batch.write_text("\n".join(json.dumps(x) for x in scen) + "\n")
    res = subprocess.run(["node", SIM_CLI, "--batch", str(batch), "--places", str(PLACES), "--params", str(PARAMS),
                          "--mode", "expected"], capture_output=True, text=True, check=True)
    cli = [json.loads(l)["expected_deaths"] for l in res.stdout.splitlines() if l.strip()]
    rel = [abs(a - b) / max(b, 1e-6) for a, b in zip(py, cli)]
    print(f"  python vs CLI expected deaths on {len(cli)} storms: max relative difference {max(rel):.2%}")
    return max(rel)


def main():
    P = json.loads(CALIBRATED.read_text())
    P["risk_bands"] = CANDIDATES[CHOSEN]
    PARAMS.write_text(json.dumps(P, indent=2) + "\n")  # lethality is unchanged by bands; the CLI check below reads this file
    bands, min_people = P["risk_bands"], P["min_cell_people"]
    widths = {int(k[2:]): v["width_m"]["median"] for k, v in json.loads((EXPORTS / "tornado_width_by_ef.json").read_text())["by_ef"].items()}
    storms = [r for r in json.loads(TORNADOES.read_text())["tornadoes"] if not r["excluded"]]
    max_diff = verify_against_cli(storms, P, widths)

    risks = defaultdict(list)          # (ef, hour) -> risk of every populated cell the storm touched
    counts = defaultdict(lambda: np.zeros(5, int))  # green, yellow, red, deep red, sparse
    for s in storms:
        b = json.loads((PLACES / s["place_id"] / "buildings.json").read_text())
        cells = np.array([x["h3"] for x in b])
        for ef in EFS:
            for hour in HOURS:
                sc = {"ef": ef, "path": s["path"], "width_m": widths[ef], "hour": hour, "warning_min": WARNING_MIN}
                ed, ppl = building_expected(b, sc, P)
                agg = defaultdict(lambda: [0.0, 0.0])
                for c, e, p in zip(cells, ed, ppl):
                    agg[c][0] += e; agg[c][1] += p
                for e, p in agg.values():
                    if p == 0:
                        continue            # empty cell: uncolored
                    if p < min_people:
                        counts[(ef, hour)][4] += 1
                        continue
                    r = e / p
                    counts[(ef, hour)][band_of(np.array([r]), bands)[0]] += 1
                    if e > 0:
                        risks[(ef, hour)].append(r)

    names = ["green", "yellow", "red", "deep_red", "sparse"]
    table = []
    print(f"\n  bands: yellow >= {bands['yellow']}, red >= {bands['red']}, deep red >= {bands['deep_red']}, min people {min_people}")
    for ef in EFS:
        for hour in HOURS:
            c = counts[(ef, hour)]
            colored = c[:4].sum()
            touched = np.array(risks[(ef, hour)])
            row = {"ef": ef, "hour": hour, **{n: int(v) for n, v in zip(names, c)},
                   "share_of_touched_cells": {n: round(float(np.mean(band_of(touched, bands) == i)), 3) for i, n in enumerate(names[:4])},
                   "touched_risk_p50": float(np.median(touched)) if len(touched) else None,
                   "touched_risk_p90": float(np.quantile(touched, 0.9)) if len(touched) else None,
                   "touched_risk_max": float(touched.max()) if len(touched) else None}
            table.append(row)
            sh = row["share_of_touched_cells"]
            print(f"  EF{ef} {hour:02d}h: populated cells {colored:>6}  cells in storm {len(touched):>5}  of those: "
                  f"green {sh['green']:.0%} yellow {sh['yellow']:.0%} red {sh['red']:.0%} deep red {sh['deep_red']:.0%}  "
                  f"median risk 1 in {1 / row['touched_risk_p50']:,.0f}")

    FIGURES.mkdir(parents=True, exist_ok=True)
    fig, ax = plt.subplots(figsize=(8, 4.5))
    for ef in EFS:
        r = np.concatenate([risks[(ef, h)] for h in HOURS])
        ax.hist(np.log10(r), bins=60, histtype="step", linewidth=1.6, label=f"EF{ef}")
    for k, v in bands.items():
        ax.axvline(np.log10(v), color="0.3", linestyle="--", linewidth=1)
        ax.text(np.log10(v), ax.get_ylim()[1] * 0.95, f" {k.replace('_', ' ')} 1 in {1 / v:,.0f}", fontsize=8, va="top")
    ax.set_xlabel("risk of death per person in the cell (log10)")
    ax.set_ylabel("cells inside the storm")
    ax.set_title("Cell risk from the calibrated simulator, 79 real towns")
    ax.legend(frameon=False)
    fig.tight_layout()
    fig.savefig(FIGURES / "cell_risk_distribution.png", dpi=150)
    print("  wrote ml/figures/cell_risk_distribution.png")

    candidates = {}
    for name, cb in CANDIDATES.items():
        candidates[name] = {"bands": cb, "share_of_touched_cells": {}}
        for (ef, hour), r in risks.items():
            b_ = band_of(np.array(r), cb)
            candidates[name]["share_of_touched_cells"][f"EF{ef}_{hour:02d}h"] = {
                n: round(float(np.mean(b_ == i)), 3) for i, n in enumerate(names[:4])}
    print(f"  wrote sim/params/sim_params.json with risk_bands = {CHOSEN} {bands}")

    write_json(EXPORTS / "heatmap_bands.json", {
        "note": ("Share of populated H3 cells in each band when the calibrated sim runs EF1-EF4 tornadoes through the 79 "
                 "backtest towns. share_of_touched_cells counts only cells with nonzero expected deaths. Interim: "
                 "confirm on the three featured places before freezing."),
        "chosen": CHOSEN, "bands": bands, "min_cell_people": min_people, "python_vs_cli_max_rel_diff": max_diff,
        "by_storm": table, "candidates": candidates,
    })


if __name__ == "__main__":
    main()
