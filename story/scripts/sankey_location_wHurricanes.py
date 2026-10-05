"""
Builds a Sankey diagram: storm type (Tornado / Hurricane) -> where the
person died (Mobile home, House, Vehicle, etc.) -> self-contained HTML,
brand-styled, animated flows on load. Uses D3 + d3-sankey.

Run from inside story/ with:
    python3 scripts/sankey_location.py

Needs: pip3 install pandas requests
Reuses your existing data/raw/ cache (same StormEvents files the other
scripts already downloaded) — should run fast with no new downloads.
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

# Same location grouping as the ML location model
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
        all_details.append(d[["EVENT_ID", "EVENT_TYPE"]])
    if fpath:
        all_fatalities.append(read_gz_csv(fpath))

details = pd.concat(all_details, ignore_index=True)
fatalities = pd.concat(all_fatalities, ignore_index=True)
merged = fatalities.merge(details, on="EVENT_ID", how="left")
merged = merged[merged["FATALITY_TYPE"] == "D"]

merged = merged[merged["EVENT_TYPE"].isin(["Tornado"] + HURRICANE_TYPES)]
merged["storm_type"] = merged["EVENT_TYPE"].apply(lambda t: "Tornado" if t == "Tornado" else "Hurricane")
merged["location_group"] = merged["FATALITY_LOCATION"].map(LOCATION_GROUPS).fillna("Other or unknown")

counts = merged.groupby(["storm_type", "location_group"]).size().reset_index(name="count")
counts = counts[counts["count"] > 0]
print(f"\n{len(merged):,} deaths total, across {len(counts)} storm-type/location pairs:")
print(counts.to_string(index=False))

# --- Build Sankey node/link structure ---
storm_types = sorted(counts["storm_type"].unique())
locations = sorted(counts["location_group"].unique(), key=lambda x: -counts[counts["location_group"] == x]["count"].sum())

nodes = [{"name": s} for s in storm_types] + [{"name": l} for l in locations]
node_index = {n["name"]: i for i, n in enumerate(nodes)}

links = [
    {"source": node_index[row["storm_type"]], "target": node_index[row["location_group"]], "value": int(row["count"])}
    for _, row in counts.iterrows()
]

sankey_data = {"nodes": nodes, "links": links}

# =====================================================================
# Write self-contained HTML
# =====================================================================

# Distinct colors for each destination location (not just source-based),
# so a flow is traceable by color even where lines cross
LOCATION_COLORS = {
    "Mobile home": "#FF4944",     # coral (mirrors Tornado, its dominant source)
    "House": "#B94A6B",
    "Vehicle": "#84F9FE",         # cyan (mirrors Hurricane, its dominant source)
    "Water": "#086AED",
    "Outdoors": "#5248D7",
    "Public building": "#2D2DCA",
    "Other or unknown": "#5A6987",
}

html = f"""<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Storm Type to Fatality Location</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@500;700&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<script src="https://cdnjs.cloudflare.com/ajax/libs/d3/7.8.5/d3.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/d3-sankey/0.12.3/d3-sankey.min.js"></script>
<style>
  html, body {{ margin: 0; padding: 0; background: {NAVY}; font-family: '{BODY_FONT}', monospace; }}
  #wrap {{ width: 100vw; min-height: 100vh; display: flex; flex-direction: column; align-items: center;
           padding: 40px 20px; box-sizing: border-box; }}
  h1 {{ font-family: '{DISPLAY_FONT}', sans-serif; color: {CREAM}; font-size: 28px; letter-spacing: 1px;
        margin: 0 0 4px 0; text-align: center; }}
  .subtitle {{ color: {CREAM}; opacity: 0.6; font-size: 13px; margin-bottom: 28px; text-align: center; }}
  #sankey {{ width: 100%; max-width: 1200px; height: auto; }}
  .node rect {{ stroke: {NAVY}; stroke-width: 1.5px; }}
  .node text {{ fill: {CREAM}; font-family: '{BODY_FONT}', monospace; font-size: 14px; }}
  .link {{ fill: none; stroke-opacity: 0.55; transition: stroke-opacity 0.2s, filter 0.2s; }}
  .link:hover {{ stroke-opacity: 0.95; filter: brightness(1.3); }}
  .value-label {{ fill: {CREAM}; opacity: 0.55; font-size: 11px; font-family: '{BODY_FONT}', monospace; }}
  #source {{ color: {CREAM}; opacity: 0.4; font-size: 11px; text-align: right; width: 100%;
             max-width: 1200px; margin-top: 16px; }}
</style>
</head>
<body>
<div id="wrap">
  <h1>WHERE PEOPLE DIED</h1>
  <div class="subtitle">Tornado &amp; hurricane deaths by location, 1996&ndash;2025 &middot; direct deaths only</div>
  <svg id="sankey" viewBox="0 0 1200 680" preserveAspectRatio="xMidYMid meet"></svg>
  <div id="source">NOAA Storm Events Database, 1996&ndash;2025</div>
