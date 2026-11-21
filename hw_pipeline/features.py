"""Heat-wave labels (IMD rule) and model features.

Everything in a feature column uses only information available on day t.
The labels (`hw`, `y_h*`) are computed retrospectively from observed
temperatures and are only ever used as targets.

Normals ("what is a normal max temp for this city on this date") are computed
from TRAIN_END and earlier only, so test years never leak into them.
"""
import numpy as np
import pandas as pd

from .config import (ABS_HW, ABS_SEVERE, ANOM_HW, ANOM_SEVERE, HORIZONS, MIN_RUN,
                     THRESH, TRAIN_END)

REGION_CODE = {"plains": 0, "coastal": 1, "hilly": 2}
NON_FEATURES = {"city", "date", "hw", "severe", "region"}


def _normal(g):
    """Smoothed day-of-year normal of the daily max temp, from training years."""
    tr = g[g.date <= TRAIN_END]
    doy = tr.date.dt.day_of_year
    clim = (tr.groupby(doy)["temperature_2m_max"].mean()
              .reindex(range(1, 367)).interpolate(limit_direction="both"))
    ext = pd.concat([clim.iloc[-15:], clim, clim.iloc[:15]])
    norm = ext.rolling(31, center=True, min_periods=1).mean().iloc[15:-15]
    norm.index = range(1, 367)
    return norm


def _city_table(g):
    g = g.sort_values("date").reset_index(drop=True)
    norm = _normal(g)
    region = g.region.iloc[0]
    thr = THRESH[region]

    tmax, tmin = g.temperature_2m_max, g.temperature_2m_min
    app = g.apparent_temperature_max
    anom = tmax - g.date.dt.day_of_year.map(norm)

    # ---- labels (retrospective) -------------------------------------------
    hot = (((tmax >= thr) & (anom >= ANOM_HW)) | (tmax >= ABS_HW)).astype(int)
    grp = (hot != hot.shift()).cumsum()
    run = hot.groupby(grp).transform("size")
    hw = (hot == 1) & (run >= MIN_RUN)
    severe = hw & (((anom >= ANOM_SEVERE) & (tmax >= thr)) | (tmax >= ABS_SEVERE))
    streak = hot.groupby(grp).cumsum()          # causal: consecutive hot days up to today

    # ---- features (causal) -------------------------------------------------
    f = {}
    for lag in range(7):
        f[f"tmax_l{lag}"] = tmax.shift(lag)
        f[f"tmin_l{lag}"] = tmin.shift(lag)
        f[f"app_l{lag}"] = app.shift(lag)
    for w in (3, 7):
        f[f"tmax_m{w}"] = tmax.rolling(w).mean()
        f[f"tmin_m{w}"] = tmin.rolling(w).mean()
        f[f"anom_m{w}"] = anom.rolling(w).mean()
    f["anom_l0"] = anom
    f["tmax_vs_thr"] = tmax - thr
    f["hot_streak"] = streak
    f["hw_now"] = (streak >= MIN_RUN).astype(int)   # "already in a heat wave" as known today

    hum, wb, p = g.humidity_mean_pct, g.wet_bulb_c, g.surface_pressure_kpa
    f["humidity"] = hum
    f["wet_bulb"] = wb
    f["wind_max"] = g.wind_max_ms
    f["solar"] = g.solar_kwh_m2
    f["soil_wetness"] = g.soil_wetness
    f["precip_14d"] = g.precip_mm.rolling(14, min_periods=7).sum()
    f["pressure"] = p
    f["pressure_d3"] = p - p.shift(3)
    f["humidity_d3"] = hum - hum.shift(3)
    f["soil_d7"] = g.soil_wetness - g.soil_wetness.shift(7)
    f["nasa_tmax_minus_om"] = g.nasa_temp_max_c - tmax

    doy = g.date.dt.day_of_year
    f["doy_sin"] = np.sin(2 * np.pi * doy / 365.25)
    f["doy_cos"] = np.cos(2 * np.pi * doy / 365.25)

    for c in ("latitude", "longitude", "elevation_m", "dist_to_coast_km",
              "oni_lag2m", "dmi_lag1m"):
        f[c] = g[c]
    f["region_code"] = REGION_CODE[region]
    f["thr"] = thr

    out = pd.DataFrame(f)
    out.insert(0, "date", g.date)
    out.insert(0, "city", g.city)
    out["region"] = region
    out["hw"] = hw.astype(int)
    out["severe"] = severe.astype(int)
    for h in HORIZONS:
        out[f"y_h{h}"] = out["hw"].astype(float).shift(-h)   # NaN where unknown
    return out, norm


def build_features(df):
    """Returns (table, normals) where normals is {city: 366-value Series}."""
    parts, normals = [], {}
    for city, g in df.groupby("city", sort=True):
        t, norm = _city_table(g)
        parts.append(t)
        normals[city] = norm
    return pd.concat(parts, ignore_index=True), normals


def feature_columns(table):
    return [c for c in table.columns
            if c not in NON_FEATURES and not c.startswith("y_h")]
