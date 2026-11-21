"""
Build ward-level input tables for disaster_lens from the downloaded data.

Writes inputs/ward_data.csv with one row per ward (ward_id plus columns that
disaster_lens understands) and prints sanity checks. Run after
collect_worldpop.py and collect_osm.py. Everything is restricted to Delhi.

Columns produced
  total_population, pop_0_4, pop_65_plus   WorldPop 2020 (1 km), area-weighted
  hospital_travel_min                       ESTIMATE: straight-line distance from
                                            the ward centroid to the nearest OSM
                                            hospital x 1.3 detour / 20 km/h
  hospitals_in_ward, clinics_in_ward        OSM counts (extra, not scored)
  water_points_per_km2                      OSM public drinking-water points (extra)
  slum_features_in_ward                     OSM slum tags (extra; OSM is incomplete)
  tree_cover_pct, green_cover_pct, built_up_share, built_up_area_km2,
  water_share_pct                           ESA WorldCover 2021 (from collect_satellite.py)
  lst_mean_c, lst_p90_c, lst_hot45_share, ndvi_mean, lst_scenes, lst_years
                                            Landsat 8/9 Apr-Jun 2019-2025 (collect_satellite.py)
  assets_index, tap_treated_pct, tap_in_premises_pct, poor_housing_index, ...
                                            Census 2011 HL-14 household tables (build_census.py)
"""
import json
from pathlib import Path

import numpy as np
import pandas as pd
import rasterio
from pyproj import Transformer
from rasterio.windows import from_bounds
from shapely.geometry import Point, box, shape
from shapely.ops import unary_union
from shapely.strtree import STRtree

DATA = Path("data")
OUT = Path("inputs")
SPEED_KMH, DETOUR = 20.0, 1.3   # assumptions for the hospital travel-time estimate


def load_wards():
    gj = json.load(open("delhi_wards.geojson"))
    return [(f["properties"]["ward_id"], shape(f["geometry"])) for f in gj["features"]]


def raster_to_wards(path, wards):
    """Sum a population raster into wards, splitting each pixel by area overlap."""
    with rasterio.open(path) as ds:
        minx = min(g.bounds[0] for _, g in wards); miny = min(g.bounds[1] for _, g in wards)
        maxx = max(g.bounds[2] for _, g in wards); maxy = max(g.bounds[3] for _, g in wards)
        win = from_bounds(minx - 0.02, miny - 0.02, maxx + 0.02, maxy + 0.02, ds.transform).round_offsets().round_lengths()
        arr = ds.read(1, window=win, masked=True).filled(0).astype(float)
        tr = ds.window_transform(win)
    arr[arr < 0] = 0
    cells = []
    for r in range(arr.shape[0]):
        for c in range(arr.shape[1]):
            if arr[r, c] > 0:
                x0, y0 = tr * (c, r + 1)
                x1, y1 = tr * (c + 1, r)
                cells.append((box(x0, y0, x1, y1), arr[r, c]))
    geoms = [g for g, _ in cells]
    tree = STRtree(geoms)
    out = {}
    for wid, wg in wards:
        total = 0.0
        for i in tree.query(wg):
            inter = geoms[i].intersection(wg).area
            if inter > 0:
                total += cells[i][1] * inter / geoms[i].area
        out[wid] = total
    return pd.Series(out), float(arr.sum())


def osm_points(name, boundary):
    p = DATA / f"osm_{name}.json"
    if not p.exists():
        return []
    pts = []
    for e in json.load(open(p)).get("elements", []):
        lat, lon = (e.get("lat"), e.get("lon")) if e["type"] == "node" else (
            e.get("center", {}).get("lat"), e.get("center", {}).get("lon"))
        if lat is None:
            continue
        pt = Point(lon, lat)
        if boundary.contains(pt):
            pts.append((pt, e.get("tags", {})))
    return pts


