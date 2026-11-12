# /// script
# requires-python = ">=3.11"
# dependencies = ["pyshp>=2.3", "pyproj>=3.6", "rasterio>=1.4", "numpy>=2", "pillow>=11", "shapely>=2.1", "scipy>=1.14"]
# ///
"""Data pipeline for the AidEM map prototype.

Rerun whenever the source data in ../data changes:

    uv run scripts/build_data.py            # rebuild everything that is stale
    uv run scripts/build_data.py --force    # rebuild everything, incl. basemap

Outputs go to public/data/:
    domain.geojson   map domain polygon in WGS84
    domain.json      bbox of the domain + padded bbox used for basemap/maxBounds
    basemap.pmtiles  Protomaps basemap extract covering the padded bbox
    <raster>.pmtiles Terrarium-encoded raster-dem tiles per entry in RASTERS
    rasters.json     manifest of raster layers (url, zooms, value range, units)
    terrain.pmtiles  Mapterhorn terrain for the hillshade (see MAPTERHORN_URLS)
    buildings.pmtiles Overture building footprints for the domain bbox
    evacuation_zones.geojson  simplified evacuation zones with LifeSim impacts
    dam.geojson, reservoir.geojson  abstract modern dam (wall, spillway) and its reservoir
    cascade_*.geojson, cascade_summary.json  cascading impacts (see CASCADE_DIR)
    cascade_flooded_severity.json, cascade_flooded_use.json  flooded buildings and people by severity and by use
    cascade_use_by_tier.json  all impacted buildings and people by use, per first tier

Requires the `pmtiles` CLI (brew install pmtiles).
"""

from __future__ import annotations

import argparse
import atexit
import io
import json
import shutil
import sqlite3
import subprocess
import sys
import urllib.request
import zipfile
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np
import rasterio
import shapefile
from PIL import Image
from pyproj import CRS, Transformer
from rasterio.enums import Resampling
from rasterio.shutil import copy as rio_copy
from rasterio.warp import transform_bounds
from rasterio.windows import from_bounds

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT.parent / "data"
OUT = ROOT / "public" / "data"

DOMAIN_SHP = SOURCE / "b_Potential Map Boundary" / "AidEM_MapDomain.shp"

# Evacuation zones (3 polygons) with LifeSim direct impacts as attributes.
# They come from ArcGIS Raster to Polygon: jagged, 1000+ slivers per zone, and
# edges that stop fitting once each zone is simplified on its own. So the zones
# are generalised together, as one coverage:
#   1. rasterise each zone at EVAC_CELL and blur it (Gaussian, EVAC_SIGMA)
#   2. the outer edge is where the blurred zones sum to >= EVAC_OUTER (< 0.5
#      grows slightly, to make up for corners the smoothing cuts off)
#   3. inside, each cell goes to the zone with the highest blurred value, so
#      zones can't overlap or leave gaps, and contested edges are split fairly
#   4. polygonise, simplify shared edges together (coverage_simplify), round
#      corners with EVAC_SMOOTH Chaikin passes, drop pieces < EVAC_MIN_AREA
# Units are the source CRS's (US survey feet). Zone areas stay within ~2%.
EVAC_SHP = SOURCE / "c_Evacuation Zones" / "Evacuation_Zones.shp"
EVAC_CELL = 5.0
EVAC_SIGMA = 20.0
EVAC_OUTER = 0.4
EVAC_SIMPLIFY = 15.0
EVAC_SMOOTH = 2
EVAC_MIN_AREA = 10_000.0  # ~930 m2

# Cascading impacts (primary, secondary, tertiary) from the dam failure
# analysis in ../data/johnstown_cascade (see its README; round 2). Already in
# WGS84. Facilities and service areas are slimmed to what the map shows;
# buildings become points with their first tier only (1-3), since there are
# ~51,000 of them. Service areas are simplified by CASCADE_SIMPLIFY degrees.
CASCADE_DIR = SOURCE / "johnstown_cascade" / "output"
CASCADE_SIMPLIFY = 0.0002  # ~20 m

# Modern dam at the South Fork Dam site, drawn as 3D map layers. The flood
# scenario is fictional and doesn't describe the dam, so its size is derived
# from what the model and terrain imply:
#   - the model leaves a dry gap between reservoir and downstream flood at
#     DAM_CENTER: that's where it has the dam
#   - valley floor at the dam: 471 m; old dam abutments: ~493 m
#   - reservoir at t = 0 (cells wet from the start): shoreline at 488.8 m
#     -> normal pool = spillway crest
#   - peak reservoir level: 492.7 m at 8.5 h, just before the breach (8.83 h)
#   - water first reaches the area below the dam at ~4.5 h; with the pool
#     rising roughly steadily, it passed ~491 m then -> dam crest
# So: ~20 m high, 2.2 m freeboard, overtopped by ~1.7 m at the peak. Close
# to the 1889 dam (72 ft high, 931 ft long). Heights are metres above sea level.
DAM_CENTER = (-78.7751, 40.3485)
DAM_AXIS_AZIMUTH = 234.0     # crest direction, degrees from north; upstream is to its left (SE)
DAM_CREST_ELEV = 491.0
DAM_POOL_ELEV = 488.8        # normal pool and spillway crest
DAM_CREST_WIDTH = 9.0        # crest road
DAM_SLOPE_UP = 3.0           # horizontal : vertical, riprap
DAM_SLOPE_DOWN = 2.5         # grassed
DAM_CELL = 2.5               # m, slices of the wall along the crest
# Spillway at the NE end, as sketched: a lip along the shore, and a curved
# translucent shape falling away from it downhill, like the water pouring
# over the dam in the 1889 painting. Depth and height follow an arc along the
# lip, tapering to its ends.
DAM_SPILLWAY_LIP = [(-78.7734202, 40.3493357), (-78.7731162, 40.3493356)]
DAM_SPILLWAY_DEPTH = 10.0    # m, largest bulge downhill from the lip
DAM_SPILLWAY_HEIGHT = 4.0    # m above ground, at the middle

# Margin around the county domain for domain.json's paddedBbox (no longer
# used for extracts or pan limits), as a fraction of its width/height.
BBOX_PADDING = 0.25
# Margin around the flood extent for the basemap, buildings and coarse terrain.
DATA_PADDING = 0.5
BASEMAP_MAXZOOM = 15
PROTOMAPS_BUILDS = "https://build-metadata.protomaps.dev/builds.json"
PROTOMAPS_BUILD_URL = "https://build.protomaps.com/{key}"

# Basemap fonts (glyph PBFs) and sprites, self-hosted under public/assets/.
# Pinned to a commit of protomaps/basemaps-assets; bump the SHA to update.
# Fonts: Noto Sans, SIL OFL 1.1. Sprites: derived from MIT-licensed tangrams/icons.
ASSETS_COMMIT = "028c18f713baecad011301ff7a69acc39bcc2ae7"
ASSETS_ZIP = "https://github.com/protomaps/basemaps-assets/archive/{sha}.zip"
ASSETS_FONTS = ["Noto Sans Regular", "Noto Sans Medium", "Noto Sans Italic"]
ASSETS_SPRITES = "sprites/v4/"
SPRITES_LICENSE_URL = (
    "https://raw.githubusercontent.com/tangrams/icons/92510779634f4a006c61ea70e50cb8c52c765a81/LICENSE.md"
)
ASSETS_OUT = ROOT / "public" / "assets"

