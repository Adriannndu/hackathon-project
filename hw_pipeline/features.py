"""Heat-wave labels (IMD rule) and model features.

Everything in a feature column uses only information available on day t.
The labels (`hw`, `y_h*`) are computed retrospectively from observed
temperatures and are only ever used as targets.

Normals ("what is a normal max temp for this city on this date") are computed
from TRAIN_END and earlier only, so test years never leak into them.
"""
import warnings

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


def add_neighbor_features(tab):
    """Spatial context: how hot are the surrounding cities right now?

    Heat waves travel (hot dry air usually arrives from the north-west), so
    anomalies in nearby/upwind cities hint at what is coming 1-3 days later.
    Uses only day-t and day-(t-1) values of the other cities (no leakage).

    At prediction time this needs recent temperatures of the surrounding
    reference cities (one batched API call for the whole city list).
    """
    cities = sorted(tab.city.unique())
    n = len(cities)
    meta = tab.groupby("city")[["latitude", "longitude"]].first().loc[cities]
    lat, lon = np.radians(meta.latitude.values), np.radians(meta.longitude.values)

    # pairwise distance (km) and bearing (degrees) from city i to city j
    dphi, dl = lat[None, :] - lat[:, None], lon[None, :] - lon[:, None]
    a = np.sin(dphi / 2) ** 2 + np.cos(lat[:, None]) * np.cos(lat[None, :]) * np.sin(dl / 2) ** 2
    dist = 2 * 6371.0 * np.arcsin(np.sqrt(a))
    yy = np.sin(dl) * np.cos(lat[None, :])
    xx = (np.cos(lat[:, None]) * np.sin(lat[None, :])
          - np.sin(lat[:, None]) * np.cos(lat[None, :]) * np.cos(dl))
    bearing = (np.degrees(np.arctan2(yy, xx)) + 360) % 360

    eye = np.eye(n, dtype=bool)
    near = (dist <= 500) & ~eye                              # within 500 km
    upwind = (dist <= 800) & (bearing >= 225) & ~eye         # to the W / NW / N, within 800 km

    anom = tab.pivot(index="date", columns="city", values="anom_l0")[cities]
    hot = (tab.pivot(index="date", columns="city", values="hot_streak")[cities] >= 1) \
        .astype(float).where(anom.notna())

    def nmean(mat, mask):
        v = mat.values
        num = np.nan_to_num(v) @ mask.T.astype(float)
        den = (~np.isnan(v)).astype(float) @ mask.T.astype(float)
        with np.errstate(invalid="ignore", divide="ignore"):
            return np.where(den > 0, num / den, np.nan)

    def nmax(mat, mask):
        v = mat.values
        out = np.full(v.shape, np.nan)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)
            for i in range(n):
                idx = np.where(mask[i])[0]
                if len(idx):
                    out[:, i] = np.nanmax(v[:, idx], axis=1)
        return out

    up_mean = nmean(anom, upwind)
    feats = {
        "nbr_anom_mean": nmean(anom, near),
        "nbr_anom_max": nmax(anom, near),
        "nbr_hot_frac": nmean(hot, near),
        "up_anom_mean": up_mean,
        "up_anom_max": nmax(anom, upwind),
        "up_anom_d1": up_mean - np.vstack([np.full((1, n), np.nan), up_mean[:-1]]),
    }
    out = tab
    for name, arr in feats.items():
        long = (pd.DataFrame(arr, index=anom.index, columns=cities)
                .reset_index().melt(id_vars="date", var_name="city", value_name=name))
        out = out.merge(long, on=["city", "date"], how="left")
    return out


def build_features(df):
    """Returns (table, normals) where normals is {city: 366-value Series}."""
    parts, normals = [], {}
    for city, g in df.groupby("city", sort=True):
        t, norm = _city_table(g)
        parts.append(t)
        normals[city] = norm
    tab = add_neighbor_features(pd.concat(parts, ignore_index=True))
    return tab, normals


def feature_columns(table):
    return [c for c in table.columns
            if c not in NON_FEATURES and not c.startswith("y_h")]
