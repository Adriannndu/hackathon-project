"""Load and merge every data source into one table (one row per city-day)."""
import numpy as np
import pandas as pd

from .config import DATA, HILLY_M, COAST_KM, EXCLUDE_CITIES

NASA_COLS = ["nasa_temp_max_c", "nasa_temp_min_c", "humidity_mean_pct", "wet_bulb_c",
             "wind_max_ms", "precip_mm", "solar_kwh_m2", "soil_wetness",
             "surface_pressure_kpa"]


def load_table(max_cities=None):
    raw_files = sorted((DATA / "raw").glob("*.csv"))
    if not raw_files:
        raise SystemExit("No files in data/raw/. The raw weather data was removed from the repo; "
                         "restore it with: git show d1e197a:data_bundle.tgz > data_bundle.tgz && tar xzf data_bundle.tgz")
    excluded = {c.lower().replace(" ", "_") for c in EXCLUDE_CITIES}
    raw_files = [f for f in raw_files if f.stem not in excluded]
    if max_cities and max_cities < len(raw_files):  # evenly spaced subset (quick tests)
        idx = sorted(set(np.linspace(0, len(raw_files) - 1, max_cities).round().astype(int)))
        raw_files = [raw_files[i] for i in idx]

    frames = []
    for f in raw_files:
        om = pd.read_csv(f, parse_dates=["date"])
        nasa_file = DATA / "nasa" / f.name
        if nasa_file.exists():
            nasa = pd.read_csv(nasa_file, parse_dates=["date"]).drop(columns=["city"])
            om = om.merge(nasa, on="date", how="left")
        frames.append(om)
    df = pd.concat(frames, ignore_index=True)
    for c in NASA_COLS:  # older NASA files may lack newer columns
        if c not in df:
            df[c] = np.nan

    loc = pd.read_csv(DATA / "location_features.csv")[
        ["city", "latitude", "longitude", "dist_to_coast_km"]]
    df = df.merge(loc, on="city", how="left")

    ind = pd.read_csv(DATA / "climate_indices.csv")
    df["year"], df["month"] = df.date.dt.year, df.date.dt.month
    df = df.merge(ind, on=["year", "month"], how="left")

    df["region"] = np.where(df.elevation_m >= HILLY_M, "hilly",
                            np.where(df.dist_to_coast_km <= COAST_KM, "coastal", "plains"))
    return df.sort_values(["city", "date"]).reset_index(drop=True)