# Mapterhorn terrain (Terrarium-encoded raster-dem, 512px WebP) for the hillshade.
# Around Johnstown it's built from USGS 3DEP 1 m lidar (public domain).
# planet.pmtiles holds z0-12; z13+ is split into one archive per z6 tile.
# Full detail over the whole padded bbox would be 13+ GB, so z13+ is only
# extracted for the footprint of the flood rasters (plus TERRAIN_DETAIL_PADDING),
# up to TERRAIN_FULL_MAXZOOM, into build/terrain-z15.pmtiles (the dam is sized
# from it). The published terrain.pmtiles is cut from that to stay under
# GitHub's 100 MB file limit (GitHub Pages): z0 to TERRAIN_COARSE_MAXZOOM over
# the padded bbox (horizon in tilted views), up to TERRAIN_DETAIL_MAXZOOM over the
# detail bbox, which covers everywhere the map can pan. About 70 MB. Each zoom
# must be complete over the detail bbox: MapLibre draws a missing tile as blank
# (and as a hole in 3D terrain) rather than falling back to the zoom below, so
# z15 only along the valley doesn't work.
MAPTERHORN_URLS = "https://download.mapterhorn.com/download_urls.json"
TERRAIN_FULL_MAXZOOM = 15
TERRAIN_COARSE_MAXZOOM = 11
TERRAIN_DETAIL_MAXZOOM = 14
TERRAIN_DETAIL_PADDING = 0.1

# Overture Maps building footprints (OSM conflated with Microsoft ML footprints
# and others), ODbL. Overture publishes ready-made vector PMTiles per release
# (source layer "building", z5-14); we extract the domain bbox. Pinned release
# for reproducibility; bump it to update (old releases eventually go offline).
OVERTURE_RELEASE = "2026-10-21.0"
OVERTURE_BUILDINGS_URL = "https://tiles.overturemaps.org/{release}/buildings.pmtiles"

# Intermediate files (reprojected COGs, build stamps). Safe to delete.
CACHE = ROOT / "build"

RASTER_DIR = SOURCE / "a_Flood Files" / "a_Raster Outputs"
RASTER_SUFFIX = ".Johnstown_Terrain.Johnstown_Terrain.Jamestown_BE_DEM_20211229.tif"

# Float rasters to tile as value-encoded raster-dem PMTiles.
# maxzoom refers to 512px tiles; z16 is ~0.9 m/px here (source is 2.5 ft).
RASTERS = [
    {"id": "depth_max", "src": "Depth (Max)" + RASTER_SUFFIX, "units": "ft", "minzoom": 8, "maxzoom": 16},
    {"id": "velocity_max", "src": "Velocity (Max)" + RASTER_SUFFIX, "units": "ft/s", "minzoom": 8, "maxzoom": 16},
    # Hours from simulation start until water first reaches the cell (0 = wet
    # at the start, e.g. the reservoir and river). Drives the flood advance
    # animation. The breach happens at 8.83 h; earlier water is overtopping.
    # NoData is stored above any arrival time: the GPU blends edge pixels with
    # their NoData neighbours, and with a low sentinel the blend passed through
    # every earlier time, drawing the final flood boundary as a hairline from
    # the start. Kept below 255 so the encoding's R byte stays 0.
    {"id": "arrival_first", "src": "Arrival Time (hrs)" + RASTER_SUFFIX, "units": "h", "minzoom": 8, "maxzoom": 16,
     "nodata": 200.0},
]
TILE_SIZE = 512
NODATA_SENTINEL = -1.0  # close to 0 so edge interpolation stays within half a pixel

# MapLibre "custom" raster-dem encoding (MapLibre subtracts baseShift):
#     value = R * 256 + G + B / 256 - baseShift
# baseShift = -NODATA_SENTINEL, so NoData encodes as (0, 0, 0) and values from
# the sentinel up to ~255 share R = 0. The GPU blends raw RGB bytes between
# pixels before decoding; if neighbours differ in R, rounding errors get
# multiplied by 256 and show up as stripes. Keeping R constant avoids that.
DEM_ENCODING = {
    "encoding": "custom",
    "redFactor": 256.0,
    "greenFactor": 1.0,
    "blueFactor": 1.0 / 256.0,
    "baseShift": -NODATA_SENTINEL,
}
MERC_HALF = 20037508.342789244


def log(msg: str) -> None:
    print(f"[build_data] {msg}", flush=True)


def build_domain() -> dict:
    """Reproject the domain polygons (counties) to WGS84 and write GeoJSON + bbox."""
    import shapely.geometry
    crs = CRS.from_wkt(DOMAIN_SHP.with_suffix(".prj").read_text())
    to_wgs84 = Transformer.from_crs(crs, "EPSG:4326", always_xy=True)

    features = []
    with shapefile.Reader(str(DOMAIN_SHP)) as shp:
        for shape_rec in shp.iterShapeRecords():
            geom = shape_rec.shape.__geo_interface__

            def reproject(coords):
                if isinstance(coords[0], (int, float)):
                    x, y = to_wgs84.transform(coords[0], coords[1])
                    return [round(x, 6), round(y, 6)]
                return [reproject(c) for c in coords]

            geom = {"type": geom["type"], "coordinates": reproject(geom["coordinates"])}
            rec = shape_rec.record.as_dict()
            props = {"name": rec.get("NAME"), "county": rec.get("CountyName"), "fips": rec.get("FIPSCode")}
            features.append({"type": "Feature", "properties": props, "geometry": geom})

    xs, ys = [], []

    def collect(coords):
        if isinstance(coords[0], (int, float)):
            xs.append(coords[0])
            ys.append(coords[1])
        else:
            for c in coords:
                collect(c)

    for f in features:
        collect(f["geometry"]["coordinates"])

    bbox = [min(xs), min(ys), max(xs), max(ys)]
    dx = (bbox[2] - bbox[0]) * BBOX_PADDING
    dy = (bbox[3] - bbox[1]) * BBOX_PADDING
    padded = [bbox[0] - dx, bbox[1] - dy, bbox[2] + dx, bbox[3] + dy]

    meta = {
        "bbox": [round(v, 6) for v in bbox],
        "paddedBbox": [round(v, 6) for v in padded],
    }

    # One label point per county, inside the polygon (GeoJSON polygons would
    # otherwise get a label per map tile).
    labels = []
    for f in features:
        pt = shapely.geometry.shape(f["geometry"]).representative_point()
        labels.append({"type": "Feature", "properties": {**f["properties"], "label": True},
                       "geometry": {"type": "Point", "coordinates": [round(pt.x, 6), round(pt.y, 6)]}})

    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "domain.geojson").write_text(
        json.dumps({"type": "FeatureCollection", "features": features + labels})
    )
    (OUT / "domain.json").write_text(json.dumps(meta, indent=2) + "\n")
    log(f"domain: {len(features)} feature(s), bbox {meta['bbox']}")
    return meta


def _chaikin_ring(coords, n: int) -> np.ndarray:
    pts = np.asarray(coords)[:-1]
    for _ in range(n):
        nxt = np.roll(pts, -1, axis=0)
        pts = np.stack([0.75 * pts + 0.25 * nxt, 0.25 * pts + 0.75 * nxt], axis=1).reshape(-1, 2)
    return np.vstack([pts, pts[:1]])


