"""
Ward-level household indicators from Census of India 2011, Houselisting table HL-14
("Percentage of households by amenities and assets", NCT of Delhi, one file per district).

Source: https://censusindia.gov.in/nada/index.php/catalog/9388 ... /9396  (9 districts)
Files are saved in data/census/hl14_<catalog id>.xlsx. Values in these tables are
PERCENTAGES of households, and a ward split across sub-districts appears as several
rows, which are averaged (no household counts are published to weight them).

Ward numbers are matched to delhi_wards.geojson ids: the 272 municipal wards (DMC-U)
by number, plus NDMC_n and CANT_n. Census lists the rural/census-town parts of the
outer wards separately, so ~55 municipal wards have no row and stay empty.

Writes inputs/ward_census.csv (all 2011 data; relative ranking is what matters).
  assets_index         mean percentile of: car/jeep/van, computer/laptop, NOT lacking all assets
  tap_treated_pct      % households with tap water from a treated source
  tap_in_premises_pct  % households with the drinking-water source within the premises
  poor_housing_index   mean percentile of: % semi-permanent/temporary structures, % one-room or no-room homes
  plus the raw percentages used.
"""
import glob
from pathlib import Path

import numpy as np
import pandas as pd

COLS = {"one_room_pct": (48, 49), "kutcha_pct": (140, 141), "tap_treated_pct": (71,),
        "within_premises_pct": (81,), "no_latrine_pct": (99,), "lpg_pct": (113,),
        "car_pct": (136,), "computer_pct": (129, 130), "scooter_pct": (135,), "no_assets_pct": (138,)}


def main():
    files = sorted(glob.glob("data/census/hl14_93*.xlsx"))
    if len(files) < 9:
        raise SystemExit(f"expected 9 district files in data/census/, found {len(files)}")
    c = pd.concat([pd.read_excel(f, "Sheet1", header=None).iloc[7:] for f in files], ignore_index=True)
    c.columns = range(c.shape[1])
    w = c[c[8].astype(str).str.contains(r"Ward No\.", regex=True)].copy()
    w["no"] = w[8].str.extract(r"Ward No\.\s*(\d+)")[0].astype(int)
    kind = w[8].str.extract(r"^(.*?)\s*-\s*Ward No")[0].str.replace(r"\s*\(Part\)", "", regex=True).str.strip()
    w["ward_id"] = np.select([kind == "DMC (U)", kind == "NDMC", kind.str.startswith("Delhi Cantonment")],
                             [w.no.astype(str), "NDMC_" + w.no.astype(str), "CANT_" + w.no.astype(str)], None)
    w = w[w.ward_id.notna()]
    for k in range(10, 145):
        w[k] = pd.to_numeric(w[k], errors="coerce")
    out = pd.DataFrame({"ward_id": w.ward_id})
    for name, cols in COLS.items():
        out[name] = w[list(cols)].sum(axis=1, min_count=1).values
    out = out.groupby("ward_id").mean().reset_index()       # average split-ward pieces

    pr = lambda s: s.rank(pct=True)
    out["assets_index"] = (pr(out.car_pct) + pr(out.computer_pct) + pr(-out.no_assets_pct)) / 3
    out["poor_housing_index"] = (pr(out.kutcha_pct) + pr(out.one_room_pct)) / 2
    out = out.rename(columns={"within_premises_pct": "tap_in_premises_pct"})
    Path("inputs").mkdir(exist_ok=True)
    out.to_csv("inputs/ward_census.csv", index=False)
    print(f"wrote inputs/ward_census.csv: {len(out)} wards")
    print(out.describe().loc[["min", "50%", "max"]].round(1).T.to_string())


if __name__ == "__main__":
    main()
