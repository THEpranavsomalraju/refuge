"""Empirical hurricane wind mortality curve for people at home, fit on US landfalls 2004-2024.

  python ml/hurricane_calibrate.py

Why: the building-damage chain alone is 23x too high at Mexico Beach (most residents evacuated) and
5x too low in Augusta for Helene (deaths from trees falling on homes). Real outcomes already include
typical evacuation, trees and debris, so we fit the per-person risk directly.

Data: every storm x county within reach of the track. Peak 3-s gust at the county's 2020 population
center from ml/hurricane_wind.py; population and mobile-home share (SVI 2022); NOAA direct deaths
recorded in homes (Permanent Home, Mobile/Trailer Home) from wind-type events (Hurricane (Typhoon),
Tropical Storm, High Wind, Strong Wind) during the storm window. NOAA files these by forecast zone, so
zone names are matched to counties. Katrina 2005 is excluded (its home deaths were flooding filed as
hurricane events); flood-type events are never counted.

Model: Poisson GLM, deaths ~ offset(log pop) + b0 + b1 * gust_mph + b2 * mh_share.
Validation: leave whole storms out (GroupKFold by storm); deviance vs a constant-rate baseline.
Writes ml/exports/hurricane_mortality.json and ml/figures/hurricane_mortality_curve.png.
"""
import json
import re
from datetime import datetime, timedelta

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import polars as pl
import statsmodels.api as sm
from sklearn.model_selection import GroupKFold

import hurricane_wind as hw
from common import EXPORTS, FIGURES, PROCESSED, ROOT, write_json

YEARS = (2004, 2024)
EXCLUDE = {("KATRINA", 2005)}
WIND_TYPES = ["Hurricane (Typhoon)", "Tropical Storm", "High Wind", "Strong Wind"]
HOME = ["Permanent Home", "Mobile/Trailer Home"]
MAX_KM = 500                      # counties farther than this from every track point are not exposed
MIN_GUST = 30                     # mph; below this a county is not counted as exposed
ZONE_WORDS = r"\b(COASTAL|INLAND|NORTHERN|SOUTHERN|EASTERN|WESTERN|CENTRAL|GREATER|NORTHWEST|NORTHEAST|SOUTHEAST|SOUTHWEST|UPPER|LOWER|MAINLAND|INTERIOR|OUTER|NORTH|SOUTH|EAST|WEST|COUNTY|PARISH|AND|BEACHES|ISLANDS|MOUNTAINS)\b"


def counties():
    c = pl.read_csv(ROOT / "data/raw/hurdat/cenpop2020_county.txt", encoding="utf8-lossy",
                    schema_overrides={"STATEFP": pl.Utf8, "COUNTYFP": pl.Utf8})
    c = c.rename({c.columns[0]: "STATEFP"}).with_columns(
        county_fips=pl.col("STATEFP") + pl.col("COUNTYFP"), state=pl.col("STNAME").str.to_uppercase(),
        name=pl.col("COUNAME").str.to_uppercase().str.replace_all(r"[^A-Z ]", "").str.replace_all(r"\s+", " ").str.strip_chars())
    svi = pl.read_parquet(PROCESSED / "county_features.parquet").select("county_fips", "mh_share")
    return c.join(svi, on="county_fips", how="left").with_columns(pl.col("mh_share").fill_null(pl.col("mh_share").median()))


def zone_to_county(ev, cty):
    """County FIPS for each event row: county-based rows directly, zone rows by name within the state."""
    look = {}
    for r in cty.select("state", "name", "county_fips").iter_rows():
        look.setdefault((r[0], r[1]), r[2])
    fips = []
    for r in ev.select("cz_type", "county_fips", "state", "cz_name").iter_rows():
        if r[0] == "C" and r[1]:
            fips.append(r[1]); continue
        n = re.sub(r"\s+", " ", re.sub(ZONE_WORDS, " ", re.sub(r"[^A-Z ]", " ", (r[3] or "").upper()))).strip()
        fips.append(look.get((r[2], n)) or look.get((r[2], (r[3] or "").upper().strip())))
    return ev.with_columns(fips=pl.Series(fips))