def build_evacuation_zones() -> None:
    """Generalise the evacuation zones as one coverage (see EVAC_*), reproject
    to WGS84, keep all attributes."""
    import shapely
    from rasterio.features import rasterize, shapes
    from rasterio.transform import from_origin
    from scipy.ndimage import gaussian_filter
    from shapely.geometry import MultiPolygon, Polygon, mapping, shape

    crs = CRS.from_wkt(EVAC_SHP.with_suffix(".prj").read_text())
    to_wgs84 = Transformer.from_crs(crs, "EPSG:4326", always_xy=True)

    with shapefile.Reader(str(EVAC_SHP)) as shp:
        recs = sorted(
            ((r.record.as_dict(), shapely.make_valid(shape(r.shape.__geo_interface__))) for r in shp.iterShapeRecords()),
            key=lambda r: r[0]["Zone"],
        )
    geoms = [g for _, g in recs]

    # 1-3. Label grid
    pad = 5 * EVAC_SIGMA
    x0, y0, x1, y1 = shapely.union_all(geoms).bounds
    x0, y0, x1, y1 = x0 - pad, y0 - pad, x1 + pad, y1 + pad
    size = (int((y1 - y0) / EVAC_CELL) + 1, int((x1 - x0) / EVAC_CELL) + 1)
    tr = from_origin(x0, y1, EVAC_CELL, EVAC_CELL)
    blur = np.stack([
        gaussian_filter(rasterize([g], size, transform=tr).astype(np.float32), EVAC_SIGMA / EVAC_CELL)
        for g in geoms
    ])
    label = np.where(blur.sum(0) >= EVAC_OUTER, np.argmax(blur, 0) + 1, 0).astype(np.int32)
    del blur

    # 4. Polygons
    pieces = [[] for _ in geoms]
    for geom, v in shapes(label, mask=label > 0, transform=tr):
        pieces[int(v) - 1].append(shape(geom))
    coverage = shapely.coverage_simplify(
        np.array([shapely.union_all(p) for p in pieces], dtype=object), EVAC_SIMPLIFY
    )

    zones, taken = [], None
    for geom in coverage:
        polys = [
            shapely.make_valid(Polygon(
                _chaikin_ring(p.exterior.coords, EVAC_SMOOTH),
                [_chaikin_ring(i.coords, EVAC_SMOOTH) for i in p.interiors],
            ))
            for p in getattr(geom, "geoms", [geom])
        ]
        # Rounding quadruples the vertices; thin them out again (1 ft is invisible).
        geom = shapely.union_all(polys).simplify(1.0)
        # Smoothing moves shared edges by a hair at junctions; earlier zones win.
        if taken is not None:
            geom = geom.difference(taken)
        geom = MultiPolygon([p for p in getattr(geom, "geoms", [geom]) if isinstance(p, Polygon) and p.area >= EVAC_MIN_AREA])
        taken = geom if taken is None else taken.union(geom)
        zones.append(geom)

    # That also leaves hairline slits between zones. Give every hole in the
    # union smaller than EVAC_MIN_AREA to the zone it shares the most edge with.
    union = shapely.union_all(zones)
    slits = [
        Polygon(ring) for p in getattr(union, "geoms", [union]) for ring in p.interiors
        if Polygon(ring).area < EVAC_MIN_AREA
    ]
    fill = [[] for _ in zones]
    for slit in slits:
        edge = slit.boundary.buffer(0.5)
        best = max(range(len(zones)), key=lambda i: zones[i].intersection(edge).area)
        fill[best].append(slit)
    zones = [shapely.union_all([z, *f]) if f else z for z, f in zip(zones, fill)]
    log(f"evacuation zones: filled {len(slits)} slit(s) between zones")

    features = []
    for (props, src), geom in zip(recs, zones):
        parts = [p for p in getattr(geom, "geoms", [geom]) if isinstance(p, Polygon)]
        geom = MultiPolygon(parts)
        log(f"evacuation zones: zone {props['Zone']}: {len(parts)} part(s), area {geom.area / src.area:.1%} of source")
        geom = shapely.transform(geom, lambda xy: np.column_stack(to_wgs84.transform(xy[:, 0], xy[:, 1])))
        features.append({"type": "Feature", "id": props["Zone"], "properties": props, "geometry": mapping(geom)})

    def rounded(obj):
        if isinstance(obj, float):
            return round(obj, 6)
        if isinstance(obj, (list, tuple)):
            return [rounded(o) for o in obj]
        if isinstance(obj, dict):
            return {k: rounded(v) for k, v in obj.items()}
        return obj

    out = OUT / "evacuation_zones.geojson"
    out.write_text(json.dumps(rounded({"type": "FeatureCollection", "features": features}), separators=(",", ":")))
    log(f"evacuation zones: wrote {out.relative_to(ROOT)} ({out.stat().st_size // 1024} KB)")


