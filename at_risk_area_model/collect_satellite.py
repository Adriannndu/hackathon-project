"""
Satellite layers for each Delhi ward, from Microsoft Planetary Computer (free,
no account needed).

  --landcover  ESA WorldCover 2021 (10 m): tree cover %, green cover %,
               built-up share and area, water share  -> inputs/ward_landcover.csv
  --landsat    Landsat 8/9 Collection 2 Level-2, April-June clear scenes
               (2019-2025): land surface temperature and NDVI per ward
                                                      -> inputs/ward_landsat.csv

Landsat scenes are processed one at a time and cached in data/landsat/, so the
script can be interrupted and re-run. LST is read at ~90 m (the sensor's native
thermal resolution is 100 m).

Usage: python collect_satellite.py [--landcover] [--landsat] [--max-per-year 3]
"""
import argparse
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import planetary_computer as pc
import pystac_client
import rasterio
from pyproj import Transformer
from rasterio.features import rasterize
from rasterio.transform import Affine
from rasterio.windows import Window, from_bounds
from shapely.geometry import shape
from shapely.ops import transform as shp_transform

STAC = "https://planetarycomputer.microsoft.com/api/stac/v1"
OUT, CACHE = Path("inputs"), Path("data/landsat")


def load_wards():
    gj = json.load(open("delhi_wards.geojson"))
    wards = [(f["properties"]["ward_id"], shape(f["geometry"])) for f in gj["features"]]
    area = {f["properties"]["ward_id"]: f["properties"]["area_km2"] for f in gj["features"]}
    return wards, area


def bounds_of(wards, pad=0.01):
    return (min(g.bounds[0] for _, g in wards) - pad, min(g.bounds[1] for _, g in wards) - pad,
            max(g.bounds[2] for _, g in wards) + pad, max(g.bounds[3] for _, g in wards) + pad)


def catalog():
    return pystac_client.Client.open(STAC, modifier=pc.sign_inplace)


# ------------------------------------------------------------- land cover
def landcover(wards, area_km2):
    minx, miny, maxx, maxy = bounds_of(wards)
    items = list(catalog().search(collections=["esa-worldcover"], bbox=[minx, miny, maxx, maxy],
                                  datetime="2021-01-01/2021-12-31").items())
    if not items:
        raise SystemExit("ESA WorldCover 2021 tile not found")
    print(f"reading {items[0].id} ...", flush=True)
    with rasterio.open(items[0].assets["map"].href) as ds:
        win = from_bounds(minx, miny, maxx, maxy, ds.transform).round_offsets().round_lengths()
        cls = ds.read(1, window=win)
        tr = ds.window_transform(win)
    ids = rasterize([(g, i + 1) for i, (_, g) in enumerate(wards)], out_shape=cls.shape,
                    transform=tr, fill=0, dtype="int32")
    inside = ids > 0
    counts = np.bincount((ids[inside].astype(np.int64) * 256 + cls[inside]),
                         minlength=(len(wards) + 1) * 256).reshape(len(wards) + 1, 256)
    rows = []
    for i, (wid, _) in enumerate(wards):
        c = counts[i + 1]
        n = c.sum()
        share = lambda codes: float(c[list(codes)].sum()) / n if n else np.nan
        rows.append({"ward_id": wid, "tree_cover_pct": 100 * share([10]),
                     "green_cover_pct": 100 * share([10, 20, 30]),
                     "built_up_share": share([50]), "water_share_pct": 100 * share([80, 90]),
                     "built_up_area_km2": share([50]) * area_km2[wid]})
    df = pd.DataFrame(rows)
    OUT.mkdir(exist_ok=True)
    df.to_csv(OUT / "ward_landcover.csv", index=False)
    print(f"wrote {OUT / 'ward_landcover.csv'}")
    print(df.describe().loc[["min", "50%", "max"]].round(2).T.to_string())


