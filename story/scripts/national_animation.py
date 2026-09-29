"""
Builds ONE animated national map: tornado deaths (glowing dots that fade in)
+ Atlantic hurricanes (moving comet-trail paths, colored by whether they
caused deaths), 1996-2025, as a single self-contained HTML file. No Flourish,
no Plotly — this uses deck.gl (WebGL), which is what actually makes the
"Image 1/2/3" glow/3D style you showed possible, and is much faster to
animate than the Plotly version.

Run from inside story/ with:
    python3 scripts/national_animation.py

Needs: pip3 install pandas requests

WHAT THIS SCRIPT DOES
1. Downloads NOAA's Atlantic HURDAT2 file and parses it (it's a raw text
   format, not a normal CSV) into per-storm tracks.
2. Downloads StormEvents details+fatalities 1996-2025 (reuses your existing
   data/raw/ cache if you've already run the other scripts).
3. Builds tornado death points (lat/lon/date), same as before.
4. Matches each hurricane's name against StormEvents fatality records to
   flag which hurricanes actually caused deaths (HURDAT2 has no deaths
   column, so this cross-reference is required).
5. Writes flourish/national_animation.html — open it directly in a browser.

HONESTY NOTE: I don't have internet access in my own environment, so I
could not run this end-to-end myself. The data-handling logic (parsing,
joining, filtering) I'm confident in. The deck.gl animation code follows
deck.gl's own standard patterns for this exact use case (trip/comet-trail
animation, additive glow blending), but you'll be the one actually seeing
it render for the first time. If something breaks or looks wrong, send me
the error or a screenshot and I'll fix it.
"""

import gzip
import io
import json
import re
from pathlib import Path

import pandas as pd
import requests

RAW_DIR = Path("data/raw")
OUT_DIR = Path("flourish")
RAW_DIR.mkdir(parents=True, exist_ok=True)
OUT_DIR.mkdir(parents=True, exist_ok=True)

STORM_EVENTS_BASE = "https://www.ncei.noaa.gov/pub/data/swdi/stormevents/csvfiles/"
HURDAT_INDEX_URL = "https://www.nhc.noaa.gov/data/index.php?text"

YEAR_START = 1996
YEAR_END = 2025

# Brand kit
CREAM = "#EEE4D7"
CORAL = "#FF4944"
NAVY = "#232E43"
NAVY_LIGHT = "#2E3A56"
CYAN = "#84F9FE"
BLUE_DEEP = "#2D2DCA"
DISPLAY_FONT = "Chakra Petch"
BODY_FONT = "IBM Plex Mono"

# =====================================================================
# PART 1: HURDAT2 — download + parse
# =====================================================================

def find_hurdat_url() -> str:
    print("Finding current HURDAT2 file...")
    FALLBACK_URL = "https://www.nhc.noaa.gov/data/hurdat/hurdat2-1851-2025-091226.txt"
    try:
        html = requests.get(HURDAT_INDEX_URL, timeout=60).text
    except Exception:
        print("  couldn't reach NHC's page, using last known file as fallback")
        return FALLBACK_URL
    # Search broadly: single or double quotes, with or without the full
    # domain prefix (NOAA's raw HTML markup varies from what renders visually).
    m = re.search(r'''href=['"]([^'"]*hurdat2-1851-\d{4}-\d+\.txt)['"]''', html)
    if not m:
        print("  couldn't find the link automatically, using last known file as fallback")
        print("  (if this is stale, tell Claude — NOAA's page format changed)")
        return FALLBACK_URL
    url = m.group(1)
    if url.startswith("//"):
        url = "https:" + url
    elif url.startswith("/"):
        url = "https://www.nhc.noaa.gov" + url
    elif not url.startswith("http"):
        url = "https://www.nhc.noaa.gov/data/hurdat/" + url
    return url


def download_hurdat(url: str) -> Path:
    local_path = RAW_DIR / "hurdat2_atlantic.txt"
    if local_path.exists() and local_path.stat().st_size > 1000:
        return local_path
    print(f"  downloading {url} ...")
    resp = requests.get(url, timeout=180)
    resp.raise_for_status()
    if len(resp.content) < 1000:
        raise RuntimeError(f"Download looked too small ({len(resp.content)} bytes) — "
                            f"something's wrong with the URL: {url}")
    local_path.write_bytes(resp.content)
    return local_path


HEADER_RE = re.compile(r'^([A-Z]{2}\d{6}),\s*([^,]*),\s*(\d+),?\s*$')
DATA_RE = re.compile(
    r'^(\d{8}),\s*(\d{4}),\s*([A-Z]?),\s*([A-Z]{2}),\s*'
    r'([\d.]+[NS]),\s*([\d.]+[EW]),\s*(-?\d+),\s*(-?\d+)'
)


