#!/usr/bin/env python3
"""Delhi ward heat-risk score.

Ranks Delhi's 290 wards by how at risk their residents are when a heat wave
hits. It is a RELATIVE index (a ward is compared with other Delhi wards) and is
not a probability of harm and has not been validated against heat illness data.

Four groups of indicators, each worth 25% of the score (ranks, not raw values,
so differing units don't matter):

  Heat hazard         surface temperature (mean, and share of clear days above
                      45 C), built-up share                        [Landsat, WorldCover]
  Exposure            population density, number of people living there  [WorldPop]
  Sensitivity         share 65+, share under 5, people per km2 built-up,
                      poor housing                                  [WorldPop, Census 2011]
  Adaptive capacity   estimated travel time to a hospital, hospitals per
                      100k people, tree cover, household assets (wealth proxy),
                      treated tap water      [OpenStreetMap, WorldCover, Census 2011]

Inputs : inputs/ward_data.csv (build_inputs.py), delhi_wards.geojson
Outputs: outputs/risk_v2/  ward_risk.csv, ward_risk.geojson, summary.json

Run:  python area_model.py
"""
import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd

import impute

# column -> (label, group, which direction means MORE risk)
INDICATORS = {
    "lst_mean_c": ("Surface temperature (Apr-Jun mean)", "Heat hazard", "higher"),
    "lst_hot45_share": ("Share of clear days above 45 C surface temp", "Heat hazard", "higher"),
    "built_up_share": ("Built-up (paved/roofed) share", "Heat hazard", "higher"),
    "pop_density": ("Population density", "Exposure", "higher"),
    "people_exposed": ("People living in the ward", "Exposure", "higher"),
    "elderly_share": ("Population aged 65+", "Sensitivity", "higher"),
    "under5_share": ("Children under 5", "Sensitivity", "higher"),
    "crowding": ("People per km2 of built-up area", "Sensitivity", "higher"),
    "poor_housing_index": ("Poor housing (temporary/semi-permanent structures, one-room homes)", "Sensitivity", "higher"),
    "hospital_travel_min": ("Est. travel time to nearest hospital", "Adaptive capacity", "higher"),
    "hospitals_per_100k": ("Hospitals per 100k people (low = riskier)", "Adaptive capacity", "lower"),
    "tree_cover_pct": ("Tree cover (low = riskier)", "Adaptive capacity", "lower"),
    "assets_index": ("Household assets: car, computer (low = riskier)", "Adaptive capacity", "lower"),
    "tap_treated_pct": ("Households with treated tap water (low = riskier)", "Adaptive capacity", "lower"),
}
GROUPS = ["Heat hazard", "Exposure", "Sensitivity", "Adaptive capacity"]
CLASSES = ["Low", "Moderate", "High", "Very High", "Extreme"]


def load(ward_csv, geojson):
    gj = json.load(open(geojson))
    meta = pd.DataFrame([{"ward_id": str(f["properties"]["ward_id"]),
                          "ward_name": f["properties"]["Ward_Name"].strip(),
                          "ward_type": f["properties"].get("ward_type"),
                          "area_km2": f["properties"]["area_km2"]} for f in gj["features"]])
    d = pd.read_csv(ward_csv, dtype={"ward_id": str}).merge(meta, on="ward_id")
    pop = d.total_population
    d["pop_density"] = pop / d.area_km2
    d["people_exposed"] = pop
    d["elderly_share"] = d.pop_65_plus / pop
    d["under5_share"] = d.pop_0_4 / pop
    d["crowding"] = pop / d.built_up_area_km2.clip(lower=0.05)
    d["hospitals_per_100k"] = d.hospitals_in_ward / pop * 1e5
    # the Yamuna floodplain polygon is not a ward: score it out
    d["scored"] = d.ward_type != "Non-ward polygon"
    # estimate Census indicators for outer wards the Census table does not cover (validated, flagged)
    d, report = impute.impute(d, geojson)
    d.attrs["imputation"] = report
    return d, gj


def percentile_risk(series, direction):
    p = series.rank(pct=True, method="average")
    return p if direction == "higher" else 1.0 - p


def score(d, group_weights=None):
    """Returns (indicator percentiles, group scores 0-1, final score 0-100)."""
    active = {k: v for k, v in INDICATORS.items() if k in d and d.loc[d.scored, k].notna().mean() >= 0.8}
    pct = pd.DataFrame({k: percentile_risk(d.loc[d.scored, k], v[2]) for k, v in active.items()})
    groups = pd.DataFrame({g: pct[[k for k, v in active.items() if v[1] == g]].mean(axis=1)
                           for g in GROUPS if any(v[1] == g for v in active.values())})
    w = pd.Series(group_weights or {g: 1.0 for g in groups}, dtype=float)[groups.columns]
    w = w / w.sum()
    return active, pct, groups, (groups * w).sum(axis=1) * 100.0, w


def classify(s):
    return pd.qcut(s.rank(method="first"), 5, labels=CLASSES)


def sensitivity(groups, base, w, sims=500, seed=42):
    rng = np.random.default_rng(seed)
    base_cls = classify(base)
    rho, changed = [], []
    for _ in range(sims):
        ww = w * rng.uniform(0.7, 1.3, size=len(w))
        s = (groups * (ww / ww.sum())).sum(axis=1) * 100
        rho.append(base.corr(s, method="spearman"))
        changed.append((classify(s) != base_cls).mean())
    loo = {}
    for g in groups.columns:
        keep = [c for c in groups.columns if c != g]
        s = groups[keep].mean(axis=1)
        loo[g] = round(float(base.corr(s, method="spearman")), 3)
    return float(np.mean(rho)), float(np.mean(changed)), loo


