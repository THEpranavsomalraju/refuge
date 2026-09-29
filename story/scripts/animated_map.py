"""
Builds an animated, brand-styled "growing" map of tornado + flash flood
deaths (1996-2025) as a single self-contained HTML file — dark navy theme,
Chakra Petch title, IBM Plex Mono data, coral/cyan dots that fade in smoothly
as the timeline plays. Matches the Refuge brand board.

Run from inside story/ with:
    python3 scripts/animated_map.py

Needs: pip3 install pandas plotly numpy
"""

import numpy as np
import pandas as pd
import plotly.graph_objects as go

IN_PATH = "flourish/deaths_map.csv"
OUT_PATH = "flourish/deaths_map.html"

# --- Brand colors, from Gray_Green_Modern..._Brand_Board.pdf ---
CREAM = "#EEE4D7"
CORAL = "#FF4944"
NAVY = "#232E43"
NAVY_LIGHT = "#2E3A56"   # a lighter tint of navy, for land/panel fill
PURPLE = "#5248D7"
BLUE_DEEP = "#2D2DCA"
BLUE_BRIGHT = "#086AED"
CYAN = "#84F9FE"

TORNADO_COLOR = CORAL
FLOOD_COLOR = CYAN

DISPLAY_FONT = "Chakra Petch"
BODY_FONT = "IBM Plex Mono"

FADE_MONTHS = 3       # how many months a dot takes to fully fade in
FRAME_MS = 25          # time each frame plays for at 1x (lower = faster playback)
TRANSITION_MS = 90     # smoothing between frames at 1x

# --- Load + prep data ---
df = pd.read_csv(IN_PATH, parse_dates=["date"]).sort_values("date").reset_index(drop=True)
df["month_idx"] = (df["date"].dt.year - df["date"].dt.year.min()) * 12 + (df["date"].dt.month - 1)
n_frames = int(df["month_idx"].max()) + 1

# Build one label per frame, e.g. "Jan 1996"
start_year = df["date"].dt.year.min()
frame_dates = pd.date_range(f"{start_year}-01-01", periods=n_frames, freq="MS")
frame_labels = [d.strftime("%b %Y") for d in frame_dates]

# --- Vectorized fade-in opacity: shape (n_points, n_frames) ---
frame_idx = np.arange(n_frames)
month_idx = df["month_idx"].to_numpy()
opacity_all = np.clip((frame_idx[None, :] - month_idx[:, None] + 1) / FADE_MONTHS, 0, 1)

types = {"Tornado": TORNADO_COLOR, "Flooding": FLOOD_COLOR}
masks = {t: (df["storm_type"] == t).to_numpy() for t in types}

# --- Base traces (constant lat/lon; only opacity changes per frame) ---
fig = go.Figure()
for t, color in types.items():
    m = masks[t]
    fig.add_trace(go.Scattergeo(
        lat=df.loc[m, "latitude"],
        lon=df.loc[m, "longitude"],
        mode="markers",
        name=t,
        marker=dict(size=6, color=color, opacity=opacity_all[m, 0], line=dict(width=0)),
        hovertemplate="%{customdata[0]}<br>" + t + "<extra></extra>",
        customdata=df.loc[m, ["state"]].to_numpy(),
    ))

# --- Frames ---
frames = []
for f in range(n_frames):
    frame_data = []
    for t in types:
        m = masks[t]
        frame_data.append(go.Scattergeo(marker=dict(opacity=opacity_all[m, f])))
    frames.append(go.Frame(name=str(f), data=frame_data, traces=[0, 1]))
fig.frames = frames

# --- Slider ---
slider_steps = [
    dict(
        method="animate",
        args=[[str(f)], dict(mode="immediate",
                              frame=dict(duration=TRANSITION_MS, redraw=True),
                              transition=dict(duration=TRANSITION_MS, easing="cubic-in-out"))],
        label=frame_labels[f] if frame_dates[f].month == 1 else "",
    )
    for f in range(n_frames)
]

fig.update_layout(
    sliders=[dict(
        active=0,
        x=0.08, y=0, len=0.86,
        pad=dict(t=20, b=10),
        currentvalue=dict(visible=True, prefix="", xanchor="left",
                           font=dict(size=16, family=BODY_FONT, color=CREAM)),
        font=dict(size=11, family=BODY_FONT, color=CREAM),
        bgcolor=NAVY_LIGHT, activebgcolor=CORAL, bordercolor=NAVY_LIGHT,
        steps=slider_steps,
    )],
    updatemenus=[dict(
        type="buttons", showactive=False,
        x=0.0, y=0, xanchor="left", yanchor="top", pad=dict(t=20, r=10),
        bgcolor=NAVY_LIGHT, bordercolor=CREAM, font=dict(color=CREAM, family=BODY_FONT),
        buttons=[
            dict(label="▶", method="animate",
                 args=[None, dict(frame=dict(duration=FRAME_MS, redraw=True),
                                   transition=dict(duration=TRANSITION_MS, easing="cubic-in-out"),
                                   fromcurrent=True, mode="immediate")]),
            dict(label="⏸", method="animate",
                 args=[[None], dict(frame=dict(duration=0, redraw=False),
                                     mode="immediate", transition=dict(duration=0))]),
        ],
    )],
)

