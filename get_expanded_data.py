"""
Expanded historical weather collection for heat-wave modelling.

Downloads daily weather (2000 -> a week ago) for ~60 locations spread across
India from the Open-Meteo archive API (ERA5 reanalysis).

Open-Meteo's free tier is limited by *data volume* (10,000 units/day,
5,000/hour, 600/minute). One location over ~27 years of 3 variables costs
~215 units, so roughly 40 locations fit in one day's quota. The script is resumable: each
location is cached in data/raw/<name>.csv, and anything already cached is
skipped. If a limit is hit it waits (minute/hour) or stops (daily) -- just
re-run it later to continue.

Usage:
    python get_expanded_data.py              # fetch whatever is missing
    python get_expanded_data.py --combine    # only rebuild the combined CSV
    python get_expanded_data.py --start 1991-01-01
    python get_expanded_data.py --max-locations 10
"""

import argparse
import sys
import time
from datetime import date, timedelta
from pathlib import Path

import pandas as pd
import requests

URL = "https://archive-api.open-meteo.com/v1/archive"
DATA_DIR = Path("data")
RAW_DIR = DATA_DIR / "raw"
COMBINED = DATA_DIR / "india_expanded_weather.csv"
LOCATIONS_CSV = DATA_DIR / "locations.csv"

# Daily variables. Kept to what heat-wave detection needs, because API cost
# scales with the number of variables.
DAILY_VARS = [
    "temperature_2m_max",
    "temperature_2m_min",
    "apparent_temperature_max",
]

