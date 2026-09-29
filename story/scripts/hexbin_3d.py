"""
Builds a 3D extruded hexagon map: death density rises as glowing coral
columns out of the map, auto-rotating camera for a hands-off cinematic
demo. Tornado / Hurricane toggle swaps which dataset drives the columns.
Uses deck.gl's HexagonLayer. Self-contained HTML, brand-styled.

Run from inside story/ with:
    python3 scripts/hexbin_3d.py

Needs: pip3 install pandas requests
Reuses your existing data/raw/ cache -- should run fast, no new downloads.
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
YEAR_START, YEAR_END = 1996, 2025

CREAM, CORAL, NAVY, NAVY_LIGHT, CYAN = "#EEE4D7", "#FF4944", "#232E43", "#2E3A56", "#84F9FE"
DISPLAY_FONT, BODY_FONT = "Chakra Petch", "IBM Plex Mono"

HURRICANE_TYPES = ["Hurricane (Typhoon)", "Hurricane", "Tropical Storm", "Storm Surge/Tide"]


def latest_filename_for(kind, year, listing_html):
    pattern = rf"StormEvents_{kind}-ftp_v1\.0_d{year}_c(\d+)\.csv\.gz"
    matches = re.findall(pattern, listing_html)
    return f"StormEvents_{kind}-ftp_v1.0_d{year}_c{max(matches)}.csv.gz" if matches else None


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


print("Loading StormEvents (reusing cache where possible)...")
listing_html = requests.get(STORM_EVENTS_BASE, timeout=60).text

all_details, all_fatalities = [], []
for year in range(YEAR_START, YEAR_END + 1):
    dpath = download_year("details", year, listing_html)
    fpath = download_year("fatalities", year, listing_html)
    if dpath:
        d = read_gz_csv(dpath)
        all_details.append(d[["EVENT_ID", "EVENT_TYPE", "BEGIN_LAT", "BEGIN_LON"]])
    if fpath:
        all_fatalities.append(read_gz_csv(fpath))

details = pd.concat(all_details, ignore_index=True)
fatalities = pd.concat(all_fatalities, ignore_index=True)
merged = fatalities.merge(details, on="EVENT_ID", how="left")
merged = merged[merged["FATALITY_TYPE"] == "D"]
merged = merged.dropna(subset=["BEGIN_LAT", "BEGIN_LON"])

def points_for(event_types):
    sub = merged[merged["EVENT_TYPE"].isin(event_types)]
    return [
        {"position": [round(lon, 3), round(lat, 3)]}
        for lat, lon in zip(sub["BEGIN_LAT"], sub["BEGIN_LON"])
    ]

tornado_points = points_for(["Tornado"])
hurricane_points = points_for(HURRICANE_TYPES)
print(f"\n{len(tornado_points):,} tornado death points, {len(hurricane_points):,} hurricane death points")

# =====================================================================
# Write self-contained HTML
# =====================================================================

html = f"""<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Death Density, 3D</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@500;700&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<script src="https://unpkg.com/deck.gl@8.9.0/dist.min.js"></script>
<style>
  html, body {{ margin: 0; padding: 0; background: {NAVY}; overflow: hidden; }}
  #app {{ position: relative; width: 100vw; height: 100vh; }}
  #deck-canvas {{ position: absolute; top: 0; left: 0; width: 100%; height: 100%; }}
  #hud {{
    position: absolute; top: 28px; left: 32px; z-index: 10;
    font-family: '{DISPLAY_FONT}', sans-serif; color: {CREAM}; pointer-events: none;
  }}
  #hud h1 {{ font-size: 28px; margin: 0; letter-spacing: 1px; }}
  #hud .subtitle {{ font-family: '{BODY_FONT}', monospace; font-size: 13px; opacity: 0.6;
                     margin-top: 6px; letter-spacing: 0.5px; }}
  #toggle {{
    position: absolute; bottom: 32px; left: 32px; z-index: 10;
    display: flex; gap: 10px; font-family: '{BODY_FONT}', monospace;
  }}
  .toggle-btn {{
    background: {NAVY_LIGHT}; color: {CREAM}; border: 1.5px solid transparent;
    padding: 10px 22px; border-radius: 8px; font-family: '{BODY_FONT}', monospace;
    font-size: 14px; cursor: pointer; letter-spacing: 0.5px; transition: all 0.15s;
  }}
  .toggle-btn.active {{ border-color: {CORAL}; background: #3a2432; }}
  .toggle-btn:hover {{ border-color: {CREAM}; }}
  #source {{ position: absolute; bottom: 32px; right: 32px; z-index: 10;
             color: {CREAM}; opacity: 0.4; font-size: 11px; font-family: '{BODY_FONT}', monospace; }}