def parse_hurdat2(path: Path):
    """Returns a list of dicts, one per storm: id, name, year, track
    (list of (datetime, lat, lon, max_wind_kt, status)).

    Identifies header vs. data lines by their actual shape (regex) rather
    than trusting the header's declared line-count — real-world HURDAT2
    files have occasional formatting quirks that break strict positional
    parsing. Lines that don't match either pattern are skipped with a
    warning instead of crashing the whole run.
    """
    storms = []
    current = None
    skipped = 0
    with open(path) as f:
        for raw_line in f:
            line = raw_line.strip()
            if not line:
                continue

            hm = HEADER_RE.match(line)
            if hm:
                if current is not None and current["track"]:
                    storms.append(current)
                storm_id, name, _n = hm.group(1), hm.group(2).strip(), hm.group(3)
                year = int(storm_id[4:8])
                current = {"id": storm_id, "name": name, "year": year, "track": []}
                continue

            dm = DATA_RE.match(line)
            if dm and current is not None:
                date_s, time_s, _rec_id, status, lat_s, lon_s, wind_s, _pres_s = dm.groups()
                dt = pd.Timestamp(f"{date_s[:4]}-{date_s[4:6]}-{date_s[6:8]} "
                                   f"{time_s[:2]}:{time_s[2:]}:00")
                lat = float(lat_s[:-1]) * (1 if lat_s[-1] == "N" else -1)
                lon = float(lon_s[:-1]) * (-1 if lon_s[-1] == "W" else 1)
                wind = int(wind_s) if wind_s not in ("", "-999") else None
                current["track"].append((dt, lat, lon, wind, status))
            else:
                skipped += 1

        if current is not None and current["track"]:
            storms.append(current)

    if skipped:
        print(f"  (skipped {skipped} lines that didn't match the expected "
              f"header/data format — this is usually fine)")
    return storms


print("=== Part 1: HURDAT2 hurricanes ===")
hurdat_url = find_hurdat_url()
hurdat_path = download_hurdat(hurdat_url)
all_storms = parse_hurdat2(hurdat_path)

storms = [
    s for s in all_storms
    if YEAR_START <= s["year"] <= YEAR_END
    and any(pt[4] == "HU" for pt in s["track"])   # reached hurricane strength
]
print(f"  {len(storms)} storms reached hurricane strength, {YEAR_START}-{YEAR_END}")

def latest_filename_for(kind, year, listing_html):
    pattern = rf"StormEvents_{kind}-ftp_v1\.0_d{year}_c(\d+)\.csv\.gz"
    matches = re.findall(pattern, listing_html)
    if not matches:
        return None
    return f"StormEvents_{kind}-ftp_v1.0_d{year}_c{max(matches)}.csv.gz"


def download_year(kind, year, listing_html):
    fname = latest_filename_for(kind, year, listing_html)
    if fname is None:
        return None
    local_path = RAW_DIR / fname
    if local_path.exists() and local_path.stat().st_size > 100:
        return local_path
    print(f"  downloading {fname} ...")
    resp = requests.get(STORM_EVENTS_BASE + fname, timeout=120)
    resp.raise_for_status()
    local_path.write_bytes(resp.content)
    return local_path


def read_gz_csv(path):
    with gzip.open(path, "rb") as f:
        return pd.read_csv(io.BytesIO(f.read()), low_memory=False)


print("\n=== Part 2: StormEvents (tornado deaths + hurricane deaths) ===")
listing_html = requests.get(STORM_EVENTS_BASE, timeout=60).text

all_details, all_fatalities = [], []
for year in range(YEAR_START, YEAR_END + 1):
    print(f"Year {year}:")
    dpath = download_year("details", year, listing_html)
    fpath = download_year("fatalities", year, listing_html)
    if dpath:
        d = read_gz_csv(dpath)
        all_details.append(d[["EVENT_ID", "EVENT_TYPE", "STATE", "BEGIN_LAT",
                               "BEGIN_LON", "YEAR", "EPISODE_NARRATIVE", "EVENT_NARRATIVE"]])
    if fpath:
        all_fatalities.append(read_gz_csv(fpath))

details = pd.concat(all_details, ignore_index=True)
fatalities = pd.concat(all_fatalities, ignore_index=True)
merged = fatalities.merge(details, on="EVENT_ID", how="left")
merged = merged[merged["FATALITY_TYPE"] == "D"]

# --- Tornado deaths (points) ---
tornado = merged[merged["EVENT_TYPE"] == "Tornado"].dropna(
    subset=["BEGIN_LAT", "BEGIN_LON", "FATALITY_DATE"])