# (name, state, latitude, longitude, coastal)
# Ordered so that the first ~20 already give good national coverage; if the
# daily limit interrupts a run, what's been collected is still usable.
LOCATIONS = [
    ("New Delhi", "Delhi", 28.6139, 77.2090, False),
    ("Mumbai", "Maharashtra", 19.0760, 72.8777, True),
    ("Chennai", "Tamil Nadu", 13.0827, 80.2707, True),
    ("Kolkata", "West Bengal", 22.5726, 88.3639, True),
    ("Hyderabad", "Telangana", 17.3850, 78.4867, False),
    ("Ahmedabad", "Gujarat", 23.0225, 72.5714, False),
    ("Jaipur", "Rajasthan", 26.9124, 75.7873, False),
    ("Nagpur", "Maharashtra", 21.1458, 79.0882, False),
    ("Lucknow", "Uttar Pradesh", 26.8467, 80.9462, False),
    ("Bengaluru", "Karnataka", 12.9716, 77.5946, False),
    ("Patna", "Bihar", 25.5941, 85.1376, False),
    ("Bhopal", "Madhya Pradesh", 23.2599, 77.4126, False),
    ("Jodhpur", "Rajasthan", 26.2389, 73.0243, False),
    ("Visakhapatnam", "Andhra Pradesh", 17.6868, 83.2185, True),
    ("Bhubaneswar", "Odisha", 20.2961, 85.8245, False),
    ("Guwahati", "Assam", 26.1445, 91.7362, False),
    ("Amritsar", "Punjab", 31.6340, 74.8723, False),
    ("Srinagar", "Jammu and Kashmir", 34.0837, 74.7973, False),
    ("Kochi", "Kerala", 9.9312, 76.2673, True),
    ("Raipur", "Chhattisgarh", 21.2514, 81.6296, False),
    ("Varanasi", "Uttar Pradesh", 25.3176, 82.9739, False),
    ("Pune", "Maharashtra", 18.5204, 73.8567, False),
    ("Indore", "Madhya Pradesh", 22.7196, 75.8577, False),
    ("Ranchi", "Jharkhand", 23.3441, 85.3096, False),
    ("Kurnool", "Andhra Pradesh", 15.8281, 78.0373, False),
    ("Bikaner", "Rajasthan", 28.0229, 73.3119, False),
    ("Chandigarh", "Chandigarh", 30.7333, 76.7794, False),
    ("Dehradun", "Uttarakhand", 30.3165, 78.0322, False),
    ("Shimla", "Himachal Pradesh", 31.1048, 77.1734, False),
    ("Surat", "Gujarat", 21.1702, 72.8311, True),
    ("Rajkot", "Gujarat", 22.3039, 70.8022, False),
    ("Bhuj", "Gujarat", 23.2420, 69.6669, False),
    ("Coimbatore", "Tamil Nadu", 11.0168, 76.9558, False),
    ("Madurai", "Tamil Nadu", 9.9252, 78.1198, False),
    ("Vijayawada", "Andhra Pradesh", 16.5062, 80.6480, False),
    ("Thiruvananthapuram", "Kerala", 8.5241, 76.9366, True),
    ("Mangaluru", "Karnataka", 12.9141, 74.8560, True),
    ("Panaji", "Goa", 15.4909, 73.8278, True),
    ("Aurangabad", "Maharashtra", 19.8762, 75.3433, False),
    ("Gwalior", "Madhya Pradesh", 26.2183, 78.1828, False),
    ("Agra", "Uttar Pradesh", 27.1767, 78.0081, False),
    ("Kanpur", "Uttar Pradesh", 26.4499, 80.3319, False),
    ("Gorakhpur", "Uttar Pradesh", 26.7606, 83.3732, False),
    ("Gaya", "Bihar", 24.7955, 85.0002, False),
    ("Siliguri", "West Bengal", 26.7271, 88.3953, False),
    ("Imphal", "Manipur", 24.8170, 93.9368, False),
    ("Agartala", "Tripura", 23.8315, 91.2868, False),
    ("Puri", "Odisha", 19.8135, 85.8312, True),
    ("Warangal", "Telangana", 17.9689, 79.5941, False),
    ("Tiruchirappalli", "Tamil Nadu", 10.7905, 78.7047, False),
    ("Ballari", "Karnataka", 15.1394, 76.9214, False),
    ("Solapur", "Maharashtra", 17.6599, 75.9064, False),
    ("Akola", "Maharashtra", 20.7002, 77.0082, False),
    ("Kota", "Rajasthan", 25.2138, 75.8648, False),
    ("Ajmer", "Rajasthan", 26.4499, 74.6399, False),
    ("Jabalpur", "Madhya Pradesh", 23.1815, 79.9864, False),
    ("Bilaspur", "Chhattisgarh", 22.0797, 82.1409, False),
    ("Port Blair", "Andaman and Nicobar", 11.6234, 92.7265, True),
    ("Mysuru", "Karnataka", 12.2958, 76.6394, False),
    ("Shillong", "Meghalaya", 25.5788, 91.8933, False),
    ("Nellore", "Andhra Pradesh", 14.4426, 79.9865, True),
    ("Salem", "Tamil Nadu", 11.6643, 78.1460, False),
]


# This project only targets India. Rough bounding box of the country; it is a
# sanity check against typos (it can't exclude small border slivers of
# neighbouring countries, so keep locations to real Indian cities).
INDIA_LAT = (6.5, 37.1)
INDIA_LON = (68.0, 97.5)

for _name, _state, _lat, _lon, _coastal in LOCATIONS:
    assert INDIA_LAT[0] <= _lat <= INDIA_LAT[1] and INDIA_LON[0] <= _lon <= INDIA_LON[1], (
        f"{_name} ({_lat}, {_lon}) is outside India"
    )

def slug(name):
    return name.lower().replace(" ", "_")


class DailyLimit(Exception):
    pass