def build_dataset():
    storms = hw.parse_hurdat()
    coef, _ = hw.rmw_regression(storms)
    cty = counties()
    ev = pl.read_parquet(PROCESSED / "events.parquet").filter(pl.col("event_type").is_in(WIND_TYPES))
    fat = pl.read_parquet(PROCESSED / "fatalities.parquet").filter((pl.col("fatality_type") == "D") & pl.col("location_raw").is_in(HOME))
    ev = zone_to_county(ev, cty)
    lon_c, lat_c = cty["LONGITUDE"].to_numpy(), cty["LATITUDE"].to_numpy()
    rows, unmatched = [], 0
    for s in storms.values():
        yr = int(s["id"][-4:])
        if not (YEARS[0] <= yr <= YEARS[1]) or (s["name"], yr) in EXCLUDE:
            continue
        pts = [p for p in s["points"] if p["record"] == "L" and p["status"] == "HU" and -100 < p["lon"] < -65 and 24 < p["lat"] < 45]
        if not pts:
            continue
        first = min(p["date"] + p["time"] for p in pts)
        t_first = datetime.strptime(first, "%Y%m%d%H%M")
        t0 = (t_first - timedelta(days=1)).strftime("%Y%m%d%H%M")        # a day before the first US landfall
        track = hw.storm_track(s, coef, t0=t0)
        if len(track) < 2:
            continue
        T = np.array(track)
        d = np.min([hw.R_EARTH_KM * np.hypot(np.radians(lon_c - x) * np.cos(np.radians(y)), np.radians(lat_c - y)) for x, y in T[:, :2]], axis=0)
        near = d <= MAX_KM
        gust = np.zeros(len(cty))
        gust[near] = hw.max_gust_mph(track, lon_c[near], lat_c[near])
        exposed = near & (gust >= MIN_GUST)
        win = ev.filter(pl.col("begin_time").is_between(t_first - timedelta(days=1), t_first + timedelta(days=4)))
        deaths = fat.join(win.select("event_id", "fips"), on="event_id", how="inner")
        unmatched += deaths.filter(pl.col("fips").is_null()).height
        per = dict(deaths.filter(pl.col("fips").is_not_null()).group_by("fips").len().iter_rows())
        mh = dict(deaths.filter(pl.col("location_raw") == "Mobile/Trailer Home").group_by("fips").len().iter_rows())
        for i in np.flatnonzero(exposed):
            f = cty["county_fips"][int(i)]
            rows.append({"storm": f"{s['name']} {yr}", "county_fips": f, "state": cty["state"][int(i)], "gust_mph": float(gust[i]),
                         "pop": int(cty["POPULATION"][int(i)]), "mh_share": float(cty["mh_share"][int(i)]),
                         "deaths_home": per.get(f, 0), "deaths_mh": mh.get(f, 0)})
        print(f"  {s['name']} {yr}: {int(exposed.sum())} exposed counties, max gust {gust.max():.0f} mph, home deaths matched {sum(per.values())}")
    df = pl.DataFrame(rows)
    print(f"dataset: {df.height} storm-county rows, {df['storm'].n_unique()} storms, home deaths {df['deaths_home'].sum()} "
          f"(unmatched zone deaths dropped: {unmatched})")
    return df


def design(df):
    return sm.add_constant(np.column_stack([df["gust_mph"].to_numpy(), df["mh_share"].to_numpy()]))


def fit(df):
    return sm.GLM(df["deaths_home"].to_numpy(), design(df), family=sm.families.Poisson(),
                  offset=np.log(df["pop"].to_numpy())).fit()


def poisson_dev(y, mu):
    mu = np.clip(mu, 1e-12, None)
    return float(2 * np.sum(np.where(y > 0, y * np.log(np.where(y > 0, y, 1) / mu), 0) - (y - mu)))


