# Heat-wave forecasting pipeline (1-3 days ahead)

Predicts whether a location will be in an IMD-defined heat wave 1, 2 and 3
days from now. "Is there a heat wave right now?" is answered by the IMD rule
itself (see `features.py`), not by the model.

## Run it on a stronger computer

1. Copy the project (or just these) to that machine:
   - `hw_pipeline/`, `get_expanded_data.py` (only for its location list)
   - the whole `data/` folder (`raw/`, `nasa/`, `climate_indices.csv`,
     `location_features.csv`). `data/external/` is not needed.
2. Set up Python:
   ```
   python3 -m venv .venv
   .venv/bin/pip install pandas scikit-learn joblib requests
   ```
3. Train + evaluate (from the project root):
   ```
   .venv/bin/python -m hw_pipeline.train --importance --final
   ```
   `--quick --max-cities 6` runs a 10-second smoke test instead.
4. Results: `artifacts/metrics.json` (all numbers) and
   `artifacts/hw_h1.joblib`, `hw_h2.joblib`, `hw_h3.joblib` (models).

Expect a few minutes to ~20 minutes depending on the machine (3 horizons x
(1 main fit + 5 leave-locations-out fits)).

### Neighbor-city features (v2)

`features.py` also adds 6 spatial features: the mean/max temperature anomaly
of cities within 500 km, the share of them already hot, and the mean/max
anomaly (and its 1-day change) of cities to the west/north-west within 800 km
("upwind"). To compare with an earlier run, write results elsewhere:
`python -m hw_pipeline.train --importance --final --out artifacts_v2`.
At prediction time these need recent temperatures of the surrounding
reference cities (one batched API call).

## What the output tells you

For each horizon, on the test years (2022 onward):
- `model` vs `baseline_persistence` ("heat wave today -> tomorrow") and
  `baseline_climatology`. **If the model doesn't clearly beat persistence,
  the model isn't adding value at that horizon** - read these first.
- `unseen_locations`: same metrics when whole cities were held out of
  training. This is the number that says whether it works for "any location".
- `event_recall`: share of real heat-wave events where at least one day was
  flagged in advance.
- Accuracy is deliberately not reported (about 99% for always saying "no").

## Known limitations

- **Surat and Srinagar are excluded** (`EXCLUDE_CITIES` in `config.py`). Their
  Open-Meteo temperatures have a break around 2017 relative to NASA POWER,
  which produced fake heat waves (Surat: 6 days in 2000-16 vs 312 from 2017;
  Srinagar: 15 vs 279). Across all cities the Open-Meteo minus NASA gap also
  drifts by about 1.7 C over 2000-2025, so labels are slightly affected
  everywhere; which source is drifting is unknown.

- Labels come from reanalysis (ERA5), which tends to understate extremes;
  they are not IMD station declarations.
- Normals use 2000-2017 only; a new, unseen location needs its own history
  to compute a normal (not built yet).
- NASA POWER features have a few days' lag. At prediction time the same
  variables must come from somewhere with fresh data (e.g. the Open-Meteo
  forecast API) - values from a different model may be slightly biased.
- Only temperature data from Open-Meteo drives the labels; NASA temperatures
  differ by 1-2 C and are used as an extra feature only.
