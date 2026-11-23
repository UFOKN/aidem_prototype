"""Cascade round 4: round 3 plus the hypothetical Franklin Water Utilities.

The AidEM team's "Critical Infrastructure v4" (Nov 2026) is round 3's CIKR file
plus one record, Franklin Water Utilities (water treatment), and its service
area. Round 3 was run by the cascade analysis in "../data/cascades v3" with
USACE's full data package (NSI buildings, flood grids), which this machine
doesn't have. This script applies round 3's rules to the new plant using only
round 3's output, so no package is needed:

- The plant stays dry. Like the hospitals and schools, it needs power: it
  fails when a failed power provider whose area it lies in goes offline
  (Franklin Power Ventures, tier 2, 2:54 PM).
- Its service, drinking water, is lost in its whole service area, one tier
  later (tier 3): by every dry building there, and by the dry hospitals and
  schools, which need drinking water (round 2's rule).
- As in round 3, a facility that fails in tier 3 takes nothing further down.

Every dry building in the water area is already in round 3's output, because
the area lies wholly inside the service areas of providers that failed in
round 3 (the power plant and the flooded or powerless hospitals and schools),
and round 3 keeps every dry building in a failed provider's area. The script
checks that and stops if it ever stops being true, since buildings outside
round 3's output would then be missing.

Writes the same files as round 3 to ../data/cascades v4/output (the publish
GeoPackage and overview map aren't made). Usage:

    uv run --with geopandas --with pyogrio --with rasterio python scripts/cascade_round4.py
"""
import csv
import json
import shutil
from pathlib import Path

import geopandas as gpd
import numpy as np
import pandas as pd
import rasterio
import shapely

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT.parent / "data"
ROUND3 = DATA / "cascades v3" / "cambria_county_cascade_round3" / "output"
OUT = DATA / "cascades v4" / "output"
CIKR_DIR = DATA / "December_Demo_Flood_Data" / "Critical Infrastructure v4 ForKai"
CIKR = CIKR_DIR / "CIKR_2026_Study_Area.shp"
STUDY_AREA = DATA / "December_Demo_Flood_Data" / "Study Area" / "Study Area.shp"
EVAC_ZONES = DATA / "c_Evacuation Zones v2" / "Evacuation_Zones_v2.shp"
DEPTH = DATA / "a_Flood Files" / "a_Raster Outputs" / "Depth (Max).Johnstown_Terrain.Johnstown_Terrain.Jamestown_BE_DEM_20211229.tif"

ROUND = 4
PLANT = "Franklin Water Utilities"
PLANT_AREA = CIKR_DIR / "FranklinWaterUtilities_ServiceArea.shp"
SERVICE = "drinking water"
NEEDS_WATER = {"Hospitals", "Schools"}
FAIL_DEPTH_FT = 2.0
TIERS = ["primary", "secondary", "tertiary"]
OUTSIDE = "outside"
METRIC = 32617  # UTM 17N, for areas


def join(a, b, sep: str) -> str:
    """Join two ;-lists into one sorted list without duplicates."""
    items = {s.strip() for v in (a, b) if isinstance(v, str) for s in v.split(sep.strip()) if s.strip()}
    return sep.join(sorted(items))


def depth_at(points: gpd.GeoSeries) -> np.ndarray:
    """Maximum flood depth (ft) at each point, NaN where dry."""
    with rasterio.open(DEPTH) as src:
        xy = points.to_crs(src.crs)
        v = np.array([s[0] for s in src.sample(zip(xy.x, xy.y))], dtype=float)
        v[(v == src.nodata) | (v <= 0)] = np.nan
    return v


