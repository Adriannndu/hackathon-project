# HeatLens
HeatLens is a heat-assessment app which allows people to see regions that are most vulnerable to extreme heat. 


Built for EvoHacks 2
# Problem
Many regions around the world are at high risk of death or injury from heat waves. Delhi, the capital of India, is one of them. Places with less access to drinking water, hospitals, greenery, and good infrastructure are more vulnerable during a heat wave.

Currently, there exist systems to predict extreme heat, yet no system works to predict which regions are impacted the most by this heat.
## Why Delhi?
India is one of the regions most at risk from extreme heat. Delhi, its capital, shows this risk well. It is a large, dense city where neighborhoods differ a lot in water access, greenery, crowding, and infrastructure.

Delhi is the proof of concept for HeatLens. We built and tested the full method in one city. In the future, the same method can be applied to other cities and countries.
# Solution
HeatLens is an application that identifies which regions are most vulnerable during a heat wave. It allows users to view different parts of Delhi. For each part, HeatLens determines how vulnerable that region is during a heat wave, and shows the reasons. 
### Key Features: 
* Risk Factor Detection: Our application uses a specialized ranking algorithm to determine which regions are most vulnerable 
* Live Heat Map: Our application displays a live heat map which shows users which regions are currently at risk. 
* User Location: Determines where the user is, or the user can choose a regions to determine the current risk. 
##Preview
ADD SCREENSHOT
### Who can use it 
Planners and officials can use HeatLens to decide where to send water, cooling, and medical aid first. Community groups can use it to find the areas that need the most support. 

## How it works
We took data about population density, water access, healthcare access, and shaded regions along with other parameters and made a program that ranks how vulnerable each of Delhi’s 250 wards is during a heat wave. HeatLens then combines that ranking with a live weather forecast that can tell the user if a heatwave is coming, and how much risk it poses based on where the user lives.

1. 	Collecting the data
For every ward, we collected 14 indicators from free public datasets, categorized into 4 groups.
These are heat hazard, exposure, sensitivity, and ability to cope. Heat hazard measures how hot a ward gets, its indicators are ground surface temperature, number of clear days with surface temperature above 45C, and share of the ward that is paved or roofed. The data for this group was retrieved from the Landsat 8 and 9 satellites (2019 - 2025) and ESA WorldCover. Next is exposure, which measures how many people the heat reaches. Indicators for this group are population density and number of residents, and data was collected from WordPop 2020. Sensitivity measures how many people are especially vulnerable, and it includes the share of people under the age of 5, share of people above the age of 65, crowding, and temporary/one-room housing. The sensitivity data was collected from WorldPop 2020 and the 2011 Census. Lastly is the ability to cope, which measures how well people can protect themselves. Key indicators are travel time to the nearest hospital, hospitals per 100,000 people, tree cover, household assets, and number of homes with treated tap water. Data was collected from OpenStreetMap, ESA WorldCover, and the 2011 Census.

Satellite and population data come as grids, so we averaged or added them up inside each ward’s boundary. The Census has no data for 56 outer wards, so for those we estimated household assets and tap water from each ward’s other data and its neighbours. These wards are marked with a dashed outline on the map.

2.	Scoring each ward.
Each of the 14 indicators is turned into a rank among the wards, with 0 meaning least at risk and 100 meaning most at risk. The indicators in each group are averaged into a group score. The four groups each make up an equal amount toward the final 0-100 vulnerability score for each ward. These scores then place all the wards into 5 equal sized classes, low, moderate, high, very high, and extreme.

3.	Checking the rankings
The final rankings were compared with the wards named in the Delhi Heat Action Plan 2025 and a Centre for Science and Environment (CSE) study. Wards that those reports call “high-risk” rank above the wards that the CSE call low heat stress in 94% of pairs.

4.	Adding the weather forecast
HeatLens gets a 7-day forecast from Open-Meteo for the user’s location or a ward that they pick. Each day is checked against the India Meteorological Department (IMD) heat-wave rule, which states that it must be at least 40C and at least 4.5C above Delhi’s normal for that date, or at least 45C for 2 or more dates in a row. The hottest forecast day is combined with the ward’s vulnerability class to give the risk level. The map colors every ward by this risk level, and a demo mode replays the real May 2024 Delhi heat wave.
 
## What’s Next?
HeatLens is currently a proof of concept. The next step is to apply the same method to other at-risk cities and countries. Additionally, we plan to develop it into a full scale application, not just a website. 
