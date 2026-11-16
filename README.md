# AidEM map prototype

MapLibre GL JS + PMTiles, served as static files from `public/`.

## Setup

```bash
brew install pmtiles uv
```

## Data pipeline

Source data lives in `../data`. Rerun the pipeline when it changes:

```bash
npm run data          # rebuild stale outputs
npm run data:force    # also re-extract the basemap from the latest Protomaps build
```

`scripts/build_data.py` writes to `public/data/`:

- `domain.geojson`, `domain.json`: map domain from `AidEM_MapDomain.shp` (Cambria, Somerset and Westmoreland counties), reprojected to WGS84 with county names and one label point per county, plus its bbox and a padded bbox
- `evacuation_zones.geojson`: the 3 evacuation zones from `Evacuation_Zones.shp` with all LifeSim attributes, reprojected to WGS84. The source is jagged raster output with 1000+ slivers per zone, so the zones are generalised together as one coverage: rasterised, blurred, each cell assigned to its dominant zone, then polygonised, simplified along shared edges and rounded (`EVAC_*` in the script). Zones don't overlap, share their edges, and stay within ~2% of their source area
- `dam.geojson`, `reservoir.geojson`: an abstract modern dam at the South Fork Dam site and its reservoir at normal pool (the area the flood model has wet from the start, behind the dam). The dam is a wall along the crest (sliced along its length so it stands level on 3D terrain, with flat-map heights in `fbase`/`fheight`), its footprint on the ground, and the spillway. The scenario doesn't describe the dam, so it's sized from the model and terrain: normal pool 488.8 m (spillway crest), crest 491 m (about where the reservoir starts spilling past the dam at ~4.5 h), peak pool 492.7 m (overtopped by ~1.7 m before the breach). That gives a ~20 m high, ~320 m long dam, close to the 1889 one. Settings and reasoning are under `DAM_*` in the script
- `cascade_facilities.geojson`, `cascade_buildings.geojson`, `cascade_service_areas.geojson`, `cascade_summary.json`: cascading impacts of the dam failure from `../data/johnstown_cascade/output` (round 2; see the README there). Facilities are points in their first tier (1 flooded, 2 lost a service from a failed facility, 3 lost a service from a facility that failed in tier 2) with what they lost, from whom and when (hours after the breach; negative is before it). Buildings are one MultiPoint per first tier (about 51,000 points). Service areas are the failed providers' areas, simplified, with `utility` marking power, sewer and water. The map shows them as the layer groups `impactFacilities`, `impactBuildings`, `utilityAreas` and `otherAreas` (off by default); story 1 turns them on in step 3, and its sidebar and story 3 read the summary. `cascade_use_by_tier.json` splits each tier's buildings and people by use (homes, businesses, industry, public buildings) for story 3's impacts table
- `basemap.pmtiles`: Protomaps extract for the flood extent plus `DATA_PADDING` (50%; zoom 0 to 15). The map itself is limited to the flood extent plus 10%; the extra margin fills the horizon in tilted views. It's only re-extracted when the bbox or max zoom changes, or with `--force`
- `<id>.pmtiles`: one per entry in `RASTERS` in the script. These are the float GeoTIFFs as value-encoded `raster-dem` tiles (MapLibre `custom` encoding, `value = R*256 + G + B/256 - 1`, lossless WebP, 512px; see `DEM_ENCODING` in the script for why not Terrarium). The map colours them with a `color-relief` layer, so changing colours only means editing the ramp in `public/map/core.js`. NoData is encoded as -1, except in `arrival_first`, where it is 200 so edge pixels don't show the final flood boundary early. A raster is only rebuilt when its source file or tiling settings change
  - `depth_max`: maximum depth (ft), shown as stepped classes
  - `velocity_max`: maximum velocity (ft/s), shown as stepped classes (<2, 2–5, 5–10, 10–15, 15+)
  - `arrival_first`: hours until water first reaches a cell (0 = wet at the start), used for the flood advance animation
- `public/assets/`: basemap fonts (Noto Sans glyphs, SIL OFL) and sprites (from tangrams/icons, MIT), with their license files, from a pinned commit of `protomaps/basemaps-assets`. Bump `ASSETS_COMMIT` in the script to update
- `terrain.pmtiles`: Mapterhorn terrain (Terrarium raster-dem, USGS 3DEP 1 m around Johnstown, public domain) for the igor hillshade. The full extract goes to `build/terrain-z15.pmtiles` (about 240 MB): z0-12 for the flood extent plus `DATA_PADDING`, z13-15 for the flood raster footprint plus 10%, because full detail everywhere would be 13+ GB. The dam is sized from it. The published file is cut from it to stay under GitHub's 100 MB file limit (about 70 MB): z0 to `TERRAIN_COARSE_MAXZOOM` (11) everywhere, up to `TERRAIN_DETAIL_MAXZOOM` (14) over the flood footprint, which is everywhere the map can pan. Each zoom has to cover that whole area: MapLibre leaves a missing tile blank instead of using the zoom below. Re-extracted when those bboxes or zooms change, or with `--force`
- `buildings.pmtiles`: Overture Maps building footprints (OSM plus Microsoft ML footprints, ODbL), extracted for the flood extent plus `DATA_PADDING` from Overture's published PMTiles (source layer `building`, z5-14). Pinned via `OVERTURE_RELEASE`; re-extracted when the release or bbox changes, or with `--force`
- `zone_arrival.json`: typical flood arrival per evacuation zone (25th and 75th percentile of `arrival_first` inside the zone, hours since overtopping), shown as clock times in the zone table and popup
- `rasters.json`: manifest of the raster layers (URL, zooms, bounds, units, value range), which the page reads to add sources and layers

Intermediate files (reprojected COGs, the full terrain, build stamps) go to `build/`, which is safe to delete (the terrain is then downloaded again).

## Pages

- `public/index.html`: the explorer, i.e. the shared map plus the layer panel
- `public/map/core.js`: the shared map. `createMap()` builds the map with all data layers and returns a small API (`setFlood`, `setTime`, `play`, `setLayer`, `selectZone`, `zoneStats`, `zoneBounds`, events, plus `app.map` for plain MapLibre). Data paths resolve relative to this file, so pages can live in any folder. `core.css` has the shared styles
- `public/map/panel.js` (+ `panel.css`): the explorer's layer panel and legend helpers
- `public/stories/<name>/`: one folder per storytelling direction, each a standalone page at `/stories/<name>/` built on `map/core.js`. Keep story-specific code in its folder; move something into `map/` only once a second story needs it. Delete a folder to drop a direction. `story-1` is the first story at wireframe stage (from Figma, AidEM, Section 1)

## Run

```bash
script/server         # http://localhost:8080 (or npm run serve; PORT=8081 for another port)
```

PMTiles needs HTTP range requests, so don't use `python -m http.server`.

## Deploy

`public/` is published to GitHub Pages by `.github/workflows/pages.yml` on every push to `main` (repository settings: Pages, source "GitHub Actions"). Paths are relative, so the site works under `/aidem_prototype/`. GitHub rejects files over 100 MB: the build warns if `terrain.pmtiles` grows past that.