def main():
    df = build_dataset()
    y = df["deaths_home"].to_numpy().astype(float)
    groups = df["storm"].to_numpy()
    oof = np.zeros(len(y)); base = np.zeros(len(y))
    folds = []
    for k, (tr, te) in enumerate(GroupKFold(5).split(df, groups=groups)):
        m = fit(df[tr])
        oof[te] = m.predict(design(df[te]), offset=np.log(df[te]["pop"].to_numpy()))
        rate = y[tr].sum() / df[tr]["pop"].sum()
        base[te] = rate * df[te]["pop"].to_numpy()
        folds.append({"fold": k + 1, "storms": sorted(set(groups[te])), "deaths": int(y[te].sum()),
                      "predicted": round(float(oof[te].sum()), 1), "baseline_constant_rate": round(float(base[te].sum()), 1),
                      "deviance": round(poisson_dev(y[te], oof[te]), 1), "deviance_baseline": round(poisson_dev(y[te], base[te]), 1)})
        print(f"  fold {k + 1}: deaths {int(y[te].sum())}, predicted {oof[te].sum():.1f} (constant-rate baseline {base[te].sum():.1f}), "
              f"deviance {folds[-1]['deviance']} vs {folds[-1]['deviance_baseline']}")
    explained = 1 - poisson_dev(y, oof) / poisson_dev(y, base)
    m = fit(df)
    b0, b1, b2 = (float(v) for v in m.params)
    # mobile-home relative risk from where deaths happened (pooled over exposed counties)
    mh_pop = float((df["pop"] * df["mh_share"]).sum()); other_pop = float(df["pop"].sum()) - mh_pop
    mh_d = float(df["deaths_mh"].sum()); other_d = float(y.sum()) - mh_d
    rr_mh = (mh_d / mh_pop) / (other_d / other_pop)
    print(f"held-out storms: deviance explained {explained:.1%}; fit: rate = exp({b0:.3f} + {b1:.4f} gust + {b2:.3f} mh_share); "
          f"mobile-home relative risk {rr_mh:.1f}")

    # per-person risk at home by gust, for a county with the dataset's median mobile-home share
    mh_med = float(df["mh_share"].median())
    g = np.arange(40, 181, 10)
    curve = [{"gust_mph": int(x), "risk_per_person": float(np.exp(b0 + b1 * x + b2 * mh_med))} for x in g]
    by_bin = (df.with_columns(bin=(pl.col("gust_mph") // 20 * 20).cast(pl.Int32)).group_by("bin")
              .agg(deaths=pl.col("deaths_home").sum(), pop=pl.col("pop").sum(), n=pl.len()).sort("bin")
              .with_columns(observed_rate=pl.col("deaths") / pl.col("pop")))
    FIGURES.mkdir(parents=True, exist_ok=True)
    fig, ax = plt.subplots(figsize=(7, 4))
    ob = by_bin.filter(pl.col("deaths") > 0)
    ax.scatter(ob["bin"] + 10, ob["observed_rate"], s=np.sqrt(ob["pop"]) / 20, color="#2a78d6", alpha=0.7, label="observed (20 mph bins)")
    ax.plot(g, [c["risk_per_person"] for c in curve], color="#eb6834", lw=2, label="fitted curve")
    ax.set_yscale("log"); ax.set_xlabel("peak 3-s gust at county population center (mph)"); ax.set_ylabel("home deaths per resident")
    ax.set_title("Hurricane wind deaths at home, US landfalls 2004-2024"); ax.legend(frameon=False)
    fig.tight_layout(); fig.savefig(FIGURES / "hurricane_mortality_curve.png", dpi=150)

    write_json(EXPORTS / "hurricane_mortality.json", {
        "note": ("Per-person risk of dying at home from hurricane winds (structure, trees, debris), fit on NOAA-recorded home "
                 "deaths in wind-type events for US landfalls 2004-2024 (Katrina excluded). Already reflects typical real "
                 "evacuation. Engine use: see `engine`: risk per person at home = exp(a + b_per_mph * gust_mph) * class_factor."),
        "engine": {"a": b0 + b2 * mh_med, "b_per_mph": b1,
                   "class_factor": {"MH": rr_mh / (1 - mh_med + mh_med * rr_mh), "other": 1 / (1 - mh_med + mh_med * rr_mh)},
                   "population": "night (at home)", "gust": "max 3-s gust from ml/hurricane_wind.py"},
        "coef": {"b0": b0, "b1_per_mph": b1, "b2_mh_share": b2}, "median_mh_share": mh_med, "rr_mh": rr_mh,
        "norm": 1 - mh_med + mh_med * rr_mh,
        "validation": {"method": "GroupKFold by storm (5 folds)", "deviance_explained_vs_constant_rate": round(explained, 4), "folds": folds},
        "curve": curve, "observed_by_gust_bin": by_bin.to_dicts(),
        "data": {"storm_county_rows": df.height, "storms": df["storm"].n_unique(), "home_deaths": int(y.sum()),
                 "min_gust_mph": MIN_GUST, "max_km": MAX_KM},
    })


if __name__ == "__main__":
    main()
