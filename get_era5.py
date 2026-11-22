"""
Download the ERA5 upper-air fields we need, in request-sized pieces.

(era5.py asks for 1940-2026, 24 hours, 37 levels = ~140 million values, which
the CDS rejects. This asks for 2000-2026, one time a day, 2 levels.)

Files go to data/era5/ and existing files are skipped, so it is safe to re-run.

One-time setup (see the steps printed on failure):
  1. Free account at https://cds.climate.copernicus.eu
  2. Put your API token in ~/.cdsapirc :
         url: https://cds.climate.copernicus.eu/api
         key: <your personal access token>
  3. Accept the licence on BOTH dataset pages (bottom of each "Download" tab):
       reanalysis-era5-pressure-levels, reanalysis-era5-single-levels

Usage:  python get_era5.py
"""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import cdsapi

OUT = Path("data/era5")
AREA = [38, 66, 5, 100]            # North, West, South, East (India, padded)
TIME = ["06:00"]                   # 06 UTC = 11:30 IST; upper-air patterns change slowly
DAYS = [f"{d:02d}" for d in range(1, 32)]
MONTHS = [f"{m:02d}" for m in range(1, 13)]

PRESSURE = {
    "dataset": "reanalysis-era5-pressure-levels",
    "prefix": "pl",
    "extra": {
        "variable": ["geopotential", "temperature", "u_component_of_wind",
                     "v_component_of_wind", "relative_humidity"],
        "pressure_level": ["500", "850"],
    },
}
SURFACE = {
    "dataset": "reanalysis-era5-single-levels",
    "prefix": "sl",
    "extra": {"variable": ["mean_sea_level_pressure"]},
}

# (label, years, months, days). ERA5 lags ~5 days, so 2026 is cut at 10 Nov.
CHUNKS = [
    ("2000_2008", range(2000, 2009), MONTHS, DAYS),
    ("2009_2017", range(2009, 2018), MONTHS, DAYS),
    ("2018_2025", range(2018, 2026), MONTHS, DAYS),
    ("2026_jan_oct", [2026], MONTHS[:10], DAYS),
    ("2026_nov", [2026], ["11"], DAYS[:10]),
]


def job(kind, label, years, months, days):
    path = OUT / f"{kind['prefix']}_{label}.nc"
    if path.exists():
        print(f"skip {path} (already downloaded)", flush=True)
        return
    request = {
        "product_type": ["reanalysis"],
        "year": [str(y) for y in years],
        "month": months,
        "day": days,
        "time": TIME,
        "area": AREA,
        "data_format": "netcdf",
        "download_format": "unarchived",
        **kind["extra"],
    }
    print(f"requesting {path.name} ...", flush=True)
    tmp = path.with_suffix(".part")
    cdsapi.Client().retrieve(kind["dataset"], request).download(str(tmp))
    tmp.replace(path)
    print(f"saved {path}", flush=True)


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    jobs = [(k, *c) for k in (PRESSURE, SURFACE) for c in CHUNKS]
    # submit several at once so the CDS queue time overlaps
    with ThreadPoolExecutor(max_workers=4) as ex:
        futures = [ex.submit(job, *j) for j in jobs]
        for f in futures:
            f.result()  # surface any error
    print("ERA5 download complete")
