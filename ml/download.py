"""Download raw data into data/raw/.

  python ml/download.py            # everything
  python ml/download.py --only storm
  python ml/download.py --only acs  # needs CENSUS_API_KEY in ml/.env or env

Storm Events: newest details + fatalities file per year (1996-2025).
SVI 2022 county parquet.
ACS 2023 5-year county variables (skipped if no key).
"""
import argparse
import json
import os
import re
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw"

STORM_URL = "https://www.ncei.noaa.gov/pub/data/swdi/stormevents/csvfiles/"
SVI_URL = "https://data.source.coop/cboettig/social-vulnerability/2022/SVI2022_US_county.parquet"
ACS_URL = "https://api.census.gov/data/2023/acs/acs5"

YEARS = range(1996, 2026)
KINDS = ("details", "fatalities")

ACS_VARS = {
    "B01003_001E": "pop",
    "B25001_001E": "housing_units",
    "B25024_001E": "units_total",
    "B25024_010E": "units_mobile",
    "B08201_001E": "households",
    "B08201_002E": "households_noveh",
    # 65+ male then female
    **{f"B01001_0{i}E": f"m_{i}" for i in range(20, 26)},
    **{f"B01001_0{i}E": f"f_{i}" for i in range(44, 50)},
}


def get(url, **kw):
    for attempt in range(4):
        try:
            r = requests.get(url, timeout=120, **kw)
            r.raise_for_status()
            return r
        except requests.RequestException as e:
            if attempt == 3:
                raise
            print(f"  retry {attempt + 1} for {url}: {e}")
            time.sleep(2 * (attempt + 1))


def download_file(url, dest):
    if dest.exists() and dest.stat().st_size > 0:
        return "cached"
    tmp = dest.with_suffix(dest.suffix + ".part")
    with get(url, stream=True) as r, open(tmp, "wb") as f:
        for chunk in r.iter_content(1 << 20):
            f.write(chunk)
    tmp.rename(dest)
    return "downloaded"


def storm_file_list():
    """Newest file per (kind, year) from the NCEI directory listing."""
    html = get(STORM_URL).text
    pat = re.compile(r"StormEvents_(details|fatalities)-ftp_v1\.0_d(\d{4})_c(\d{8})\.csv\.gz")
    newest = {}
    for kind, year, created in set(pat.findall(html)):
        key = (kind, int(year))
        if key[1] in YEARS and (key not in newest or created > newest[key]):
            newest[key] = created
    files = []
    for (kind, year), created in sorted(newest.items()):
        files.append(f"StormEvents_{kind}-ftp_v1.0_d{year}_c{created}.csv.gz")
    missing = [(k, y) for k in KINDS for y in YEARS if (k, y) not in newest]
    if missing:
        print(f"  WARNING: no file on server for {missing}")
    return files


def download_storm():
    out = RAW / "stormevents"
    out.mkdir(parents=True, exist_ok=True)
    files = storm_file_list()
    print(f"storm events: {len(files)} files")

    def one(name):
        return name, download_file(STORM_URL + name, out / name)

    with ThreadPoolExecutor(4) as pool:
        for name, status in pool.map(one, files):
            print(f"  {status:10s} {name}")

    # drop older versions of the same year so build_tables never reads two copies
    keep = set(files)
    for p in out.glob("StormEvents_*.csv.gz"):
        if p.name not in keep:
            print(f"  removing old version {p.name}")
            p.unlink()


def download_svi():
    out = RAW / "svi"
    out.mkdir(parents=True, exist_ok=True)
    status = download_file(SVI_URL, out / "SVI2022_US_county.parquet")
    print(f"svi: {status}")


def census_key():
    if os.environ.get("CENSUS_API_KEY"):
        return os.environ["CENSUS_API_KEY"].strip()
    env = ROOT / "ml" / ".env"
    if env.exists():
        for line in env.read_text().splitlines():
            if line.startswith("CENSUS_API_KEY="):
                return line.split("=", 1)[1].strip().strip('"')
    return None


def download_acs():
    key = census_key()
    if not key:
        print("acs: skipped, no CENSUS_API_KEY (county features will use SVI's ACS fields)")
        return
    out = RAW / "acs"
    out.mkdir(parents=True, exist_ok=True)
    params = {"get": "NAME," + ",".join(ACS_VARS), "for": "county:*", "in": "state:*", "key": key}
    r = get(ACS_URL, params=params, allow_redirects=False)
    if r.status_code != 200 or not r.text.startswith("["):
        raise RuntimeError(f"ACS request failed ({r.status_code}): {r.text[:200]}")
    rows = r.json()
    (out / "acs2023_county.json").write_text(json.dumps(rows))
    print(f"acs: {len(rows) - 1} counties")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", choices=["storm", "svi", "acs"])
    args = ap.parse_args()
    steps = {"storm": download_storm, "svi": download_svi, "acs": download_acs}
    for name, fn in steps.items():
        if args.only in (None, name):
            fn()


if __name__ == "__main__":
    main()