def fetch(name, lat, lon, start, end):
    """Fetch one location. Returns (DataFrame, elevation). Handles rate limits."""
    params = {
        "latitude": lat,
        "longitude": lon,
        "start_date": start,
        "end_date": end,
        "daily": ",".join(DAILY_VARS),
        "timezone": "Asia/Kolkata",
    }
    for attempt in range(8):
        try:
            r = requests.get(URL, params=params, timeout=180)
        except requests.exceptions.RequestException as e:
            print(f"  network error ({e}); retrying in 30s")
            time.sleep(30)
            continue

        if r.status_code == 429:
            reason = ""
            try:
                reason = r.json().get("reason", "")
            except ValueError:
                pass
            low = reason.lower()
            if "daily" in low:
                raise DailyLimit(reason)
            if "hourly" in low:
                print("  hourly limit reached; waiting 15 min...")
                time.sleep(15 * 60)
            else:
                print("  per-minute limit reached; waiting 65s...")
                time.sleep(65)
            continue

        r.raise_for_status()
        body = r.json()
        df = pd.DataFrame(body["daily"]).rename(columns={"time": "date"})
        return df, body.get("elevation")

    raise RuntimeError(f"gave up on {name} after repeated failures")


def collect(start, end, max_locations, locations=None):
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    meta_rows = []
    fetched = 0

    for name, state, lat, lon, coastal in (locations or LOCATIONS):
        path = RAW_DIR / f"{slug(name)}.csv"
        if path.exists():
            continue
        if max_locations is not None and fetched >= max_locations:
            break

        print(f"Fetching {name} ({state}) {start} -> {end} ...", flush=True)
        try:
            df, elevation = fetch(name, lat, lon, start, end)
        except DailyLimit as e:
            print(f"\nDaily API limit reached: {e}")
            print("Progress is saved. Re-run this script tomorrow to continue.")
            return False

        df.insert(0, "city", name)
        df["elevation_m"] = elevation
        # Write atomically so an interrupted run never leaves a half file.
        tmp = path.with_suffix(".tmp")
        df.to_csv(tmp, index=False)
        tmp.replace(path)
        fetched += 1
        print(f"  saved {len(df)} rows (elevation {elevation} m)", flush=True)
        time.sleep(25)  # stay under the 600/min limit (one call costs ~215)

    return True


def combine():
    """Merge cached per-location files + location metadata into one CSV."""
    meta = pd.DataFrame(
        LOCATIONS, columns=["city", "state", "latitude", "longitude", "coastal"]
    )
    frames = []
    for name, *_ in LOCATIONS:
        path = RAW_DIR / f"{slug(name)}.csv"
        if path.exists():
            frames.append(pd.read_csv(path))
    if not frames:
        print("No cached locations to combine yet.")
        return

    df = pd.concat(frames, ignore_index=True)
    df = df.merge(meta, on="city", how="left")
    front = ["city", "state", "latitude", "longitude", "elevation_m", "coastal", "date"]
    df = df[front + [c for c in df.columns if c not in front]]

    DATA_DIR.mkdir(exist_ok=True)
    meta.to_csv(LOCATIONS_CSV, index=False)
    df.to_csv(COMBINED, index=False)

    print(f"\nCombined {df['city'].nunique()} of {len(LOCATIONS)} locations "
          f"-> {COMBINED} ({len(df):,} rows)")
    print(f"Date range: {df['date'].min()} to {df['date'].max()}")
    missing = [n for n, *_ in LOCATIONS if not (RAW_DIR / f'{slug(n)}.csv').exists()]
    if missing:
        print(f"Still to fetch ({len(missing)}): {', '.join(missing[:8])}"
              f"{' ...' if len(missing) > 8 else ''}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", default="2000-01-01")
    ap.add_argument("--end", default=(date.today() - timedelta(days=7)).isoformat())
    ap.add_argument("--max-locations", type=int, default=None)
    ap.add_argument("--slice", default=None,
                    help="only fetch locations A:B of the list, e.g. 40:60 "
                         "(lets two computers split the work)")
    ap.add_argument("--combine", action="store_true", help="only rebuild combined CSV")
    args = ap.parse_args()

    if not args.combine:
        subset = None
        if args.slice:
            a, b = args.slice.split(":")
            subset = LOCATIONS[int(a or 0):int(b) if b else None]
        collect(args.start, args.end, args.max_locations, subset)
    combine()
    sys.exit(0)
