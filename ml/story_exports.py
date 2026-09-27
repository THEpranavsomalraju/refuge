"""Flourish-ready CSVs + a plain English README for the Story / visualization lead.

  python ml/story_exports.py      (run after patterns.py, train_risk.py, train_location.py, calibrate.py backtest)

Writes ml/exports/story/*.csv and ml/exports/story/README.md. Every number comes from the other
exports or the processed tables, so re-running keeps the slides and the site in sync.
"""
import json

import polars as pl

from common import EXPORTS, PROCESSED, STATE_FIPS_US

OUT = EXPORTS / "story"
LABEL = {"MH": "Mobile home", "RES": "House or apartment", "PUBLIC": "School, church, business",
         "VEHICLE": "Vehicle", "WATER": "In water", "OUTDOOR": "Outdoors", "OTHER": "Other or not recorded"}
KNOB_TEXT = {
    "MH": ("Mobile home death rate multiplier", "How deadly a damaged mobile home is, relative to the engineering starting value"),
    "RES": ("House and apartment death rate multiplier", "Same, for houses and apartments"),
    "PUBLIC": ("Public building death rate multiplier", "Same, for schools, churches, businesses, big-box stores"),
    "night": ("Night multiplier", "Extra risk for storms between 8 PM and 6 AM (people asleep, warnings missed)"),
    "basement": ("Basement factor", "Risk in a building with a basement, relative to one without (lower = safer)"),
}


def load(name):
    return json.loads((EXPORTS / name).read_text())


def write(df, name):
    OUT.mkdir(parents=True, exist_ok=True)
    df.write_csv(OUT / name)
    print(f"  wrote ml/exports/story/{name}  ({df.height} rows)")
    return df


def national_patterns():
    ev = pl.read_parquet(PROCESSED / "events.parquet").filter(pl.col("state_fips").is_in(STATE_FIPS_US))
    by_year = ev.group_by("year").agg(
        tornado=pl.col("deaths_direct").filter(pl.col("event_type") == "Tornado").sum(),
        flash_flood=pl.col("deaths_direct").filter(pl.col("event_type") == "Flash Flood").sum(),
        all_storm_types=pl.col("deaths_direct").sum(),
    ).sort("year")
    write(by_year, "deaths_by_year.csv")

    by_type = ev.group_by("event_type").agg(deaths=pl.col("deaths_direct").sum(), events=pl.len()) \
        .filter(pl.col("deaths") > 0).sort("deaths", descending=True).head(15)
    write(by_type, "deaths_by_storm_type.csv")

    h = load("deaths_by_hour.json")
    for key in ("hour", "month"):
        t = pl.DataFrame(h[key]["Tornado"]).select(key, tornado_deaths="deaths", tornado_deaths_per_100_storms="deaths_per_100_events")
        f = pl.DataFrame(h[key]["Flash Flood"]).select(key, flash_flood_deaths="deaths",
                                                       flash_flood_deaths_per_100_storms="deaths_per_100_events")
        write(t.join(f, on=key), f"deaths_by_{key}.csv")

    loc = load("deaths_by_location.json")["by_event_type"]
    rows = [{"where": LABEL[c],
             "tornado_share": loc["Tornado"]["shares"][c],
             "tornado_night_share": loc["Tornado"]["shares_night"][c],
             "tornado_day_share": loc["Tornado"]["shares_day"][c],
             "flash_flood_share": loc["Flash Flood"]["shares"][c],
             "tornado_deaths": loc["Tornado"]["counts"][c],
             "flash_flood_deaths": loc["Flash Flood"]["counts"][c]} for c in loc["Tornado"]["shares"]]
    write(pl.DataFrame(rows).sort("tornado_share", descending=True), "deaths_by_location.csv")
    return h, loc, by_type


