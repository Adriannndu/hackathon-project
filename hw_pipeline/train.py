"""Train and evaluate the heat-wave forecaster (1-3 days ahead).

Run from the project root:
    python -m hw_pipeline.train                 # full run
    python -m hw_pipeline.train --quick         # tiny smoke test
    python -m hw_pipeline.train --final         # also refit on train+val for deployment

One global model per horizon, trained on all locations together, so it can
be applied to locations it never saw (checked by the leave-locations-out test).
"""
import argparse
import json
import time

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.inspection import permutation_importance
from sklearn.metrics import average_precision_score, brier_score_loss, precision_recall_curve
from sklearn.model_selection import GroupKFold

from .config import ARTIFACTS, HORIZONS, TRAIN_END, VAL_END
from .data import load_table
from .features import build_features, feature_columns


# --------------------------------------------------------------- helpers
def new_model(quick):
    return HistGradientBoostingClassifier(
        max_iter=40 if quick else 300, learning_rate=0.06, max_leaf_nodes=31,
        min_samples_leaf=100, l2_regularization=1.0, random_state=0)


def best_threshold(y, score):
    """Probability cut-off that maximises F1 (chosen on validation data only)."""
    if y.sum() == 0:
        return 0.5
    p, r, t = precision_recall_curve(y, score)
    f1 = 2 * p * r / (p + r + 1e-12)
    return float(t[np.nanargmax(f1[:-1])])


def scores(y, score, thr):
    y = np.asarray(y)
    pred = score >= thr
    tp = int((pred & (y == 1)).sum())
    fp = int((pred & (y == 0)).sum())
    fn = int((~pred & (y == 1)).sum())
    prec = tp / (tp + fp) if tp + fp else 0.0
    rec = tp / (tp + fn) if tp + fn else 0.0
    return {
        "positives": int(y.sum()), "rows": int(len(y)),
        "pr_auc": float(average_precision_score(y, score)) if y.sum() else None,
        "brier": float(brier_score_loss(y, np.clip(score, 0, 1))),
        "threshold": round(float(thr), 4),
        "precision": round(prec, 3), "recall": round(rec, 3),
        "f1": round(2 * prec * rec / (prec + rec), 3) if prec + rec else 0.0,
    }


def event_recall(sub, pred, h):
    """Share of real heat-wave events (runs of heat-wave days) in which the
    model flagged at least one day, forecasting h days ahead."""
    d = pd.DataFrame({"city": sub.city.values, "target": sub.date.values + np.timedelta64(h, "D"),
                      "y": sub[f"y_h{h}"].values, "pred": np.asarray(pred)})
    d = d[d.y == 1].sort_values(["city", "target"])
    if d.empty:
        return None, 0
    new = (d.city != d.city.shift()) | (d.target.diff() != pd.Timedelta(days=1))
    caught = d.groupby(new.cumsum()).pred.any()
    return round(float(caught.mean()), 3), int(len(caught))


def split(tab):
    d = tab.date
    return (tab[d <= TRAIN_END], tab[(d > TRAIN_END) & (d <= VAL_END)], tab[d > VAL_END])


