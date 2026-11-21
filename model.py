
import pandas as pd
import numpy as np

from sklearn.ensemble import RandomForestRegressor
from sklearn.metrics import mean_absolute_error, mean_squared_error

# Load historical weather data
df = pd.read_csv("miami_historical_weather.csv")

# Prepare dates
df["time"] = pd.to_datetime(df["time"])
df = df.sort_values("time").reset_index(drop=True)

# Create features using previous temperatures
for column in ["temperature_2m_max", "temperature_2m_min"]:

    # Previous 7 days
    for lag in range(7):
        df[f"{column}_lag_{lag}"] = df[column].shift(lag)

    # Recent temperature averages
    df[f"{column}_rolling_3"] = df[column].rolling(3).mean()
    df[f"{column}_rolling_7"] = df[column].rolling(7).mean()

# Predict tomorrow's maximum temperature
df["target"] = df["temperature_2m_max"].shift(-1)

# Account for seasonal patterns
tomorrow = df["time"] + pd.Timedelta(days=1)

df["day_sin"] = np.sin(2 * np.pi * tomorrow.dt.dayofyear / 365.25)
df["day_cos"] = np.cos(2 * np.pi * tomorrow.dt.dayofyear / 365.25)

# Select features
features = [
    col for col in df.columns
    if "_lag_" in col or "_rolling_" in col
] + ["day_sin", "day_cos"]

# Remove incomplete rows
dataset = df.dropna(subset=features + ["target"])

X = dataset[features]
y = dataset["target"]

# Chronological 80/20 split
split = int(len(dataset) * 0.8)

X_train = X.iloc[:split]
X_test = X.iloc[split:]

y_train = y.iloc[:split]
y_test = y.iloc[split:]

# Create and train model
model = RandomForestRegressor(
    n_estimators=200,
    max_depth=10,
    random_state=42
)

model.fit(X_train, y_train)

# Make predictions
predictions = model.predict(X_test)

# Evaluate model
mae = mean_absolute_error(y_test, predictions)
rmse = np.sqrt(mean_squared_error(y_test, predictions))

print("MODEL PERFORMANCE")
print("-----------------")
print(f"Mean Absolute Error: {mae:.2f} °F")
print(f"Root Mean Squared Error: {rmse:.2f} °F")

# Predict the next day's maximum temperature
latest_features = df[features].iloc[[-1]]

tomorrow_prediction = model.predict(latest_features)[0]

# Determine the date being predicted
prediction_date = df["time"].iloc[-1] + pd.Timedelta(days=1)

print("\nTEMPERATURE PREDICTION")
print(f"Prediction date: {prediction_date:%Y-%m-%d}")
print(f"Predicted maximum temperature: {tomorrow_prediction:.2f} °F")