def build_cascade() -> None:
    """Cascade layers and summary from CASCADE_DIR (see the README there)."""
    from shapely import from_wkb
    from shapely.geometry import mapping, shape

    if not CASCADE_DIR.exists():
        log(f"cascade: {CASCADE_DIR} not found, skipped")
        return
    tiers = {"primary": 1, "secondary": 2, "tertiary": 3}
    hours = lambda v: None if v is None else round(v, 2)

    # Providers by id (CIKR facilities and water systems), for "caused by" names.
    areas = json.loads((CASCADE_DIR / "service_areas.geojson").read_text())["features"]
    provider = {f["properties"]["pid"]: f["properties"]["name"] for f in areas}

    pid_by_name = {}
    for f in areas:
        pid_by_name.setdefault(f["properties"]["name"].strip(), f["properties"]["pid"])
    facilities = []
    for name in ["primary_facilities", "secondary_facilities", "tertiary_facilities"]:
        for f in json.loads((CASCADE_DIR / f"{name}.geojson").read_text())["features"]:
            p = f["properties"]
            if p["first_tier"] != p["tier"]:
                continue  # listed again in a later tier: keep the first
            causes = [] if p["caused_by"] == "flood" else [provider.get(c, c) for c in p["caused_by"].split(";")]
            facilities.append({
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [round(c, 6) for c in f["geometry"]["coordinates"]]},
                "properties": {
                    "name": p["NAME"].strip(), "type": p["Point_Type"], "tier": tiers[p["tier"]],
                    "certainty": p["certainty"], "depth_ft": None if p["depth_ft"] is None else round(p["depth_ft"], 1),
                    "services": None if p["caused_by"] == "flood" else p["services"],
                    "causes": "; ".join(causes) or None, "impact_h": hours(p["impact_h"]),
                    # id of its service area and of its file of affected buildings, if it has one
                    "provider": pid_by_name.get(p["NAME"].strip()),
                },
            })

    service_areas = []
    for f in areas:
        p = f["properties"]
        geom = shape(f["geometry"]).simplify(CASCADE_SIMPLIFY, preserve_topology=True)
        service_areas.append({
            "type": "Feature",
            "geometry": json.loads(json.dumps(mapping(geom)), parse_float=lambda s: round(float(s), 5)),
            "properties": {
                "name": p["name"].strip(), "kind": p["kind"], "service": p["service"],
                # utility: power, sewer and water, which other facilities depend on
                "utility": p["kind"] in ("Gas-Fired Power Plant", "Wastewater Treatment Plants", "Public Water System", "Electric Substations"),
                "tier": tiers[p["tier"]], "certainty": p["certainty"], "basis": p["area_basis"],
                "offline_h": hours(p["offline_h"]), "buildings": p["buildings"],
                "pop_night": round(p["pop_night"] or 0), "pop_day": round(p["pop_day"] or 0),
            },
        })

    # Buildings: GeoPackage points (standard header, no envelope, then WKB).
    con = sqlite3.connect(CASCADE_DIR / "impacted_buildings.gpkg")
    rows = con.execute("SELECT geom, first_tier, first_impact_h FROM all_impacted").fetchall()
    con.close()
    # One MultiPoint per tier and impact time (to 0.01 h) keeps the file small
    # (no per-building features) and lets the map show them as time passes.
    # impact_h is null for buildings the cascade gives no time for; past the
    # flooded tier those are drinking-water losses, which are only potential.
    points = {}
    for blob, tier, h in rows:
        flags = blob[3]
        envelope = {0: 0, 1: 32, 2: 48, 3: 48, 4: 64}[(flags >> 1) & 7]
        pt = from_wkb(bytes(blob[8 + envelope:]))
        points.setdefault((tiers[tier], hours(h)), []).append([round(pt.x, 5), round(pt.y, 5)])
    buildings = [
        {"type": "Feature", "geometry": {"type": "MultiPoint", "coordinates": c}, "properties": {"tier": t, "impact_h": h, "potential": h is None and t > 1, "count": len(c)}}
        for (t, h), c in sorted(points.items(), key=lambda kv: (kv[0][0], kv[0][1] is None, kv[0][1] or 0))
    ]

    # Links: which provider took out which facility (facility_links.csv), as
    # lines from provider to facility, for arrows on the map. Facilities are
    # matched by name and type. Water systems have no location (their plants
    # aren't public): their lines start at a point inside the service area
    # only so every link has a geometry; "located" is false and the map
    # leaves them off (they're listed in the facility details).
    import csv
    from shapely.geometry import shape as _shape
    where = {}
    for name in ["primary_facilities", "secondary_facilities", "tertiary_facilities"]:
        for f in json.loads((CASCADE_DIR / f"{name}.geojson").read_text())["features"]:
            p = f["properties"]
            where.setdefault((p["NAME"].strip(), p["Point_Type"]), [round(c, 6) for c in f["geometry"]["coordinates"][:2]])
    by_name = {}
    for (n, t), c in where.items():
        by_name.setdefault(n, c)
    area_point = {f["properties"]["pid"]: [round(c, 6) for c in _shape(f["geometry"]).representative_point().coords[0]] for f in areas}
    area_kind = {f["properties"]["pid"]: f["properties"]["kind"] for f in areas}
    links = []
    with open(CASCADE_DIR / "facility_links.csv") as fh:
        for r in csv.DictReader(fh):
            water = r["from"].startswith("pws/")
            a = area_point.get(r["from"]) if water else by_name.get(r["from_name"].strip())
            b = where.get((r["to_name"].strip(), r["to_type"])) or by_name.get(r["to_name"].strip())
            if not a or not b or a == b:
                log(f"cascade: link {r['from_name']} -> {r['to_name']} skipped (no location)")
                continue
            links.append({
                "type": "Feature",
                "geometry": {"type": "LineString", "coordinates": [a, b]},
                "properties": {
                    "from": r["from_name"].strip(), "to": r["to_name"].strip(), "kind": area_kind.get(r["from"]),
                    "service": r["service_lost"], "certainty": r["certainty"], "located": not water,
                    "impact_h": hours(float(r["impact_h"])) if r["impact_h"] else None,
                },
            })

    def write(name: str, features: list) -> None:
        out = OUT / name
        out.write_text(json.dumps({"type": "FeatureCollection", "features": features}, separators=(",", ":")))
        log(f"cascade: wrote {out.relative_to(ROOT)} ({len(features)} features, {out.stat().st_size // 1024} KB)")

    write("cascade_facilities.geojson", facilities)
    write("cascade_service_areas.geojson", service_areas)
    write("cascade_buildings.geojson", buildings)
    write("cascade_links.geojson", links)

    # Buildings each provider affects (its caused_by in the secondary and
    # tertiary tables), one small file per provider, loaded when its
    # facility is selected: one MultiPoint per tier.
    by_provider = {}
    con = sqlite3.connect(CASCADE_DIR / "impacted_buildings.gpkg")
    for table, tier in [("secondary", 2), ("tertiary", 3)]:
        for blob, caused_by in con.execute(f'SELECT geom, caused_by FROM "{table}"'):
            flags = blob[3]
            envelope = {0: 0, 1: 32, 2: 48, 3: 48, 4: 64}[(flags >> 1) & 7]
            pt = from_wkb(bytes(blob[8 + envelope:]))
            for pid in (caused_by or "").split(";"):
                if pid and pid != "flood":
                    by_provider.setdefault(pid, {}).setdefault(tier, []).append([round(pt.x, 5), round(pt.y, 5)])
    con.close()
    folder = OUT / "cascade_by_provider"
    shutil.rmtree(folder, ignore_errors=True)
    folder.mkdir()
    for pid, tiers_pts in by_provider.items():
        feats = [{"type": "Feature", "geometry": {"type": "MultiPoint", "coordinates": c}, "properties": {"tier": t, "count": len(c)}}
                 for t, c in sorted(tiers_pts.items())]
        (folder / (pid.replace("/", "_") + ".json")).write_text(json.dumps({"type": "FeatureCollection", "features": feats}, separators=(",", ":")))
    log(f"cascade: wrote {len(by_provider)} files to {folder.relative_to(ROOT)} "
        f"({sum(f.stat().st_size for f in folder.iterdir()) // 1024} KB)")
    shutil.copyfile(CASCADE_DIR / "summary.json", OUT / "cascade_summary.json")
    log("cascade: copied summary.json to cascade_summary.json")
    build_flooded_severity()


def build_flooded_severity() -> None:
    """Flooded buildings and the people in them by flood severity (the
    cascade's own depth classes), for story 3's people page."""
    con = sqlite3.connect(CASCADE_DIR / "impacted_buildings.gpkg")
    rows = con.execute('SELECT severity, COUNT(*), SUM(pop_day), SUM(pop_night) FROM "primary" GROUP BY severity').fetchall()
    con.close()
    order = ["Severe", "Moderate", "Minor", "Nuisance"]
    rows.sort(key=lambda r: next((i for i, o in enumerate(order) if r[0].startswith(o)), 99))
    data = [{"severity": r[0], "buildings": r[1], "pop_day": round(r[2]), "pop_night": round(r[3])} for r in rows]
    (OUT / "cascade_flooded_severity.json").write_text(json.dumps(data, indent=1))
    log(f"cascade: wrote cascade_flooded_severity.json ({len(data)} classes)")
    # The same buildings by use (NSI damage category), for the summary.
    con = sqlite3.connect(CASCADE_DIR / "impacted_buildings.gpkg")
    rows = con.execute('SELECT st_damcat, COUNT(*), SUM(pop_day), SUM(pop_night) FROM "primary" GROUP BY st_damcat ORDER BY COUNT(*) DESC').fetchall()
    con.close()
    labels = {"RES": "Homes", "COM": "Businesses", "PUB": "Public buildings", "IND": "Industry"}
    data = [{"use": labels.get(r[0], r[0]), "buildings": r[1], "pop_day": round(r[2]), "pop_night": round(r[3])} for r in rows]
    (OUT / "cascade_flooded_use.json").write_text(json.dumps(data, indent=1))
    log(f"cascade: wrote cascade_flooded_use.json ({len(data)} uses)")
    # All impacted buildings by use, in the first tier where they lose
    # something (as summary.json counts them), for story 3's impacts table.
    con = sqlite3.connect(CASCADE_DIR / "impacted_buildings.gpkg")
    rows = con.execute('SELECT first_tier, st_damcat, COUNT(*), SUM(pop_day), SUM(pop_night) FROM all_impacted GROUP BY first_tier, st_damcat').fetchall()
    con.close()
    order = ["Homes", "Businesses", "Industry", "Public buildings"]
    by_tier: dict[str, list] = {}
    for tier, cat, count, day, night in rows:
        by_tier.setdefault(tier, []).append({"use": labels.get(cat, cat), "buildings": count, "pop_day": round(day), "pop_night": round(night)})
    for uses in by_tier.values():
        uses.sort(key=lambda r: order.index(r["use"]) if r["use"] in order else 99)
    (OUT / "cascade_use_by_tier.json").write_text(json.dumps(by_tier, indent=1))
    log(f"cascade: wrote cascade_use_by_tier.json ({', '.join(by_tier)})")


