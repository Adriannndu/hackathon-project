import joblib
import pandas as pd

from heatwave_model.features import load_data, build_features_by_city

DATA_PATH = "india_historical_weather.csv"
MODEL_PATH = "city_models.joblib"

saved = joblib.load(MODEL_PATH)
models = saved["models"]

df = load_data(DATA_PATH)
city_data = build_features_by_city(df)

print("TEMPERATURE PREDICTION")
print("----------------------")

for city, (featured, features) in city_data.items():
    if city not in models:
        print(f"{city}: no trained model, skipped")
        continue

    latest_features = featured[features].iloc[[-1]]
    prediction = models[city].predict(latest_features)[0]
    prediction_date = featured["time"].iloc[-1] + pd.Timedelta(days=1)

    print(f"{city} ({prediction_date:%Y-%m-%d}): {prediction:.1f} °C")