# --- Map + overall styling ---
fig.update_geos(
    scope="usa",
    bgcolor=NAVY,
    landcolor=NAVY_LIGHT,
    lakecolor=NAVY,
    showsubunits=True, subunitcolor="rgba(238,228,215,0.25)",   # state lines
    showcountries=True, countrycolor="rgba(238,228,215,0.35)",
    showcoastlines=False,
)

fig.update_traces(hoverlabel=dict(bgcolor=NAVY_LIGHT, font=dict(family=BODY_FONT, color=CREAM)))

fig.update_layout(
    title=dict(text="TORNADO &amp; FLASH FLOOD DEATHS, 1996–2025",
               font=dict(family=DISPLAY_FONT, size=30, color=CREAM),
               x=0.03, xanchor="left"),
    paper_bgcolor=NAVY,
    plot_bgcolor=NAVY,
    font=dict(family=BODY_FONT, color=CREAM),
    legend=dict(bgcolor="rgba(0,0,0,0)", font=dict(family=BODY_FONT, color=CREAM),
                orientation="h", x=0.98, y=0.99, xanchor="right", yanchor="top"),
    height=800,
    margin=dict(l=20, r=20, t=100, b=160),
)

# --- Write file, then inject brand fonts + page-level background ---
fig.write_html(OUT_PATH, include_plotlyjs=True, full_html=True)

with open(OUT_PATH, "r", encoding="utf-8") as f:
    html = f.read()

head_inject = f"""
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@500;700&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  html, body {{ margin: 0; padding: 0; background: {NAVY}; }}
  .plotly-graph-div {{ margin: 0 auto; }}
</style>
"""
html = html.replace("<head>", "<head>" + head_inject, 1)

with open(OUT_PATH, "w", encoding="utf-8") as f:
    f.write(html)

# --- Inject a "Speed" button. At higher speeds it SKIPS frames instead of
#     just requesting shorter durations — browser redraw time is the real
#     bottleneck with this many points, so thinning frames is what actually
#     makes it feel faster (shrinking duration alone hits a wall). ---
frame_name_list = [str(f) for f in range(n_frames)]
speed_widget = f"""
<div style="text-align:center; margin-top: 8px; padding-bottom: 24px; font-family:'{BODY_FONT}', monospace;">
  <button id="speedBtn" style="
      background:{NAVY_LIGHT}; color:{CREAM}; border:1px solid {CORAL};
      padding:8px 18px; border-radius:6px; font-family:'{BODY_FONT}', monospace;
      font-size:14px; cursor:pointer; letter-spacing:0.5px;">
    Speed: 1x
  </button>
</div>
<script>
(function() {{
  var gd = document.getElementsByClassName('plotly-graph-div')[0];
  var frameNames = {frame_name_list!r};
  var currentIdx = 0;
  var speedMult = 1;
  var baseFrame = {FRAME_MS};
  var baseTrans = {TRANSITION_MS};
  var btn = document.getElementById('speedBtn');

  gd.on('plotly_animatingframe', function(ev) {{
    var idx = frameNames.indexOf(ev.frame.name);
    if (idx !== -1) {{ currentIdx = idx; }}
  }});

  btn.addEventListener('click', function() {{
    speedMult = speedMult >= 64 ? 1 : speedMult * 2;
    btn.innerText = 'Speed: ' + speedMult + 'x';

    // Above 2x, start skipping frames (step = speedMult / 2) so we're
    // actually rendering fewer frames, not just asking for them faster.
    var step = Math.max(1, Math.floor(speedMult / 2));
    var pool = frameNames.slice(currentIdx);
    var remaining = pool.filter(function(_, i) {{ return i % step === 0; }});
    if (remaining.length < 2) {{
      remaining = frameNames.filter(function(_, i) {{ return i % step === 0; }});
      currentIdx = 0;
    }}

    Plotly.animate(gd, remaining, {{
      frame: {{ duration: Math.max(4, baseFrame / Math.min(speedMult, 4)), redraw: true }},
      transition: {{ duration: Math.max(0, baseTrans / Math.min(speedMult, 4)), easing: 'cubic-in-out' }},
      mode: 'immediate',
    }});
  }});
}})();
</script>
"""
html = html.replace("</body>", speed_widget + "</body>", 1)

with open(OUT_PATH, "w", encoding="utf-8") as f:
    f.write(html)

print(f"Done. {n_frames} monthly frames written to {OUT_PATH}.")
print("Open it in a browser, hit play, then click 'Speed: 1x' to double the "
      "speed each click (wraps back to 1x after 32x).")
