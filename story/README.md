# Story visualizations

Scripts that build the story charts. Each one downloads the NOAA data it needs into `data/raw/` (gitignored) and writes a self-contained HTML file to `flourish/`.

Run from this folder with Python 3.10+:

```bash
cd story
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python scripts/sankey_location.py
```

| Script | Output (`flourish/`) | Chart |
|---|---|---|
| `build_death_map.py`, then `animated_map.py` | `deaths_map.csv`, `deaths_map.html` | Growing map of every storm death |
| `national_animation.py` | `national_animation.html` | Tornado deaths and Atlantic hurricane tracks, 1996–2025 |
| `sankey_location.py` | `sankey_location.html` | Storm type (tornado, flooding) → where people died |
| `sankey_location_wHurricanes.py` | `sankey_locationHurricanes.html` | Same, with hurricanes |
| `risk_factors_dashboard.py` | `risk_factors_dashboard.html` | Location, night vs day, and age 65+ by storm type |
| `hexbin_3d.py` | `hexbin_3d.html` | 3D hexagon map of death density |

Data: NOAA Storm Events Database, 1996–2025, and NOAA HURDAT2 (Atlantic hurricane tracks).

The sankey, risk factors dashboard and national animation also appear on the website; copies live in `web/public/charts/`.
