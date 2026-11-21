import requests
import pandas as pd

# The 5 study cities (latitude, longitude)
CITIES = {
    "Ahmedabad": (23.0225, 72.5714),
    "New Delhi": (28.6139, 77.2090),
    "Hyderabad": (17.3850, 78.4867),
    "Chennai":   (13.0827, 80.2707),
    "Mumbai":    (19.0760, 72.8777),
}

URL = "https://api.open-meteo.com/v1/forecast"

all_rows = []

for city, (lat, lon) in CITIES.items():
    params = {
        "latitude": lat,
        "longitude": lon,
        "timezone": "Asia/Kolkata",
        "forecast_days": 7,
        "daily": ",".join([
            "temperature_2m_max",
            "temperature_2m_min",
            "apparent_temperature_max",
            "precipitation_probability_max",
            "wind_speed_10m_max",
            "weather_code",
        ]),
        "hourly": "relative_humidity_2m",
    }

    response = requests.get(URL, params=params, timeout=30)
    response.raise_for_status()
    data = response.json()

    # Daily data
    daily = pd.DataFrame(data["daily"])
    daily["date"] = pd.to_datetime(daily["time"]).dt.date

    # Hourly humidity -> daily mean and daily max
    hourly = pd.DataFrame(data["hourly"])
    hourly["date"] = pd.to_datetime(hourly["time"]).dt.date
    humidity = (
        hourly.groupby("date")["relative_humidity_2m"]
        .agg(humidity_mean="mean", humidity_max="max")
        .round(1)
        .reset_index()
    )

    # Join daily and humidity data
    city_df = daily.merge(humidity, on="date", how="left")
    city_df.insert(0, "city", city)
    all_rows.append(city_df)

weather = pd.concat(all_rows, ignore_index=True)

# Clean column names
weather = weather.rename(columns={
    "temperature_2m_max": "temp_max_c",
    "temperature_2m_min": "temp_min_c",
    "apparent_temperature_max": "feels_like_max_c",
    "precipitation_probability_max": "precip_prob_max_pct",
    "wind_speed_10m_max": "wind_max_kmh",
}).drop(columns=["time"])

print(weather.to_string(index=False))

# Save the data
weather.to_csv("india_5city_7day_forecast.csv", index=False)