/* ==========================================================================
   feeds.js - live environmental data for Saipan
   --------------------------------------------------------------------------
   Every endpoint here is open, keyless and CORS-enabled, which matters: an
   island app should not depend on a paid key that expires when a grant ends.

     Open-Meteo forecast  api.open-meteo.com          ICON/GFS blend
     Open-Meteo marine    marine-api.open-meteo.com   waves + sea surface temp
     Open-Meteo archive   archive-api.open-meteo.com  ERA5 reanalysis (training)
     NWS                  api.weather.gov             office GUM, zone MPZ003
     USGS                 earthquake.usgs.gov         Mariana seismicity
     NASA GIBS            gibs.earthdata.nasa.gov     daily satellite imagery

   Each fetch writes through to IndexedDB. If the network is gone the cached
   payload is returned with `stale: true` and the UI labels it rather than
   pretending the number is current.
   ========================================================================== */

import { cacheGet, cacheSet } from './store.js';

export const SAIPAN = {
  lat: 15.19,
  lon: 145.745,
  tz: 'Pacific/Saipan',
  nwsGrid: 'GUM/87,123',
  nwsZone: 'MPZ003',
  nwsArea: 'MP',
};

/* Monthly maximum mean sea surface temperature used as the bleaching
   baseline. NOAA Coral Reef Watch defines HotSpot = SST - MMM and accumulates
   degree heating weeks above it. 29.3 C is the working value for the southern
   Marianas; it is a constant here so it can be swapped for the official CRW
   pixel value for Saipan when that is wired in. */
export const CORAL_MMM = 29.3;

const TIMEOUT_MS = 12000;

