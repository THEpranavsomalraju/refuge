"""Build clean tables from data/raw/ into data/processed/.

  python ml/build_tables.py

events.parquet          one row per NOAA event (tornadoes are per county segment)
fatalities.parquet      one row per death, location mapped to our classes
county_features.parquet ACS + SVI features by 5 digit county FIPS
narratives.parquet      event/episode narratives for Tornado + Flash Flood only
"""
import json
from pathlib import Path

import polars as pl

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw"
OUT = ROOT / "data" / "processed"

YEAR_MIN, YEAR_MAX = 1996, 2025
FOCUS_TYPES = ["Tornado", "Flash Flood"]

# NOAA FATALITY_LOCATION -> our classes. Anything not listed falls to OTHER and gets printed.
LOCATION_CLASS = {
    "Mobile/Trailer Home": "MH",
    "Permanent Home": "RES",
    "School": "PUBLIC",
    "Church": "PUBLIC",
    "Business": "PUBLIC",
    "Long Span Roof": "PUBLIC",
    "Permanent Structure": "PUBLIC",
    "Vehicle/Towed Trailer": "VEHICLE",
    "In Water": "WATER",
    "Boating": "WATER",
    "Boat": "WATER",
    "Outside/Open Areas": "OUTDOOR",
    "Under Tree": "OUTDOOR",
    "Camping": "OUTDOOR",
    "Ball Field": "OUTDOOR",
    "Golfing": "OUTDOOR",
    "Heavy Equipment/Construction": "OTHER",
    "Other": "OTHER",
    "Unknown": "OTHER",
}


def read_storm(kind):
    files = sorted((RAW / "stormevents").glob(f"StormEvents_{kind}-ftp_v1.0_d*.csv.gz"))
    frames = [pl.read_csv(f, infer_schema=False) for f in files]
    return pl.concat(frames, how="diagonal")


def num(col, dtype=pl.Float64):
    return pl.col(col).str.strip_chars().cast(dtype, strict=False)


def damage_usd(col):
    """'20.00K' -> 20000, '1.5M' -> 1.5e6, '' -> null."""
    s = pl.col(col).str.strip_chars().str.to_uppercase()
    mult = (
        pl.when(s.str.ends_with("K")).then(1e3)
        .when(s.str.ends_with("M")).then(1e6)
        .when(s.str.ends_with("B")).then(1e9)
        .otherwise(1.0)
    )
    return s.str.replace(r"[KMB]$", "").cast(pl.Float64, strict=False) * mult


def coord(col, lo, hi):
    """Null out missing / zero / out of range coordinates."""
    v = num(col)
    return pl.when((v >= lo) & (v <= hi) & (v != 0)).then(v).otherwise(None)


# NOAA records times in local standard time ("CST-6"). The simulator uses local clock time,
# so convert: standard time -> UTC -> IANA zone (which applies the real DST rules per year).
STD_OFFSET = {"E": -5, "C": -6, "M": -7, "P": -8, "AK": -9, "H": -10, "A": -4, "S": -11, "G": 10}
IANA = {
    "E": "America/New_York", "C": "America/Chicago", "M": "America/Denver", "P": "America/Los_Angeles",
    "AK": "America/Anchorage", "H": "Pacific/Honolulu", "A": "America/Puerto_Rico",
    "S": "Pacific/Pago_Pago", "G": "Pacific/Guam",
}


