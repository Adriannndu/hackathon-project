"""Shared settings for the heat-wave pipeline."""
from pathlib import Path

DATA = Path("data")
ARTIFACTS = Path("artifacts")

# Chronological split (the model never sees later years when training/tuning)
TRAIN_END = "2017-12-31"   # train:  2000-2017
VAL_END = "2021-12-31"     # tune:   2018-2021   test: 2022 onward

HORIZONS = (1, 2, 3)       # predict heat wave 1, 2, 3 days ahead

# Region classification (heuristic; the IMD uses station categories)
COAST_KM = 50
HILLY_M = 1000

# IMD heat-wave criteria
THRESH = {"coastal": 37.0, "plains": 40.0, "hilly": 30.0}  # min daily max temp (C)
ANOM_HW = 4.5            # departure from normal for a heat wave (C)
ANOM_SEVERE = 6.5        # departure for a severe heat wave (C)
ABS_HW = 45.0            # absolute: heat wave regardless of departure
ABS_SEVERE = 47.0        # absolute: severe heat wave
MIN_RUN = 2              # consecutive days required

# Locations dropped from training/evaluation because the Open-Meteo series has
# a non-climatic break around 2017 (vs NASA POWER), which creates fake heat
# waves in later years: Surat 6 -> 312 heat-wave days (2000-16 vs 2017+),
# Srinagar 15 -> 279. See README "Known limitations".
EXCLUDE_CITIES = ("Surat", "Srinagar")
