"""
Builds a linked small-multiples dashboard: a Tornado / Hurricane / Both
toggle at the top, with four mini-charts below that all update together --
fatality location breakdown, night vs day split, age 65+ share, and a
mobile-home/vehicle highlight. Self-contained HTML, brand-styled.

Run from inside story/ with:
    python3 scripts/risk_factors_dashboard.py

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

LOCATION_GROUPS = {
    "Mobile/Trailer Home": "Mobile home",
    "Permanent Home": "House",
    "Permanent Structure": "Public building",
    "Business": "Public building",
    "School": "Public building",
    "Church": "Public building",
    "Long Span Roof": "Public building",
    "Vehicle/Towed Trailer": "Vehicle",
    "In Water": "Water",
    "Boating": "Water",
    "Outside/Open Areas": "Outdoors",
    "Under Tree": "Outdoors",
    "Camping": "Outdoors",
    "Ball Field": "Outdoors",
    "Golfing": "Outdoors",
    "Heavy Equipment/Construction": "Outdoors",
}
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
        all_details.append(d[["EVENT_ID", "EVENT_TYPE", "BEGIN_TIME"]])
    if fpath:
        all_fatalities.append(read_gz_csv(fpath))

details = pd.concat(all_details, ignore_index=True)
fatalities = pd.concat(all_fatalities, ignore_index=True)
merged = fatalities.merge(details, on="EVENT_ID", how="left")
merged = merged[merged["FATALITY_TYPE"] == "D"]
merged = merged[merged["EVENT_TYPE"].isin(["Tornado"] + HURRICANE_TYPES)]
merged["storm_type"] = merged["EVENT_TYPE"].apply(lambda t: "Tornado" if t == "Tornado" else "Hurricane")

merged["location_group"] = merged["FATALITY_LOCATION"].map(LOCATION_GROUPS).fillna("Other or unknown")

# BEGIN_TIME is HHMM as an int/string (e.g. 1812 for 18:12). Night = 20:00-05:59,
# matching the convention already agreed in the team's email thread.
def hour_from_begin_time(v):
    try:
        v = int(v)
        return v // 100
    except (ValueError, TypeError):
        return None

merged["hour"] = merged["BEGIN_TIME"].apply(hour_from_begin_time)
merged["night_day"] = merged["hour"].apply(
    lambda h: "Unknown" if pd.isna(h) else ("Night" if (h >= 20 or h < 6) else "Day")
)

merged["age_group"] = merged["FATALITY_AGE"].apply(
    lambda a: "Unknown" if pd.isna(a) else ("65+" if a >= 65 else "Under 65")
)

def build_summary(df):
    total = len(df)
    if total == 0:
        return None
    location = df["location_group"].value_counts().to_dict()
    night_day = df["night_day"].value_counts().to_dict()
    age_group = df["age_group"].value_counts().to_dict()
    return {
        "total": total,
        "location": location,
        "night_day": night_day,
        "age_group": age_group,
        "night_pct": round(100 * night_day.get("Night", 0) / total, 1),
        "over65_pct": round(100 * age_group.get("65+", 0) / total, 1),
        # location as % of this storm type's own total, for the mirrored comparison
        "location_pct": {k: round(100 * v / total, 1) for k, v in location.items()},
    }

summaries = {
    "Both": build_summary(merged),
    "Tornado": build_summary(merged[merged["storm_type"] == "Tornado"]),
    "Hurricane": build_summary(merged[merged["storm_type"] == "Hurricane"]),
}

# Age x Location cross-tab per storm type, as % of that storm type's total
# deaths per cell -- this is the "compounding risk" heatmap data
AGE_ORDER = ["Under 65", "65+", "Unknown"]

def build_heatmap(df, total):
    cross = df.groupby(["location_group", "age_group"]).size()
    locations = df["location_group"].value_counts().index.tolist()
    grid = []
    for loc in locations:
        row = {"location": loc}
        for age in AGE_ORDER:
            count = cross.get((loc, age), 0)
            row[age] = round(100 * count / total, 1)
        grid.append(row)
    return grid

heatmaps = {
    "Tornado": build_heatmap(merged[merged["storm_type"] == "Tornado"], summaries["Tornado"]["total"]),
    "Hurricane": build_heatmap(merged[merged["storm_type"] == "Hurricane"], summaries["Hurricane"]["total"]),
}

print("\nSummary stats:")
for k, v in summaries.items():
    print(f"  {k}: total={v['total']}, night={v['night_pct']}%, over65={v['over65_pct']}%")
    print(f"    location breakdown (%): {v['location_pct']}")

# =====================================================================
# Write self-contained HTML
# =====================================================================

html = f"""<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Risk Factors Dashboard</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@500;700&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<script src="https://cdnjs.cloudflare.com/ajax/libs/d3/7.8.5/d3.min.js"></script>
<style>
  html, body {{ margin: 0; padding: 0; background: {NAVY}; font-family: '{BODY_FONT}', monospace; }}
  #wrap {{ width: 100vw; min-height: 100vh; display: flex; flex-direction: column; align-items: center;
           padding: 40px 20px; box-sizing: border-box; }}
  h1 {{ font-family: '{DISPLAY_FONT}', sans-serif; color: {CREAM}; font-size: 28px; letter-spacing: 1px;
        margin: 0 0 4px 0; text-align: center; }}
  .subtitle {{ color: {CREAM}; opacity: 0.6; font-size: 13px; margin-bottom: 28px; text-align: center; }}
  .section-title {{ font-family: '{DISPLAY_FONT}', sans-serif; color: {CREAM}; font-size: 17px;
                     letter-spacing: 0.5px; margin: 0 0 4px 0; text-align: center; }}
  .section-subtitle {{ color: {CREAM}; opacity: 0.55; font-size: 12px; margin-bottom: 18px; text-align: center; }}

  .panel {{ background: {NAVY_LIGHT}; border-radius: 12px; padding: 26px 30px; margin-bottom: 28px;
            width: 100%; max-width: 980px; box-sizing: border-box; }}

  /* Mirrored bar chart */
  .mirror-row {{ display: grid; grid-template-columns: 1fr 140px 1fr; align-items: center;
                 margin-bottom: 10px; font-size: 13px; color: {CREAM}; }}
  .mirror-bar-left {{ display: flex; justify-content: flex-end; }}
  .mirror-bar-right {{ display: flex; justify-content: flex-start; }}
  .mirror-fill {{ height: 22px; border-radius: 4px 0 0 4px; transition: width 0.6s cubic-bezier(.2,.8,.2,1); }}
  .mirror-fill.right {{ border-radius: 0 4px 4px 0; }}
  .mirror-label {{ text-align: center; opacity: 0.85; font-size: 12px; color: {CREAM}; }}
  .mirror-value {{ font-size: 11px; opacity: 0.7; padding: 0 8px; white-space: nowrap; color: {CREAM}; }}
  .legend-row {{ display: flex; justify-content: center; gap: 28px; margin-bottom: 20px; font-size: 12px; color: {CREAM}; }}
  .legend-swatch {{ display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 6px; vertical-align: middle; }}

  /* Heatmap */
  .heatmap-wrap {{ display: flex; gap: 40px; justify-content: center; flex-wrap: wrap; }}
  .heatmap-col h3 {{ font-family: '{DISPLAY_FONT}', sans-serif; color: {CREAM}; font-size: 14px;
                      text-align: center; margin: 0 0 10px 153px; width: 198px; }}
  .heatmap-grid {{ display: grid; grid-template-columns: 150px repeat(3, 64px); gap: 3px; }}
  .hm-cell {{ display: flex; align-items: center; justify-content: center; font-size: 11px;
              color: {CREAM}; height: 34px; border-radius: 3px; }}
  .hm-rowlabel {{ justify-content: flex-end; padding-right: 8px; opacity: 0.85; background: none !important;
                  white-space: nowrap; }}
  .hm-collabel {{ opacity: 0.6; font-size: 10px; background: none !important; }}

  /* Small supporting cards */
  #small-grid {{ display: grid; grid-template-columns: repeat(2, 1fr); gap: 24px;
                 width: 100%; max-width: 980px; }}
  .small-panel {{ background: {NAVY_LIGHT}; border-radius: 12px; padding: 20px 24px; }}
  .panel-title {{ font-family: '{DISPLAY_FONT}', sans-serif; color: {CREAM}; font-size: 14px;
                  letter-spacing: 0.5px; margin: 0 0 4px 0; }}
  .panel-stat {{ font-family: '{BODY_FONT}', monospace; color: {CORAL}; font-size: 30px;
                 font-weight: 600; margin: 2px 0 12px 0; }}
  .bar-row {{ display: flex; align-items: center; margin-bottom: 7px; font-size: 12px; color: {CREAM}; }}
  .bar-label {{ width: 90px; flex-shrink: 0; opacity: 0.85; }}
  .bar-track {{ flex: 1; background: rgba(238,228,215,0.12); border-radius: 4px; height: 14px;
                overflow: hidden; margin-right: 10px; }}
  .bar-fill {{ height: 100%; border-radius: 4px; transition: width 0.5s cubic-bezier(.2,.8,.2,1); }}
  .bar-value {{ width: 46px; text-align: right; opacity: 0.7; flex-shrink: 0; }}

  #toggle {{ display: flex; gap: 10px; margin-bottom: 16px; }}
  .toggle-btn {{
    background: {NAVY_LIGHT}; color: {CREAM}; border: 1.5px solid transparent;
    padding: 8px 20px; border-radius: 8px; font-family: '{BODY_FONT}', monospace;
    font-size: 13px; cursor: pointer; letter-spacing: 0.5px; transition: all 0.15s;
  }}
  .toggle-btn.active {{ border-color: {CORAL}; background: #3a2432; }}
  .toggle-btn:hover {{ border-color: {CREAM}; }}

  #source {{ color: {CREAM}; opacity: 0.4; font-size: 11px; text-align: right; width: 100%;
             max-width: 980px; margin-top: 4px; }}
