"""
Download WorldPop 2020 India population rasters (1 km, ~19 MB each) that we
need for Delhi: total population, children under 5 (age groups 0 and 1) and
people 65+ (age groups 65, 70, 75, 80+), each for both sexes.

WorldPop's server does not support partial downloads, so whole national files
are fetched (they are small at 1 km). Files go to data/worldpop/; existing
files are skipped and downloads resume safely by being written atomically.

Usage: python collect_worldpop.py
"""
from pathlib import Path

import requests

BASE = "https://data.worldpop.org/GIS"
OUT = Path("data/worldpop")
FILES = {"total": f"{BASE}/Population/Global_2000_2020_1km/2020/IND/ind_ppp_2020_1km_Aggregated.tif"}
for sex in ("f", "m"):
    for age in (0, 1, 65, 70, 75, 80):
        FILES[f"{sex}_{age}"] = (f"{BASE}/AgeSex_structures/Global_2000_2020_1km/"
                                 f"unconstrained/2020/IND/ind_{sex}_{age}_2020_1km.tif")


def download(name, url):
    path = OUT / f"{name}.tif"
    if path.exists():
        print(f"skip {name}", flush=True)
        return
    tmp = path.with_suffix(".part")
    for attempt in range(4):
        try:
            with requests.get(url, stream=True, timeout=120) as r:
                r.raise_for_status()
                with open(tmp, "wb") as f:
                    for chunk in r.iter_content(1 << 20):
                        f.write(chunk)
            tmp.replace(path)
            print(f"saved {name} ({path.stat().st_size / 1e6:.0f} MB)", flush=True)
            return
        except requests.exceptions.RequestException as e:
            print(f"{name}: {type(e).__name__}; retry {attempt + 1}", flush=True)
    raise SystemExit(f"failed to download {name}")


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    for n, u in FILES.items():
        download(n, u)
    print("WorldPop download complete", flush=True)
