"""
Collect Delhi healthcare, water and informal-settlement features from OpenStreetMap.

Uses the public Overpass API (free, no key) with retries and several mirror
servers, because the public servers are often at capacity. Results are saved
to data/osm_<name>.json; existing files are skipped, so it is safe to re-run.

Only features inside Delhi's boundary are kept later (see build_inputs).

Usage: python collect_osm.py
"""
import json
import sys
import time
from pathlib import Path

import requests

BBOX = "28.40,76.83,28.89,77.35"   # south,west,north,east (just covers Delhi)
MIRRORS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]
HEADERS = {"User-Agent": "delhi-heat-risk-research-script"}
OUT = Path("data")

QUERIES = {
    # hospitals, clinics and other health facilities (nodes, ways and relations)
    "health": f'(nwr["amenity"~"^(hospital|clinic|doctors)$"]({BBOX});'
              f'nwr["healthcare"~"^(hospital|clinic|centre|doctor)$"]({BBOX}););',
    # public drinking-water points
    "water": f'(nwr["amenity"="drinking_water"]({BBOX});nwr["man_made"="water_tap"]({BBOX}););',
    # informal settlements / slums as tagged by mappers (likely incomplete)
    "slum": f'(nwr["landuse"="residential"]["residential"="slum"]({BBOX});'
            f'nwr["place"~"^(slum|squatter_settlement)$"]({BBOX});'
            f'nwr["informal"="yes"]["landuse"="residential"]({BBOX}););',
}


def run(name, body):
    path = OUT / f"osm_{name}.json"
    if path.exists():
        print(f"skip {name} (already downloaded)", flush=True)
        return True
    query = f"[out:json][timeout:120];{body}out center tags;"
    delay = 10
    for attempt in range(8):
        url = MIRRORS[attempt % len(MIRRORS)]
        try:
            r = requests.post(url, data={"data": query}, headers=HEADERS, timeout=180)
            if r.status_code == 200 and r.text.lstrip().startswith("{"):
                data = r.json()
                tmp = path.with_suffix(".tmp")
                tmp.write_text(json.dumps(data))
                tmp.replace(path)
                print(f"saved {name}: {len(data.get('elements', []))} features (via {url.split('/')[2]})", flush=True)
                return True
            print(f"{name}: HTTP {r.status_code} from {url.split('/')[2]}; waiting {delay}s", flush=True)
        except requests.exceptions.RequestException as e:
            print(f"{name}: {type(e).__name__} from {url.split('/')[2]}; waiting {delay}s", flush=True)
        time.sleep(delay)
        delay = min(delay * 2, 120)
    print(f"FAILED {name} after 8 attempts", flush=True)
    return False


if __name__ == "__main__":
    OUT.mkdir(exist_ok=True)
    ok = all([run(n, q) for n, q in QUERIES.items()])
    sys.exit(0 if ok else 1)