def main():
    OUT.mkdir(exist_ok=True)
    wards = load_wards()
    boundary = unary_union([g for _, g in wards]).buffer(0.002)
    ids = [w for w, _ in wards]
    df = pd.DataFrame(index=pd.Index(ids, name="ward_id"))

    # ---- population (WorldPop) ----
    wp = DATA / "worldpop"
    if (wp / "total.tif").exists():
        tot, window_total = raster_to_wards(wp / "total.tif", wards)
        df["total_population"] = tot
        print(f"total population: wards sum {tot.sum():,.0f} (raster window {window_total:,.0f})")
        for col, parts in (("pop_0_4", [f"{s}_{a}" for s in "fm" for a in (0, 1)]),
                           ("pop_65_plus", [f"{s}_{a}" for s in "fm" for a in (65, 70, 75, 80)])):
            if all((wp / f"{p}.tif").exists() for p in parts):
                df[col] = sum(raster_to_wards(wp / f"{p}.tif", wards)[0] for p in parts)
                print(f"{col}: {df[col].sum():,.0f} ({100 * df[col].sum() / df.total_population.sum():.1f}% of population)")
            else:
                print(f"{col}: skipped (age rasters not all downloaded yet)")

    # ---- OpenStreetMap ----
    to_m = Transformer.from_crs(4326, 32643, always_xy=True).transform  # UTM 43N, metres
    health = osm_points("health", boundary)
    if health:
        hosp = [p for p, t in health if t.get("amenity") == "hospital" or t.get("healthcare") == "hospital"]
        clin = [p for p, t in health if p not in hosp]
        hx = np.array([to_m(p.x, p.y) for p in hosp])
        cent = {w: g.representative_point() for w, g in wards}
        dist_km = {}
        for w, c in cent.items():
            cx, cy = to_m(c.x, c.y)
            dist_km[w] = float(np.min(np.hypot(hx[:, 0] - cx, hx[:, 1] - cy))) / 1000.0
        df["hospital_travel_min"] = pd.Series(dist_km).mul(DETOUR / SPEED_KMH * 60.0)
        df["hospitals_in_ward"] = pd.Series({w: sum(g.contains(p) for p in hosp) for w, g in wards})
        df["clinics_in_ward"] = pd.Series({w: sum(g.contains(p) for p in clin) for w, g in wards})
        print(f"OSM health: {len(hosp)} hospitals, {len(clin)} clinics/doctors inside Delhi; "
              f"hospital_travel_min median {df.hospital_travel_min.median():.1f}, max {df.hospital_travel_min.max():.1f}")
    water = osm_points("water", boundary)
    if water:
        area = {w: g.area * (111.0 * 111.0 * np.cos(np.radians(28.6))) for w, g in wards}  # km2 approx
        df["water_points_per_km2"] = pd.Series({w: sum(g.contains(p) for p, _ in water) for w, g in wards}) / pd.Series(area)
        print(f"OSM water points: {len(water)} inside Delhi")
    slum = osm_points("slum", boundary)
    if (DATA / "osm_slum.json").exists():
        df["slum_features_in_ward"] = pd.Series({w: sum(g.contains(p) for p, _ in slum) for w, g in wards})
        print(f"OSM slum features: {len(slum)} inside Delhi (OSM coverage is incomplete)")

    # ---- satellite layers (collect_satellite.py) ----
    for fname in ("ward_landcover.csv", "ward_landsat.csv", "ward_census.csv"):
        f = OUT / fname
        if f.exists():
            extra = pd.read_csv(f, dtype={"ward_id": str}).set_index("ward_id")
            df = df.join(extra)
            print(f"merged {fname}: {list(extra.columns)}")

    df.reset_index().to_csv(OUT / "ward_data.csv", index=False)
    print(f"\nwrote {OUT / 'ward_data.csv'}: {len(df)} wards, columns {list(df.columns)}")
    print(df.describe().loc[["count", "min", "50%", "max"]].round(1).T.to_string())


if __name__ == "__main__":
    main()
