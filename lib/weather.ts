import { WeatherConditions } from '../types';

// Fixed-dome indoor venues — no weather fetch needed
const INDOOR_VENUE_IDS = new Set([
  12,  // Tropicana Field (TB)
  14,  // Rogers Centre (TOR)
]);

// Lat/lon for every MLB venue, keyed by MLB Stats API venue ID
const VENUE_COORDS: Record<number, { lat: number; lon: number }> = {
  2:    { lat: 39.2839,  lon: -76.6217  }, // Oriole Park at Camden Yards
  3:    { lat: 42.3467,  lon: -71.0972  }, // Fenway Park
  3313: { lat: 40.8296,  lon: -73.9262  }, // Yankee Stadium
  2524: { lat: 40.7571,  lon: -73.8458  }, // Citi Field
  14:   { lat: 43.6414,  lon: -79.3894  }, // Rogers Centre (indoor)
  4:    { lat: 41.8300,  lon: -87.6338  }, // Guaranteed Rate Field
  5:    { lat: 41.4962,  lon: -81.6852  }, // Progressive Field
  2394: { lat: 42.3390,  lon: -83.0485  }, // Comerica Park
  7:    { lat: 39.0517,  lon: -94.4803  }, // Kauffman Stadium
  3312: { lat: 44.9817,  lon: -93.2781  }, // Target Field
  1:    { lat: 33.8003,  lon: -117.8827 }, // Angel Stadium
  2392: { lat: 29.7573,  lon: -95.3555  }, // Minute Maid Park
  10:   { lat: 38.5716,  lon: -121.5066 }, // Sutter Health Park (Sacramento)
  680:  { lat: 47.5914,  lon: -122.3323 }, // T-Mobile Park
  5325: { lat: 32.7513,  lon: -97.0832  }, // Globe Life Field
  4705: { lat: 33.8907,  lon: -84.4677  }, // Truist Park
  4169: { lat: 25.7781,  lon: -80.2197  }, // loanDepot park
  2681: { lat: 39.9061,  lon: -75.1665  }, // Citizens Bank Park
  31:   { lat: 40.4469,  lon: -80.0057  }, // PNC Park
  3309: { lat: 38.8730,  lon: -77.0074  }, // Nationals Park
  17:   { lat: 41.9484,  lon: -87.6553  }, // Wrigley Field
  2602: { lat: 39.0979,  lon: -84.5077  }, // Great American Ball Park
  19:   { lat: 39.7560,  lon: -104.9942 }, // Coors Field
  32:   { lat: 43.0280,  lon: -87.9712  }, // American Family Field
  2889: { lat: 38.6226,  lon: -90.1928  }, // Busch Stadium
  15:   { lat: 33.4455,  lon: -112.0667 }, // Chase Field
  22:   { lat: 34.0739,  lon: -118.2400 }, // Dodger Stadium
  2395: { lat: 37.7786,  lon: -122.3893 }, // Oracle Park
  2680: { lat: 32.7076,  lon: -117.1570 }, // Petco Park
  12:   { lat: 27.7683,  lon: -82.6534  }, // Tropicana Field (indoor)
};

function windLabel(deg: number, mph: number): string {
  if (mph < 5) return 'Calm';
  const d = deg % 360;
  if (d >= 315 || d <= 45) return 'out to CF';
  if (d >= 135 && d <= 225) return 'in from CF';
  if (d > 45 && d < 135) return 'crosswind (E)';
  return 'crosswind (W)';
}

interface OpenMeteoResponse {
  hourly: {
    time: string[];
    temperature_2m: number[];
    relative_humidity_2m: number[];
    wind_speed_10m: number[];
    wind_direction_10m: number[];
  };
}

export async function fetchWeather(
  gamePk: number,
  venueId: number,
  gameDateTime: string,
): Promise<WeatherConditions | null> {
  const fetchedAt = new Date().toISOString();

  if (INDOOR_VENUE_IDS.has(venueId)) {
    return {
      gamePk, tempF: 72, windSpeedMph: 0, windDirectionDeg: 0,
      windDirectionLabel: 'Indoor', humidity: 50,
      isIndoor: true, dataSource: 'unavailable', fetchedAt,
    };
  }

  const coords = VENUE_COORDS[venueId];
  if (!coords || !gameDateTime) return null;

  try {
    const url =
      `https://api.open-meteo.com/v1/forecast` +
      `?latitude=${coords.lat}&longitude=${coords.lon}` +
      `&hourly=temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m` +
      `&temperature_unit=fahrenheit&wind_speed_unit=mph` +
      `&timezone=UTC&past_days=1&forecast_days=3`;

    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return null;

    const data = await res.json() as OpenMeteoResponse;
    const times = data.hourly.time;
    const gameMs = new Date(gameDateTime).getTime();

    let closestIdx = 0;
    let closestDiff = Infinity;
    for (let i = 0; i < times.length; i++) {
      const diff = Math.abs(new Date(times[i] + 'Z').getTime() - gameMs);
      if (diff < closestDiff) { closestDiff = diff; closestIdx = i; }
    }

    const tempF          = data.hourly.temperature_2m[closestIdx];
    const humidity       = data.hourly.relative_humidity_2m[closestIdx];
    const windSpeedMph   = data.hourly.wind_speed_10m[closestIdx];
    const windDirectionDeg = data.hourly.wind_direction_10m[closestIdx];

    return {
      gamePk,
      tempF,
      windSpeedMph,
      windDirectionDeg,
      windDirectionLabel: windLabel(windDirectionDeg, windSpeedMph),
      humidity,
      isIndoor: false,
      dataSource: 'forecast',
      fetchedAt,
    };
  } catch {
    return null;
  }
}