</style>
</head>
<body>
<div id="app">
  <canvas id="deck-canvas"></canvas>
  <div id="hud">
    <h1>DEATH DENSITY</h1>
    <div class="subtitle">TORNADO DEATHS, 1996&ndash;2025</div>
  </div>
  <div id="toggle">
    <button class="toggle-btn active" data-key="Tornado">Tornado</button>
    <button class="toggle-btn" data-key="Hurricane">Hurricane</button>
  </div>
  <div id="source">NOAA Storm Events Database, 1996&ndash;2025</div>
</div>

<script>
const TORNADO_POINTS = {json.dumps(tornado_points)};
const HURRICANE_POINTS = {json.dumps(hurricane_points)};
const CORAL = "{CORAL}";
const CYAN = "{CYAN}";

// Low -> high color ramp, brand palette
const COLOR_RANGE = [
  [45, 72, 135],
  [82, 72, 215],
  [8, 106, 237],
  [132, 249, 254],
  [255, 150, 120],
  [255, 73, 68],
];

const ROTATE_SPEED = 0.045;   // degrees per frame; full rotation ~2.2 min
const IDLE_RESUME_MS = 3000;  // pause auto-rotate this long after user interacts

// Basemap: world + US state outlines, built once (not per-frame -- see
// national_animation.py notes on why that matters for performance)
const worldLayer = new deck.GeoJsonLayer({{
  id: 'world-countries',
  data: 'https://d2ad6b4ur7yvpq.cloudfront.net/naturalearth-3.3.0/ne_50m_admin_0_scale_rank.geojson',
  filled: true,
  stroked: true,
  getFillColor: [46, 58, 86],
  getLineColor: [132, 249, 254, 40],
  getLineWidth: 800,
  lineWidthMinPixels: 0.5,
}});

const statesLayer = new deck.GeoJsonLayer({{
  id: 'us-states',
  data: 'https://raw.githubusercontent.com/PublicaMundi/MappingAPI/master/data/geojson/us-states.json',
  filled: false,
  stroked: true,
  getLineColor: [238, 228, 215, 50],
  getLineWidth: 1200,
  lineWidthMinPixels: 1,
}});

function buildLayers(stormType) {{
  const data = stormType === "Tornado" ? TORNADO_POINTS : HURRICANE_POINTS;
  const hexLayer = new deck.HexagonLayer({{
    id: 'hexbin',
    data,
    getPosition: d => d.position,
    radius: 30000,
    coverage: 0.88,
    extruded: true,
    elevationScale: 60,
    colorRange: COLOR_RANGE,
    material: {{ ambient: 0.5, diffuse: 0.6, shininess: 32,
                 specularColor: [255, 255, 255] }},
    transitions: {{ elevationScale: 400 }},
  }});
  return [worldLayer, statesLayer, hexLayer];
}}

let currentStormType = "Tornado";
let viewState = {{ longitude: -96, latitude: 37.5, zoom: 3.3, pitch: 55, bearing: 0 }};
let lastInteraction = 0;

const deckgl = new deck.Deck({{
  canvas: 'deck-canvas',
  viewState: viewState,
  controller: true,
  layers: buildLayers(currentStormType),
  parameters: {{ clearColor: [0.137, 0.180, 0.263, 1] }},
  onViewStateChange: ({{ viewState: vs, interactionState }}) => {{
    viewState = vs;
    if (interactionState && (interactionState.isDragging || interactionState.isPanning ||
        interactionState.isZooming || interactionState.isRotating)) {{
      lastInteraction = Date.now();
    }}
    deckgl.setProps({{ viewState }});
  }},
}});

function tick() {{
  if (Date.now() - lastInteraction > IDLE_RESUME_MS) {{
    viewState = {{ ...viewState, bearing: (viewState.bearing + ROTATE_SPEED) % 360 }};
    deckgl.setProps({{ viewState }});
  }}
  requestAnimationFrame(tick);
}}
requestAnimationFrame(tick);

document.querySelectorAll(".toggle-btn").forEach(btn => {{
  btn.addEventListener("click", () => {{
    document.querySelectorAll(".toggle-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    currentStormType = btn.dataset.key;
    document.querySelector("#hud .subtitle").textContent =
      currentStormType.toUpperCase() + " DEATHS, 1996\u20132025";
    deckgl.setProps({{ layers: buildLayers(currentStormType) }});
  }});
}});
</script>
</body>
</html>
"""

out_path = OUT_DIR / "hexbin_3d.html"
out_path.write_text(html, encoding="utf-8")
print(f"\nDone. Open {out_path} in your browser (Chrome/Firefox recommended).")