</style>
</head>
<body>
<div id="wrap">
  <h1>RISK FACTORS</h1>
  <div class="subtitle">Tornado &amp; hurricane deaths, 1996&ndash;2025 &middot; direct deaths only</div>

  <!-- Panel A: How each storm kills -->
  <div class="panel">
    <div class="section-title">HOW EACH STORM KILLS</div>
    <div class="section-subtitle">Where deaths happened, as a share of each storm type&rsquo;s own total</div>
    <div class="legend-row">
      <span><span class="legend-swatch" style="background:{CORAL}"></span>Tornado</span>
      <span><span class="legend-swatch" style="background:{CYAN}"></span>Hurricane</span>
    </div>
    <div id="mirror-chart"></div>
  </div>

  <!-- Panel B: Compounding risk heatmaps -->
  <div class="panel">
    <div class="section-title">COMPOUNDING RISK</div>
    <div class="section-subtitle">Age &times; location, as a share of each storm type&rsquo;s own total &mdash; darker means more deaths</div>
    <div class="heatmap-wrap">
      <div class="heatmap-col">
        <h3 style="color:{CORAL}">TORNADO</h3>
        <div class="heatmap-grid" id="heatmap-tornado"></div>
      </div>
      <div class="heatmap-col">
        <h3 style="color:{CYAN}">HURRICANE</h3>
        <div class="heatmap-grid" id="heatmap-hurricane"></div>
      </div>
    </div>
  </div>

  <!-- Supporting cards: night/day, age, still toggleable -->
  <div id="toggle">
    <button class="toggle-btn active" data-key="Both">Both</button>
    <button class="toggle-btn" data-key="Tornado">Tornado</button>
    <button class="toggle-btn" data-key="Hurricane">Hurricane</button>
  </div>
  <div id="small-grid">
    <div class="small-panel">
      <div class="panel-title">NIGHT VS. DAY</div>
      <div class="panel-stat" id="stat-night">--%</div>
      <div id="chart-nightday"></div>
    </div>
    <div class="small-panel">
      <div class="panel-title">AGE 65+</div>
      <div class="panel-stat" id="stat-over65">--%</div>
      <div id="chart-age"></div>
    </div>
  </div>
  <div id="source">NOAA Storm Events Database, 1996&ndash;2025</div>