def zone_of(points: gpd.GeoSeries, zones: gpd.GeoDataFrame) -> pd.Series:
    hit = gpd.sjoin(gpd.GeoDataFrame(geometry=points, crs=zones.crs), zones[["zone", "geometry"]], predicate="within")
    return hit.zone[~hit.index.duplicated()].reindex(points.index).fillna(OUTSIDE)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    zones = gpd.read_file(EVAC_ZONES).to_crs(4326)
    zones["zone"] = zones.Zone.astype(int).astype(str)
    zones = zones.sort_values("zone").reset_index(drop=True)
    counties = gpd.read_file(STUDY_AREA).to_crs(4326)[["CountyName", "StAbb", "geometry"]]

    cikr = gpd.read_file(CIKR).to_crs(4326)
    cikr = cikr[~(cikr.Point_Type.isna() & cikr.NAME.isna())].reset_index(drop=True)
    cikr["fid"] = np.arange(len(cikr))
    cikr["Point_Type"] = cikr.Point_Type.str.strip()
    cikr["NAME"] = cikr.NAME.str.strip()
    plant = cikr[cikr.NAME == PLANT].iloc[0]
    plant_key = f"cikr/{plant.fid}"
    area = shapely.union_all(gpd.read_file(PLANT_AREA).to_crs(4326).geometry.to_numpy())

    # --- round 3 ---------------------------------------------------------------------------------
    gpkg = ROUND3 / "impacted_buildings.gpkg"
    b = gpd.read_file(gpkg, layer="all_impacted")
    layers = {t: gpd.read_file(gpkg, layer=t) for t in TIERS}
    fac = {t: gpd.read_file(ROUND3 / f"{t}_facilities.geojson") for t in TIERS}
    for t in TIERS:  # round 3 has no tertiary facilities: its layer has no columns
        if fac[t].empty:
            fac[t] = fac["secondary"].iloc[0:0].copy()
    sa = gpd.read_file(ROUND3 / "service_areas.geojson")
    links = list(csv.DictReader(open(ROUND3 / "facility_links.csv")))
    summary3 = json.loads((ROUND3 / "summary.json").read_text())

    # Round 3's keys must still name the same facilities in the v4 file.
    for _, r in sa.iterrows():
        if r.pid.startswith("cikr/") and cikr.NAME[int(r.pid[5:])] != r["name"].strip():
            raise SystemExit(f"CIKR v4 renumbered {r.pid}: {r['name']} -> {cikr.NAME[int(r.pid[5:])]}")

    # --- the plant fails: power lost from a failed provider -------------------------------------
    power = sa[(sa.service == "electric power") & sa.contains(plant.geometry)]
    if power.empty:
        raise SystemExit(f"{PLANT} lies in no failed power provider's area: it doesn't fail")
    src = power.sort_values("offline_h").iloc[0]
    plant_tier = TIERS[TIERS.index(src.tier) + 1]
    water_tier = TIERS[TIERS.index(plant_tier) + 1]
    offline = float(src.offline_h)
    print(f"{PLANT} loses power from {src['name']} at {offline:.2f} h ({plant_tier}); "
          f"its area loses {SERVICE} in the {water_tier} tier")

    # Every dry building in the area must already be in round 3's output (see the docstring).
    uncovered = shapely.difference(area, shapely.union_all(sa.geometry.to_numpy()))
    uncovered_km2 = gpd.GeoSeries([uncovered], crs=4326).to_crs(METRIC).area.iloc[0] / 1e6
    if uncovered_km2 > 0.01:
        raise SystemExit(f"{uncovered_km2:.2f} km2 of the water area lies outside round 3's failed provider "
                         "areas: its buildings aren't in round 3's output, so this needs a full cascade run")

    # --- buildings -------------------------------------------------------------------------------
    inside = b.within(area) & (b.in_primary == 0)
    ids = set(b.fd_id[inside])
    print(f"buildings losing {SERVICE}: {len(ids):,}")
    b.loc[inside, "services_lost"] = b.loc[inside, "services_lost"].map(lambda v: join(v, SERVICE, "; "))
    b.loc[inside, "n_services"] = b.loc[inside, "services_lost"].str.split("; ").str.len()
    b.loc[inside, "first_impact_h"] = b.loc[inside, "first_impact_h"].fillna(np.inf).clip(upper=offline)
    b.loc[inside, "in_" + water_tier] = 1

    lay = layers[water_tier]
    old = lay.fd_id.isin(ids)
    lay.loc[old, "caused_by"] = lay.loc[old, "caused_by"].map(lambda v: join(v, plant_key, ";"))
    lay.loc[old, "services"] = lay.loc[old, "services"].map(lambda v: join(v, SERVICE, "; "))
    lay.loc[old, "impact_h"] = lay.loc[old, "impact_h"].clip(upper=offline)
    new = b[b.fd_id.isin(ids - set(lay.fd_id))].copy()
    new["tier"], new["certainty"], new["caused_by"], new["services"], new["impact_h"] = \
        water_tier, "modelled", plant_key, SERVICE, offline
    lay = pd.concat([lay, new[lay.columns]], ignore_index=True)
    layers[water_tier] = gpd.GeoDataFrame(lay, crs=b.crs)
    # Keep the in_* flags and services in every tier layer in step with all_impacted.
    for t in TIERS:
        cols = ["services_lost", "n_services", "in_primary", "in_secondary", "in_tertiary"]
        upd = b.set_index("fd_id")[cols]
        layers[t] = layers[t].drop(columns=cols).join(upd, on="fd_id")

    # --- facilities ------------------------------------------------------------------------------
    allfac = pd.concat(fac.values(), ignore_index=True)
    first = allfac.drop_duplicates("NAME").set_index("NAME").first_tier.to_dict()

    def new_facility(r, tier: str, cause: str, service: str) -> dict:
        d = depth_at(gpd.GeoSeries([r.geometry], crs=4326))[0]
        county = counties[counties.contains(r.geometry)]
        return {"NAME": r.NAME, "Point_Type": r.Point_Type, "Address": r.Address,
                "CountyName": county.CountyName.iloc[0] if len(county) else None,
                "StAbb": county.StAbb.iloc[0] if len(county) else None, "source": "CIKR",
                "depth_ft": d, "severity": None, "dxv": None, "first_wet_h": None, "two_ft_h": None,
                "services_lost": service, "evac_zone": zone_of(gpd.GeoSeries([r.geometry]), zones).iloc[0],
                "tier": tier, "certainty": "modelled", "caused_by": cause, "services": service, "impact_h": offline,
                "first_tier": tier, "in_primary": 0, "in_secondary": int(tier == "secondary"),
                "in_tertiary": int(tier == "tertiary"), "geometry": r.geometry}

    rows = {t: [] for t in TIERS}
    rows[plant_tier].append(new_facility(plant, plant_tier, src.pid, "electric power"))
    new_links = [{"from": src.pid, "from_name": src["name"], "to": plant_key, "to_name": PLANT, "to_type": plant.Point_Type,
                  "service_lost": "electric power", "tier": plant_tier, "certainty": "modelled", "impact_h": offline,
                  "first_loss": True}]
    deps = cikr[cikr.within(area) & cikr.Point_Type.isin(NEEDS_WATER)]
    for _, r in deps.iterrows():
        was = first.get(r.NAME)
        if was == "primary":
            continue  # flooded: fails anyway (round 3 links nothing to flooded facilities)
        new_links.append({"from": plant_key, "from_name": PLANT, "to": f"cikr/{r.fid}", "to_name": r.NAME,
                          "to_type": r.Point_Type, "service_lost": SERVICE, "tier": water_tier, "certainty": "modelled",
                          "impact_h": offline, "first_loss": was is None})
        if was is None:
            rows[water_tier].append(new_facility(r, water_tier, plant_key, SERVICE))
            print(f"  {r.NAME} ({r.Point_Type}) loses {SERVICE} ({water_tier})")
        else:
            # Already failed earlier: also in this tier, for this loss.
            prev = allfac[allfac.NAME == r.NAME].iloc[0].to_dict()
            prev.update(tier=water_tier, caused_by=plant_key, services=SERVICE, impact_h=offline,
                        services_lost=join(prev["services_lost"], SERVICE, "; "), in_tertiary=1)
            rows[water_tier].append(prev)
            for t in TIERS:
                hit = fac[t].NAME == r.NAME
                fac[t].loc[hit, "services_lost"] = prev["services_lost"]
                fac[t].loc[hit, "in_tertiary"] = 1
            print(f"  {r.NAME} ({r.Point_Type}) also loses {SERVICE} ({water_tier}; failed in the {was} tier)")
    for t in TIERS:
        if rows[t]:
            fac[t] = gpd.GeoDataFrame(pd.concat([fac[t], gpd.GeoDataFrame(rows[t], crs=4326)], ignore_index=True), crs=4326)

    # --- service areas ---------------------------------------------------------------------------
    served = b[b.fd_id.isin(ids)]
    sa = pd.concat([sa, gpd.GeoDataFrame([{
        "pid": plant_key, "name": PLANT, "kind": plant.Point_Type, "source": "CIKR", "service": SERVICE,
        "tier": plant_tier, "certainty": "modelled", "area_basis": "provided", "max_depth_ft": 0.0, "offline_h": offline,
        "population_served": None, "flooded_area_km2": None, "buildings": len(served),
        "pop_night": float(served.pop_night.sum()), "pop_day": float(served.pop_day.sum()), "geometry": area}], crs=4326)],
        ignore_index=True)
    # Facilities that fail in the last tier take nothing down, so their (empty) areas aren't added;
    # they're counted in failed_providers below, as round 3 would.
    tertiary_failures = [r for r in rows[water_tier] if first.get(r["NAME"]) is None]

    # --- write -----------------------------------------------------------------------------------
    gpkg_out = OUT / "impacted_buildings.gpkg"
    gpkg_out.unlink(missing_ok=True)
    b.to_file(gpkg_out, layer="all_impacted", driver="GPKG")
    for t in TIERS:
        layers[t].to_file(gpkg_out, layer=t, driver="GPKG")
    for t in TIERS:
        fac[t].to_file(OUT / f"{t}_facilities.geojson", driver="GeoJSON")
    gpd.GeoDataFrame(sa, crs=4326).to_file(OUT / "service_areas.geojson", driver="GeoJSON")
    with open(OUT / "facility_links.csv", "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=list(links[0]))
        w.writeheader()
        w.writerows(links + new_links)
    for name in ("flood_extent.geojson",):
        shutil.copyfile(ROUND3 / name, OUT / name)

    # --- summary (as cascade.py makes it) --------------------------------------------------------
    facilities = pd.concat(fac.values(), ignore_index=True).drop_duplicates("NAME")
    facilities = facilities.set_index("NAME")
    for t in TIERS:  # inclusive flags and per-tier times from every tier layer
        names = set(fac[t].NAME)
        facilities[f"in_{t}"] = facilities.index.isin(names).astype(int)
        facilities[f"impact_h_{t[:3]}"] = fac[t].set_index("NAME").impact_h.groupby(level=0).min().reindex(facilities.index)
    facilities["first_impact_h"] = facilities[[f"impact_h_{t[:3]}" for t in TIERS]].min(axis=1)
    facilities = facilities.reset_index()
    for t in TIERS:
        b[f"impact_h_{t[:3]}"] = layers[t].set_index("fd_id").impact_h.reindex(b.fd_id).to_numpy()

    def counts(frame, people: bool) -> dict:
        out = {"count": len(frame)}
        if people:
            out.update(pop_night=int(round(frame.pop_night.sum())), pop_day=int(round(frame.pop_day.sum())))
        return out

    summary = {"note": summary3["note"], "round": ROUND,
               "derived_from": f"round 3's output plus {PLANT} (Critical Infrastructure v4), by Prototype/scripts/cascade_round4.py",
               "fail_depth_ft": summary3["fail_depth_ft"], "building_depth_ft": summary3["building_depth_ft"],
               "dam_failure_h": summary3["dam_failure_h"], "cikr_records": len(cikr)}
    for name, layer_of, frame, people in (("buildings", layers, b, True), ("facilities", fac, facilities, False)):
        summary[name] = {}
        for t in TIERS:
            layer = layer_of[t]
            first_t = frame[frame.first_tier == t]
            entry = {"affected": {c: counts(g, people) for c, g in layer.groupby("certainty")},
                     "first_affected": counts(first_t, people),
                     "first_affected_from_h": None if first_t.first_impact_h.isna().all() else
                         round(float(first_t.first_impact_h.min()), 2)}
            if not people:
                entry["affected_by_type"] = layer.Point_Type.value_counts().to_dict()
            summary[name][t] = entry
    failed = sa.groupby(["tier", "kind"]).size()
    summary["failed_providers"] = {t: (failed[t].to_dict() if t in failed.index.get_level_values(0) else {}) for t in TIERS}
    for r in tertiary_failures:
        fp = summary["failed_providers"][water_tier]
        fp[r["Point_Type"]] = fp.get(r["Point_Type"], 0) + 1
    shallow = [r for t in TIERS for r in rows[t] if r["depth_ft"] and 0 < r["depth_ft"] < FAIL_DEPTH_FT]
    summary["wet_below_fail_depth"] = summary3["wet_below_fail_depth"] + [
        {"name": r["NAME"], "type": r["Point_Type"], "depth_ft": round(float(r["depth_ft"]), 2)} for r in shallow]
    summary["substation_yards_wet"] = summary3["substation_yards_wet"]

    zrows = []
    for zone in zones.zone.tolist() + [OUTSIDE, "all"]:
        bz = b if zone == "all" else b[b.evac_zone == zone]
        fz = facilities if zone == "all" else facilities[facilities.evac_zone == zone]
        for t in TIERS + ["any"]:
            bt = bz if t == "any" else bz[bz[f"in_{t}"] == 1]
            ft = fz if t == "any" else fz[fz[f"in_{t}"] == 1]
            col = "first_impact_h" if t == "any" else f"impact_h_{t[:3]}"
            h = pd.concat([bt[col], ft[col]])
            zrows.append({
                "evac_zone": zone, "tier": t, "buildings": len(bt),
                "buildings_first_affected": int((bz.first_tier == t).sum()) if t != "any" else len(bz),
                "pop_night": int(round(bt.pop_night.sum())), "pop_day": int(round(bt.pop_day.sum())),
                "facilities": len(ft), "hospitals": int((ft.Point_Type == "Hospitals").sum()),
                "schools": int((ft.Point_Type == "Schools").sum()),
                "power_facilities": int(ft.Point_Type.isin(["Electric Substations", "Electric Power Generation"]).sum()),
                "water_facilities": int((ft.Point_Type == "Water Treatment").sum()),
                "earliest_impact_h": None if h.isna().all() else round(float(h.min()), 2),
                "facility_names": "; ".join(sorted(ft.NAME.astype(str)))})
    zsum = pd.DataFrame(zrows)
    zsum.to_csv(OUT / "evacuation_zone_summary.csv", index=False)
    summary["evacuation_zones"] = {
        z: {t: {k: (None if pd.isna(v) else v) for k, v in r.items() if k not in ("evac_zone", "tier", "facility_names")}
            for t, r in g.set_index("tier").to_dict("index").items()}
        for z, g in zsum.groupby("evac_zone", sort=False)}
    (OUT / "summary.json").write_text(json.dumps(summary, indent=2))
    print(json.dumps({k: summary[k] for k in ("buildings", "facilities", "failed_providers")}, indent=1))


if __name__ == "__main__":
    main()
