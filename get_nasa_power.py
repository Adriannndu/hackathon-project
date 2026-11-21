"""
Supplementary daily weather from NASA POWER (MERRA-2 based) for the same
India locations as get_expanded_data.py.

Adds what the Open-Meteo download left out (humidity, wet-bulb, wind, rain,
solar radiation, soil moisture). It's a separate provider with its own rate
limits, so it can run at the same time as get_expanded_data.py.

NOTE: NASA's temperatures come from a different model than Open-Meteo's
(ERA5), so they differ by a few degrees. They are saved with a "nasa_"
prefix and should be treated as separate columns, not merged into the
Open-Meteo temperature columns.

Resumable: each location is cached in data/nasa/<name>.csv.

Usage:
    python get_nasa_power.py                 # fetch whatever is missing
    python get_nasa_power.py --combine       # only rebuild the combined CSV
    python get_nasa_power.py --slice 40:     # subset (like get_expanded_data.py)
"""

import argparse
import time
from datetime import date, timedelta
from pathlib import Path

import pandas as pd
import requests

from get_expanded_data import LOCATIONS, slug  # same India-only location list

URL = "https://power.larc.nasa.gov/api/temporal/daily/point"
DATA_DIR = Path("data")
RAW_DIR = DATA_DIR / "nasa"
COMBINED = DATA_DIR / "india_nasa_power.csv"

PARAMS = {
    "T2M_MAX": "nasa_temp_max_c",
    "T2M_MIN": "nasa_temp_min_c",
    "RH2M": "humidity_mean_pct",
    "T2MWET": "wet_bulb_c",
    "WS10M_MAX": "wind_max_ms",
    "PRECTOTCORR": "precip_mm",
    "ALLSKY_SFC_SW_DWN": "solar_kwh_m2",
    "GWETTOP": "soil_wetness",
    "PS": "surface_pressure_kpa",
}


def fetch(name, lat, lon, start, end):
    params = {
        "parameters": ",".join(PARAMS),
        "community": "AG",
        "latitude": lat,
        "longitude": lon,
        "start": start.replace("-", ""),
        "end": end.replace("-", ""),
        "format": "JSON",
    }
    for attempt in range(6):
        try:
            r = requests.get(URL, params=params, timeout=180)
            if r.status_code in (429, 500, 502, 503, 504):
                wait = 15 * (attempt + 1)
                print(f"  HTTP {r.status_code}; waiting {wait}s", flush=True)
                time.sleep(wait)
                continue
            r.raise_for_status()
            body = r.json()["properties"]["parameter"]
            df = pd.DataFrame(body)
            df.index.name = "date"
            df = df.reset_index()
            df["date"] = pd.to_datetime(df["date"], format="%Y%m%d").dt.strftime("%Y-%m-%d")
            df = df.rename(columns=PARAMS)
            df = df.replace(-999.0, float("nan"))  # NASA's missing-value marker
            return df
        except (requests.exceptions.RequestException, KeyError, ValueError) as e:
            print(f"  error ({e}); retrying", flush=True)
            time.sleep(15 * (attempt + 1))
    raise RuntimeError(f"gave up on {name}")


def collect(start, end, locations):
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    for name, state, lat, lon, coastal in locations:
        path = RAW_DIR / f"{slug(name)}.csv"
        if path.exists() and set(PARAMS.values()) <= set(pd.read_csv(path, nrows=0).columns):
            continue  # cached and has every column we currently ask for
        print(f"NASA POWER: {name} {start} -> {end} ...", flush=True)
        df = fetch(name, lat, lon, start, end)
        df.insert(0, "city", name)
        tmp = path.with_suffix(".tmp")
        df.to_csv(tmp, index=False)
        tmp.replace(path)
        print(f"  saved {len(df)} rows", flush=True)
        time.sleep(3)  # be polite to a free public service


def combine():
    frames = [pd.read_csv(RAW_DIR / f"{slug(n)}.csv")
              for n, *_ in LOCATIONS if (RAW_DIR / f"{slug(n)}.csv").exists()]
    if not frames:
        print("Nothing cached yet.")
        return
    df = pd.concat(frames, ignore_index=True)
    DATA_DIR.mkdir(exist_ok=True)
    df.to_csv(COMBINED, index=False)
    print(f"Combined {df['city'].nunique()} locations -> {COMBINED} ({len(df):,} rows)")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", default="2000-01-01")
    ap.add_argument("--end", default=(date.today() - timedelta(days=7)).isoformat())
    ap.add_argument("--slice", default=None)
    ap.add_argument("--combine", action="store_true")
    args = ap.parse_args()

    if not args.combine:
        subset = LOCATIONS
        if args.slice:
            a, b = args.slice.split(":")
            subset = LOCATIONS[int(a or 0):int(b) if b else None]
        collect(args.start, args.end, subset)
    combine()
