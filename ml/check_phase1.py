"""Sanity checks and checkpoint stats for the Phase 1 tables.

  python ml/check_phase1.py
"""
from pathlib import Path

import polars as pl

ROOT = Path(__file__).resolve().parents[1]
P = ROOT / "data" / "processed"
FOCUS = ["Tornado", "Flash Flood"]

pl.Config.set_tbl_rows(40)
pl.Config.set_tbl_cols(20)
pl.Config.set_fmt_str_lengths(40)
pl.Config.set_tbl_width_chars(200)

ev = pl.read_parquet(P / "events.parquet")
fat = pl.read_parquet(P / "fatalities.parquet")
cf = pl.read_parquet(P / "county_features.parquet")


def section(title):
    print(f"\n=== {title} ===")


section("rows per year")
per_year = (
    ev.group_by("year").agg(
        events=pl.len(),
        tornado=(pl.col("event_type") == "Tornado").sum(),
        flash_flood=(pl.col("event_type") == "Flash Flood").sum(),
        deaths_direct=pl.col("deaths_direct").sum(),
        deaths_indirect=pl.col("deaths_indirect").sum(),
    )
    .join(fat.group_by("year").agg(fatality_rows=pl.len()), on="year", how="left")
    .with_columns(fat_rows_vs_event_deaths=pl.col("fatality_rows") - pl.col("deaths_direct") - pl.col("deaths_indirect"))
    .sort("year")
)
print(per_year)

section("focus types: coordinates, widths, EF, county")
cov = ev.filter(pl.col("event_type").is_in(FOCUS)).group_by("event_type").agg(
    n=pl.len(),
    has_begin_end_coords=pl.col("has_coords").mean(),
    has_width=(pl.col("tor_width_yd") > 0).mean(),
    has_length=(pl.col("tor_length_mi") > 0).mean(),
    has_ef=pl.col("ef_rating").is_not_null().mean(),
    county_based=(pl.col("cz_type") == "C").mean(),
)
print(cov)
tor = ev.filter(pl.col("event_type") == "Tornado")
print("tornado coords+width by period:")
print(
    tor.with_columns(period=pl.when(pl.col("year") < 2007).then(pl.lit("1996-2006")).otherwise(pl.lit("2007-2025")))
    .group_by("period").agg(n=pl.len(), coords=pl.col("has_coords").mean(), width=(pl.col("tor_width_yd") > 0).mean())
    .sort("period")
)
print("EF rating (tornado):")
print(tor.group_by("ef_scale", "ef_rating").len().sort("ef_scale", "ef_rating"))

section("fatality location mapping")
print(
    fat.group_by("location_raw", "location_class").agg(n=pl.len(), direct=(pl.col("fatality_type") == "D").sum())
    .sort("location_class", "n", descending=[False, True])
)
print("by class, all events vs tornado vs flash flood:")
print(
    fat.group_by("location_class").agg(
        all=pl.len(),
        tornado=(pl.col("event_type") == "Tornado").sum(),
        flash_flood=(pl.col("event_type") == "Flash Flood").sum(),
    ).sort("all", descending=True)
)

section("county join rate")
keys = cf.select("county_fips")
for name, df in [("all events (county rows)", ev), ("tornado", tor), ("flash flood", ev.filter(pl.col("event_type") == "Flash Flood"))]:
    c = df.filter(pl.col("county_fips").is_not_null())
    hit = c.join(keys, on="county_fips", how="semi").height
    print(f"{name:26s} county rows {c.height:>9,} of {df.height:>9,}  joined {hit / max(c.height, 1):.1%}")
fatal_focus = ev.filter(pl.col("event_type").is_in(FOCUS) & (pl.col("deaths_direct") > 0))
hit = fatal_focus.join(keys, on="county_fips", how="semi").height
print(f"{'fatal tornado+flash flood':26s} {hit}/{fatal_focus.height} joined {hit / fatal_focus.height:.1%}")
misses = (
    ev.filter(pl.col("county_fips").is_not_null()).join(keys, on="county_fips", how="anti")
    .group_by("state").agg(n=pl.len(), fips=pl.col("county_fips").unique().head(3)).sort("n", descending=True).head(10)
)
print("top unjoined states:")
print(misses)
print("null counts in county_features:")
print(cf.null_count().transpose(include_header=True, column_names=["nulls"]).filter(pl.col("nulls") > 0))

section("timezones (should be standard time)")
print(ev.group_by("timezone").len().sort("len", descending=True))

section("samples")
cols_ev = ["event_id", "event_type", "year", "month", "hour", "state", "county_fips", "ef_rating",
           "tor_length_mi", "tor_width_yd", "begin_lat", "begin_lon", "deaths_direct", "injuries_direct"]
print(tor.filter(pl.col("deaths_direct") > 0).sample(5, seed=1).select(cols_ev))
print(fat.sample(5, seed=1).select("fatality_id", "event_id", "event_type", "year", "fatality_type", "age", "age_band", "sex", "location_raw", "location_class"))
print(cf.sample(5, seed=1).select("county_fips", "state", "county", "pop", "pop_density", "mh_share", "age65_share", "noveh_share", "svi", "source"))
