# Refuge

Storm simulator for real American towns. Pick a place, send a tornado or flash flood through the real buildings, see who is at risk and why, then plan protections and replay the storm.

Carolina Data Challenge 2026, Natural Science track.

## Who owns what

| Folder | Owner | What |
|---|---|---|
| `ml/` | ML lead (@THEpranavsomalraju) | risk + location models, calibration, backtest, landing page data |
| `sim/params/sim_params.json` | ML lead | calibrated params (rest of `sim/` is Simulation) |
| `places/` | Structures and 3D (@thepatkinator) | Structure Inventory pipeline, roads, streams, terrain, crossings |
| `web/src/scene/` | Structures and 3D | 3D town |
| `web/src/landing/` | Structures and 3D | landing page |
| `sim/` | Simulation (@mahilmanoharan) | engine, storm effects, protections, optimizer, CLI |
| `web/src/game/` | Simulation | game UI and results panel |
| `web/src/shared/` | everyone | agree before editing |
| `story/` | Story lead | research, costs, copy, slides, DevPost |

Only edit your own folders. `data/` is gitignored, so keep raw downloads there.

## Getting started

```bash
git clone https://github.com/THEpranavsomalraju/refuge.git
cd refuge
git checkout -b <your-folder>/<task>
```

Read `REFUGE_overview.md` first, then your role file (`ROLE_ml.md`, `ROLE_structures_3d.md`, `ROLE_simulation.md`).

## Rules

- Small PRs, pull often
- Nothing over 20 MB, no `.env` files
- Shared file formats are in `REFUGE_overview.md`. Don't change them without telling the team.