async function fetchJSON(url, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeout || TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: opts.headers || {},
      cache: 'no-store',
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Network-first with a durable cache fallback.
 * @returns {Promise<{data:any, stale:boolean, at:string|null, error:string|null}>}
 */
export async function load(key, url, opts = {}) {
  try {
    const data = await fetchJSON(url, opts);
    await cacheSet(key, data);
    return { data, stale: false, at: new Date().toISOString(), error: null };
  } catch (err) {
    const row = await cacheGet(key);
    if (row) {
      return { data: row.payload, stale: true, at: row.cached_at, error: String(err.message || err) };
    }
    return { data: null, stale: true, at: null, error: String(err.message || err) };
  }
}

/* ========================== Weather ====================================== */

export function weatherNow() {
  const u = new URL('https://api.open-meteo.com/v1/forecast');
  u.search = new URLSearchParams({
    latitude: SAIPAN.lat,
    longitude: SAIPAN.lon,
    current: 'temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,rain,weather_code,surface_pressure,wind_speed_10m,wind_direction_10m,wind_gusts_10m',
    hourly: 'precipitation,precipitation_probability,wind_speed_10m,wind_gusts_10m',
    daily: 'precipitation_sum,precipitation_hours,wind_speed_10m_max,wind_gusts_10m_max,temperature_2m_max,temperature_2m_min',
    past_days: 7,
    forecast_days: 7,
    timezone: SAIPAN.tz,
  }).toString();
  return load('feed:weather', u.toString());
}

export function marineNow() {
  const u = new URL('https://marine-api.open-meteo.com/v1/marine');
  u.search = new URLSearchParams({
    latitude: SAIPAN.lat,
    longitude: SAIPAN.lon,
    current: 'wave_height,wave_direction,wave_period,sea_surface_temperature',
    daily: 'wave_height_max,wave_period_max,sea_surface_temperature_mean,sea_surface_temperature_max',
    past_days: 92,
    forecast_days: 7,
    timezone: SAIPAN.tz,
  }).toString();
  return load('feed:marine', u.toString());
}

export function nwsForecast() {
  return load(
    'feed:nws-forecast',
    `https://api.weather.gov/gridpoints/${SAIPAN.nwsGrid}/forecast`,
    { headers: { Accept: 'application/geo+json' } },
  );
}

export function nwsAlerts() {
  return load(
    'feed:nws-alerts',
    `https://api.weather.gov/alerts/active?area=${SAIPAN.nwsArea}`,
    { headers: { Accept: 'application/geo+json' } },
  );
}

export function quakes() {
  const since = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  const u = new URL('https://earthquake.usgs.gov/fdsnws/event/1/query');
  u.search = new URLSearchParams({
    format: 'geojson',
    starttime: since,
    latitude: SAIPAN.lat,
    longitude: SAIPAN.lon,
    maxradiuskm: 500,
    minmagnitude: 4,
    orderby: 'time',
    limit: 40,
  }).toString();
  return load('feed:quakes', u.toString());
}

/**
 * ERA5 reanalysis history, the training set for the flood model.
 * Daily values for Saipan back to 1940; we use the last ~11 years.
 */
export function archive(startDate, endDate) {
  const u = new URL('https://archive-api.open-meteo.com/v1/archive');
  u.search = new URLSearchParams({
    latitude: SAIPAN.lat,
    longitude: SAIPAN.lon,
    start_date: startDate,
    end_date: endDate,
    daily: 'precipitation_sum,precipitation_hours,wind_speed_10m_max,wind_gusts_10m_max,temperature_2m_max,surface_pressure_mean',
    timezone: SAIPAN.tz,
  }).toString();
  return load(`feed:archive:${startDate}:${endDate}`, u.toString(), { timeout: 30000 });
}

/* ========================== Satellite imagery ============================ */

/* GIBS true-colour composites publish on a ~3h lag, so "today" can 404.
   Default to two days back for a reliable first paint. */
export function gibsDefaultDate() {
  const d = new Date(Date.now() - 2 * 864e5);
  return d.toISOString().slice(0, 10);
}

export const GIBS_LAYERS = {
  truecolor: {
    id: 'VIIRS_NOAA20_CorrectedReflectance_TrueColor',
    label: 'VIIRS true colour',
    ext: 'jpg',
    matrix: 'GoogleMapsCompatible_Level9',
    maxZoom: 9,
    blurb: 'Daily 375 m visible composite. Cloud structure, typhoon bands, sediment plumes off the lagoon.',
  },
  sstanom: {
    id: 'GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies',
    label: 'Sea surface temp anomaly',
    ext: 'png',
    matrix: 'GoogleMapsCompatible_Level7',
    maxZoom: 7,
    blurb: 'MUR L4 anomaly against climatology. Warm anomalies are what drive coral bleaching here.',
  },
  sst: {
    id: 'MODIS_Aqua_L2_Sea_Surface_Temp_Day',
    label: 'Sea surface temperature',
    ext: 'png',
    matrix: 'GoogleMapsCompatible_Level7',
    maxZoom: 7,
    blurb: 'MODIS Aqua daytime SST swaths.',
  },
};

export function gibsUrl(layerKey, date) {
  const L = GIBS_LAYERS[layerKey];
  return `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${L.id}/default/${date}/${L.matrix}/{z}/{y}/{x}.${L.ext}`;
}

/* ========================== Derived science ============================== */

/**
 * Degree Heating Weeks, NOAA Coral Reef Watch method.
 * DHW = sum of daily (SST - MMM) over a rolling 12 weeks, divided by 7,
 * counting only days where SST exceeds the monthly maximum mean.
 */
export function degreeHeatingWeeks(dates, sst, mmm = CORAL_MMM) {
  if (!Array.isArray(sst) || !sst.length) return null;

  const today = new Date().toISOString().slice(0, 10);
  let end = sst.length - 1;
  for (let i = 0; i < dates.length; i++) if (dates[i] <= today) end = i;

  const start = Math.max(0, end - 83);
  const series = [];
  let dhw = 0;

  for (let i = start; i <= end; i++) {
    const v = sst[i];
    const hs = v == null ? 0 : Math.max(0, v - mmm);
    dhw += hs;
    series.push({ date: dates[i], sst: v, hotspot: +hs.toFixed(2) });
  }

  dhw = dhw / 7;

  return {
    dhw: +dhw.toFixed(2),
    mmm,
    days: series.length,
    daysAboveMMM: series.filter((d) => d.hotspot > 0).length,
    latestSST: sst[end],
    window: [dates[start], dates[end]],
    series,
    alert: bleachingAlert(dhw, sst[end], mmm),
  };
}

export function bleachingAlert(dhw, latestSST, mmm = CORAL_MMM) {
  const hot = latestSST != null && latestSST > mmm;
  if (dhw >= 8) return { level: 4, code: 'Alert Level 2', tone: 'crit' };
  if (dhw >= 4) return { level: 3, code: 'Alert Level 1', tone: 'alert' };
  if (dhw > 0 && dhw < 4 && hot) return { level: 2, code: 'Warning', tone: 'warn' };
  if (hot) return { level: 1, code: 'Watch', tone: 'watch' };
  return { level: 0, code: 'No Stress', tone: 'ok' };
}

/* ========================== Small helpers =============================== */

export function compass(deg) {
  if (deg == null) return '--';
  const pts = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return pts[Math.round(deg / 22.5) % 16];
}

export function mmToIn(mm) { return mm == null ? null : mm / 25.4; }
export function cToF(c) { return c == null ? null : c * 9 / 5 + 32; }
export function kmhToKt(k) { return k == null ? null : k * 0.539957; }
export function kmhToMph(k) { return k == null ? null : k * 0.621371; }

export function sum(arr) {
  return (arr || []).reduce((a, b) => a + (b == null ? 0 : b), 0);
}

/** Index of today (or the newest past day) inside an Open-Meteo daily array. */
export function todayIndex(dates) {
  const today = new Date().toISOString().slice(0, 10);
  let idx = 0;
  for (let i = 0; i < dates.length; i++) if (dates[i] <= today) idx = i;
  return idx;
}
