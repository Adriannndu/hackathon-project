"""
Builds extra model features that need no API quota:

1. data/climate_indices.csv  -- ENSO (ONI) and Indian Ocean Dipole (DMI) by month
2. data/location_features.csv -- distance to coast + region type per location
   (surface pressure comes from get_nasa_power.py)

Sources (downloaded into data/external/):
  ONI:      https://www.cpc.ncep.noaa.gov/data/indices/oni.ascii.txt
  DMI:      https://psl.noaa.gov/gcos_wgsp/Timeseries/Data/dmi.had.long.data
  Coastline: Natural Earth 50m, geojson (nvkelso/natural-earth-vector)

Leakage note: these indices are published weeks after the month they
describe. The columns `oni_lag2m` / `dmi_lag1m` are already shifted so that
joining on a day's (year, month) only uses values that would have been
published by then. Don't join on the unshifted values.

Usage:  python build_extra_features.py
"""

import json
from pathlib import Path

import numpy as np
import pandas as pd

from get_expanded_data import LOCATIONS, slug

EXT = Path("data/external")
OUT_INDICES = Path("data/climate_indices.csv")
OUT_LOC = Path("data/location_features.csv")

COAST_KM = 50          # within this distance of the sea -> "coastal"
HILLY_ELEVATION_M = 1000  # at/above this -> "hilly" (heuristic, see README note)

SEASON_CENTRE = {"DJF": 1, "JFM": 2, "FMA": 3, "MAM": 4, "AMJ": 5, "MJJ": 6,
                 "JJA": 7, "JAS": 8, "ASO": 9, "SON": 10, "OND": 11, "NDJ": 12}


# ---------------------------------------------------------------- indices
def load_oni():
    rows = []
    for line in (EXT / "oni.txt").read_text().splitlines()[1:]:
        parts = line.split()
        if len(parts) == 4 and parts[0] in SEASON_CENTRE:
            season, year, _total, anom = parts
            month = SEASON_CENTRE[season]
            year = int(year)
            # DJF labelled 1950 is centred on Jan 1950; NDJ is centred on Dec.
            rows.append((year, month, float(anom)))
    return pd.DataFrame(rows, columns=["year", "month", "oni"])


def load_dmi():
    rows = []
    for line in (EXT / "dmi.txt").read_text().splitlines():
        parts = line.split()
        if len(parts) == 13 and parts[0].isdigit():
            year = int(parts[0])
            for month, v in enumerate(parts[1:], start=1):
                v = float(v)
                rows.append((year, month, np.nan if v <= -90 else v))
    return pd.DataFrame(rows, columns=["year", "month", "dmi"])


def build_indices():
    oni, dmi = load_oni(), load_dmi()
    df = oni.merge(dmi, on=["year", "month"], how="outer").sort_values(["year", "month"])
    df["date"] = pd.to_datetime(dict(year=df.year, month=df.month, day=1))
    df = df.set_index("date")
    # extend through 2027 so recent/future dates still get a (carried-forward) value
    full = pd.date_range(df.index.min(), "2027-12-01", freq="MS")
    df = df.reindex(full)
    df["year"], df["month"] = df.index.year, df.index.month
    df["oni_lag2m"] = df["oni"].shift(2).ffill()
    df["dmi_lag1m"] = df["dmi"].shift(1).ffill()
    out = df.loc["1991-01-01":, ["year", "month", "oni_lag2m", "dmi_lag1m"]]
    out.to_csv(OUT_INDICES, index=False)
    last_oni = df["oni"].dropna().index.max().strftime("%Y-%m")
    last_dmi = df["dmi"].dropna().index.max().strftime("%Y-%m")
    print(f"Climate indices -> {OUT_INDICES} ({len(out)} months). "
          f"Latest ONI: {last_oni}, latest DMI: {last_dmi} (later months carried forward)")


# ----------------------------------------------------------- coast distance
def coast_points():
    """Densified coastline vertices around India, as (lat, lon) arrays."""
    gj = json.loads((EXT / "coast.geojson").read_text())
    lines = []
    for f in gj["features"]:
        g = f["geometry"]
        if g["type"] == "LineString":
            lines.append(g["coordinates"])
        elif g["type"] == "MultiLineString":
            lines.extend(g["coordinates"])
    pts = []
    for line in lines:
        arr = np.asarray(line)
        # keep segments in a box well around India (speed)
        if arr[:, 0].max() < 60 or arr[:, 0].min() > 105 or arr[:, 1].max() < -5 or arr[:, 1].min() > 40:
            continue
        for (x0, y0), (x1, y1) in zip(arr[:-1], arr[1:]):
            n = max(2, int(np.hypot(x1 - x0, y1 - y0) / 0.02))  # ~2 km steps
            pts.append(np.column_stack([np.linspace(y0, y1, n), np.linspace(x0, x1, n)]))
    p = np.vstack(pts)
    return p[:, 0], p[:, 1]


def haversine_km(lat, lon, lats, lons):
    r = 6371.0
    p1, p2 = np.radians(lat), np.radians(lats)
    dphi, dl = p2 - p1, np.radians(lons - lon)
    a = np.sin(dphi / 2) ** 2 + np.cos(p1) * np.cos(p2) * np.sin(dl / 2) ** 2
    return 2 * r * np.arcsin(np.sqrt(a))


def build_locations():
    clats, clons = coast_points()
    rows = []
    for name, state, lat, lon, _coastal in LOCATIONS:
        dist = float(haversine_km(lat, lon, clats, clons).min())
        raw = Path("data/raw") / f"{slug(name)}.csv"
        elev = float(pd.read_csv(raw, usecols=["elevation_m"], nrows=1).iloc[0, 0]) if raw.exists() else np.nan
        if elev >= HILLY_ELEVATION_M:
            region = "hilly"
        elif dist <= COAST_KM:
            region = "coastal"
        else:
            region = "plains"
        rows.append((name, state, lat, lon, elev, round(dist, 1), region))
    df = pd.DataFrame(rows, columns=["city", "state", "latitude", "longitude",
                                     "elevation_m", "dist_to_coast_km", "region_type"])
    df.to_csv(OUT_LOC, index=False)
    print(f"Location features -> {OUT_LOC}")
    print(df.region_type.value_counts().to_string())
    return df


if __name__ == "__main__":
    build_indices()
    build_locations()