def add_local_clock_time(ev):
    tz = pl.col("tz_raw")
    family = pl.when(tz.str.starts_with("AK")).then(pl.lit("AK")).otherwise(tz.str.slice(0, 1))
    ev = ev.with_columns(
        tz_family=family,
        already_daylight=tz.str.slice(1, 2) == "DT",
    ).with_columns(
        iana=pl.when((pl.col("state") == "ARIZONA") & (pl.col("tz_family") == "M")).then(pl.lit("America/Phoenix"))
        .when((pl.col("state") == "INDIANA") & (pl.col("tz_family") == "E")).then(pl.lit("America/Indiana/Indianapolis"))
        .otherwise(pl.col("tz_family").replace_strict(IANA, default=None)),
        std_offset_h=pl.col("tz_family").replace_strict(STD_OFFSET, default=None),
    )
    parts = []
    for (zone,), part in ev.partition_by("iana", as_dict=True, include_key=True).items():
        if zone is None:
            parts.append(part.with_columns(begin_time_local=pl.col("begin_time")))
            continue
        utc = pl.col("begin_time") - pl.duration(hours=pl.col("std_offset_h"))
        local = utc.dt.replace_time_zone("UTC").dt.convert_time_zone(zone).dt.replace_time_zone(None)
        parts.append(part.with_columns(
            begin_time_local=pl.when(pl.col("already_daylight")).then(pl.col("begin_time")).otherwise(local)
        ))
    ev = pl.concat(parts).sort("event_id")
    shifted = ev.filter(pl.col("begin_time_local") != pl.col("begin_time")).height
    unknown = ev.filter(pl.col("iana").is_null()).height
    print(f"  clock time: {shifted:,} rows shifted for DST, {unknown} rows with unknown zone left as recorded")
    return ev.with_columns(
        hour_lst=pl.col("hour"),
        hour=pl.col("begin_time_local").dt.hour().cast(pl.Int8),
    ).drop("tz_family", "already_daylight", "std_offset_h", "tz_raw")