class _Terrain:
    """Elevation (m) from the Terrarium terrain archive at TERRAIN zoom 15."""

    Z = 15

    def __init__(self, path: Path):
        self.path, self.tiles = path, {}

    def _tile(self, x: int, y: int) -> np.ndarray:
        if (x, y) not in self.tiles:
            data = subprocess.run(
                ["pmtiles", "tile", str(self.path), str(self.Z), str(x), str(y)], capture_output=True, check=True
            ).stdout
            a = np.asarray(Image.open(io.BytesIO(data)).convert("RGB")).astype(np.float64)
            self.tiles[(x, y)] = a[..., 0] * 256 + a[..., 1] + a[..., 2] / 256 - 32768
        return self.tiles[(x, y)]

    def __call__(self, lon: float, lat: float) -> float:
        n = 2 ** self.Z
        fx = (lon + 180) / 360 * n
        fy = (1 - np.arcsinh(np.tan(np.radians(lat))) / np.pi) / 2 * n
        tx, ty = int(fx), int(fy)
        a = self._tile(tx, ty)
        size = a.shape[0]
        px, py = (fx - tx) * size - 0.5, (fy - ty) * size - 0.5
        i, j = int(np.clip(py, 0, size - 2)), int(np.clip(px, 0, size - 2))
        u, v = px - j, py - i
        return float(a[i, j] * (1 - u) * (1 - v) + a[i, j + 1] * u * (1 - v) + a[i + 1, j] * (1 - u) * v + a[i + 1, j + 1] * u * v)


