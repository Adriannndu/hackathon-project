"""
Ward-level wealth proxy from Meta's Relative Wealth Index (RWI).

Source: Chi et al. / Meta + UC Berkeley, ~2.4 km tiles, machine-learning estimates
from satellite, phone-network and map data (April 2021 release), via the Humanitarian
Data Exchange. Licence: CC BY-NC 4.0 (non-commercial use, credit Meta/UC Berkeley).
Download: collect step is a plain curl, see the commented URL in this file.

Each ward gets the area-weighted mean of the tiles overlapping it. Tiles are ~2.1 km
squares, comparable to a ward, so values are smooth: wards sharing a tile share a value.
Writes inputs/ward_wealth.csv  (wealth_index = RWI, higher = wealthier).
"""
import json
from pathlib import Path

import numpy as np
import pandas as pd
from shapely.geometry import box, shape
from shapely.strtree import STRtree

# https://data.humdata.org/dataset/relative-wealth-index  ("India and Pakistan_relative_wealth_index.csv")
SRC = Path("data/wealth/ind_pak_rwi.csv")
HALF_LON = 360 / 2 ** 14 / 2           # zoom-14 tiles: half-width in degrees


def main():
    gj = json.load(open("delhi_wards.geojson"))
    wards = [(str(f["properties"]["ward_id"]), shape(f["geometry"])) for f in gj["features"]]
    minx = min(g.bounds[0] for _, g in wards) - 0.05; maxx = max(g.bounds[2] for _, g in wards) + 0.05
    miny = min(g.bounds[1] for _, g in wards) - 0.05; maxy = max(g.bounds[3] for _, g in wards) + 0.05
    t = pd.read_csv(SRC)
    t = t[(t.longitude.between(minx, maxx)) & (t.latitude.between(miny, maxy))].reset_index(drop=True)
    print(f"{len(t)} RWI tiles in/around Delhi; rwi range {t.rwi.min():.2f} to {t.rwi.max():.2f}")
    half_lat = HALF_LON * np.cos(np.radians(t.latitude))   # Web-Mercator tiles shrink in latitude
    boxes = [box(x - HALF_LON, y - h, x + HALF_LON, y + h) for x, y, h in zip(t.longitude, t.latitude, half_lat)]
    tree = STRtree(boxes)
    rows = []
    for wid, g in wards:
        num = den = err = 0.0
        for i in tree.query(g):
            a = boxes[i].intersection(g).area
            if a > 0:
                num += a * t.rwi[i]; err += a * t.error[i]; den += a
        rows.append({"ward_id": wid, "wealth_index": num / den if den else np.nan,
                     "wealth_error": err / den if den else np.nan, "wealth_coverage": den / g.area})
    df = pd.DataFrame(rows)
    df.loc[df.wealth_coverage < 0.5, ["wealth_index", "wealth_error"]] = np.nan
    Path("inputs").mkdir(exist_ok=True)
    df.to_csv("inputs/ward_wealth.csv", index=False)
    print(f"wrote inputs/ward_wealth.csv: {df.wealth_index.notna().sum()} of {len(df)} wards with a value")
    print(df[["wealth_index", "wealth_error", "wealth_coverage"]].describe().loc[["min", "25%", "50%", "75%", "max"]].round(2).T.to_string())


if __name__ == "__main__":
    main()
