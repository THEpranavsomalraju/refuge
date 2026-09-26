"""Hour, season and location patterns for the landing page and as calibration targets.

  python ml/patterns.py

Exports: deaths_by_hour.json, deaths_by_location.json, tornado_width_by_ef.json, fatalities_dots.csv
All counts are direct deaths, 50 states + DC, 1996-2025, hours in local clock time.
"""
import polars as pl

from common import EXPORTS, FOCUS_TYPES, LOCATION_CLASSES, PROCESSED, STATE_FIPS_US, write_json

NIGHT_HOURS = [20, 21, 22, 23, 0, 1, 2, 3, 4, 5]  # 8 PM to 5:59 AM


def load():
    ev = pl.read_parquet(PROCESSED / "events.parquet").filter(pl.col("state_fips").is_in(STATE_FIPS_US))
    fat = pl.read_parquet(PROCESSED / "fatalities.parquet").join(
        ev.select("event_id"), on="event_id", how="semi")
    return ev, fat


def by_hour_and_month(ev):
    out = {"note": "Direct deaths by local clock hour of storm start and by month, 1996-2025.", "hour": {}, "month": {}}
    for t in FOCUS_TYPES:
        e = ev.filter(pl.col("event_type") == t)
        for key, n in [("hour", 24), ("month", 12)]:
            g = e.group_by(key).agg(
                events=pl.len(), fatal_events=(pl.col("deaths_direct") > 0).sum(), deaths=pl.col("deaths_direct").sum())
            start = 0 if key == "hour" else 1
            g = pl.DataFrame({key: list(range(start, start + n))}).cast({key: g[key].dtype}).join(
                g, on=key, how="left").fill_null(0).sort(key)
            g = g.with_columns(
                deaths_per_100_events=(pl.col("deaths") / pl.col("events") * 100).round(3),
                share_of_deaths=(pl.col("deaths") / pl.col("deaths").sum()).round(4),
            )
            out[key][t] = g.to_dicts()
    # headline: night share of tornado deaths vs night share of tornadoes
    tor = ev.filter(pl.col("event_type") == "Tornado")
    night = tor.filter(pl.col("hour").is_in(NIGHT_HOURS))
    out["tornado_night"] = {
        "night_hours": "8 PM to 6 AM",
        "share_of_tornadoes": round(night.height / tor.height, 4),
        "share_of_deaths": round(night["deaths_direct"].sum() / tor["deaths_direct"].sum(), 4),
        "deaths_per_100_tornadoes_night": round(night["deaths_direct"].sum() / night.height * 100, 3),
        "deaths_per_100_tornadoes_day": round(
            (tor["deaths_direct"].sum() - night["deaths_direct"].sum()) / (tor.height - night.height) * 100, 3),
    }
    write_json(EXPORTS / "deaths_by_hour.json", out)
    return out


def by_location(fat):
    d = fat.filter((pl.col("fatality_type") == "D") & ~pl.col("location_unknown"))
    unknown = fat.filter((pl.col("fatality_type") == "D") & pl.col("location_unknown"))
    out = {"note": "Direct deaths by where the person was. 'Unknown' location excluded from shares (count given).",
           "classes": LOCATION_CLASSES, "by_event_type": {}}
    groups = [("Tornado", pl.col("event_type") == "Tornado"), ("Flash Flood", pl.col("event_type") == "Flash Flood"),
              ("All storm types", pl.lit(True))]
    for name, f in groups:
        sub = d.filter(f)
        counts = dict(sub.group_by("location_class").len().iter_rows())
        total = sub.height
        entry = {"deaths_known_location": total, "deaths_unknown_location": unknown.filter(f).height,
                 "counts": {c: counts.get(c, 0) for c in LOCATION_CLASSES},
                 "shares": {c: round(counts.get(c, 0) / total, 4) for c in LOCATION_CLASSES}}
        if name != "All storm types":
            for label, hf in [("night", pl.col("hour").is_in(NIGHT_HOURS)), ("day", ~pl.col("hour").is_in(NIGHT_HOURS))]:
                s = sub.filter(hf)
                c2 = dict(s.group_by("location_class").len().iter_rows())
                entry[f"shares_{label}"] = {c: round(c2.get(c, 0) / max(s.height, 1), 4) for c in LOCATION_CLASSES}
                entry[f"deaths_{label}"] = s.height
        out["by_event_type"][name] = entry
    write_json(EXPORTS / "deaths_by_location.json", out)
    return out


def tornado_widths(ev):
    """For the Simulation teammate: path width and length by EF rating (EF scale era, 2007+)."""
    t = ev.filter((pl.col("event_type") == "Tornado") & (pl.col("year") >= 2007) & pl.col("ef_rating").is_not_null()
                  & (pl.col("tor_width_yd") > 0))
    rows = {}
    for ef in range(6):
        s = t.filter(pl.col("ef_rating") == ef)
        rows[f"EF{ef}"] = {
            "n": s.height,
            "width_m": {q: round(s["tor_width_m"].quantile(p), 1) for q, p in
                        [("p10", .1), ("p25", .25), ("median", .5), ("p75", .75), ("p90", .9)]},
            "length_km": {q: round(s["tor_length_km"].quantile(p), 2) for q, p in
                          [("p10", .1), ("p25", .25), ("median", .5), ("p75", .75), ("p90", .9)]},
        }
    write_json(EXPORTS / "tornado_width_by_ef.json", {
        "note": "NOAA Storm Events tornado segments 2007-2025 (EF scale). Widths are max path width; lengths are per county segment.",
        "by_ef": rows,
    })


def dots_csv(fat):
    out = fat.select("year", "event_type", "location_class", "age_band",
                     pl.col("sex").replace({"": None}).fill_null("unknown").alias("sex"),
                     "fatality_type").sort("year", "event_type")
    path = EXPORTS / "fatalities_dots.csv"
    out.write_csv(path)
    print(f"  wrote {path.relative_to(EXPORTS.parent.parent)}  {out.height:,} rows")


def main():
    ev, fat = load()
    h = by_hour_and_month(ev)
    loc = by_location(fat)
    tornado_widths(ev)
    dots_csv(fat)
    tn = h["tornado_night"]
    print(f"  tornado night: {tn['share_of_tornadoes']:.1%} of tornadoes, {tn['share_of_deaths']:.1%} of deaths, "
          f"{tn['deaths_per_100_tornadoes_night']} vs {tn['deaths_per_100_tornadoes_day']} deaths per 100")
    for t in ["Tornado", "Flash Flood"]:
        print(f"  {t}: {loc['by_event_type'][t]['shares']}")


if __name__ == "__main__":
    main()