</div>

<script>
const SUMMARIES = {json.dumps(summaries)};
const HEATMAPS = {json.dumps(heatmaps)};
const AGE_ORDER = {json.dumps(AGE_ORDER)};
const CORAL = "{CORAL}";
const CYAN = "{CYAN}";
const CREAM = "{CREAM}";
const PALETTE = ["{CORAL}", "{CYAN}", "#5248D7", "#086AED", "#5A6987", "#B94A6B"];

// --- Panel A: mirrored bar chart (Tornado left, Hurricane right) ---
function renderMirrorChart() {{
  const tornadoLoc = SUMMARIES["Tornado"].location_pct;
  const hurricaneLoc = SUMMARIES["Hurricane"].location_pct;
  const allLocations = Array.from(new Set([...Object.keys(tornadoLoc), ...Object.keys(hurricaneLoc)]));
  // Sort by combined magnitude, biggest contrast first
  allLocations.sort((a, b) => (tornadoLoc[b] || 0) + (hurricaneLoc[b] || 0) - ((tornadoLoc[a] || 0) + (hurricaneLoc[a] || 0)));

  const maxVal = Math.max(...allLocations.map(l => Math.max(tornadoLoc[l] || 0, hurricaneLoc[l] || 0)));
  const container = d3.select("#mirror-chart");

  allLocations.forEach(loc => {{
    const row = container.append("div").attr("class", "mirror-row");
    const tVal = tornadoLoc[loc] || 0;
    const hVal = hurricaneLoc[loc] || 0;

    const left = row.append("div").attr("class", "mirror-bar-left");
    left.append("span").attr("class", "mirror-value").text(tVal + "%");
    left.append("div").attr("class", "mirror-fill")
      .style("background", CORAL)
      .style("width", (tVal / maxVal * 100) + "px");

    row.append("div").attr("class", "mirror-label").text(loc);

    const right = row.append("div").attr("class", "mirror-bar-right");
    right.append("div").attr("class", "mirror-fill right")
      .style("background", CYAN)
      .style("width", (hVal / maxVal * 100) + "px");
    right.append("span").attr("class", "mirror-value").text(hVal + "%");
  }});
}}

