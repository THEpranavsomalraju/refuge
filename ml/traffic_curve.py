"""Hourly traffic curve from the FHWA National Household Travel Survey.

  python ml/traffic_curve.py

Share of daily personal vehicle trips starting in each local hour (driver trips in a
car, SUV, van or pickup, weighted by the NHTS trip weights). Built from NHTS 2017
(~920k trips) because NHTS 2022 (~31k trips) is too thin at night, especially rural.
2022 is used as a check.

Daily vehicles per road come from FHWA Highway Statistics 2023: VM-2 (annual vehicle miles)
divided by HM-20 (road miles) and 365, by rural/urban and functional class, mapped to OSM tags.

Structures turns this into crossings.json cars_per_hour:
  cars_per_hour[h] = daily_volume[osm_tag] * share[h]
"""
import html
import re

import numpy as np
import polars as pl

from common import EXPORTS, ROOT, write_json

NHTS = ROOT / "data" / "raw" / "nhts"
SOURCES = {
    # year: (trip file, vehicle mode codes for car/SUV/van/pickup)
    2017: ("trippub.csv", ["03", "04", "05", "06"]),
    2022: ("tripv2pub.csv", ["01", "02", "03", "04"]),
}


FHWA = ROOT / "data" / "raw" / "fhwa"
FC = ["Interstate", "Other freeways and expressways", "Other principal arterial", "Minor arterial",
      "Major collector", "Minor collector", "Local"]
# OSM highway tag -> FHWA functional class, following the OSM US tagging guidelines. Approximate.
OSM_TO_FC = {
    "motorway": "Interstate",
    "trunk": "Other freeways and expressways",
    "primary": "Other principal arterial",
    "secondary": "Minor arterial",
    "tertiary": "Major collector",
    "unclassified": "Minor collector",
    "residential": "Local",
    "service": "Local",
}


def fhwa_us_total(table):
    """U.S. Total row: 7 rural classes, rural total, 7 urban classes, urban total, grand total."""
    s = (FHWA / f"{table}_2023.html").read_text(encoding="utf-8", errors="ignore")
    for row in re.findall(r"<tr[^>]*>(.*?)</tr>", s, flags=re.S | re.I):
        cells = [html.unescape(re.sub(r"<[^>]+>", "", c)).strip()
                 for c in re.findall(r"<t[hd][^>]*>(.*?)</t[hd]>", row, flags=re.S | re.I)]
        if cells and cells[0] == "U.S. Total":
            vals = [float(c.replace(",", "")) for c in cells[1:]]
            assert len(vals) == 17, f"{table}: expected 17 values, got {len(vals)}"
            return {"rural": vals[0:7], "urban": vals[8:15]}
    raise ValueError(f"no U.S. Total row in {table}")


def daily_volumes():
    vmt, miles = fhwa_us_total("vm2"), fhwa_us_total("hm20")  # millions of vehicle miles / year, miles
    by_fc = {area: {fc: round(v * 1e6 / 365 / m) for fc, v, m in zip(FC, vmt[area], miles[area])}
             for area in ("rural", "urban")}
    by_osm = {area: {tag: by_fc[area][fc] for tag, fc in OSM_TO_FC.items()} for area in ("rural", "urban")}
    return by_fc, by_osm


def load(year):
    fname, modes = SOURCES[year]
    t = pl.read_csv(NHTS / fname, infer_schema=False,
                    columns=["DRVR_FLG", "TRPTRANS", "TRAVDAY", "URBRUR", "STRTTIME", "WTTRDFIN"])
    return t.filter((pl.col("DRVR_FLG") == "01") & pl.col("TRPTRANS").is_in(modes)).with_columns(
        hour=pl.col("STRTTIME").str.slice(0, 2).cast(pl.Int32, strict=False),
        w=pl.col("WTTRDFIN").cast(pl.Float64),
        day=pl.when(pl.col("TRAVDAY").is_in(["01", "07"])).then(pl.lit("weekend")).otherwise(pl.lit("weekday")),
        area=pl.when(pl.col("URBRUR") == "02").then(pl.lit("rural")).otherwise(pl.lit("urban")),
    ).filter(pl.col("hour").is_between(0, 23))


def shares(t):
    g = t.group_by("hour").agg(w=pl.col("w").sum(), n=pl.len())
    full = pl.DataFrame({"hour": list(range(24))}).join(g, on="hour", how="left").fill_null(0).sort("hour")
    return (full["w"] / full["w"].sum()).to_numpy(), int(full["n"].sum()), int(full["n"].min())


def main():
    t17, t22 = load(2017), load(2022)
    print(f"driver trips: 2017 {t17.height:,}, 2022 {t22.height:,}")
    curves, check = {}, {}
    for day in ["weekday", "weekend", "all"]:
        for area in ["rural", "urban", "all"]:
            f = pl.lit(True)
            if day != "all":
                f &= pl.col("day") == day
            if area != "all":
                f &= pl.col("area") == area
            s17, n17, min17 = shares(t17.filter(f))
            s22, n22, _ = shares(t22.filter(f))
            key = f"{day}_{area}"
            curves[key] = {"share": [round(float(x), 5) for x in s17], "trips": n17, "min_trips_in_an_hour": min17}
            check[key] = {"corr_2017_vs_2022": round(float(np.corrcoef(s17, s22)[0, 1]), 3), "trips_2022": n22}
            print(f"  {key:15s} trips {n17:>7,}  min/hour {min17:>5}  corr with 2022 {check[key]['corr_2017_vs_2022']}")

    by_fc, by_osm = daily_volumes()
    for area in ("rural", "urban"):
        print(f"  daily vehicles {area}: " + ", ".join(f"{k} {v:,}" for k, v in by_osm[area].items()))

    write_json(EXPORTS / "traffic_by_hour.json", {
        "source": "FHWA National Household Travel Survey 2017, driver trips in car/SUV/van/pickup, weighted",
        "hours": "local clock hour of trip start, 0-23",
        "use": ("cars_per_hour[h] = daily_volume_by_osm_tag[area][highway] * curves[day_area].share[h]. "
                "Small towns: area 'rural', curve 'weekday_rural'. Chapel Hill: 'urban'."),
        "curves": curves,
        "check_vs_nhts_2022": check,
        "daily_volume_source": ("FHWA Highway Statistics 2023, VM-2 vehicle miles / HM-20 public road miles / 365, "
                                "U.S. totals. Average vehicles per day on a road of that class."),
        "daily_volume_by_osm_tag": by_osm,
        "osm_tag_to_fhwa_class": OSM_TO_FC,
        "daily_volume_by_fhwa_class": by_fc,
    })


if __name__ == "__main__":
    main()