</div>

<script>
const DATA = {json.dumps(sankey_data)};
const CORAL = "{CORAL}";
const CYAN = "{CYAN}";
const CREAM = "{CREAM}";

const NODE_COLORS = {{
  "Tornado": CORAL,
  "Hurricane": CYAN,
}};
const LOCATION_COLORS = {json.dumps(LOCATION_COLORS)};
const DEFAULT_COLOR = "#5A6987";

function colorFor(name) {{
  return NODE_COLORS[name] || LOCATION_COLORS[name] || DEFAULT_COLOR;
}}

const svg = d3.select("#sankey");
const width = 1200;
const height = 680;

const sankeyGen = d3.sankey()
  .nodeWidth(20)
  .nodePadding(40)
  .extent([[1, 30], [width - 1, height - 30]]);

const graph = sankeyGen({{
  nodes: DATA.nodes.map(d => Object.assign({{}}, d)),
  // Sort links so the thickest flows stack together — much less visual
  // crossing/tangling than the original arbitrary order
  links: DATA.links.map(d => Object.assign({{}}, d)).sort((a, b) => b.value - a.value),
}});

// A per-link gradient (source color -> destination's own color) makes each
// flow visually traceable end-to-end, even where paths cross each other
const defs = svg.append("defs");
graph.links.forEach((d, i) => {{
  const gradId = "grad-" + i;
  d.gradId = gradId;
  const grad = defs.append("linearGradient")
    .attr("id", gradId)
    .attr("gradientUnits", "userSpaceOnUse")
    .attr("x1", d.source.x1).attr("x2", d.target.x0);
  grad.append("stop").attr("offset", "0%").attr("stop-color", colorFor(d.source.name));
  grad.append("stop").attr("offset", "100%").attr("stop-color", colorFor(d.target.name));
}});

// Links
const link = svg.append("g")
  .selectAll("path")
  .data(graph.links)
  .join("path")
  .attr("class", "link")
  .attr("d", d3.sankeyLinkHorizontal())
  .attr("stroke", d => `url(#${{d.gradId}})`)
  .attr("stroke-width", d => Math.max(1.5, d.width))
  .attr("stroke-dasharray", function() {{ return this.getTotalLength(); }})
  .attr("stroke-dashoffset", function() {{ return this.getTotalLength(); }});

link.transition()
  .duration(1400)
  .delay((d, i) => i * 80)
  .ease(d3.easeCubicInOut)
  .attr("stroke-dashoffset", 0);

// Nodes
const node = svg.append("g")
  .selectAll("rect")
  .data(graph.nodes)
  .join("rect")
  .attr("class", "node")
  .attr("x", d => d.x0)
  .attr("y", d => d.y0)
  .attr("height", d => d.y1 - d.y0)
  .attr("width", d => d.x1 - d.x0)
  .attr("fill", d => colorFor(d.name))
  .style("opacity", 0);

node.transition().duration(600).delay(1000).style("opacity", 1);

// Labels
const label = svg.append("g")
  .selectAll("text")
  .data(graph.nodes)
  .join("text")
  .attr("x", d => d.x0 < width / 2 ? d.x1 + 10 : d.x0 - 10)
  .attr("y", d => (d.y0 + d.y1) / 2)
  .attr("dy", "0.35em")
  .attr("text-anchor", d => d.x0 < width / 2 ? "start" : "end")
  .attr("fill", "{CREAM}")
  .attr("font-family", "'{BODY_FONT}', monospace")
  .attr("font-size", "15px")
  .attr("font-weight", "600")
  .text(d => d.name)
  .style("opacity", 0);

label.transition().duration(600).delay(1200).style("opacity", 1);

// Value labels under each node
const valueLabel = svg.append("g")
  .selectAll("text")
  .data(graph.nodes)
  .join("text")
  .attr("class", "value-label")
  .attr("x", d => d.x0 < width / 2 ? d.x1 + 10 : d.x0 - 10)
  .attr("y", d => (d.y0 + d.y1) / 2 + 18)
  .attr("text-anchor", d => d.x0 < width / 2 ? "start" : "end")
  .text(d => d.value.toLocaleString() + " deaths")
  .style("opacity", 0);

valueLabel.transition().duration(600).delay(1200).style("opacity", 1);

// Hover highlight: dim all but the hovered flow
link.on("mouseover", function(event, d) {{
  link.transition().duration(150).attr("stroke-opacity", l => l === d ? 0.95 : 0.08);
}}).on("mouseout", function() {{
  link.transition().duration(150).attr("stroke-opacity", 0.55);
}});
</script>
</body>
</html>
"""

out_path = OUT_DIR / "sankey_locationHurricanes.html"
out_path.write_text(html, encoding="utf-8")
print(f"\nDone. Open {out_path} in your browser.")
