# Role: Structures and 3D (read with REFUGE_overview.md)

You are helping me build my part of Refuge, a storm simulator for real towns. Read REFUGE_overview.md first. My job: turn real building, road, stream, and terrain data into clean place files and a 3D town. I pair all day with the Simulation teammate, who builds the engine reading my files. Every format change I make gets tested against the engine the same hour.

## Folders I own
`places/` (Python pipeline and outputs), `web/src/scene/` (3D town), `web/src/landing/` (landing page below the game). Do not edit other folders without asking me.

## Datasets for my role

| Data | Use | Link |
|---|---|---|
| USACE National Structure Inventory (API) | Every building: occupancy type, stories, basement, elevation, flood zone, day and night population by age | API docs: https://www.hec.usace.army.mil/confluence/nsi/technicalreferences/latest/api-reference-guide |
| NSI example query | Structures by bounding box or county FIPS | `https://nsi.sec.usace.army.mil/nsiapi/structures?bbox=...` and `https://nsi.sec.usace.army.mil/nsiapi/structures?fips=37021` |
| NSI attribute list | Field meanings | https://github.com/USACE-NSI/NSI/blob/master/NSI_Attributes.MD |
| OpenStreetMap, North Carolina extract | Roads, building footprint shapes, parks, campgrounds, ball fields | https://download.geofabrik.de/north-america/us/north-carolina.html |
| OpenStreetMap Overpass API | Small area queries without downloading the state file | https://overpass-api.de/api/interpreter |
| Microsoft US Building Footprints (backup) | Footprint shapes where OSM lacks buildings | https://github.com/microsoft/USBuildingFootprints |
| USGS 3DEP elevation | Terrain and height above stream | Python library `py3dep` (HyRiver project), or https://apps.nationalmap.gov/downloader/ |
| National Hydrography Dataset | Streams and rivers | Python library `pynhd` (HyRiver project) |
| AWS Terrain Tiles (free, no key) | Terrain mesh in the browser | `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png` |
| Kenney assets (free, CC0) | Low-poly cars, trees, props | https://kenney.nl/assets |
| Poly Pizza (free low-poly models) | Extra props | https://poly.pizza |
| H3 hexagon grid (Uber, open source) | Cell ids for the risk map, Python `h3` and browser `h3-js` | https://h3geo.org |

## Phase 1 (hours 0 to 3): one place end to end
1. Set up `places/requirements.txt` with pinned versions: requests, geopandas, shapely, pyproj, numpy, py3dep, pynhd, osmnx, h3.
2. Write `places/fetch_nsi.py` with a reusable function `fetch_buildings(bbox)` returning a GeoDataFrame from the NSI API. The ML lead reuses this function for the historical tornado backtest across the country, so keep the function clean, cached to disk, and documented.
3. Map NSI `occtype` to our `cls` values. Starting rules to verify against the NSI attribute docs: `RES2` means manufactured housing, so `MH`. `RES1` with masonry or concrete construction goes to `RES_MASONRY`, other `RES1` to `RES_WOOD`. `RES3` goes to `MULTI`. `EDU` types go to `SCHOOL`. `REL` types go to `WORSHIP`. Large `COM` buildings above a floor-area threshold go to `BIGROOF`, other `COM` to `COMMERCIAL`. Everything else goes to `OTHER`. Print counts per class for the place.
4. Basement from the NSI foundation type. First floor height from `found_ht` (feet, convert to meters).
5. Match NSI points to OSM footprints by point-in-polygon. When no footprint exists, generate a small rectangle sized from `sqft`.
6. Assign every building an H3 cell id at resolution 10 (`h3` Python library, version 4 API: `latlng_to_cell(lat, lon, 10)`) and keep the NSI census block code `cbfips`. Also give every crossing an H3 id.
7. Write `places/<place_id>/cells.json`: every H3 cell touching the place with its hexagon boundary coordinates, center, ground elevation, and night and day people counts. The scene draws hexagons from this file.
8. Write `places/<place_id>/buildings.json` exactly as in the overview. Send the first files to the Simulation teammate by hour 3.

## Phase 2 (hours 3 to 8): water, roads, terrain, 3D
1. Streams from `pynhd`, elevation from `py3dep`. Compute `hand_m` (height above nearest drainage) for every building: building ground elevation minus elevation of the nearest stream point. Simple nearest-stream version first.
2. Roads from OSM. Find low water crossings: points where a road line crosses a stream line and the road elevation sits within a few meters of the stream. Assign `cars_per_hour` from road class times an hourly traffic curve (the ML lead or Story lead supplies the curve from Census commuting data). Write `crossings.json`.
3. Write `place.json` with bbox, center, camera start, stream lines, and road lines.
4. 3D town in React Three Fiber: terrain mesh, buildings extruded from footprints to real story counts, colored by `cls`, roads and streams drawn on the terrain. Use instanced meshes and merged geometry so 5,000 buildings stay smooth. Stylized low-poly look, calm palette agreed with the Story lead. If I use GPT Astra through my ChatGPT subscription for scene code, keep the output as normal TypeScript files in `web/src/scene/`.
5. Expose a scene API the game code calls: `setBuildingGlow(id, value0to1)`, `setWaterLevel(m)`, `showTornadoPath(coords, width)`, `placeProtection(type, lon, lat)`, `onBuildingClick(callback)`, `onCellHover(callback)`.
6. The risk map layer in `web/src/scene/RiskMap.tsx`:
   - `showRiskMap(cells, bands)`: draws a hexagon for each cell from `cells.json`, draped on the terrain. Color from the cell's band, height from expected deaths (scaled, capped). Empty cells stay uncolored. Cells below `min_cell_people` show an outline only. Cells flagged `uncertain` get a hatched texture.
   - Transition: weather fades, buildings fade to neutral gray, hexagons rise band by band with deep red last, then hold.
   - `showDifference(beforeCells, afterCells)`: blue for cells where risk dropped, gray for unchanged, height from lives saved.
   - `showSwipeCompare(leftCells, rightCells)`: a draggable vertical divider splitting the view between two difference maps (user plan versus optimal plan).
   - `hideRiskMap()` returns to the normal town view.
   - Colorblind safe ramp: pale yellow-green, amber, orange-red, deep red with hatch. Check the palette in a colorblindness simulator before locking.
   - Instanced or merged meshes so a few thousand cells stay smooth.

## Phase 3 (hours 8 to 14): all three places and joint testing with Simulation
1. Run the pipeline for all three featured places.
2. Sit with the Simulation teammate and test storms on every place. Check: mobile homes land in `MH`, houses along the creek show low `hand_m`, crossings sit where roads meet streams, night and day populations look sane. Fix data bugs fast.
3. Sanity script `places/validate.py`: counts per class, share with basements, population totals versus Census county population, buildings with missing elevation, every building has an H3 id found in `cells.json`. Flag anything odd.
4. Test the risk map together with the Simulation teammate on every place: bands look right, empty areas stay uncolored, hover shows the right numbers.

## Phase 4 (hours 14 to 20): landing page and polish
1. Landing page in `web/src/landing/`: sections for national death patterns (Flourish embeds from the Story lead), the model explained (charts from the ML lead's JSON files), backtest chart, and methods.
2. Camera intro animation for the opening scene.
3. Performance pass on the presentation laptop. Fallbacks: drop shadows, lower terrain detail, fewer props.

## Definition of done
Three places with valid `buildings.json`, `crossings.json`, `cells.json`, `place.json`. `fetch_buildings(bbox)` works for any U.S. area. 3D town renders smoothly with water, tornado path, placed protections, the post-storm risk map, the difference view, and the swipe comparison. Landing page built.