# --------------------------------------------------------------- main
def run(args):
    t0 = time.time()
    print("Loading data...")
    df = load_table(args.max_cities)
    print(f"  {df.city.nunique()} cities, {len(df):,} rows, {df.date.min():%Y-%m-%d} to {df.date.max():%Y-%m-%d}")
    tab, normals = build_features(df)
    feats = feature_columns(tab)
    print(f"  {len(feats)} features; heat-wave days: {int(tab.hw.sum()):,} "
          f"({100 * tab.hw.mean():.2f}% of days)")

    ARTIFACTS.mkdir(exist_ok=True)
    results = {"cities": sorted(df.city.unique().tolist()), "features": feats, "horizons": {}}

    for h in HORIZONS:
        print(f"\n===== Horizon: {h} day(s) ahead =====")
        ycol = f"y_h{h}"
        sub = tab[tab[ycol].notna() & tab["tmax_l6"].notna()]
        tr, va, te = split(sub)
        print(f"  rows  train {len(tr):,} | val {len(va):,} | test {len(te):,}   "
              f"positives  {int(tr[ycol].sum())} | {int(va[ycol].sum())} | {int(te[ycol].sum())}")

        model = new_model(args.quick).fit(tr[feats], tr[ycol])
        thr = best_threshold(va[ycol], model.predict_proba(va[feats])[:, 1])
        p_te = model.predict_proba(te[feats])[:, 1]
        res = {"model": scores(te[ycol], p_te, thr)}
        res["model"]["event_recall"], res["model"]["events"] = event_recall(te, p_te >= thr, h)

        # --- baselines ---
        p_pers = te["hw_now"].values.astype(float)
        res["baseline_persistence"] = scores(te[ycol], p_pers, 0.5)
        res["baseline_persistence"]["event_recall"], _ = event_recall(te, p_pers >= 0.5, h)
        clim = tr.groupby(["city", tr.date.dt.month])[ycol].mean()
        key = list(zip(va.city, va.date.dt.month))
        v_clim = np.array([clim.get(k, 0.0) for k in key])
        t_clim = np.array([clim.get(k, 0.0) for k in zip(te.city, te.date.dt.month)])
        res["baseline_climatology"] = scores(te[ycol], t_clim, best_threshold(va[ycol], v_clim))

        # --- leave-locations-out: can it handle cities it never saw? ---
        if not args.quick and sub.city.nunique() >= 5:
            folds = []
            for k, (a, b) in enumerate(GroupKFold(5).split(sub, groups=sub.city)):
                tr_k = sub.iloc[a]; ho = sub.iloc[b]
                tr_k_tr, tr_k_va, _ = split(tr_k)
                _, _, ho_te = split(ho)
                m = new_model(False).fit(tr_k_tr[feats], tr_k_tr[ycol])
                thr_k = best_threshold(tr_k_va[ycol], m.predict_proba(tr_k_va[feats])[:, 1])
                folds.append(scores(ho_te[ycol], m.predict_proba(ho_te[feats])[:, 1], thr_k)
                             | {"held_out_cities": sorted(ho.city.unique().tolist())})
                print(f"    fold {k + 1}/5 done")
            ok = [f for f in folds if f["pr_auc"] is not None]
            res["unseen_locations"] = {
                "mean_pr_auc": round(float(np.mean([f["pr_auc"] for f in ok])), 3),
                "mean_recall": round(float(np.mean([f["recall"] for f in ok])), 3),
                "mean_precision": round(float(np.mean([f["precision"] for f in ok])), 3),
                "folds": folds}

        # --- what the model relies on (horizon 1 only, it is slow) ---
        if args.importance and h == HORIZONS[0] and va[ycol].sum() > 0:
            s = va.sample(min(30000, len(va)), random_state=0)
            pi = permutation_importance(model, s[feats], s[ycol], scoring="average_precision",
                                        n_repeats=3, random_state=0)
            imp = pd.Series(pi.importances_mean, index=feats).sort_values(ascending=False)
            res["top_features"] = {k: round(float(v), 4) for k, v in imp.head(15).items()}

        results["horizons"][h] = res
        m = res["model"]
        print(f"  TEST  precision {m['precision']}  recall {m['recall']}  F1 {m['f1']}  "
              f"PR-AUC {m['pr_auc'] and round(m['pr_auc'], 3)}  event recall {m['event_recall']} "
              f"({m['events']} events)")
        for b in ("baseline_persistence", "baseline_climatology"):
            x = res[b]
            print(f"  {b[9:]:<12} precision {x['precision']}  recall {x['recall']}  F1 {x['f1']}")
        if "unseen_locations" in res:
            u = res["unseen_locations"]
            print(f"  UNSEEN LOCATIONS  PR-AUC {u['mean_pr_auc']}  recall {u['mean_recall']}  "
                  f"precision {u['mean_precision']}")

        final = model
        if args.final:  # refit on train+val for deployment, same settings/threshold
            tv = pd.concat([tr, va])
            final = new_model(args.quick).fit(tv[feats], tv[ycol])
        joblib.dump({"model": final, "features": feats, "threshold": thr, "horizon": h,
                     "normals": {c: n.tolist() for c, n in normals.items()}},
                    ARTIFACTS / f"hw_h{h}.joblib")

    (ARTIFACTS / "metrics.json").write_text(json.dumps(results, indent=2))
    print(f"\nSaved models to {ARTIFACTS}/hw_h*.joblib and {ARTIFACTS}/metrics.json "
          f"({time.time() - t0:.0f}s)")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--quick", action="store_true", help="tiny/fast smoke test")
    ap.add_argument("--max-cities", type=int, default=None)
    ap.add_argument("--importance", action="store_true", help="compute feature importance")
    ap.add_argument("--final", action="store_true", help="refit saved model on train+val")
    run(ap.parse_args())
