
import requests
import pandas as pd

# Miami, Florida
latitude = 25.7617
longitude = -80.1918

# Historical date range
start_date = "2015-01-01"
end_date = "2025-12-31"

url = "https://archive-api.open-meteo.com/v1/archive"

params = {
    "latitude": latitude,
    "longitude": longitude,
    "start_date": start_date,
    "end_date": end_date,

    # Daily weather variables
    "daily": [
        "temperature_2m_max",
        "temperature_2m_min",
        "precipitation_sum",
        "wind_speed_10m_max",
        "wind_direction_10m_dominant",
        "shortwave_radiation_sum"
    ],

    "temperature_unit": "fahrenheit",
    "wind_speed_unit": "mph",
    "timezone": "America/New_York"
}

# Retrieve data
response = requests.get(url, params=params)
response.raise_for_status()

data = response.json()

# Convert daily data into DataFrame
weather = pd.DataFrame(data["daily"])

# Save historical data
weather.to_csv("miami_historical_weather.csv", index=False)

print(weather.head())
print("Total observations:", len(weather))