def build_dam() -> None:
    """Modern dam (3D cells for fill-extrusion) and its reservoir. See DAM_*."""
    import shapely
    from rasterio.features import shapes
    from rasterio.windows import from_bounds as window_from_bounds
    from scipy import ndimage
    from scipy.ndimage import gaussian_filter
    from shapely.geometry import Polygon, mapping, shape

    # Sized from 1 m terrain at zoom 15: the full copy, not the published one (z14).
    terrain = _Terrain(TERRAIN_FULL)
    lon0, lat0 = DAM_CENTER
    mx = 111_320.0 * np.cos(np.radians(lat0))  # metres per degree
    my = 110_540.0
    az = np.radians(DAM_AXIS_AZIMUTH)
    ax = np.array([np.sin(az), np.cos(az)])     # along the crest (east, north)
    up = np.array([-ax[1], ax[0]])              # left of the axis = upstream

    def lonlat(s: float, d: float) -> tuple[float, float]:
        e, n = ax * s + up * d
        return (round(lon0 + e / mx, 7), round(lat0 + n / my, 7))

    def surface(d: float) -> float:
        half = DAM_CREST_WIDTH / 2
        if abs(d) <= half:
            return DAM_CREST_ELEV
        return DAM_CREST_ELEV - (abs(d) - half) / (DAM_SLOPE_UP if d > 0 else DAM_SLOPE_DOWN)

    # Crest ends: where natural hillside rises above the crest on both sides of
    # the axis. Walking along the axis alone would stop at the 1889 dam's
    # remnants (ridges at ~493 m beside the river gap), which the new dam covers.
    def crest_end(sign: int) -> float:
        s = 0.0
        while s < 600 and not all(terrain(*lonlat(sign * s, d)) > DAM_CREST_ELEV + 1 for d in (40, -40)):
            s += 2.0
        return sign * s
    s_ne, s_sw = crest_end(-1), crest_end(1)  # azimuth 234 points SW, so negative s is NE
    floor = min(terrain(*lonlat(s, 0)) for s in np.arange(s_ne, s_sw, 2.0))
    log(f"dam: crest {s_sw - s_ne:.0f} m long at {DAM_CREST_ELEV} m, valley floor {floor:.1f} m, "
        f"height {DAM_CREST_ELEV - floor:.1f} m")

    features = []
    def cell(s0, s1, d0, d1, props):
        ring = [lonlat(s0, d0), lonlat(s1, d0), lonlat(s1, d1), lonlat(s0, d1), lonlat(s0, d0)]
        features.append({"type": "Feature", "properties": props, "geometry": {"type": "Polygon", "coordinates": [ring]}})

    # Drawn abstractly:
    #   body       one wall along the crest, from the ground up to the crest
    #              elevation, for a translucent fill-extrusion. It's sliced every
    #              DAM_CELL along the crest so its top stays level: MapLibre
    #              stands each slice on the terrain, so each gets the height
    #              from its own ground (base/height). fbase/fheight use smoothed
    #              ground, for maps without 3D terrain.
    #   spill      the spillway shape at the NE end (see DAM_SPILLWAY_*)
    reach = DAM_CREST_WIDTH / 2 + (DAM_CREST_ELEV - floor + 2) * max(DAM_SLOPE_UP, DAM_SLOPE_DOWN)
    gs = np.arange(s_ne - 2, s_sw + 3, 1.0)
    gd = np.arange(-reach - 1, reach + 1, 1.0)
    grid = gaussian_filter(np.array([[terrain(*lonlat(x, y)) for x in gs] for y in gd]), 4)
    def smooth_ground(sv: float, dv: float) -> float:
        i = int(np.clip(round(dv - gd[0]), 0, len(gd) - 1))
        j = int(np.clip(round(sv - gs[0]), 0, len(gs) - 1))
        return float(grid[i, j])

    half = DAM_CREST_WIDTH / 2
    for s0 in np.arange(s_ne, s_sw, DAM_CELL):
        sm = s0 + DAM_CELL / 2
        h = DAM_CREST_ELEV - terrain(*lonlat(sm, 0))
        fh = DAM_CREST_ELEV - smooth_ground(sm, 0)
        if max(h, fh) < 0.3:
            continue  # old remnants at or above the crest
        cell(s0, s0 + DAM_CELL, -half, half,
             {"kind": "body", "base": 0, "height": round(max(h, 0), 2), "fbase": 0, "fheight": round(max(fh, 0), 2)})

    # Spillway: slices along the lip, each reaching DAM_SPILLWAY_DEPTH * arc
    # downhill (north, the downstream side) and standing that high above ground.
    (la, pa), (lb, pb) = DAM_SPILLWAY_LIP
    lip0 = np.array([(la - lon0) * mx, (pa - lat0) * my])
    lip1 = np.array([(lb - lon0) * mx, (pb - lat0) * my])
    lip_len = float(np.linalg.norm(lip1 - lip0))
    along_lip = (lip1 - lip0) / lip_len
    downhill = -up  # downstream side of the dam axis
    def en(v):
        return (round(lon0 + v[0] / mx, 7), round(lat0 + v[1] / my, 7))
    n = int(lip_len // 1.0)
    for i in range(n):
        t0, t1 = i / n, (i + 1) / n
        arc = np.sin(np.pi * (t0 + t1) / 2)
        p0, p1 = lip0 + along_lip * lip_len * t0, lip0 + along_lip * lip_len * t1
        out = downhill * DAM_SPILLWAY_DEPTH * arc
        ring = [en(p0), en(p1), en(p1 + out), en(p0 + out), en(p0)]
        h = round(0.3 + DAM_SPILLWAY_HEIGHT * arc, 2)
        features.append({"type": "Feature", "properties": {"kind": "spill", "base": 0, "height": h, "fbase": 0, "fheight": h},
                         "geometry": {"type": "Polygon", "coordinates": [ring]}})

    log(f"dam: {len(features)} features")

    # Reservoir at normal pool: the area wet from the start (first arrival 0)
    # that touches the dam's upstream face, smoothed like the evacuation zones.
    src = RASTER_DIR / ("Arrival Time (hrs)" + RASTER_SUFFIX)
    with rasterio.open(src) as ds:
        to_src = Transformer.from_crs("EPSG:4326", ds.crs, always_xy=True)
        to_wgs = Transformer.from_crs(ds.crs, "EPSG:4326", always_xy=True)
        cx, cy = to_src.transform(lon0, lat0)
        span = 16_000.0  # ft
        win = window_from_bounds(cx - span, cy - span, cx + span, cy + span, ds.transform)
        f = 4  # 10 ft cells are plenty
        shp = (int(win.height) // f, int(win.width) // f)
        arr = ds.read(1, window=win, out_shape=shp, boundless=True, fill_value=ds.nodata,
                      resampling=Resampling.nearest)
        tr = ds.window_transform(win) * rasterio.Affine.scale(win.width / shp[1], win.height / shp[0])
        wet = arr == 0
        # Cut the river channel off at the dam: drop everything downstream of the axis line.
        rows, cols = np.indices(shp)
        xs, ys = rasterio.transform.xy(tr, rows.ravel(), cols.ravel())
        lon, lat = to_wgs.transform(np.asarray(xs), np.asarray(ys))
        d = ((lon - lon0) * mx * up[0] + (lat - lat0) * my * up[1]).reshape(shp)
        wet &= d > 0
        labels, _ = ndimage.label(wet)
    # Seed: the wet component nearest the upstream face.
    seed_x, seed_y = to_src.transform(*lonlat(0, DAM_CREST_WIDTH / 2 + 5))
    sr, sc = rasterio.transform.rowcol(tr, seed_x, seed_y)
    near = labels[max(0, sr - 15):sr + 15, max(0, sc - 15):sc + 15]
    ids, counts = np.unique(near[near > 0], return_counts=True)
    reservoir = labels == ids[np.argmax(counts)]
    blurred = gaussian_filter(reservoir.astype(np.float32), 1.5) >= 0.5
    polys = [shape(g) for g, v in shapes(blurred.astype(np.uint8), mask=blurred, transform=tr) if v]
    geom = shapely.union_all(polys).simplify(15.0)
    geom = shapely.transform(geom, lambda xy: np.column_stack(to_wgs.transform(xy[:, 0], xy[:, 1])))
    geom = shapely.set_precision(geom, 1e-6)

    (OUT / "dam.geojson").write_text(json.dumps({"type": "FeatureCollection", "features": features}, separators=(",", ":")))
    (OUT / "reservoir.geojson").write_text(json.dumps(
        {"type": "FeatureCollection", "features": [{"type": "Feature", "properties": {"pool": DAM_POOL_ELEV}, "geometry": mapping(geom)}]},
        separators=(",", ":"),
    ))
    log(f"dam: wrote dam.geojson ({(OUT / 'dam.geojson').stat().st_size // 1024} KB), "
        f"reservoir.geojson ({(OUT / 'reservoir.geojson').stat().st_size // 1024} KB, {geom.area * mx * my / 1e6:.2f} km2)")


def latest_protomaps_build() -> str:
    req = urllib.request.Request(PROTOMAPS_BUILDS, headers={"User-Agent": "aidem-prototype-build"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        builds = json.load(resp)
    return builds[-1]["key"]


def build_basemap(padded_bbox: list[float], force: bool) -> None:
    """Extract a Protomaps basemap for the padded bbox, unless already current."""
    if shutil.which("pmtiles") is None:
        sys.exit("pmtiles CLI not found. Install it with: brew install pmtiles")

    target = OUT / "basemap.pmtiles"
    stamp = OUT / "basemap.json"
    wanted = {"bbox": padded_bbox, "maxzoom": BASEMAP_MAXZOOM}

    if target.exists() and stamp.exists() and not force:
        current = json.loads(stamp.read_text())
        if current.get("bbox") == wanted["bbox"] and current.get("maxzoom") == wanted["maxzoom"]:
            log(f"basemap: up to date (build {current.get('build')}), skipping. Use --force to refresh.")
            return

    key = latest_protomaps_build()
    bbox_arg = ",".join(str(v) for v in padded_bbox)
    log(f"basemap: extracting from Protomaps build {key} ...")
    tmp = target.with_suffix(".pmtiles.tmp")
    subprocess.run(
        [
            "pmtiles", "extract",
            PROTOMAPS_BUILD_URL.format(key=key),
            str(tmp),
            f"--bbox={bbox_arg}",
            f"--maxzoom={BASEMAP_MAXZOOM}",
        ],
        check=True,
    )
    tmp.replace(target)
    stamp.write_text(json.dumps({**wanted, "build": key}, indent=2) + "\n")
    log(f"basemap: wrote {target.relative_to(ROOT)} ({target.stat().st_size / 1e6:.1f} MB)")


def _pad(bbox: list[float], frac: float) -> list[float]:
    dx = (bbox[2] - bbox[0]) * frac
    dy = (bbox[3] - bbox[1]) * frac
    return [round(v, 6) for v in (bbox[0] - dx, bbox[1] - dy, bbox[2] + dx, bbox[3] + dy)]


def _intersects(a: list[float], b: list[float]) -> bool:
    return a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3]


def _union_bounds(raster_layers: dict) -> list[float]:
    """Bounding box of all flood rasters (the flood model's extent)."""
    bounds = [layer["bounds"] for layer in raster_layers.values()]
    return [min(b[0] for b in bounds), min(b[1] for b in bounds), max(b[2] for b in bounds), max(b[3] for b in bounds)]


TERRAIN_FULL = CACHE / "terrain-z15.pmtiles"


def build_terrain(padded_bbox: list[float], raster_layers: dict, force: bool) -> None:
    """Extract Mapterhorn terrain into TERRAIN_FULL (z0-12 for the padded bbox,
    z13+ for the flood footprint), then cut the published terrain.pmtiles from it."""
    detail_bbox = _pad(_union_bounds(raster_layers), TERRAIN_DETAIL_PADDING)

    # Full copy, from Mapterhorn (only when its extent changes; build/ is a cache)
    full_stamp = CACHE / "terrain-z15.json"
    full_wanted = {"bbox": padded_bbox, "detailBbox": detail_bbox, "detailMaxzoom": TERRAIN_FULL_MAXZOOM}
    full_current = json.loads(full_stamp.read_text()) if full_stamp.exists() else {}
    if force or not TERRAIN_FULL.exists() or any(full_current.get(k) != v for k, v in full_wanted.items()):
        items = json.loads(_download(MAPTERHORN_URLS))["items"]
        planet = next(i for i in items if i["name"] == "planet.pmtiles")
        detail = [
            i for i in items
            if i["name"] != "planet.pmtiles"
            and _intersects(detail_bbox, [i["min_lon"], i["min_lat"], i["max_lon"], i["max_lat"]])
        ]
        CACHE.mkdir(parents=True, exist_ok=True)
        parts = []
        jobs = [(planet, padded_bbox, planet["max_zoom"])]
        jobs += [(i, detail_bbox, min(TERRAIN_FULL_MAXZOOM, i["max_zoom"])) for i in detail]
        for item, bbox, maxzoom in jobs:
            part = CACHE / f"terrain_{item['name']}"
            log(f"terrain: extracting {item['name']} up to z{maxzoom} ...")
            subprocess.run(
                [
                    "pmtiles", "extract", item["url"], str(part),
                    f"--bbox={','.join(str(v) for v in bbox)}",
                    f"--maxzoom={maxzoom}",
                ],
                check=True,
            )
            parts.append(part)
        tmp = TERRAIN_FULL.with_suffix(".pmtiles.tmp")
        tmp.unlink(missing_ok=True)
        subprocess.run(["pmtiles", "merge", "--quiet", *map(str, parts), str(tmp)], check=True)
        tmp.replace(TERRAIN_FULL)
        for part in parts:
            part.unlink()
        full_stamp.write_text(json.dumps({**full_wanted, "sources": [i["name"] for i, _, _ in jobs]}, indent=2) + "\n")
        log(f"terrain: wrote {TERRAIN_FULL.relative_to(ROOT)} ({TERRAIN_FULL.stat().st_size / 1e6:.1f} MB)")

    # Published copy, cut from the full one
    target = OUT / "terrain.pmtiles"
    stamp = OUT / "terrain.json"
    wanted = {"bbox": padded_bbox, "detailBbox": detail_bbox, "coarseMaxzoom": TERRAIN_COARSE_MAXZOOM,
              "detailMaxzoom": TERRAIN_DETAIL_MAXZOOM, "fullSources": json.loads(full_stamp.read_text())["sources"]}
    if target.exists() and stamp.exists() and not force:
        current = json.loads(stamp.read_text())
        if all(current.get(k) == v for k, v in wanted.items()):
            log("terrain: up to date, skipping. Use --force to refresh.")
            return
    coarse, detail_part = CACHE / "terrain_coarse.pmtiles", CACHE / "terrain_detail.pmtiles"
    for part in (coarse, detail_part):
        part.unlink(missing_ok=True)
    subprocess.run(["pmtiles", "extract", str(TERRAIN_FULL), str(coarse), f"--maxzoom={TERRAIN_COARSE_MAXZOOM}"],
                   check=True, capture_output=True)
    subprocess.run(["pmtiles", "extract", str(TERRAIN_FULL), str(detail_part), f"--bbox={','.join(str(v) for v in detail_bbox)}",
                    f"--minzoom={TERRAIN_COARSE_MAXZOOM + 1}", f"--maxzoom={TERRAIN_DETAIL_MAXZOOM}"], check=True, capture_output=True)
    tmp = target.with_suffix(".pmtiles.tmp")
    tmp.unlink(missing_ok=True)
    subprocess.run(["pmtiles", "merge", "--quiet", str(coarse), str(detail_part), str(tmp)], check=True)
    tmp.replace(target)
    for part in (coarse, detail_part):
        part.unlink()
    stamp.write_text(json.dumps(wanted, indent=2) + "\n")
    size = target.stat().st_size / 1e6
    log(f"terrain: wrote {target.relative_to(ROOT)} ({size:.1f} MB)")
    if size > 100:
        log("terrain: WARNING over GitHub's 100 MB file limit; lower TERRAIN_DETAIL_MAXZOOM")


def build_buildings(bbox: list[float], force: bool) -> None:
    """Extract Overture building footprints for the domain bbox."""
    target = OUT / "buildings.pmtiles"
    stamp = OUT / "buildings.json"
    wanted = {"release": OVERTURE_RELEASE, "bbox": bbox}
    if target.exists() and stamp.exists() and not force and json.loads(stamp.read_text()) == wanted:
        log(f"buildings: up to date (Overture {OVERTURE_RELEASE}), skipping")
        return

    log(f"buildings: extracting Overture {OVERTURE_RELEASE} buildings ...")
    tmp = target.with_suffix(".pmtiles.tmp")
    subprocess.run(
        [
            "pmtiles", "extract",
            OVERTURE_BUILDINGS_URL.format(release=OVERTURE_RELEASE),
            str(tmp),
            f"--bbox={','.join(str(v) for v in bbox)}",
        ],
        check=True,
    )
    tmp.replace(target)
    stamp.write_text(json.dumps(wanted, indent=2) + "\n")
    log(f"buildings: wrote {target.relative_to(ROOT)} ({target.stat().st_size / 1e6:.1f} MB)")


def _download(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "aidem-prototype-build"})
    with urllib.request.urlopen(req, timeout=120) as resp:
        return resp.read()


def build_assets(force: bool) -> None:
    """Download basemap fonts + sprites (with their licenses) into public/assets/."""
    stamp = ASSETS_OUT / "assets.json"
    wanted = {"commit": ASSETS_COMMIT, "fonts": ASSETS_FONTS, "sprites": ASSETS_SPRITES}
    if stamp.exists() and not force and json.loads(stamp.read_text()) == wanted:
        log(f"assets: up to date ({ASSETS_COMMIT[:7]}), skipping")
        return

    log(f"assets: downloading protomaps/basemaps-assets@{ASSETS_COMMIT[:7]} ...")
    archive = zipfile.ZipFile(io.BytesIO(_download(ASSETS_ZIP.format(sha=ASSETS_COMMIT))))
    prefix = f"basemaps-assets-{ASSETS_COMMIT}/"

    if ASSETS_OUT.exists():
        shutil.rmtree(ASSETS_OUT)
    keep = [f"fonts/{f}/" for f in ASSETS_FONTS] + ["fonts/OFL.txt", ASSETS_SPRITES]
    count = 0
    for name in archive.namelist():
        rel = name.removeprefix(prefix)
        if name.endswith("/") or not any(rel.startswith(k) for k in keep):
            continue
        dest = ASSETS_OUT / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(archive.read(name))
        count += 1

    (ASSETS_OUT / ASSETS_SPRITES / "LICENSE.md").write_bytes(_download(SPRITES_LICENSE_URL))
    (ASSETS_OUT / "README.md").write_text(
        f"Basemap fonts and sprites from https://github.com/protomaps/basemaps-assets "
        f"(commit {ASSETS_COMMIT}).\n\n"
        "- fonts/: Noto Sans glyphs, SIL Open Font License 1.1 (fonts/OFL.txt)\n"
        f"- {ASSETS_SPRITES}: derived from tangrams/icons, MIT License ({ASSETS_SPRITES}LICENSE.md)\n\n"
        "Generated by scripts/build_data.py, do not edit by hand.\n"
    )
    stamp.write_text(json.dumps(wanted, indent=2) + "\n")
    log(f"assets: wrote {count} files to {ASSETS_OUT.relative_to(ROOT)}")


# ---------------------------------------------------------------------------
# Rasters: value-encoded raster-dem tiles
#
# Each float raster is reprojected to Web Mercator, cut into 512px tiles and
# the actual values are packed into RGB (see DEM_ENCODING, precision 1/256).
# Tiles are lossless WebP, so values survive exactly. MapLibre loads them as a
# `raster-dem` source and colours them in the style with a `color-relief`
# layer, so colour ramps can change without re-tiling.
# NoData is written as NODATA_SENTINEL; give it a transparent colour stop.
# ---------------------------------------------------------------------------

def _tile_bounds(z: int, x: int, y: int) -> tuple[float, float, float, float]:
    span = 2 * MERC_HALF / (1 << z)
    minx = -MERC_HALF + x * span
    maxy = MERC_HALF - y * span
    return minx, maxy - span, minx + span, maxy


def _tile_range(bounds, z: int):
    span = 2 * MERC_HALF / (1 << z)
    left, bottom, right, top = bounds
    x0 = int((left + MERC_HALF) // span)
    x1 = int((right + MERC_HALF - 1e-6) // span)
    y0 = int((MERC_HALF - top) // span)
    y1 = int((MERC_HALF - bottom - 1e-6) // span)
    return x0, x1, y0, y1


_worker_ds = None


_worker_sentinel = NODATA_SENTINEL


def _worker_init(path: str, sentinel: float) -> None:
    global _worker_ds, _worker_sentinel
    _worker_ds = rasterio.open(path)
    _worker_sentinel = sentinel
    atexit.register(_worker_ds.close)


def _render_tile(zxy: tuple[int, int, int]) -> tuple[tuple[int, int, int], bytes | None]:
    ds = _worker_ds
    z, x, y = zxy
    window = from_bounds(*_tile_bounds(z, x, y), transform=ds.transform)
    arr = ds.read(
        1,
        window=window,
        out_shape=(TILE_SIZE, TILE_SIZE),
        resampling=Resampling.bilinear,
        boundless=True,
        fill_value=ds.nodata,
    )
    valid = np.isfinite(arr)
    if ds.nodata is not None:
        valid &= arr != ds.nodata
    if not valid.any():
        return zxy, None

    v = np.where(valid, arr, _worker_sentinel).astype(np.float64) + DEM_ENCODING["baseShift"]
    v = np.clip(v, 0.0, 65535.996)
    base = np.floor(v)
    rgb = np.stack(
        [np.floor(base / 256), base % 256, np.floor((v - base) * 256)], axis=-1
    ).astype(np.uint8)
    buf = io.BytesIO()
    Image.fromarray(rgb, "RGB").save(buf, "WEBP", lossless=True, quality=100, method=4)
    return zxy, buf.getvalue()


def _source_fingerprint(path: Path, cfg: dict) -> dict:
    st = path.stat()
    return {
        "src": str(path.relative_to(SOURCE)),
        "size": st.st_size,
        "mtime": int(st.st_mtime),
        "minzoom": cfg["minzoom"],
        "maxzoom": cfg["maxzoom"],
        "tileSize": TILE_SIZE,
        "sentinel": cfg.get("nodata", NODATA_SENTINEL),
        "encoding": DEM_ENCODING,
    }


def build_raster(cfg: dict, force: bool) -> dict:
    src = RASTER_DIR / cfg["src"]
    out = OUT / f"{cfg['id']}.pmtiles"
    stamp = CACHE / f"{cfg['id']}.json"
    fingerprint = _source_fingerprint(src, cfg)
    sentinel = cfg.get("nodata", NODATA_SENTINEL)

    if out.exists() and stamp.exists() and not force:
        prev = json.loads(stamp.read_text())
        if prev.get("fingerprint") == fingerprint:
            log(f"{cfg['id']}: up to date, skipping")
            return prev["layer"]

    CACHE.mkdir(parents=True, exist_ok=True)

    # 1. Reproject to a Web Mercator COG with overviews. GDAL's
    #    GoogleMapsCompatible zoom levels refer to 256px tiles, so a 512px
    #    tile at zoom z has the resolution of 256px zoom z+1.
    cog = CACHE / f"{cfg['id']}_3857.tif"
    log(f"{cfg['id']}: reprojecting to Web Mercator COG ...")
    with rasterio.Env(GDAL_NUM_THREADS="ALL_CPUS", GDAL_CACHEMAX=1024):
        rio_copy(
            str(src),
            str(cog),
            driver="COG",
            TILING_SCHEME="GoogleMapsCompatible",
            ZOOM_LEVEL=cfg["maxzoom"] + TILE_SIZE // 256 - 1,
            RESAMPLING="BILINEAR",
            OVERVIEW_RESAMPLING="AVERAGE",
            COMPRESS="DEFLATE",
            PREDICTOR="YES",
            NUM_THREADS="ALL_CPUS",
            BIGTIFF="IF_SAFER",
        )

    with rasterio.open(cog) as ds:
        merc_bounds = ds.bounds
        lonlat = transform_bounds(ds.crs, "EPSG:4326", *ds.bounds)
        sample = ds.read(1, out_shape=(max(1, ds.height // 16), max(1, ds.width // 16)), masked=True)
        stats = {"min": round(float(sample.min()), 3), "max": round(float(sample.max()), 3)}
        nodata = ds.nodata
    log(f"{cfg['id']}: COG done, values {stats['min']} .. {stats['max']} {cfg.get('units', '')}, nodata {nodata}")

    # 2. Render tiles in parallel and write them into an MBTiles file.
    jobs = []
    for z in range(cfg["minzoom"], cfg["maxzoom"] + 1):
        x0, x1, y0, y1 = _tile_range(merc_bounds, z)
        jobs += [(z, x, y) for x in range(x0, x1 + 1) for y in range(y0, y1 + 1)]
    log(f"{cfg['id']}: rendering up to {len(jobs)} tiles (z{cfg['minzoom']}-{cfg['maxzoom']}) ...")

    mbtiles = CACHE / f"{cfg['id']}.mbtiles"
    mbtiles.unlink(missing_ok=True)
    db = sqlite3.connect(mbtiles)
    db.execute("CREATE TABLE metadata (name TEXT, value TEXT)")
    db.execute("CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB)")
    db.executemany(
        "INSERT INTO metadata VALUES (?, ?)",
        [
            ("name", cfg["id"]),
            ("format", "webp"),
            ("type", "overlay"),
            ("minzoom", str(cfg["minzoom"])),
            ("maxzoom", str(cfg["maxzoom"])),
            ("bounds", ",".join(f"{v:.6f}" for v in lonlat)),
            ("description", f"Value-encoded raster-dem {cfg['id']} ({cfg.get('units', '')}), nodata={sentinel}"),
        ],
    )
    written = 0
    with ProcessPoolExecutor(initializer=_worker_init, initargs=(str(cog), sentinel)) as pool:
        for (z, x, y), data in pool.map(_render_tile, jobs, chunksize=16):
            if data is None:
                continue
            db.execute(
                "INSERT INTO tiles VALUES (?, ?, ?, ?)",
                (z, x, (1 << z) - 1 - y, data),
            )
            written += 1
    db.commit()
    db.close()
    log(f"{cfg['id']}: {written} non-empty tiles")

    # 3. Convert to PMTiles.
    subprocess.run(["pmtiles", "convert", "--quiet", "--force", str(mbtiles), str(out)], check=True)
    mbtiles.unlink()
    log(f"{cfg['id']}: wrote {out.relative_to(ROOT)} ({out.stat().st_size / 1e6:.1f} MB)")

    layer = {
        "url": f"data/{out.name}",
        **DEM_ENCODING,
        "tileSize": TILE_SIZE,
        "minzoom": cfg["minzoom"],
        "maxzoom": cfg["maxzoom"],
        "bounds": [round(v, 6) for v in lonlat],
        "units": cfg.get("units"),
        "nodata": sentinel,
        **stats,
    }
    stamp.write_text(json.dumps({"fingerprint": fingerprint, "layer": layer}, indent=2) + "\n")
    return layer


def build_rasters(force: bool) -> dict:
    layers = {cfg["id"]: build_raster(cfg, force) for cfg in RASTERS}
    (OUT / "rasters.json").write_text(json.dumps(layers, indent=2) + "\n")
    return layers


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--force", action="store_true", help="rebuild everything, including the basemap")
    args = parser.parse_args()

    build_domain()
    build_evacuation_zones()
    build_cascade()
    layers =build_rasters(force=args.force)
    # Basemap, buildings and coarse terrain cover the flood extent plus
    # DATA_PADDING (the map itself is limited to the flood extent plus 10%,
    # see map/core.js; the extra margin fills the horizon in tilted views).
    data_bbox = _pad(_union_bounds(layers), DATA_PADDING)
    build_basemap(data_bbox, force=args.force)
    build_assets(force=args.force)
    build_terrain(data_bbox, layers, force=args.force)
    build_dam()
    build_buildings(data_bbox, force=args.force)
    log("done")


if __name__ == "__main__":
    main()
