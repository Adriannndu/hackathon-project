import numpy as np
import pandas as pd

CITY_COLUMN = "city"
BASE_COLUMNS = ["temperature_2m_max", "temperature_2m_min"]


def load_data(path):
    df = pd.read_csv(path)
    df["time"] = pd.to_datetime(df["time"])
    return df.sort_values([CITY_COLUMN, "time"]).reset_index(drop=True)


def add_features(city_df):
    """Build features for ONE city."""
    df = city_df.copy()

    for column in BASE_COLUMNS:
        # Today and the previous 6 days
        for lag in range(7):
            df[f"{column}_lag_{lag}"] = df[column].shift(lag)

        # Recent temperature averages
        df[f"{column}_rolling_3"] = df[column].rolling(3).mean()
        df[f"{column}_rolling_7"] = df[column].rolling(7).mean()

    # Target: tomorrow's maximum temperature
    df["target"] = df["temperature_2m_max"].shift(-1)

    # Seasonal pattern, based on the day being predicted
    tomorrow = df["time"] + pd.Timedelta(days=1)
    df["day_sin"] = np.sin(2 * np.pi * tomorrow.dt.dayofyear / 365.25)
    df["day_cos"] = np.cos(2 * np.pi * tomorrow.dt.dayofyear / 365.25)

    return df


def get_feature_names(df):
    return [
        col for col in df.columns
        if "_lag_" in col or "_rolling_" in col
    ] + ["day_sin", "day_cos"]


def build_features_by_city(df):
    """Return a dict: city name -> (featured data, feature names)."""
    result = {}
    for city, group in df.groupby(CITY_COLUMN):
        group = group.sort_values("time").reset_index(drop=True)
        featured = add_features(group)
        result[city] = (featured, get_feature_names(featured))
    return result