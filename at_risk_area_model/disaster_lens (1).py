#!/usr/bin/env python3
"""Disaster Lens: build a relative heat-vulnerability score on the Delhi H3 grid.

This is intentionally a single-file workflow. It:
  1. Reads the H3-cell/ward intersection crosswalk.
  2. Converts ward-level data to H3 cells using intersection weights.
  3. Optionally overlays direct H3-cell data (direct cell values take priority).
  4. Derives demographic shares and crowding where source columns permit.
  5. Computes a three-pillar, 0-100 vulnerability score and relative quintile classes.
  6. Reports top score contributors, correlations, randomized-weight sensitivity,
     and leave-one-indicator-out sensitivity.

Expected crosswalk columns:
  h3_id, ward_id, overlap_km2, share_of_cell, share_of_ward

Ward input:
  One row per ward, with ward_id and any supported indicator/source columns.
  Extensive quantities (population counts and built-up area) are allocated to
  cells using share_of_ward. Rates/indices (tree cover, wealth, travel time,
  informal-settlement share, age shares) are area-averaged using share_of_cell.

Cell input (optional but preferred whenever available):
  One row per H3 cell, with h3_id (or cell_id) and supported source columns.
  Non-missing cell-level values override ward-derived estimates.

Supported source columns:
  pop_0_4, pop_65_plus, total_population, elderly_share, under5_share,
  built_up_area_km2, crowding_people_per_km2_built, tree_cover_pct,
  informal_settlement_share, wealth_index, hospital_travel_min.

The model does not calculate heat hazard or predict probability of harm. The
score is relative to the supplied Delhi cells and is not validated against
observed heat illness or mortality.

Dependency: pandas and numpy. Install with: python3 -m pip install pandas numpy
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Dict, List, Tuple

import numpy as np
import pandas as pd


# Each active pillar receives one-third of the final score. Within a pillar,
# its available indicators divide that pillar's weight equally.
INDICATORS = {
    "elderly_share": {
        "label": "Population aged 65+",
        "group": "Demographic sensitivity",
        "direction": "higher",
    },
    "under5_share": {
        "label": "Population under 5",
        "group": "Demographic sensitivity",
        "direction": "higher",
    },
    "informal_settlement_share": {
        "label": "Informal settlement",
        "group": "Living conditions",
        "direction": "higher",
    },
    "tree_cover_pct": {
        "label": "Low tree cover",
        "group": "Living conditions",
        "direction": "lower",
    },
    "crowding_people_per_km2_built": {
        "label": "Crowding",
        "group": "Living conditions",
        "direction": "higher",
    },
    "wealth_index": {
        "label": "Low wealth",
        "group": "Adaptive capacity",
        "direction": "lower",
    },
    "hospital_travel_min": {
        "label": "Hospital travel time",
        "group": "Adaptive capacity",
        "direction": "higher",
    },
}
GROUP_ORDER = [
    "Demographic sensitivity",
    "Living conditions",
    "Adaptive capacity",
]
RISK_LABELS = ["Low", "Moderate", "High", "Very High", "Extreme"]

# These columns describe totals/quantities distributed over a ward, not a rate.
# Each is allocated to its intersecting H3 cells by share_of_ward.
EXTENSIVE_COLUMNS = {
    "pop_0_4",
    "pop_65_plus",
    "total_population",
    "built_up_area_km2",
}
CROSSWALK_REQUIRED = {
    "h3_id", "ward_id", "overlap_km2", "share_of_cell", "share_of_ward"
}


class ModelError(Exception):
    """Raised for invalid or incomplete model inputs."""


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build Disaster Lens heat-vulnerability scores for the Delhi H3 grid."
    )
    parser.add_argument("--crosswalk", default="delhi_cell_ward_crosswalk.csv",
                        help="H3-cell to ward intersection CSV (default: delhi_cell_ward_crosswalk.csv)")
    parser.add_argument("--ward-data", default=None,
                        help="Optional CSV with one row per ward and a ward_id column")
    parser.add_argument("--cell-data", default=None,
                        help="Optional CSV with one row per H3 cell and h3_id/cell_id column")
    parser.add_argument("--cell-id-column", default=None,
                        help="Override H3 ID field in --cell-data (auto-detected by default)")
    parser.add_argument("--ward-id-column", default="ward_id",
                        help="Ward ID field in --ward-data (default: ward_id)")
    parser.add_argument("--output-dir", default="disaster_lens_outputs",
                        help="Where to save outputs (default: disaster_lens_outputs)")
    parser.add_argument("--simulations", type=int, default=500,
                        help="Randomized weight simulations (default: 500)")
    parser.add_argument("--seed", type=int, default=42,
                        help="Random seed for repeatable sensitivity tests")
    parser.add_argument("--min-indicator-coverage", type=float, default=0.80,
                        help="Minimum share of cells with an indicator for it to be used (default: 0.80)")
    parser.add_argument("--correlation-threshold", type=float, default=0.80,
                        help="Flag absolute Spearman correlations at or above this value")
    return parser.parse_args()


def resolve_input_path(path: str | Path) -> Path:
    """Find an input file from the working directory or beside/above this script.

    This supports common project layouts where the user launches a script from
    the project root even though the CSV lives in the script's subfolder (or
    vice versa). Absolute paths are used exactly as supplied.
    """
    requested = Path(path).expanduser()
    if requested.is_absolute():
        candidates = [requested]
    else:
        script_dir = Path(__file__).resolve().parent
        search_dirs = [Path.cwd(), script_dir, *script_dir.parents]
        candidates = []
        seen = set()
        for directory in search_dirs:
            candidate = (directory / requested).resolve()
            if candidate not in seen:
                candidates.append(candidate)
                seen.add(candidate)

    for candidate in candidates:
        if candidate.is_file():
            return candidate

    searched = "\n".join(f"  - {candidate}" for candidate in candidates)
    raise ModelError(
        f"File not found: {requested}\nSearched these locations:\n{searched}\n"
        "Tip: pass the full path with --crosswalk, --ward-data, or --cell-data."
    )


def read_csv(path: str | Path) -> pd.DataFrame:
    resolved = resolve_input_path(path)
    try:
        return pd.read_csv(resolved)
    except Exception as exc:
        raise ModelError(f"Could not read CSV '{resolved}': {exc}") from exc


def numeric(series: pd.Series) -> pd.Series:
    return pd.to_numeric(series, errors="coerce").replace([np.inf, -np.inf], np.nan)


def normalize_weights(frame: pd.DataFrame, group_col: str, weight_col: str) -> pd.Series:
    totals = frame.groupby(group_col, dropna=False)[weight_col].transform("sum")
    return frame[weight_col] / totals.replace(0, np.nan)


def validate_crosswalk(crosswalk: pd.DataFrame) -> pd.DataFrame:
    missing = CROSSWALK_REQUIRED - set(crosswalk.columns)
    if missing:
        raise ModelError(f"Crosswalk is missing required columns: {sorted(missing)}")
    cw = crosswalk[list(CROSSWALK_REQUIRED)].copy()
    # Preserve H3 IDs as strings; ward IDs are normalized to comparable strings.
    cw["h3_id"] = cw["h3_id"].astype("string").str.strip()
    cw["ward_id"] = cw["ward_id"].astype("string").str.strip()
    for col in ["overlap_km2", "share_of_cell", "share_of_ward"]:
        cw[col] = numeric(cw[col])
    if cw[["h3_id", "ward_id"]].isna().any().any() or (cw[["h3_id", "ward_id"]] == "").any().any():
        raise ModelError("Crosswalk contains blank h3_id or ward_id values.")
    if cw.duplicated(["h3_id", "ward_id"]).any():
        examples = cw.loc[cw.duplicated(["h3_id", "ward_id"], keep=False), ["h3_id", "ward_id"]].head()
        raise ModelError(f"Crosswalk contains duplicate cell/ward intersections:\n{examples}")
    if cw[["overlap_km2", "share_of_cell", "share_of_ward"]].isna().any().any():
        raise ModelError("Crosswalk contains non-numeric or missing intersection weights.")
    if (cw[["overlap_km2", "share_of_cell", "share_of_ward"]] < 0).any().any():
        raise ModelError("Crosswalk weights and overlap areas cannot be negative.")
    if (cw["share_of_cell"] > 1.01).any() or (cw["share_of_ward"] > 1.01).any():
        raise ModelError("Crosswalk shares should be fractions from 0 to 1 (not percentages).")

    # The uploaded shares are rounded. Renormalize tiny rounding differences so
    # each cell's cell shares and each ward's ward shares sum to exactly one.
    cell_sums = cw.groupby("h3_id")["share_of_cell"].sum()
    ward_sums = cw.groupby("ward_id")["share_of_ward"].sum()
    if ((cell_sums - 1).abs() > 0.02).any():
        bad = cell_sums[(cell_sums - 1).abs() > 0.02].head().to_dict()
        raise ModelError(f"Some H3 cell share totals differ from 1 by more than 0.02: {bad}")
    if ((ward_sums - 1).abs() > 0.02).any():
        bad = ward_sums[(ward_sums - 1).abs() > 0.02].head().to_dict()
        raise ModelError(f"Some ward share totals differ from 1 by more than 0.02: {bad}")
    cw["share_of_cell"] = normalize_weights(cw, "h3_id", "share_of_cell")
    cw["share_of_ward"] = normalize_weights(cw, "ward_id", "share_of_ward")
    return cw


def weighted_to_cells(cw: pd.DataFrame, ward_data: pd.DataFrame,
                      ward_id_column: str) -> pd.DataFrame:
    """Transfer ward totals and ward rates/indices to H3 cells."""
    if ward_id_column not in ward_data.columns:
        raise ModelError(f"Ward data must contain '{ward_id_column}'.")
    wd = ward_data.copy()
    wd[ward_id_column] = wd[ward_id_column].astype("string").str.strip()
    if wd[ward_id_column].isna().any() or (wd[ward_id_column] == "").any():
        raise ModelError("Ward data contains blank ward IDs.")
    if wd[ward_id_column].duplicated().any():
        dupes = wd.loc[wd[ward_id_column].duplicated(), ward_id_column].head().tolist()
        raise ModelError(f"Ward data must have one row per ward. Duplicate IDs include: {dupes}")

    value_cols = [c for c in wd.columns if c != ward_id_column]
    if not value_cols:
        raise ModelError("Ward data contains no indicator columns.")
    for col in value_cols:
        wd[col] = numeric(wd[col])

    joined = cw.merge(wd, left_on="ward_id", right_on=ward_id_column,
                      how="left", validate="many_to_one")
    known_wards = set(wd[ward_id_column].dropna())
    missing_wards = sorted(set(cw["ward_id"]) - known_wards)
    if missing_wards:
        print(f"WARNING: {len(missing_wards)} crosswalk wards have no row in ward data; affected values remain missing.", file=sys.stderr)

    result = pd.DataFrame({"h3_id": sorted(cw["h3_id"].unique())})
    for col in value_cols:
        if col in EXTENSIVE_COLUMNS:
            # A ward total is apportioned by the fraction of the ward intersecting
            # each H3 cell. Require complete intersecting-ward data for each cell.
            joined["_weighted"] = joined[col] * joined["share_of_ward"]
            joined["_missing"] = joined[col].isna()
            agg = joined.groupby("h3_id").agg(
                value=("_weighted", lambda s: s.sum(min_count=1)),
                missing=("_missing", "any"),
            )
            agg.loc[agg["missing"], "value"] = np.nan
            result[col] = result["h3_id"].map(agg["value"])
        else:
            # Rates and indices are area-weighted across the part of the cell in
            # each ward. Missing source coverage is not silently treated as zero.
            joined["_weighted"] = joined[col] * joined["share_of_cell"]
            joined["_valid_weight"] = joined["share_of_cell"].where(joined[col].notna(), 0.0)
            agg = joined.groupby("h3_id").agg(
                weighted_sum=("_weighted", lambda s: s.sum(min_count=1)),
                valid_weight=("_valid_weight", "sum"),
            )
            values = agg["weighted_sum"] / agg["valid_weight"].replace(0, np.nan)
            values.loc[agg["valid_weight"] < 0.999] = np.nan
            result[col] = result["h3_id"].map(values)
    return result


def merge_cell_data(base: pd.DataFrame, cell_data: pd.DataFrame,
                    id_column: str | None) -> pd.DataFrame:
    """Overlay direct cell values on ward-derived approximations."""
    cd = cell_data.copy()
    candidates = [id_column] if id_column else ["h3_id", "cell_id", "h3_index"]
    found = next((c for c in candidates if c and c in cd.columns), None)
    if found is None:
        raise ModelError(
            "Cell data needs an H3 key column named h3_id or cell_id, "
            "or pass --cell-id-column to specify it."
        )
    cd = cd.rename(columns={found: "h3_id"})
    cd["h3_id"] = cd["h3_id"].astype("string").str.strip()
    if cd["h3_id"].isna().any() or (cd["h3_id"] == "").any():
        raise ModelError("Cell data contains blank H3 IDs.")
    if cd["h3_id"].duplicated().any():
        raise ModelError("Cell data must have one row per H3 cell; duplicate IDs found.")
    unknown = set(cd["h3_id"]) - set(base["h3_id"])
    if unknown:
        print(f"WARNING: ignoring {len(unknown)} cell-data IDs not present in the supplied crosswalk.", file=sys.stderr)
    cd = cd[cd["h3_id"].isin(base["h3_id"])].copy()
    for col in cd.columns:
        if col != "h3_id":
            cd[col] = numeric(cd[col])
    merged = base.merge(cd, on="h3_id", how="left", suffixes=("", "__cell"), validate="one_to_one")
    for col in cd.columns:
        if col == "h3_id":
            continue
        cell_col = f"{col}__cell" if col in base.columns else col
        if col in base.columns:
            merged[col] = merged[cell_col].combine_first(merged[col])
            merged.drop(columns=[cell_col], inplace=True)
        else:
            merged.rename(columns={cell_col: col}, inplace=True)
    return merged


def derive_indicators(raw: pd.DataFrame) -> pd.DataFrame:
    values = pd.DataFrame(index=raw.index)

    # Prefer direct shares when supplied; otherwise derive shares from counts.
    if "elderly_share" in raw.columns:
        values["elderly_share"] = numeric(raw["elderly_share"])
    elif {"pop_65_plus", "total_population"}.issubset(raw.columns):
        pop = numeric(raw["total_population"])
        values["elderly_share"] = numeric(raw["pop_65_plus"]) / pop.where(pop > 0)

    if "under5_share" in raw.columns:
        values["under5_share"] = numeric(raw["under5_share"])
    elif {"pop_0_4", "total_population"}.issubset(raw.columns):
        pop = numeric(raw["total_population"])
        values["under5_share"] = numeric(raw["pop_0_4"]) / pop.where(pop > 0)

    if "informal_settlement_share" in raw.columns:
        values["informal_settlement_share"] = numeric(raw["informal_settlement_share"])
    if "tree_cover_pct" in raw.columns:
        values["tree_cover_pct"] = numeric(raw["tree_cover_pct"])

    if "crowding_people_per_km2_built" in raw.columns:
        values["crowding_people_per_km2_built"] = numeric(raw["crowding_people_per_km2_built"])
    elif {"total_population", "built_up_area_km2"}.issubset(raw.columns):
        pop = numeric(raw["total_population"])
        area = numeric(raw["built_up_area_km2"])
        values["crowding_people_per_km2_built"] = pop / area.where(area > 0)

    if "wealth_index" in raw.columns:
        values["wealth_index"] = numeric(raw["wealth_index"])
    if "hospital_travel_min" in raw.columns:
        values["hospital_travel_min"] = numeric(raw["hospital_travel_min"])

    # Obvious impossible values are converted to missing instead of influencing ranks.
    for col in ["elderly_share", "under5_share"]:
        if col in values:
            values.loc[(values[col] < 0) | (values[col] > 1), col] = np.nan
    if "tree_cover_pct" in values:
        values.loc[(values["tree_cover_pct"] < 0) | (values["tree_cover_pct"] > 100), "tree_cover_pct"] = np.nan
    if "hospital_travel_min" in values:
        values.loc[values["hospital_travel_min"] < 0, "hospital_travel_min"] = np.nan
    if "informal_settlement_share" in values:
        values.loc[values["informal_settlement_share"] < 0, "informal_settlement_share"] = np.nan
    for col in ["pop_0_4", "pop_65_plus", "total_population", "built_up_area_km2"]:
        if col in raw.columns:
            bad = numeric(raw[col]) < 0
            if bad.any():
                print(f"WARNING: {bad.sum()} negative values found in {col}; review source data.", file=sys.stderr)
    return values


def percentile_vulnerability(series: pd.Series, direction: str) -> pd.Series:
    valid_n = int(series.notna().sum())
    if valid_n == 0:
        return pd.Series(np.nan, index=series.index, dtype=float)
    if valid_n == 1:
        out = pd.Series(np.nan, index=series.index, dtype=float)
        out.loc[series.notna()] = 0.5
        return out
    ranked = (series.rank(method="average") - 1.0) / (valid_n - 1.0)
    return 1.0 - ranked if direction == "lower" else ranked


def rank_percentile(series: pd.Series) -> pd.Series:
    n = int(series.notna().sum())
    if n == 0:
        return pd.Series(np.nan, index=series.index, dtype=float)
    if n == 1:
        out = pd.Series(np.nan, index=series.index, dtype=float)
        out.loc[series.notna()] = 0.5
        return out
    return (series.rank(method="average") - 1.0) / (n - 1.0)


def assign_classes(scores: pd.Series) -> Tuple[pd.Series, pd.Series]:
    pct = rank_percentile(scores)
    bins = np.floor(pct * 5).clip(0, 4)
    classes = pd.Series(index=scores.index, dtype="object")
    valid = bins.notna()
    classes.loc[valid] = [RISK_LABELS[int(v)] for v in bins.loc[valid]]
    return classes, pct


def calculate_weights(active: List[str]) -> Dict[str, float]:
    active_groups = [g for g in GROUP_ORDER if any(INDICATORS[k]["group"] == g for k in active)]
    missing = [g for g in GROUP_ORDER if g not in active_groups]
    if missing:
        raise ModelError(
            "A defensible three-pillar score needs at least one usable indicator in every pillar. "
            f"Missing pillar(s): {', '.join(missing)}. Supply those data before scoring."
        )
    weights: Dict[str, float] = {}
    for group in active_groups:
        members = [k for k in active if INDICATORS[k]["group"] == group]
        for key in members:
            weights[key] = (1.0 / len(active_groups)) / len(members)
    return weights


def score_values(z: pd.DataFrame, weights: Dict[str, float]) -> pd.Series:
    score = pd.Series(0.0, index=z.index)
    for key, weight in weights.items():
        score += z[key] * (100.0 * weight)
    return score


def spearman(a: pd.Series, b: pd.Series) -> float:
    pair = pd.concat([a, b], axis=1).dropna()
    if len(pair) < 2:
        return float("nan")
    return float(pair.iloc[:, 0].corr(pair.iloc[:, 1], method="spearman"))


def weight_sensitivity(z: pd.DataFrame, active: List[str], baseline_score: pd.Series,
                       baseline_class: pd.Series, base_weights: Dict[str, float],
                       simulations: int, seed: int, cell_ids: pd.Series) -> Tuple[pd.DataFrame, pd.DataFrame]:
    rng = np.random.default_rng(seed)
    rows = []
    rank_changes = []
    class_changes = pd.Series(0.0, index=z.index)
    base_rank = rank_percentile(baseline_score)
    for simulation in range(1, simulations + 1):
        varied: Dict[str, float] = {}
        for group in GROUP_ORDER:
            members = [k for k in active if INDICATORS[k]["group"] == group]
            raw_weights = np.array([base_weights[k] for k in members], dtype=float)
            adjusted = raw_weights * rng.uniform(0.70, 1.30, size=len(members))
            adjusted = adjusted / adjusted.sum() * (1.0 / len(GROUP_ORDER))
            varied.update({key: float(w) for key, w in zip(members, adjusted)})
        sim_score = score_values(z, varied)
        sim_class, _ = assign_classes(sim_score)
        sim_rank = rank_percentile(sim_score)
        changed = sim_class.ne(baseline_class)
        class_changes += changed.astype(float)
        rank_delta = (sim_rank - base_rank).abs()
        rank_changes.append(rank_delta)
        rows.append({
            "simulation": simulation,
            "spearman_rank_correlation": spearman(baseline_score, sim_score),
            "percent_cells_changing_risk_class": float(changed.mean() * 100),
            "mean_absolute_rank_percentile_change": float(rank_delta.mean()),
        })
    per_cell = pd.DataFrame({
        "h3_id": cell_ids.loc[z.index].astype(str).to_numpy(),
        "fraction_of_simulations_changing_class": class_changes.to_numpy() / simulations,
        "risk_class_stability_pct": (1.0 - class_changes.to_numpy() / simulations) * 100.0,
        "mean_absolute_rank_percentile_change": pd.concat(rank_changes, axis=1).mean(axis=1).to_numpy(),
    })
    return pd.DataFrame(rows), per_cell


def leave_one_out(z: pd.DataFrame, active: List[str], baseline_score: pd.Series,
                  baseline_class: pd.Series) -> pd.DataFrame:
    rows = []
    for removed in active:
        remaining = [k for k in active if k != removed]
        remaining_groups = [g for g in GROUP_ORDER if any(INDICATORS[k]["group"] == g for k in remaining)]
        weights: Dict[str, float] = {}
        for group in remaining_groups:
            members = [k for k in remaining if INDICATORS[k]["group"] == group]
            for key in members:
                weights[key] = (1.0 / len(remaining_groups)) / len(members)
        changed_score = score_values(z[remaining], weights)
        changed_class, _ = assign_classes(changed_score)
        rows.append({
            "removed_indicator": removed,
            "indicator_label": INDICATORS[removed]["label"],
            "spearman_rank_correlation": spearman(baseline_score, changed_score),
            "percent_cells_changing_risk_class": float(changed_class.ne(baseline_class).mean() * 100),
            "mean_absolute_score_point_change": float((changed_score - baseline_score).abs().mean()),
        })
    return pd.DataFrame(rows)


def correlation_report(raw: pd.DataFrame, active: List[str], threshold: float) -> pd.DataFrame:
    corr = raw[active].corr(method="spearman")
    rows = []
    for i, first in enumerate(active):
        for second in active[i + 1:]:
            value = corr.loc[first, second]
            rows.append({
                "indicator_1": first,
                "indicator_2": second,
                "spearman_correlation": float(value) if pd.notna(value) else np.nan,
                "flag_for_review": bool(pd.notna(value) and abs(value) >= threshold),
            })
    return pd.DataFrame(rows)


def add_contributions(output: pd.DataFrame, z: pd.DataFrame,
                      active: List[str], weights: Dict[str, float]) -> None:
    contrib = pd.DataFrame(index=z.index)
    for key in active:
        col = f"contribution_{key}_points"
        output[col] = np.nan
        output.loc[z.index, col] = z[key] * weights[key] * 100.0
        contrib[key] = z[key] * weights[key] * 100.0
    for n in range(1, 4):
        output[f"top_driver_{n}"] = ""
        output[f"top_driver_{n}_points"] = np.nan
    for idx, row in contrib.iterrows():
        ordered = row.dropna().sort_values(ascending=False, kind="stable").head(3)
        for rank, (key, points) in enumerate(ordered.items(), start=1):
            output.at[idx, f"top_driver_{rank}"] = INDICATORS[key]["label"]
            output.at[idx, f"top_driver_{rank}_points"] = float(points)


def main() -> int:
    args = arguments()
    if args.simulations < 1:
        raise ModelError("--simulations must be at least 1.")
    if not 0 < args.min_indicator_coverage <= 1:
        raise ModelError("--min-indicator-coverage must be greater than 0 and at most 1.")

    crosswalk_path = resolve_input_path(args.crosswalk)
    crosswalk = validate_crosswalk(read_csv(crosswalk_path))
    cells = pd.DataFrame({"h3_id": sorted(crosswalk["h3_id"].unique())})
    inputs_used = []
    if args.ward_data:
        ward_path = resolve_input_path(args.ward_data)
        ward_values = weighted_to_cells(crosswalk, read_csv(ward_path), args.ward_id_column)
        cells = cells.merge(ward_values, on="h3_id", how="left", validate="one_to_one")
        inputs_used.append(str(ward_path))
    if args.cell_data:
        cell_path = resolve_input_path(args.cell_data)
        cells = merge_cell_data(cells, read_csv(cell_path), args.cell_id_column)
        inputs_used.append(str(cell_path))
    if not inputs_used:
        raise ModelError("Provide at least one data file with --ward-data and/or --cell-data.")

    # This intermediate is useful for checking spatially transferred data before
    # interpreting the final score.
    outdir = Path(args.output_dir)
    outdir.mkdir(parents=True, exist_ok=True)
    cells.to_csv(outdir / "delhi_cell_indicators_assembled.csv", index=False)

    indicator_data = derive_indicators(cells)
    if indicator_data.empty:
        raise ModelError("No recognized indicator columns were found in the supplied data.")
    coverage = indicator_data.notna().mean()
    active = [key for key in INDICATORS if key in indicator_data and coverage.get(key, 0) >= args.min_indicator_coverage]
    if not active:
        raise ModelError(
            "No indicators met the minimum coverage threshold. Check the column names and data coverage. "
            f"Recognized coverage: {coverage.to_dict()}"
        )
    excluded = {key: float(coverage[key]) for key in indicator_data.columns if key not in active}
    weights = calculate_weights(active)

    # Use one consistent reference set so cells are compared on the same set of
    # indicators. A cell missing any active indicator is explicitly not scored.
    complete = indicator_data[active].notna().all(axis=1)
    n_complete = int(complete.sum())
    if n_complete < 5:
        raise ModelError(
            f"Only {n_complete} H3 cells have complete values for all active indicators; at least 5 are required. "
            "Check source coverage or add the missing pillar data."
        )
    raw_reference = indicator_data.loc[complete, active].copy()
    z = pd.DataFrame(index=raw_reference.index)
    for key in active:
        z[key] = percentile_vulnerability(raw_reference[key], INDICATORS[key]["direction"])

    baseline_score = score_values(z, weights)
    risk_class, score_pct = assign_classes(baseline_score)
    scored = cells[["h3_id"]].copy()
    for col in indicator_data.columns:
        scored[col] = indicator_data[col]
    for key in active:
        col = f"vulnerability_percentile_{key}"
        scored[col] = np.nan
        scored.loc[z.index, col] = z[key]
    scored["vulnerability_score"] = np.nan
    scored.loc[baseline_score.index, "vulnerability_score"] = baseline_score
    scored["score_percentile_in_reference"] = np.nan
    scored.loc[score_pct.index, "score_percentile_in_reference"] = score_pct
    scored["risk_class"] = "Not scored - missing data"
    scored.loc[risk_class.index, "risk_class"] = risk_class
    scored["included_in_reference"] = complete
    add_contributions(scored, z, active, weights)

    sim_results, cell_stability = weight_sensitivity(
        z, active, baseline_score, risk_class, weights, args.simulations, args.seed, cells["h3_id"]
    )
    leave_one = leave_one_out(z, active, baseline_score, risk_class)
    correlations = correlation_report(raw_reference, active, args.correlation_threshold)

    # Save the core cell-level model result and diagnostics.
    scored.to_csv(outdir / "delhi_vulnerability_scores.csv", index=False)
    pd.DataFrame([{
        "indicator": key,
        "label": INDICATORS[key]["label"],
        "pillar": INDICATORS[key]["group"],
        "vulnerability_direction": INDICATORS[key]["direction"],
        "weight": weights[key],
        "coverage_all_cells": float(coverage[key]),
    } for key in active]).to_csv(outdir / "indicator_weights.csv", index=False)
    sim_results.to_csv(outdir / "weight_sensitivity_simulations.csv", index=False)
    cell_stability.to_csv(outdir / "weight_sensitivity_by_cell.csv", index=False)
    leave_one.to_csv(outdir / "leave_one_indicator_out.csv", index=False)
    correlations.to_csv(outdir / "indicator_correlations.csv", index=False)

    summary = {
        "project": "Disaster Lens",
        "index": "Relative heat vulnerability (not heat hazard and not probability of harm)",
        "crosswalk_file": str(crosswalk_path),
        "data_files": inputs_used,
        "total_h3_cells_in_crosswalk": int(cells["h3_id"].nunique()),
        "scored_cells": n_complete,
        "unscored_cells": int(len(cells) - n_complete),
        "active_indicators": active,
        "excluded_indicators_and_coverage": excluded,
        "pillar_weights": {group: 1.0 / len(GROUP_ORDER) for group in GROUP_ORDER},
        "indicator_weights": weights,
        "risk_classes": RISK_LABELS,
        "risk_class_method": "Rank-based quintiles within the supplied Delhi reference cells; tied scores stay together",
        "weight_sensitivity": {
            "simulations": args.simulations,
            "mean_spearman_rank_correlation": float(sim_results["spearman_rank_correlation"].mean()),
            "5th_percentile_spearman_rank_correlation": float(sim_results["spearman_rank_correlation"].quantile(0.05)),
            "mean_percent_cells_changing_class": float(sim_results["percent_cells_changing_risk_class"].mean()),
            "95th_percentile_percent_cells_changing_class": float(sim_results["percent_cells_changing_risk_class"].quantile(0.95)),
        },
        "high_correlation_pairs": correlations.loc[
            correlations["flag_for_review"], ["indicator_1", "indicator_2", "spearman_correlation"]
        ].to_dict(orient="records"),
        "method_notes": [
            "Ward totals are apportioned to intersecting H3 cells by share_of_ward; this assumes uniform distribution within each ward.",
            "Ward-level rates/indices are area-weighted into H3 cells by share_of_cell.",
            "Direct cell-level non-missing values override ward-derived values.",
            "Percentile normalization is performed across scored H3 cells; higher normalized values always mean greater vulnerability.",
            "Each of the three pillars receives one-third of the score; indicators divide their pillar weight equally.",
            "Risk classes are relative to this Delhi reference set and should not be compared across cities without a shared pooled reference.",
            "The score does not include temperature, humidity, heat-wave duration, or observed heat harm.",
            "This index has not been validated against observed heat illness or mortality.",
        ],
    }
    with (outdir / "model_summary.json").open("w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2)

    print("\nDISASTER LENS RUN COMPLETE")
    print(f"H3 cells in crosswalk: {len(cells):,}")
    print(f"Cells scored: {n_complete:,} | Not scored: {len(cells) - n_complete:,}")
    print("Active indicators:")
    for key in active:
        print(f"  - {INDICATORS[key]['label']}: {weights[key]:.1%}")
    print("\nMean weight-test rank correlation: "
          f"{summary['weight_sensitivity']['mean_spearman_rank_correlation']:.4f}")
    print("Mean share of cells changing class under weight tests: "
          f"{summary['weight_sensitivity']['mean_percent_cells_changing_class']:.2f}%")
    print(f"\nResults saved to: {outdir.resolve()}")
    print("Important: these are relative vulnerability scores, not predictions of heat harm.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ModelError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise SystemExit(2)
