"""
Estimate the Census 2011 indicators for wards that have no Census row (~56 outer wards).

The Census lists the rural / census-town parts of outer wards separately, so those wards
have no household-asset, housing or water figures. Rather than leaving them out of the
score (which treats poor outer wards as average), we estimate the values from what we do
know about each ward -- density, built-up and tree cover, temperature, age mix, hospital
distance -- plus the values of the nearest wards that have Census data.

Estimates are only used if they validate: cross-validated rank correlation on wards with
known values must reach MIN_RHO, and the result is flagged in the output (census_data =
"estimated"). Missing wards are on the city fringe, which is hardest to predict, so a
second test holds out the most peripheral known wards.
"""
import json

import numpy as np
import pandas as pd
from pyproj import Transformer
from shapely.geometry import shape
from sklearn.ensemble import RandomForestRegressor
from sklearn.model_selection import KFold

TARGETS = ["assets_index", "poor_housing_index", "tap_treated_pct"]
COVARIATES = ["log_density", "built_up_share", "tree_cover_pct", "lst_mean_c", "ndvi_mean",
              "elderly_share", "under5_share", "hospital_travel_min", "log_people"]
K = 6            # nearest wards with data
MIN_RHO = 0.5    # required validation rank correlation


def centroids_km(geojson):
    to_m = Transformer.from_crs(4326, 32643, always_xy=True).transform
    out = {}
    for f in json.load(open(geojson))["features"]:
        c = shape(f["geometry"]).representative_point()
        x, y = to_m(c.x, c.y)
        out[str(f["properties"]["ward_id"])] = (x / 1000.0, y / 1000.0)
    return out


def knn_feature(xy_query, xy_ref, y_ref, k=K, exclude_self=False):
    d = np.hypot(xy_query[:, None, 0] - xy_ref[None, :, 0], xy_query[:, None, 1] - xy_ref[None, :, 1])
    if exclude_self:
        np.fill_diagonal(d, np.inf)
    idx = np.argsort(d, axis=1)[:, :k]
    w = 1.0 / (np.take_along_axis(d, idx, 1) + 0.5)
    return (y_ref[idx] * w).sum(axis=1) / w.sum(axis=1)


def design(d, xy, y_known, known_mask_ref, query_rows, ref_rows, self_ref):
    X = d.loc[query_rows, COVARIATES].to_numpy(float)
    kn = knn_feature(xy[query_rows], xy[ref_rows], y_known[ref_rows], exclude_self=self_ref)
    return np.column_stack([X, kn])


def spearman(a, b):
    return float(pd.Series(a).corr(pd.Series(b), method="spearman"))


def impute(d, geojson, verbose=True):
    """d: ward table (index aligned) with covariates and the 3 census targets. Returns
    (d_with_filled_targets, report dict). Adds column census_data."""
    d = d.copy()
    d["log_density"] = np.log1p(d.pop_density)
    d["log_people"] = np.log1p(d.total_population)
    cen = centroids_km(geojson)
    xy = np.array([cen.get(str(w), (np.nan, np.nan)) for w in d.ward_id])
    d["census_data"] = np.where(d.assets_index.notna(), "census 2011", "estimated")
    centre = np.nanmedian(xy, axis=0)
    report = {}
    usable = d.scored & d[COVARIATES].notna().all(axis=1) & ~np.isnan(xy).any(axis=1)
    for t in TARGETS:
        known = (d[t].notna() & usable).to_numpy()
        unknown = (d[t].isna() & usable).to_numpy()
        y = d[t].to_numpy(float)
        kidx = np.where(known)[0]
        # --- validation 1: 5-fold random CV on known wards
        pred = np.full(len(d), np.nan)
        for tr, te in KFold(5, shuffle=True, random_state=0).split(kidx):
            tr_i, te_i = kidx[tr], kidx[te]
            m = RandomForestRegressor(300, min_samples_leaf=3, random_state=0, n_jobs=1)
            m.fit(design(d, xy, y, None, tr_i, tr_i, True), y[tr_i])
            pred[te_i] = m.predict(design(d, xy, y, None, te_i, tr_i, False))
        rho_cv = spearman(y[kidx], pred[kidx])
        # --- validation 2: hold out the most peripheral 25% of known wards
        dist = np.hypot(*(xy[kidx] - centre).T)
        far = kidx[dist >= np.quantile(dist, 0.75)]
        near = np.setdiff1d(kidx, far)
        m = RandomForestRegressor(300, min_samples_leaf=3, random_state=0, n_jobs=1)
        m.fit(design(d, xy, y, None, near, near, True), y[near])
        rho_far = spearman(y[far], m.predict(design(d, xy, y, None, far, near, False)))
        ok = rho_cv >= MIN_RHO
        report[t] = {"cv_rank_corr": round(rho_cv, 3), "fringe_holdout_rank_corr": round(rho_far, 3),
                     "used": bool(ok), "wards_estimated": int(unknown.sum()) if ok else 0}
        if verbose:
            print(f"  {t:<20} CV rank corr {rho_cv:5.2f} | fringe hold-out {rho_far:5.2f} | "
                  f"{'USED' if ok else 'not used'} for {int(unknown.sum())} wards")
        if ok and unknown.any():
            m = RandomForestRegressor(500, min_samples_leaf=3, random_state=0, n_jobs=1)
            m.fit(design(d, xy, y, None, kidx, kidx, True), y[kidx])
            uidx = np.where(unknown)[0]
            d.loc[d.index[uidx], t] = m.predict(design(d, xy, y, None, uidx, kidx, False))
    return d.drop(columns=["log_density", "log_people"]), report
