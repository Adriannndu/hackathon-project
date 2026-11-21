# Delhi ward heat-risk ranking

Ranks Delhi's 290 wards by how at risk their residents are when a heat wave hits.
It is a **relative** ranking (a ward vs. other Delhi wards) built from open data. It is
not a forecast, not a probability of harm, and has **not** been validated against
heat-illness data. Open `outputs/report/index.html` in a browser for the map and
per-ward explanations (works offline, no libraries).

## How the score works (`area_model.py`)
Four groups, 25% each; every indicator is turned into a percentile rank among wards:

| Group | Indicators | Source |
|---|---|---|
| Heat hazard | surface temperature, share of clear days >45 °C, built-up share | Landsat 8/9, ESA WorldCover |
| Exposure | population density, number of people | WorldPop 2020 |
| Sensitivity | share 65+, share under 5, crowding, poor housing | WorldPop, Census 2011 |
| Adaptive capacity | est. hospital travel time, hospitals per 100k, tree cover, household assets, treated tap water | OpenStreetMap, WorldCover, Census 2011 |

Risk classes are quintiles of the final score. Weight-sensitivity and leave-one-group-out
tests are written to `outputs/risk_v2/summary.json`.

## Re-running it (from this folder, Python 3.10+)
```
pip install pandas numpy shapely pyproj rasterio requests pystac-client planetary-computer openpyxl scikit-learn
python collect_worldpop.py      # 13 small rasters (~250 MB) -> data/worldpop
python collect_osm.py           # hospitals, water points -> data/osm_*.json (public servers can be busy; it retries)
python collect_satellite.py     # land cover + Landsat per ward -> inputs/ward_landcover.csv, ward_landsat.csv
#   Census HL-14 files (9 districts) go in data/census/hl14_9388..9396.xlsx:
#   https://censusindia.gov.in/nada/index.php/catalog/9388 ... /9396
python build_census.py          # -> inputs/ward_census.csv
python build_inputs.py          # merges everything -> inputs/ward_data.csv
python area_model.py            # -> outputs/risk_v2/ (ward_risk.csv, ward_risk.geojson, summary.json)
python make_report.py           # -> outputs/report/index.html
```
`data/` (raw downloads) is git-ignored; `inputs/` and `outputs/` are small and committed.

## Checks against published lists
`reference_wards.csv` holds wards named by the Delhi Heat Action Plan 2025 (DDMA) and CSE's
"No time to cool" (2026), matched to this ward file. Named high-risk wards rank above CSE's
low-heat-stress wards in ~94% of pairs. This is encouraging, not proof: the hazard part is
not independent (those lists also come from Landsat temperature), and one design choice
(adding "number of people" to exposure) was made after looking at these lists.

## Known limitations
- Census figures are from 2011. The Census has no row for ~56 outer wards (rural / census-town parts):
  assets and treated-tap-water are **estimated** for them (validation rank correlation ~0.5-0.6) and flagged
  `census_data = "estimated"`; housing quality could not be estimated well enough and is left out for them.
- Temperature comes from mid-morning Landsat passes (Apr-Jun 2019-2025), not the afternoon peak.
- Population is a 1 km modelled grid. Hospital travel time is a straight-line estimate and OpenStreetMap includes small nursing homes.
- Groups are weighted equally, so each of the 2 exposure indicators weighs more than each of the 5 adaptive-capacity ones.
- Ward boundaries are the pre-2022 municipal wards (+ NDMC, cantonment).
- Tested and rejected: Meta's Relative Wealth Index (`build_wealth.py`) - it rates dense Old Delhi wards as wealthy.
  Licence is CC BY-NC 4.0 if you revisit it.

## Licences / credit
WorldPop (CC BY 4.0), ESA WorldCover (CC BY 4.0), Landsat (USGS, public domain), OpenStreetMap contributors (ODbL),
Census of India 2011 (Government of India). `disaster_lens (1).py` is a teammate's earlier cell-level vulnerability
script and is not used by this pipeline.
