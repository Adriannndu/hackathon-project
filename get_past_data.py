
import requests
import pandas as pd
from datetime import date, timedelta
import time

# -----------------------------------
# 1. DEFINE INDIAN CITIES
# -----------------------------------

cities = {
    "Ahmedabad": (23.0225, 72.5714),
    "New Delhi": (28.6139, 77.2090),
    "Hyderabad": (17.3850, 78.4867),
    "Chennai": (13.0827, 80.2707),
    "Mumbai": (19.0760, 72.8777)
}

# -----------------------------------
# 2. DATE RANGE
# -----------------------------------

start_date = "2015-01-01"

# Leave a few days for historical data processing
end_date = (date.today() - timedelta(days=7)).isoformat()

url = "https://archive-api.open-meteo.com/v1/archive"

# -----------------------------------
# 3. COLLECT DATA FOR EACH CITY
# -----------------------------------


# -----------------------------------
# 3. COLLECT DATA FOR EACH CITY
# -----------------------------------

all_weather = []

for city, (latitude, longitude) in cities.items():

    print(f"\nCollecting data for {city}...")

    params = {
        "latitude": latitude,
        "longitude": longitude,
        "start_date": start_date,
        "end_date": end_date,

        "daily": [
            "temperature_2m_max",
            "temperature_2m_min",
            "precipitation_sum",
            "wind_speed_10m_max",
            "wind_direction_10m_dominant",
            "shortwave_radiation_sum"
        ],

        "temperature_unit": "celsius",
        "wind_speed_unit": "kmh",
        "timezone": "Asia/Kolkata"
    }

    # Retry up to 5 times
    for attempt in range(5):

        try:
            response = requests.get(
                url,
                params=params,
                timeout=60
            )

            if response.status_code == 429:
                wait_time = 10 * (attempt + 1)

                print(
                    f"Rate limit reached. "
                    f"Waiting {wait_time} seconds..."
                )

                time.sleep(wait_time)
                continue

            response.raise_for_status()

            data = response.json()

            weather = pd.DataFrame(data["daily"])
            weather["city"] = city

            all_weather.append(weather)

            print(f"{city} successfully collected!")
            break

        except requests.exceptions.RequestException as e:

            print(f"Request failed: {e}")

            if attempt < 4:
                time.sleep(10 * (attempt + 1))

    else:
        print(f"FAILED to collect {city} after 5 attempts.")


# -----------------------------------
# 4. COMBINE ALL CITIES
# -----------------------------------

india_weather = pd.concat(
    all_weather,
    ignore_index=True
)

# Organize columns
columns = ["city"] + [
    col for col in india_weather.columns if col != "city"
]

india_weather = india_weather[columns]

# -----------------------------------
# 5. SAVE DATA
# -----------------------------------

india_weather.to_csv(
    "india_historical_weather.csv",
    index=False
)

print("\nDATA COLLECTION COMPLETE")
print(india_weather.head())

print("\nObservations per city:")
print(india_weather["city"].value_counts())

print("\nDate range:")
print(india_weather["time"].min(), "to",
      india_weather["time"].max())
