"""
Builds story/flourish/deaths_map.csv — one row per storm death, with
location, date, and storm type. This is the file you upload to Flourish's
"Point Map" template for the intro "growing map of deaths" chart.

What this script does, in plain terms:
1. Downloads NOAA's "details" and "fatalities" files for every year from
   1996 to today (skips files it already has, so re-running is fast).
2. Matches each death (fatalities file) to its storm event (details file)
   using EVENT_ID, so we get a location and storm type for every death.
3. Cleans it into one small CSV Flourish can read directly.

Run it from the story/ folder with:
    python scripts/build_death_map.py
"""

import gzip
import io
import re
import sys
from pathlib import Path

import pandas as pd
import requests

BASE_URL = "https://www.ncei.noaa.gov/pub/data/swdi/stormevents/csvfiles/"
RAW_DIR = Path("data/raw")
OUT_DIR = Path("flourish")
YEARS = range(1996, 2026)  # 1996 through 2025, per team convention

RAW_DIR.mkdir(parents=True, exist_ok=True)
OUT_DIR.mkdir(parents=True, exist_ok=True)


def latest_filename_for(kind: str, year: int, listing_html: str) -> str | None:
    """Find the newest file for a given year + kind (details/fatalities).

    NOAA's file names carry a creation date that changes, e.g.
    StormEvents_details-ftp_v1.0_d2024_c20260728.csv.gz
    so we search the folder listing rather than guessing the name.
    """
    pattern = rf"StormEvents_{kind}-ftp_v1\.0_d{year}_c(\d+)\.csv\.gz"
    matches = re.findall(pattern, listing_html)
    if not matches:
        return None
    latest_c = max(matches)  # creation-date strings sort correctly as text
    return f"StormEvents_{kind}-ftp_v1.0_d{year}_c{latest_c}.csv.gz"


def download_year(kind: str, year: int, listing_html: str) -> Path | None:
    fname = latest_filename_for(kind, year, listing_html)
    if fname is None:
        print(f"  no {kind} file found for {year}, skipping")
        return None

    local_path = RAW_DIR / fname
    if local_path.exists():
        return local_path  # already downloaded

    url = BASE_URL + fname
    print(f"  downloading {fname} ...")
    resp = requests.get(url, timeout=120)
    resp.raise_for_status()
    local_path.write_bytes(resp.content)
    return local_path


def read_gz_csv(path: Path) -> pd.DataFrame:
    with gzip.open(path, "rb") as f:
        return pd.read_csv(io.BytesIO(f.read()), low_memory=False)


def money_or_year_two_digit_fix(details: pd.DataFrame) -> pd.DataFrame:
    # BEGIN_DATE_TIME uses a 2-digit year like "08-MAY-24 18:12:00".
    # We trust the separate YEAR column for the real century instead of
    # parsing that string's year part.
    return details


def main():
    print("Fetching NOAA folder listing...")
    listing_html = requests.get(BASE_URL, timeout=60).text

    all_fatalities = []
    all_details = []

    for year in YEARS:
        print(f"Year {year}:")
        details_path = download_year("details", year, listing_html)
        fatalities_path = download_year("fatalities", year, listing_html)

        if details_path:
            d = read_gz_csv(details_path)
            d["YEAR"] = year
            all_details.append(d[[
                "EVENT_ID", "EVENT_TYPE", "STATE",
                "BEGIN_LAT", "BEGIN_LON", "YEAR",
            ]])

        if fatalities_path:
            f = read_gz_csv(fatalities_path)
            all_fatalities.append(f)

    print("Combining years...")
    details = pd.concat(all_details, ignore_index=True)
    fatalities = pd.concat(all_fatalities, ignore_index=True)

    print("Joining fatalities to their storm event (for location + type)...")
    merged = fatalities.merge(details, on="EVENT_ID", how="left")

    # Keep only direct deaths with a usable location, matching the
    # role doc's "count direct deaths by default" rule.
    merged = merged[merged["FATALITY_TYPE"] == "D"]
    merged = merged.dropna(subset=["BEGIN_LAT", "BEGIN_LON", "FATALITY_DATE"])

    # Storm type grouping, matching the rest of the team's categories
    GROUPS = {
        "Tornado": "Tornado",
        "Thunderstorm Wind": "Thunderstorm Wind",
        "Hail": "Hail",
        "Flash Flood": "Flooding", "Flood": "Flooding",
        "Heavy Rain": "Flooding", "Debris Flow": "Flooding",
        "Hurricane": "Tropical", "Hurricane (Typhoon)": "Tropical",
        "Tropical Storm": "Tropical", "Tropical Depression": "Tropical",
        "Storm Surge/Tide": "Tropical",
        "Winter Storm": "Winter", "Heavy Snow": "Winter", "Ice Storm": "Winter",
        "Blizzard": "Winter", "Winter Weather": "Winter",
        "Cold/Wind Chill": "Winter", "Extreme Cold/Wind Chill": "Winter",
        "Frost/Freeze": "Winter",
        "Heat": "Heat", "Excessive Heat": "Heat",
        "High Wind": "Wind", "Strong Wind": "Wind",
        "Lightning": "Lightning",
        "Rip Current": "Coastal", "High Surf": "Coastal",
        "Coastal Flood": "Coastal", "Sneakerwave": "Coastal",
        "Wildfire": "Wildfire",
    }
    merged["storm_group"] = merged["EVENT_TYPE"].map(GROUPS).fillna("Other")

    out = pd.DataFrame({
        "latitude": merged["BEGIN_LAT"],
        "longitude": merged["BEGIN_LON"],
        "date": pd.to_datetime(merged["FATALITY_DATE"], errors="coerce"),
        "storm_type": merged["storm_group"],
        "state": merged["STATE"],
    }).dropna(subset=["date"])

    out = out.sort_values("date")

    out_path = OUT_DIR / "deaths_map.csv"
    out.to_csv(out_path, index=False)
    print(f"\nDone. Wrote {len(out):,} rows to {out_path}")
    print("Columns: latitude, longitude, date, storm_type, state")


if __name__ == "__main__":
    main()