// --- Panel B: heatmaps ---
function colorForPct(pct, maxPct) {{
  const t = Math.min(1, pct / maxPct);
  // Interpolate from navy-light (low) to coral (high)
  const c = d3.interpolateRgb("#2E3A56", "#FF4944")(t);
  return c;
}}

function renderHeatmap(containerId, grid) {{
  const container = d3.select("#" + containerId);
  const maxPct = Math.max(...grid.flatMap(row => AGE_ORDER.map(age => row[age])));
  // Shorter label here only -- guarantees it fits on one line regardless
  // of exact column width, rather than fighting text-wrapping edge cases
  const SHORT_LABEL = {{ "Other or unknown": "Other/Unknown" }};

  container.append("div").attr("class", "hm-cell hm-rowlabel hm-collabel").text("");
  AGE_ORDER.forEach(age => {{
    container.append("div").attr("class", "hm-cell hm-collabel").text(age);
  }});

  grid.forEach(row => {{
    const label = SHORT_LABEL[row.location] || row.location;
    container.append("div").attr("class", "hm-cell hm-rowlabel").text(label);
    AGE_ORDER.forEach(age => {{
      container.append("div")
        .attr("class", "hm-cell")
        .style("background", colorForPct(row[age], maxPct))
        .text(row[age] + "%");
    }});
  }});
}}

// --- Supporting cards ---
function barChart(containerId, dataObj, total) {{
  const container = d3.select("#" + containerId);
  container.selectAll("*").remove();
  const entries = Object.entries(dataObj).sort((a, b) => b[1] - a[1]);
  entries.forEach((d, i) => {{
    const row = container.append("div").attr("class", "bar-row");
    row.append("div").attr("class", "bar-label").text(d[0]);
    const track = row.append("div").attr("class", "bar-track");
    track.append("div").attr("class", "bar-fill")
      .style("background", PALETTE[i % PALETTE.length])
      .style("width", (100 * d[1] / total) + "%");
    row.append("div").attr("class", "bar-value").text(Math.round(100 * d[1] / total) + "%");
  }});
}}

function renderSmallCards(key) {{
  const s = SUMMARIES[key];
  if (!s) return;
  document.getElementById("stat-night").textContent = s.night_pct + "%";
  document.getElementById("stat-over65").textContent = s.over65_pct + "%";
  barChart("chart-nightday", s.night_day, s.total);
  barChart("chart-age", s.age_group, s.total);
}}

document.querySelectorAll(".toggle-btn").forEach(btn => {{
  btn.addEventListener("click", () => {{
    document.querySelectorAll(".toggle-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    renderSmallCards(btn.dataset.key);
  }});
}});

renderMirrorChart();
renderHeatmap("heatmap-tornado", HEATMAPS["Tornado"]);
renderHeatmap("heatmap-hurricane", HEATMAPS["Hurricane"]);
renderSmallCards("Both");
</script>
</body>
</html>
"""

out_path = OUT_DIR / "risk_factors_dashboard.html"
out_path.write_text(html, encoding="utf-8")
print(f"\nDone. Open {out_path} in your browser.")
