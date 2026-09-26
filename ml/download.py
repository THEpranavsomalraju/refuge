"""Download raw data into data/raw/.

  python ml/download.py            # everything
  python ml/download.py --only storm

Storm Events: newest details + fatalities file per year (1996-2025).
SVI 2022 county parquet (includes ACS 2018-2022 county counts).
NHTS 2017 + 2022 (FHWA travel survey) trip files for the hourly traffic curve.
FHWA Highway Statistics 2023 tables VM-2 (VMT) and HM-20 (road miles) for daily volume per road class.
"""
import argparse
import re
import zipfile
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw"

STORM_URL = "https://www.ncei.noaa.gov/pub/data/swdi/stormevents/csvfiles/"
SVI_URL = "https://data.source.coop/cboettig/social-vulnerability/2022/SVI2022_US_county.parquet"
NHTS = {  # (url, zip name, trip file inside)
    "2017": ("https://nhts.ornl.gov/assets/2016/download/csv.zip", "nhts2017_csv.zip", "trippub.csv"),
    "2022": ("https://nhts.ornl.gov/assets/2022/download/csv.zip", "nhts2022_csv.zip", "tripv2pub.csv"),
}

YEARS = range(1996, 2026)
KINDS = ("details", "fatalities")



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


FHWA_TABLES = {t: f"https://www.fhwa.dot.gov/policyinformation/statistics/2023/{t}.cfm" for t in ("vm2", "hm20")}


def download_fhwa():
    out = RAW / "fhwa"
    out.mkdir(parents=True, exist_ok=True)
    for name, url in FHWA_TABLES.items():
        print(f"fhwa {name}: {download_file(url, out / f'{name}_2023.html')}")


def download_nhts():
    out = RAW / "nhts"
    out.mkdir(parents=True, exist_ok=True)
    for year, (url, zname, trip) in NHTS.items():
        status = download_file(url, out / zname)
        if not (out / trip).exists():
            with zipfile.ZipFile(out / zname) as z:
                z.extract(trip, out)
        print(f"nhts {year}: {status}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", choices=["storm", "svi", "nhts", "fhwa"])
    args = ap.parse_args()
    steps = {"storm": download_storm, "svi": download_svi, "nhts": download_nhts, "fhwa": download_fhwa}
    for name, fn in steps.items():
        if args.only in (None, name):
            fn()


if __name__ == "__main__":
    main()