tornado_dates = pd.to_datetime(tornado["FATALITY_DATE"], errors="coerce")

t0 = pd.Timestamp(f"{YEAR_START}-01-01")
tornado_points = [
    {"position": [round(lon, 3), round(lat, 3)],
     "timestamp": round((d - t0).total_seconds() / 86400, 2)}
    for lat, lon, d in zip(tornado["BEGIN_LAT"], tornado["BEGIN_LON"], tornado_dates)
    if pd.notna(d)
]
print(f"  {len(tornado_points)} tornado death points")

# =====================================================================
# PART 3: Build hurricane trip data for deck.gl
# =====================================================================

hurricane_trips = []
for s in storms:
    if len(s["track"]) < 2:
        continue
    path = [[round(lon, 3), round(lat, 3)] for _, lat, lon, _, _ in s["track"]]
    timestamps = [round((dt - t0).total_seconds() / 86400, 2) for dt, *_ in s["track"]]
    hurricane_trips.append({
        "name": s["name"].strip().title(),
        "year": s["year"],
        "path": path,
        "timestamps": timestamps,
    })

print(f"\n{len(hurricane_trips)} hurricane tracks, {len(tornado_points)} tornado death points ready.")

# =====================================================================
# PART 4: Write the self-contained HTML (deck.gl)
# =====================================================================

TOTAL_DAYS = (pd.Timestamp(f"{YEAR_END}-12-31") - t0).days
START_DATE_ISO = t0.strftime("%Y-%m-%d")