# ------------------------------------------------------------------ landsat
def scene_stats(item, wards, ward_cache):
    props = item.properties
    epsg = props.get("proj:epsg") or int(str(props["proj:code"]).split(":")[1])
    if epsg not in ward_cache:
        fn = Transformer.from_crs(4326, epsg, always_xy=True).transform
        ward_cache[epsg] = [(wid, shp_transform(fn, g)) for wid, g in wards]
    ws = ward_cache[epsg]
    minx = min(g.bounds[0] for _, g in ws); miny = min(g.bounds[1] for _, g in ws)
    maxx = max(g.bounds[2] for _, g in ws); maxy = max(g.bounds[3] for _, g in ws)
    step = 3  # read every 3rd 30 m pixel (~90 m)
    with rasterio.open(item.assets["lwir11"].href) as ds:
        win = from_bounds(minx, miny, maxx, maxy, ds.transform).round_offsets().round_lengths()
        win = win.intersection(Window(0, 0, ds.width, ds.height))
        if win.width < 30 or win.height < 30:
            return None
        shape_out = (max(1, int(win.height // step)), max(1, int(win.width // step)))
        tr = ds.window_transform(win) * Affine.scale(win.width / shape_out[1], win.height / shape_out[0])
        lst_dn = ds.read(1, window=win, out_shape=shape_out)

    def band(name):
        with rasterio.open(item.assets[name].href) as d:
            return d.read(1, window=win, out_shape=shape_out)

    qa, red, nir = band("qa_pixel"), band("red"), band("nir08")
    clear = (qa & 0b111111) == 0                       # not fill/cloud/shadow/cirrus/snow
    lst = lst_dn * 0.00341802 + 149.0 - 273.15
    ok = clear & (lst_dn > 0) & (lst > 5) & (lst < 80)
    r, n = red * 0.0000275 - 0.2, nir * 0.0000275 - 0.2
    with np.errstate(invalid="ignore", divide="ignore"):
        ndvi = (n - r) / (n + r)
    ids = rasterize([(g, i + 1) for i, (_, g) in enumerate(ws)], out_shape=shape_out,
                    transform=tr, fill=0, dtype="int32")
    df = pd.DataFrame({"i": ids.ravel(), "lst": np.where(ok, lst, np.nan).ravel(),
                       "ndvi": np.where(ok, ndvi, np.nan).ravel()})
    df = df[df.i > 0]
    g = df.groupby("i")
    out = pd.DataFrame({"n_px": g.size(), "n_ok": g.lst.count(), "lst_mean": g.lst.mean(),
                        "lst_p90": g.lst.quantile(0.9), "ndvi_mean": g.ndvi.mean()})
    out["valid_frac"] = out.n_ok / out.n_px
    out["ward_id"] = [ws[i - 1][0] for i in out.index]
    out["scene"] = item.id
    out["date"] = item.datetime.strftime("%Y-%m-%d")
    return out[out.valid_frac >= 0.5].reset_index(drop=True)


def landsat(wards, max_per_year):
    CACHE.mkdir(parents=True, exist_ok=True)
    minx, miny, maxx, maxy = bounds_of(wards)
    cat = catalog()
    found = cat.search(collections=["landsat-c2-l2"], bbox=[minx, miny, maxx, maxy],
                       datetime="2019-04-01/2025-06-30",
                       query={"eo:cloud_cover": {"lt": 12}, "platform": {"in": ["landsat-8", "landsat-9"]}}).items()
    scenes = [i for i in found if i.datetime.month in (4, 5, 6)]
    # keep the clearest few scenes per path/row/year so every year and area is represented
    scenes.sort(key=lambda i: i.properties["eo:cloud_cover"])
    keep, seen = [], {}
    for i in scenes:
        k = (i.properties["landsat:wrs_path"], i.properties["landsat:wrs_row"], i.datetime.year)
        if seen.get(k, 0) < max_per_year:
            seen[k] = seen.get(k, 0) + 1
            keep.append(i)
    print(f"{len(scenes)} clear Apr-Jun scenes found; processing {len(keep)}", flush=True)
    ward_cache = {}
    for n, item in enumerate(keep, 1):
        f = CACHE / f"{item.id}.csv"
        if f.exists():
            continue
        try:
            res = scene_stats(item, wards, ward_cache)
        except Exception as e:  # keep going if one scene fails
            print(f"  [{n}/{len(keep)}] {item.id}: {type(e).__name__}: {str(e)[:80]}", flush=True)
            continue
        (res if res is not None else pd.DataFrame(columns=["ward_id"])).to_csv(f, index=False)
        print(f"  [{n}/{len(keep)}] {item.id} {item.datetime:%Y-%m-%d}: {0 if res is None else len(res)} wards", flush=True)
    combine()


def combine():
    parts = [pd.read_csv(f) for f in CACHE.glob("*.csv") if f.stat().st_size > 20]
    if not parts:
        print("no Landsat scenes processed yet")
        return
    d = pd.concat(parts, ignore_index=True)
    d["year"] = pd.to_datetime(d.date).dt.year
    d["hot45"] = (d.lst_mean > 45).astype(float)
    g = d.groupby("ward_id")
    out = pd.DataFrame({"lst_mean_c": g.lst_mean.mean(), "lst_p90_c": g.lst_p90.mean(),
                        "lst_hot45_share": g.hot45.mean(), "ndvi_mean": g.ndvi_mean.mean(),
                        "lst_scenes": g.scene.nunique(), "lst_years": g.year.nunique()}).reset_index()
    OUT.mkdir(exist_ok=True)
    out.to_csv(OUT / "ward_landsat.csv", index=False)
    print(f"wrote {OUT / 'ward_landsat.csv'}: {len(out)} wards from {d.scene.nunique()} scenes")
    print(out.describe().loc[["min", "50%", "max"]].round(2).T.to_string())


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--landcover", action="store_true")
    ap.add_argument("--landsat", action="store_true")
    ap.add_argument("--max-per-year", type=int, default=3)
    a = ap.parse_args()
    wards, area = load_wards()
    both = not (a.landcover or a.landsat)
    if a.landcover or both:
        landcover(wards, area)
    if a.landsat or both:
        landsat(wards, a.max_per_year)
