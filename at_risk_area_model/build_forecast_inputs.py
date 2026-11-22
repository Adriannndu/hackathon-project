#!/usr/bin/env python3
"""Build the small inputs the report needs for its heat-wave outlook.

Reads  ../data/raw/new_delhi.csv  (Open-Meteo daily history, from data_bundle.tgz)
Writes inputs/delhi_tmax_normals.csv  day-of-year normal of the daily max temp,
                                      same method as hw_pipeline (2000-2017, 31-day smoothing)
       inputs/demo_may2024.csv        the observed 22-30 May 2024 Delhi heat wave, replayed
                                      by the report's demo mode as if it were a forecast

Run from at_risk_area_model/:  ../.venv/bin/python build_forecast_inputs.py
"""
import sys
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from hw_pipeline.features import _normal  # noqa: E402

DEMO_START, DEMO_END = "2024-05-22", "2024-05-30"   # 2 past days + 7 "forecast" days from 24 May


def main():
    g = pd.read_csv(ROOT / "data/raw/new_delhi.csv", parse_dates=["date"])
    norm = _normal(g)
    pd.DataFrame({"doy": norm.index, "tmax_normal_c": norm.values.round(2)}).to_csv(
        "inputs/delhi_tmax_normals.csv", index=False)

    demo = g[(g.date >= DEMO_START) & (g.date <= DEMO_END)][
        ["date", "temperature_2m_max", "temperature_2m_min", "apparent_temperature_max"]]
    demo.to_csv("inputs/demo_may2024.csv", index=False, date_format="%Y-%m-%d")
    print(f"normals: {len(norm)} days (peak {norm.max():.1f} C); demo: {len(demo)} days")


if __name__ == "__main__":
    main()