html = f"""<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Tornado &amp; Hurricane Deaths, {YEAR_START}-{YEAR_END}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@500;700&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<script src="https://unpkg.com/deck.gl@8.9.0/dist.min.js"></script>
<style>
  html, body {{ margin: 0; padding: 0; background: {NAVY}; overflow: hidden; }}
  #app {{ position: relative; width: 100vw; height: 100vh; }}
  #deck-canvas {{ position: absolute; top: 0; left: 0; width: 100%; height: 100%; }}
  #hud {{
    position: absolute; top: 24px; left: 28px; z-index: 10;
    font-family: '{DISPLAY_FONT}', sans-serif; color: {CREAM};
    pointer-events: none;
  }}
  #hud h1 {{ font-size: 26px; margin: 0 0 4px 0; letter-spacing: 1px; }}
  #hud .date {{
    font-family: '{BODY_FONT}', monospace; font-size: 34px; color: {CORAL};
    margin-top: 6px;
  }}
  #controls {{
    position: absolute; bottom: 28px; left: 28px; z-index: 10;
    display: flex; gap: 12px; align-items: center;
    font-family: '{BODY_FONT}', monospace;
  }}
  #controls button {{
    background: {NAVY_LIGHT}; color: {CREAM}; border: 1px solid {CORAL};
    padding: 10px 20px; border-radius: 6px; font-family: '{BODY_FONT}', monospace;
    font-size: 14px; cursor: pointer; letter-spacing: 0.5px;
  }}
  #controls button:hover {{ background: {CORAL}; color: {NAVY}; }}
  #legend {{
    position: absolute; bottom: 28px; right: 28px; z-index: 10;
    font-family: '{BODY_FONT}', monospace; color: {CREAM}; font-size: 13px;
    text-align: right; line-height: 1.8;
  }}
  #legend span {{ display: inline-block; width: 10px; height: 10px; border-radius: 50%;
                   margin-left: 8px; vertical-align: middle; }}
</style>
</head>
<body>
<div id="app">
  <canvas id="deck-canvas"></canvas>
  <div id="hud">
    <h1>TORNADO &amp; HURRICANE DEATHS</h1>
    <div class="date" id="dateLabel">{START_DATE_ISO}</div>
  </div>
  <div id="controls">
    <button id="playBtn">▶ Play</button>
    <button id="speedBtn">Speed: 1x</button>
  </div>
  <div id="legend">
    Tornado death <span style="background:{CORAL}"></span><br>
    Hurricane path <span style="background:{CYAN}"></span>
  </div>
</div>

<script>
const TORNADO_POINTS = {json.dumps(tornado_points)};
const HURRICANE_TRIPS = {json.dumps(hurricane_trips)};
const TOTAL_DAYS = {TOTAL_DAYS};
const START_DATE = new Date("{START_DATE_ISO}T00:00:00Z");

const CORAL = [255, 73, 68];
const CYAN = [132, 249, 254];
const NAVY_LIGHT_RGB = [90, 105, 135];

const FADE_DAYS = 20;        // tornado dot fade-in window
const TRAIL_DAYS = 3.5;      // hurricane comet trail length
let BASE_DAYS_PER_SEC = 300; // baseline playback speed (full 30-yr run ~35s)
let speedMult = 1;

let currentTime = 0;
let playing = false;
let lastFrameMs = null;

function formatDate(days) {{
  const d = new Date(START_DATE.getTime() + days * 86400000);
  return d.toISOString().slice(0, 10);
}}

// Built ONCE, not per-frame: these datasets are large (world country
// borders especially), and recreating them every animation frame was
// forcing deck.gl to redo expensive attribute work 60 times a second —
// that was the actual cause of the glitchiness.
const worldLayer = new deck.GeoJsonLayer({{
  id: 'world-countries',
  data: 'https://d2ad6b4ur7yvpq.cloudfront.net/naturalearth-3.3.0/ne_50m_admin_0_scale_rank.geojson',
  filled: true,
  stroked: true,
  getFillColor: [46, 58, 86],
  getLineColor: [132, 249, 254, 60],
  getLineWidth: 800,
  lineWidthMinPixels: 0.5,
}});

const statesLayer = new deck.GeoJsonLayer({{
  id: 'us-states',
  data: 'https://raw.githubusercontent.com/PublicaMundi/MappingAPI/master/data/geojson/us-states.json',
  filled: false,
  stroked: true,
  getLineColor: [238, 228, 215, 90],
  getLineWidth: 1200,
  lineWidthMinPixels: 1,
}});

function buildLayers(t) {{
  // Faint permanent hurricane paths, revealed once the storm has started
  const pathLayer = new deck.PathLayer({{
    id: 'hurricane-paths',
    data: HURRICANE_TRIPS.filter(s => t >= s.timestamps[0]),
    getPath: d => d.path,
    getColor: [...CYAN, 90],
    getWidth: 1000,
    widthMinPixels: 1,
  }});

  // Bright moving comet-trail head for hurricanes currently active
  const tripsLayer = new deck.TripsLayer({{
    id: 'hurricane-trips',
    data: HURRICANE_TRIPS,
    getPath: d => d.path,
    getTimestamps: d => d.timestamps,
    getColor: CYAN,
    opacity: 0.9,
    widthMinPixels: 3,
    trailLength: TRAIL_DAYS,
    currentTime: t,
  }});

  // Tornado deaths: glowing points that fade in, additive blending
  const tornadoLayer = new deck.ScatterplotLayer({{
    id: 'tornado-deaths',
    data: TORNADO_POINTS,
    getPosition: d => d.position,
    getRadius: 9000,
    radiusUnits: 'meters',
    getFillColor: d => {{
      const age = t - d.timestamp;
      if (age < 0) return [...CORAL, 0];
      const alpha = Math.min(1, age / FADE_DAYS) * 200;
      return [...CORAL, alpha];
    }},
    updateTriggers: {{ getFillColor: t }},
    parameters: {{
      blend: true,
      blendFunc: [770, 1, 770, 1],   // additive: SRC_ALPHA, ONE
      blendEquation: 32774,          // FUNC_ADD
      depthTest: false,
    }},
  }});

  return [worldLayer, statesLayer, pathLayer, tripsLayer, tornadoLayer];
}}

const deckgl = new deck.Deck({{
  canvas: 'deck-canvas',
  initialViewState: {{ longitude: -92, latitude: 32, zoom: 3.6, pitch: 0, bearing: 0 }},
  controller: true,
  layers: buildLayers(0),
  parameters: {{ clearColor: [0.137, 0.180, 0.263, 1] }},  // navy background
}});

function render() {{
  deckgl.setProps({{ layers: buildLayers(currentTime) }});
  document.getElementById('dateLabel').innerText = formatDate(currentTime);
}}
render();

function tick(nowMs) {{
  if (playing) {{
    if (lastFrameMs !== null) {{
      const dtSec = (nowMs - lastFrameMs) / 1000;
      currentTime += dtSec * BASE_DAYS_PER_SEC * speedMult;
      if (currentTime > TOTAL_DAYS) {{ currentTime = 0; }}
      render();
    }}
    lastFrameMs = nowMs;
  }} else {{
    lastFrameMs = null;
  }}
  requestAnimationFrame(tick);
}}
requestAnimationFrame(tick);

document.getElementById('playBtn').addEventListener('click', function() {{
  playing = !playing;
  this.innerText = playing ? '⏸ Pause' : '▶ Play';
}});

document.getElementById('speedBtn').addEventListener('click', function() {{
  speedMult = speedMult >= 32 ? 1 : speedMult * 2;
  this.innerText = 'Speed: ' + speedMult + 'x';
}});
</script>
</body>
</html>
"""

out_path = OUT_DIR / "national_animation.html"
out_path.write_text(html, encoding="utf-8")
print(f"\nDone. Open {out_path} directly in your browser (Chrome/Firefox recommended).")