def model_outputs():
    s = load("shap_summary.json")
    write(pl.DataFrame([{"driver": i["label"], "importance": round(i["mean_abs_shap"], 4)} for i in s["importance"]]),
          "model_drivers.csv")
    for feat, fname, xname in [("hour", "model_effect_hour.csv", "hour"), ("ef_rating", "model_effect_ef_rating.csv", "ef_rating"),
                               ("mh_share", "model_effect_mobile_home_share.csv", "county_mobile_home_share")]:
        write(pl.DataFrame([{xname: p["x"], "relative_risk": round(p["relative_risk"], 3), "storms_in_sample": p["n"]}
                            for p in s["dependence"][feat]]), fname)

    m = load("model_metrics.json")
    risk = m["risk"]
    rows = [{"test": f"Held-out states, fold {f['fold']}", "auc": f["auc_fatal"], "deviance_explained": f["deviance_explained"],
             "fatal_storms_caught_in_top_5pct": f["recall_fatal_top5pct"]} for f in risk["group_kfold_by_state"]]
    ts = risk["time_split"]
    rows.append({"test": "Future years (train to 2019, test 2020-2025)", "auc": ts["auc_fatal"],
                 "deviance_explained": ts["deviance_explained"], "fatal_storms_caught_in_top_5pct": ts["recall_fatal_top5pct"]})
    for t, r in ts["by_event_type"].items():
        rows.append({"test": f"Future years, {t.lower()} only", "auc": r["auc_fatal"],
                     "deviance_explained": r["deviance_explained"], "fatal_storms_caught_in_top_5pct": r["recall_fatal_top5pct"]})
    write(pl.DataFrame(rows), "model_validation.csv")
    write(pl.DataFrame(ts["calibration_by_decile"]).select(
        "decile", "predicted_deaths", "actual_deaths", "fatal_events", "n_events"), "model_calibration_by_decile.csv")

    loc = m["location"]
    write(pl.DataFrame([{"scenario": k, **{LABEL[c]: v for c, v in mix.items()}} for k, mix in loc["examples"].items()]),
          "location_model_examples.csv")
    return risk, loc


def backtest_outputs():
    b = load("backtest.json")
    write(pl.DataFrame([{
        "storm": f"{s['state'].title()} {s['year']}, EF{s['ef']}", "id": s["place_id"], "hour": s["hour"],
        "recorded_deaths": s["recorded"], "recorded_in_buildings": s["recorded_in_buildings"],
        "simulator_expected": round(s["calibrated"]["expected"], 2),
        "simulator_low_p05": s["calibrated"]["p05"], "simulator_high_p95": s["calibrated"]["p95"],
        "simulator_uncalibrated": round(s["default_params"]["expected"], 2),
        "national_model": round(s["national_model"]["expected"], 2),
    } for s in b["storms"]]).sort("recorded_deaths", descending=True), "backtest_storms.csv")
    summ = b["summary"]["building_deaths"]
    names = {"calibrated": "Refuge simulator (calibrated)", "default_params": "Simulator before calibration",
             "national_model": "National statistical model"}
    write(pl.DataFrame([{"method": names[k], **v} for k, v in summ.items()]), "backtest_summary.csv")

    fit = load("calibration.json")
    write(pl.DataFrame([{"knob": KNOB_TEXT[k][0], "meaning": KNOB_TEXT[k][1],
                         "before": round(fit["knobs_default"][k], 3), "after": round(v, 3)}
                        for k, v in fit["knobs_calibrated"].items()]), "calibration_knobs.csv")
    return b, fit


def county_map():
    c = load("county_risk.json")
    f = c["fields"]
    rows = [{"fips": fips, **dict(zip(f, vals))} for fips, vals in c["counties"].items()]
    df = pl.DataFrame(rows).select(
        "fips", "name", pl.col("expected_deaths_per_decade").round(2), pl.col("deaths_1996_2025"),
        pl.col("ref_tornado_night").alias("risk_same_ef2_tornado_at_night"),
        pl.col("ref_flood_night").alias("risk_same_flash_flood_at_night"))
    write(df, "county_risk.csv")
    return df