def build_events():
    raw = read_storm("details")
    print(f"details: {raw.height:,} raw rows")

    hhmm_b = num("BEGIN_TIME", pl.Int32)
    hhmm_e = num("END_TIME", pl.Int32)
    ym_b = num("BEGIN_YEARMONTH", pl.Int32)
    ym_e = num("END_YEARMONTH", pl.Int32)
    scale = pl.col("TOR_F_SCALE").str.strip_chars()

    ev = raw.select(
        event_id=num("EVENT_ID", pl.Int64),
        episode_id=num("EPISODE_ID", pl.Int64),
        event_type=pl.col("EVENT_TYPE").str.strip_chars(),
        year=num("YEAR", pl.Int32),
        month=(ym_b % 100).cast(pl.Int8),
        day=num("BEGIN_DAY", pl.Int8),
        hour=(hhmm_b // 100).cast(pl.Int8),
        begin_time=pl.datetime(ym_b // 100, ym_b % 100, num("BEGIN_DAY", pl.Int32), hhmm_b // 100, hhmm_b % 100),
        end_time=pl.datetime(ym_e // 100, ym_e % 100, num("END_DAY", pl.Int32), hhmm_e // 100, hhmm_e % 100),
        tz_raw=pl.col("CZ_TIMEZONE").str.strip_chars().str.to_uppercase(),
        state=pl.col("STATE").str.strip_chars(),
        state_fips=num("STATE_FIPS", pl.Int32),
        cz_type=pl.col("CZ_TYPE").str.strip_chars(),
        cz_fips=num("CZ_FIPS", pl.Int32),
        cz_name=pl.col("CZ_NAME").str.strip_chars(),
        wfo=pl.col("WFO").str.strip_chars(),
        ef_scale=scale.str.extract(r"^(EF|F)"),
        ef_rating=scale.str.extract(r"^E?F([0-5])$").cast(pl.Int8, strict=False),
        magnitude=num("MAGNITUDE"),
        magnitude_type=pl.col("MAGNITUDE_TYPE").str.strip_chars(),
        flood_cause=pl.col("FLOOD_CAUSE").str.strip_chars(),
        tor_length_mi=num("TOR_LENGTH"),
        tor_width_yd=num("TOR_WIDTH"),
        begin_lat=coord("BEGIN_LAT", 13, 72),
        begin_lon=coord("BEGIN_LON", -180, -60),
        end_lat=coord("END_LAT", 13, 72),
        end_lon=coord("END_LON", -180, -60),
        deaths_direct=num("DEATHS_DIRECT", pl.Int32).fill_null(0),
        deaths_indirect=num("DEATHS_INDIRECT", pl.Int32).fill_null(0),
        injuries_direct=num("INJURIES_DIRECT", pl.Int32).fill_null(0),
        injuries_indirect=num("INJURIES_INDIRECT", pl.Int32).fill_null(0),
        damage_property_usd=damage_usd("DAMAGE_PROPERTY"),
        damage_crops_usd=damage_usd("DAMAGE_CROPS"),
        source=pl.col("SOURCE").str.strip_chars(),
        begin_date_time_raw=pl.col("BEGIN_DATE_TIME"),
    )

    ev = ev.filter(pl.col("year").is_between(YEAR_MIN, YEAR_MAX))
    ev = ev.with_columns(
        # county FIPS only for county based rows; zone (Z) and marine rows stay null
        county_fips=pl.when(pl.col("cz_type") == "C")
        .then(pl.format("{}{}", pl.col("state_fips").cast(pl.Utf8).str.zfill(2), pl.col("cz_fips").cast(pl.Utf8).str.zfill(3)))
        .otherwise(None),
        tor_width_m=pl.col("tor_width_yd") * 0.9144,
        tor_length_km=pl.col("tor_length_mi") * 1.609344,
        is_focus=pl.col("event_type").is_in(FOCUS_TYPES),
        has_coords=pl.all_horizontal(pl.col("begin_lat", "begin_lon", "end_lat", "end_lon").is_not_null()),
    )

    dupes = ev.height - ev["event_id"].n_unique()
    if dupes:
        print(f"  WARNING: {dupes} duplicate event_ids, keeping first")
        ev = ev.unique("event_id", keep="first", maintain_order=True)

    # cross check: hour from BEGIN_TIME vs hour in the 2 digit year BEGIN_DATE_TIME string
    raw_hour = pl.col("begin_date_time_raw").str.extract(r" (\d{2}):").cast(pl.Int8, strict=False)
    mismatch = ev.filter(raw_hour != pl.col("hour")).height
    print(f"  hour mismatch vs BEGIN_DATE_TIME: {mismatch}")
    ev = add_local_clock_time(ev.drop("begin_date_time_raw"))

    narr = raw.select(
        event_id=num("EVENT_ID", pl.Int64),
        episode_narrative=pl.col("EPISODE_NARRATIVE"),
        event_narrative=pl.col("EVENT_NARRATIVE"),
    ).join(ev.filter("is_focus").select("event_id"), on="event_id", how="semi").unique("event_id")

    print(f"events: {ev.height:,} rows {YEAR_MIN}-{YEAR_MAX}")
    return ev, narr


def build_fatalities(events):
    raw = read_storm("fatalities")
    print(f"fatalities: {raw.height:,} raw rows")
    loc = pl.col("FATALITY_LOCATION").str.strip_chars()
    fat = raw.select(
        fatality_id=num("FATALITY_ID", pl.Int64),
        event_id=num("EVENT_ID", pl.Int64),
        fatality_type=pl.col("FATALITY_TYPE").str.strip_chars(),  # D direct, I indirect
        fatality_date=pl.col("FATALITY_DATE").str.strptime(pl.Datetime, "%m/%d/%Y %H:%M:%S", strict=False),
        age=num("FATALITY_AGE", pl.Int16),
        sex=pl.col("FATALITY_SEX").str.strip_chars(),
        location_raw=loc,
        location_class=loc.replace_strict(LOCATION_CLASS, default="OTHER"),
        location_unknown=loc.is_null() | loc.is_in(["Unknown", ""]),
    )
    unmapped = fat.filter(~pl.col("location_raw").is_in(list(LOCATION_CLASS)))["location_raw"].value_counts()
    if unmapped.height:
        print(f"  unmapped locations (-> OTHER):\n{unmapped}")

    fat = fat.with_columns(
        age_band=pl.when(pl.col("age").is_null()).then(pl.lit("unknown"))
        .when(pl.col("age") < 18).then(pl.lit("0-17"))
        .when(pl.col("age") < 40).then(pl.lit("18-39"))
        .when(pl.col("age") < 65).then(pl.lit("40-64"))
        .otherwise(pl.lit("65+")),
    )

    joined = fat.join(
        events.select("event_id", "event_type", "year", "month", "hour", "state", "county_fips"),
        on="event_id",
        how="left",
    )
    no_event = joined.filter(pl.col("event_type").is_null()).height
    print(f"  fatalities with no matching event (outside {YEAR_MIN}-{YEAR_MAX} or missing): {no_event}")
    joined = joined.filter(pl.col("event_type").is_not_null())
    print(f"fatalities: {joined.height:,} rows")
    return joined


def build_county_features():
    svi = pl.read_parquet(RAW / "svi" / "SVI2022_US_county.parquet")
    # SVI uses -999 for missing
    num_cols = [c for c in svi.columns if c.startswith(("E_", "EP_", "RPL_")) or c == "AREA_SQMI"]
    svi = svi.with_columns([
        pl.when(pl.col(c).cast(pl.Float64, strict=False) < -998).then(None)
        .otherwise(pl.col(c).cast(pl.Float64, strict=False)).alias(c)
        for c in num_cols
    ])
    cf = svi.select(
        county_fips=pl.col("FIPS").cast(pl.Utf8).str.zfill(5),
        state=pl.col("STATE"),
        county=pl.col("COUNTY"),
        area_sqmi=pl.col("AREA_SQMI"),
        pop=pl.col("E_TOTPOP"),
        day_pop=pl.col("E_DAYPOP"),
        housing_units=pl.col("E_HU"),
        households=pl.col("E_HH"),
        mobile_homes=pl.col("E_MOBILE"),
        age65=pl.col("E_AGE65"),
        households_noveh=pl.col("E_NOVEH"),
        svi=pl.col("RPL_THEMES"),
        svi_socioeconomic=pl.col("RPL_THEME1"),
        svi_household=pl.col("RPL_THEME2"),
        svi_minority=pl.col("RPL_THEME3"),
        svi_housing_transport=pl.col("RPL_THEME4"),
    ).with_columns(source=pl.lit("svi2022"))

    acs_path = RAW / "acs" / "acs2023_county.json"
    if acs_path.exists():
        rows = json.loads(acs_path.read_text())
        acs = pl.DataFrame(rows[1:], schema=rows[0], orient="row")
        age_cols = [c for c in acs.columns if c.startswith("B01001_")]
        acs = acs.select(
            county_fips=pl.col("state") + pl.col("county"),
            pop=pl.col("B01003_001E").cast(pl.Float64),
            housing_units=pl.col("B25001_001E").cast(pl.Float64),
            mobile_homes=pl.col("B25024_010E").cast(pl.Float64),
            units_total=pl.col("B25024_001E").cast(pl.Float64),
            households=pl.col("B08201_001E").cast(pl.Float64),
            households_noveh=pl.col("B08201_002E").cast(pl.Float64),
            age65=pl.sum_horizontal([pl.col(c).cast(pl.Float64) for c in age_cols]),
        )
        # prefer ACS 2023 counts where present, keep SVI for area, day pop, SVI ranks
        cf = cf.join(acs, on="county_fips", how="full", suffix="_acs", coalesce=True)
        for c in ["pop", "housing_units", "mobile_homes", "households", "households_noveh", "age65"]:
            cf = cf.with_columns(pl.coalesce(f"{c}_acs", c).alias(c)).drop(f"{c}_acs")
        cf = cf.with_columns(
            source=pl.when(pl.col("area_sqmi").is_null()).then(pl.lit("acs2023_only"))
            .when(pl.col("units_total").is_null()).then(pl.lit("svi2022"))
            .otherwise(pl.lit("acs2023+svi2022"))
        )
        print(f"  acs 2023 merged: {acs.height} counties")

    cf = cf.with_columns(
        mh_share=pl.col("mobile_homes") / pl.col("housing_units"),
        age65_share=pl.col("age65") / pl.col("pop"),
        noveh_share=pl.col("households_noveh") / pl.col("households"),
        pop_density=pl.col("pop") / pl.col("area_sqmi"),
    )
    print(f"county_features: {cf.height:,} counties")
    return cf


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    events, narr = build_events()
    fatalities = build_fatalities(events)
    counties = build_county_features()

    events.write_parquet(OUT / "events.parquet")
    fatalities.write_parquet(OUT / "fatalities.parquet")
    counties.write_parquet(OUT / "county_features.parquet")
    narr.write_parquet(OUT / "narratives.parquet")
    for p in sorted(OUT.glob("*.parquet")):
        print(f"  wrote {p.relative_to(ROOT)}  {p.stat().st_size / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
