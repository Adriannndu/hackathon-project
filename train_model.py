import joblib
import numpy as np
from sklearn.ensemble import RandomForestRegressor
from sklearn.metrics import mean_absolute_error, mean_squared_error

from features import load_data, build_features_by_city

DATA_PATH = "india_historical_weather.csv"
MODEL_PATH = "city_models.joblib"

df = load_data(DATA_PATH)
city_data = build_features_by_city(df)

models = {}
feature_names = None

print("MODEL PERFORMANCE (one model per city)")
print("--------------------------------------")

for city, (featured, features) in city_data.items():
    feature_names = features

    # Remove incomplete rows
    dataset = featured.dropna(subset=features + ["target"])

    X = dataset[features]
    y = dataset["target"]

    # Chronological 80/20 split
    split = int(len(dataset) * 0.8)
    X_train, X_test = X.iloc[:split], X.iloc[split:]
    y_train, y_test = y.iloc[:split], y.iloc[split:]

    model = RandomForestRegressor(
        n_estimators=200,
        max_depth=10,
        random_state=42,
    )
    model.fit(X_train, y_train)

    # Evaluate on the newest 20% of days
    predictions = model.predict(X_test)
    mae = mean_absolute_error(y_test, predictions)
    rmse = np.sqrt(mean_squared_error(y_test, predictions))

    print(f"{city}: MAE {mae:.2f} °C | RMSE {rmse:.2f} °C")

    models[city] = model

joblib.dump({"models": models, "features": feature_names}, MODEL_PATH)
print(f"\nSaved {len(models)} models to {MODEL_PATH}")