def readme(h, loc, by_type, risk, lm, b, fit, counties):
    tn = h["tornado_night"]
    t, ff = loc["Tornado"], loc["Flash Flood"]
    ts = risk["time_split"]
    bs = b["summary"]["building_deaths"]
    big = max(b["storms"], key=lambda s: s["recorded"])
    top_n = counties.sort("risk_same_ef2_tornado_at_night", descending=True).head(5)["name"].to_list()
    text = f"""# Refuge data for charts (from the ML lead)

All files are CSV and load straight into Flourish. Source: NOAA Storm Events 1996-2025 (direct deaths, 50 states + DC),
CDC/ATSDR Social Vulnerability Index 2022, USACE National Structure Inventory, FHWA travel survey.
Everything regenerates from `ml/story_exports.py`, so if a number changes it changes everywhere.

## Headline numbers (safe to quote)

- Mobile homes: **{t['shares']['MH']:.0%} of tornado deaths** where the location is known, rising to **{t['shares_night']['MH']:.0%} at night**.
- Vehicles: **{ff['shares']['VEHICLE']:.0%} of flash flood deaths with known locations**; another {ff['shares']['WATER']:.0%} were in the water.
- Night tornadoes (8 PM to 6 AM) are {tn['share_of_tornadoes']:.0%} of tornadoes but **{tn['share_of_deaths']:.0%} of tornado deaths**
  ({tn['deaths_per_100_tornadoes_night']:.1f} vs {tn['deaths_per_100_tornadoes_day']:.1f} deaths per 100 tornadoes).
- The national model ranks storms well: on 2020-2025 storms it never saw, AUC **{ts['auc_fatal']:.2f}**
  (tornadoes {ts['by_event_type']['Tornado']['auc_fatal']:.2f}, flash floods {ts['by_event_type']['Flash Flood']['auc_fatal']:.2f}).
- Backtest on {len(b['storms'])} tornadoes held out from parameter fitting: the largest, {big['state'].title()} {big['year']}
  (EF{big['ef']}, {big['recorded']} deaths), simulated at **{big['calibrated']['expected']:.1f} (range {big['calibrated']['p05']:.0f}-{big['calibrated']['p95']:.0f})**.
  Across all {len(b['storms'])}, the simulator predicts {bs['calibrated']['predicted_deaths']:.0f} deaths vs {bs['calibrated']['recorded_deaths']} recorded
  in the comparison target, with rank correlation {bs['calibrated']['spearman']:.2f}.

## Files and suggested charts

| File | Chart idea |
|---|---|
| deaths_by_year.csv | Line or column chart, tornado vs flash flood deaths per year |
| deaths_by_storm_type.csv | Bar chart: which storms kill (all NOAA types) |
| deaths_by_hour.csv | Radial or column chart by hour; use *_per_100_storms to show night danger |
| deaths_by_month.csv | Seasonality |
| deaths_by_location.csv | Stacked bar or waffle: where people die, tornado day vs night vs flash flood |
| fatalities_dots.csv (in ml/exports/) | Direct AND indirect deaths (23,187 rows); filter fatality_type to D for comparison with direct-death charts |
| model_drivers.csv | Bar chart: what the model says drives deaths |
| model_effect_hour.csv / _ef_rating.csv / _mobile_home_share.csv | Line charts; relative_risk 1.3 = 30% more expected deaths than an average storm |
| model_validation.csv | Table: how well the model does on states and years it never saw |
| model_calibration_by_decile.csv | Paired bars: predicted vs actual deaths, storms grouped by predicted risk |
| location_model_examples.csv | Stacked bars: same EF3 tornado, night vs day, many vs few mobile homes |
| backtest_storms.csv | Dot plot: recorded deaths vs simulator expected with its low-high range, one row per real storm |
| backtest_summary.csv | Table: simulator vs national model on the held-out storms |
| calibration_knobs.csv | Table: what calibration changed |
| county_risk.csv | US county map (Flourish uses 5 digit FIPS). risk_same_ef2_tornado_at_night compares counties on vulnerability alone. Highest: {", ".join(top_n)} |

## Words to use

- "risk per person" and "expected deaths with a range", never "this person will die".
- Model effects are **estimates, not proof of cause**.
- Structure Inventory populations are **modeled estimates**.

## Caveats to keep on the chart or in a footnote

- Location shares leave out deaths NOAA recorded as "Unknown" (about 16% overall, 6% for tornadoes).
- Connecticut is blank on the county map (its counties were redrawn in 2022). Territories are not included.
- County map values come from a model that never saw that county's state, so past disasters are not memorized.
- The backtest target (legacy recorded_in_buildings field) excludes known VEHICLE, OUTDOOR, WATER and OTHER
  locations but retains unknown locations. It is not confirmed building deaths. The national model predicts
  all direct deaths, so its comparison against this reduced target is not target-matched.
- NOAA endpoint geometry, inventory gaps and simplified lethality may contribute to underprediction;
  the backtest does not isolate the cause or establish spatial accuracy. Drawing a path does not validate death estimates.
- Sampling ranges condition on fixed inputs and omit parameter, exposure and geometry uncertainty.
- Buildings and modeled populations are contemporary NSI records retrieved in 2026; older storms replay
  on contemporary exposure, not reconstructed historical towns.
- The game models buildings and crossing vehicles; its breakdown excludes WATER and OUTDOOR exposures
  and differs from the national location chart. A town's vehicle share need not equal the national 45%.
- Flood/vehicle parameters are uncalibrated. Missing HAND or traffic is unavailable data, not verified safety.
- Night in all charts = 8 PM to 5:59 AM local clock time.
"""
    (OUT / "README.md").write_text(text)
    print("  wrote ml/exports/story/README.md")


def main():
    h, loc, by_type = national_patterns()
    risk, lm = model_outputs()
    b, fit = backtest_outputs()
    counties = county_map()
    readme(h, loc, by_type, risk, lm, b, fit, counties)


if __name__ == "__main__":
    main()
