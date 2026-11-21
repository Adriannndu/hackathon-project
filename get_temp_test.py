
import requests
import pandas as pd

# Example: Miami, Florida
latitude = 25.7617
longitude = -80.1918

# Identify your application to the NWS
headers = {
    "User-Agent": "DisasterLens/1.0 (your-email@example.com)",
    "Accept": "application/geo+json"
}

# STEP 1: Find the forecast URL
points_url = f"https://api.weather.gov/points/{latitude},{longitude}"

points_response = requests.get(points_url, headers=headers)
points_response.raise_for_status()

points_data = points_response.json()

# STEP 2: Get the seven-day forecast URL
forecast_url = points_data["properties"]["forecast"]

# STEP 3: Retrieve forecast data
forecast_response = requests.get(forecast_url, headers=headers)
forecast_response.raise_for_status()

forecast_data = forecast_response.json()

# STEP 4: Extract the forecast periods
periods = forecast_data["properties"]["periods"]

# STEP 5: Convert to a DataFrame
weather = pd.DataFrame([
    {
        "period": p["name"],
        "start_time": p["startTime"],
        "temperature": p["temperature"],
        "temperature_unit": p["temperatureUnit"],
        "precipitation_probability": (
            p["probabilityOfPrecipitation"]["value"]
            if p["probabilityOfPrecipitation"] else None
        ),
        "wind_speed": p["windSpeed"],
        "humidity": (
        p.get("relativeHumidity", {}).get("value")
        if isinstance(p.get("relativeHumidity"), dict)
        else None
        ),
        "forecast": p["shortForecast"]
    }
    for p in periods
])

print(weather.to_string(index=False))

# Save the data
weather.to_csv("miami_7day_forecast.csv", index=False)