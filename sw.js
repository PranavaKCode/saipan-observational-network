/* ==========================================================================
   sw.js - offline shell and tile cache
   --------------------------------------------------------------------------
   Three caching strategies, chosen per resource by what failure would cost:

     App shell      cache-first. The HTML, CSS, JS and island data must open
                    with no network at all, so they are precached on install.

     Map tiles      cache-first with a capped LRU-ish cache. Tiles for the
                    island are small and never change, so once a responder has
                    panned over Saipan the map keeps working in the field.

     Live feeds     network-first, falling back to the last good response.
                    A stale reading is useful; a blank dashboard is not. The
                    app labels anything served from cache as stale, so this
                    never silently passes old numbers off as current.
   ========================================================================== */

const VERSION = 'son-v13';
const SHELL_CACHE = VERSION + '-shell';
const TILE_CACHE = VERSION + '-tiles';
const FEED_CACHE = VERSION + '-feeds';

const MAX_TILES = 1200;

const SHELL = [
  './',
  'index.html',
  'css/son.css?v=8',
  'js/main.js',
  'js/store.js',
  'js/feeds.js',
  'js/model.js',
  'js/map.js',
  'js/ui.js',
  'js/grid.js',
  'js/reports.js',
  'js/config.js',
  'js/export.js',
  'js/carto-key.js',
  'data/island.json',
  'data/science.json',
  'app.webmanifest',
  'icons/icon.svg',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js',
];

const TILE_HOSTS = [
  'gibs.earthdata.nasa.gov',
  'services.arcgisonline.com',
  'basemaps.cartocdn.com',
];

const FEED_HOSTS = [
  'api.open-meteo.com',
  'marine-api.open-meteo.com',
  'archive-api.open-meteo.com',
  'api.weather.gov',
  'earthquake.usgs.gov',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      /* Individually, so one unavailable CDN file cannot fail the whole
         install and leave the app with no offline shell at all. */
      .then((cache) => Promise.all(
        SHELL.map((url) => cache.add(new Request(url, { cache: 'reload' })).catch(() => null)),
      ))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch { return; }
  if (!/^https?:$/.test(url.protocol)) return;

  if (TILE_HOSTS.some((h) => url.hostname.endsWith(h))) {
    event.respondWith(tileStrategy(req));
    return;
  }

  if (FEED_HOSTS.some((h) => url.hostname.endsWith(h))) {
    event.respondWith(feedStrategy(req));
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith(shellStrategy(req));
  }
});

/* ---------------------------------------------------------------------- */

async function shellStrategy(req) {
  const cache = await caches.open(SHELL_CACHE);
  const hit = await cache.match(req, { ignoreSearch: true });
  if (hit) {
    /* Refresh in the background so the next launch is current. */
    fetchAndPut(cache, req);
    return hit;
  }

  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    void err;
    const fallback = await cache.match('index.html');
    if (fallback && req.mode === 'navigate') return fallback;
    return new Response('Offline and not cached', { status: 503, statusText: 'Offline' });
  }
}

async function tileStrategy(req) {
  const cache = await caches.open(TILE_CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;

  try {
    const res = await fetch(req);
    /* Leaflet loads tiles as no-cors image requests, so the response is opaque:
       status 0 and `ok` false even on success. Checking only `res.ok` would
       silently cache nothing and the map would be blank offline. Opaque entries
       cost padded quota, which is the accepted trade for a map that still works
       in the field. */
    if (res.ok || res.type === 'opaque') {
      cache.put(req, res.clone()).then(() => trimCache(TILE_CACHE, MAX_TILES)).catch(() => {});
    }
    return res;
  } catch (err) {
    void err;
    /* A transparent pixel keeps the map readable instead of showing a grid of
       broken-image icons where tiles are missing. */
    return new Response(
      Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'), (c) => c.charCodeAt(0)),
      { headers: { 'Content-Type': 'image/gif' } },
    );
  }
}

async function feedStrategy(req) {
  const cache = await caches.open(FEED_CACHE);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    void err;
    const hit = await cache.match(req);
    if (hit) return hit;
    return new Response(JSON.stringify({ error: 'offline', cached: false }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

function fetchAndPut(cache, req) {
  fetch(req).then((res) => { if (res.ok) cache.put(req, res); }).catch(() => {});
}

async function trimCache(name, max) {
  const cache = await caches.open(name);
  const keys = await cache.keys();
  if (keys.length <= max) return;
  /* Oldest-inserted first; Cache Storage preserves insertion order. */
  await Promise.all(keys.slice(0, keys.length - max).map((k) => cache.delete(k)));
}