def check_against_reference(d, final, ref_csv):
    """Where do wards named by the Delhi Heat Action Plan / CSE fall in our ranking?"""
    if not Path(ref_csv).exists():
        return {}
    ref = pd.read_csv(ref_csv, dtype={"matched_ward_id": str}).dropna(subset=["matched_ward_id"])
    pctl = final.rank(pct=True) * 100
    by_id = pd.Series(pctl.values, index=d.loc[final.index, "ward_id"].values)
    out, lists = {}, {}
    for name, g in ref.groupby("list_name"):
        v = by_id.reindex(g.matched_ward_id.unique()).dropna()
        lists[name] = v
        out[name] = {"wards": int(len(v)), "median_percentile": round(float(v.median()), 1),
                     "min": round(float(v.min()), 1), "max": round(float(v.max()), 1)}
    hot = pd.concat([lists[k] for k in lists if k != "CSE_relief_low_heat_stress"])
    low = lists.get("CSE_relief_low_heat_stress")
    if low is not None and len(hot):
        diff = hot.values[:, None] - low.values[None, :]
        out["auc_named_high_vs_named_low"] = round(float(((diff > 0).mean() + 0.5 * (diff == 0).mean())), 3)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ward-data", default="inputs/ward_data.csv")
    ap.add_argument("--geojson", default="delhi_wards.geojson")
    ap.add_argument("--reference", default="reference_wards.csv")
    ap.add_argument("--out", default="outputs/risk_v2")
    ap.add_argument("--simulations", type=int, default=500)
    a = ap.parse_args()
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)

    d, gj = load(a.ward_data, a.geojson)
    active, pct, groups, final, w = score(d)
    cls = classify(final)

    res = d.set_index(d.index)[["ward_id", "ward_name", "ward_type", "area_km2", "total_population"]].copy()
    res.loc[final.index, "risk_score"] = final.round(1)
    res.loc[final.index, "risk_class"] = cls.astype(str)
    res.loc[final.index, "rank"] = final.rank(ascending=False, method="min")
    for g in groups.columns:
        res.loc[final.index, f"{g}_score"] = (groups[g] * 100).round(1)
    # the three indicators pulling each ward's score up the most
    contrib = pd.DataFrame({k: pct[k] * w[active[k][1]] / (pct.columns.map(lambda c: active[c][1]).tolist().count(active[k][1]))
                            for k in pct.columns})
    res["top_drivers"] = ""
    for i in final.index:
        top = contrib.loc[i].sort_values(ascending=False).head(3).index
        res.loc[i, "top_drivers"] = "; ".join(active[k][0] for k in top)
    raw_cols = list(active)
    res = res.join(d[raw_cols].round(3))
    res["census_data"] = d["census_data"]
    res = res.sort_values("rank")
    res.to_csv(out / "ward_risk.csv", index=False)

    # GeoJSON for mapping
    props = res.set_index("ward_id")
    for f in gj["features"]:
        r = props.loc[str(f["properties"]["ward_id"])]
        f["properties"].update({k: (None if pd.isna(v) else (v.item() if hasattr(v, "item") else v))
                                for k, v in r.items() if k not in f["properties"]})
    (out / "ward_risk.geojson").write_text(json.dumps(gj))

    rho, changed, loo = sensitivity(groups, final, w, a.simulations)
    ref = check_against_reference(d, final, a.reference)
    summary = {
        "what_this_is": "Relative heat-risk ranking of Delhi wards (not a probability of harm; not validated against heat illness data)",
        "wards_scored": int(len(final)),
        "group_weights": {k: round(float(v), 3) for k, v in w.items()},
        "indicators": {k: {"label": v[0], "group": v[1], "more_risk_when": v[2]} for k, v in active.items()},
        "class_method": "rank-based quintiles across scored wards",
        "weight_sensitivity": {"mean_rank_correlation": round(rho, 4), "share_of_wards_changing_class": round(changed, 4)},
        "leave_one_group_out_rank_correlation": loo,
        "census_estimation": {"note": "Census 2011 has no row for ~56 outer wards; assets and treated-tap-water were estimated "
                                       "for them only where validation passed (rank correlation >= 0.5); housing quality was not.",
                              "wards_estimated": int((d.census_data == "estimated").sum()),
                              "validation": d.attrs.get("imputation", {})},
        "check_against_heat_action_plan_and_cse_lists": ref,
        "limitations": [
            "Temperature is from mid-morning Landsat passes (Apr-Jun 2019-2025), not the afternoon peak",
            "Population is a 1 km modelled grid (WorldPop 2020)",
            "Hospital travel time is a straight-line estimate; OpenStreetMap includes small nursing homes",
            "Wealth, housing quality and water access come from Census 2011 (15 years old) and exist for ~234 of 289 wards; the rest are scored without them",
            "The reference check is not independent for heat hazard: those lists also come from Landsat temperature",
        ],
    }
    (out / "summary.json").write_text(json.dumps(summary, indent=2))

    print(f"Scored {len(final)} wards | group weights {summary['group_weights']}")
    print(f"Weight-sensitivity: mean rank correlation {rho:.3f}, {100 * changed:.1f}% of wards change class")
    print("Leave-one-group-out rank correlation:", loo)
    print("\nCheck against the Delhi Heat Action Plan / CSE ward lists (percentile of our score, 100 = highest risk):")
    for k, v in ref.items():
        print(f"  {k}: {v}")
    print("\nTop 15 wards:")
    print(res.head(15)[["rank", "ward_name", "risk_score", "risk_class", "top_drivers"]].to_string(index=False))
    print(f"\nclass counts: {res.risk_class.value_counts().to_dict()}")
    print(f"saved to {out}/")


if __name__ == "__main__":
    main()
