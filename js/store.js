/* ==========================================================================
   store.js - offline-first persistence
   --------------------------------------------------------------------------
   Everything the field user does is written to IndexedDB FIRST and only then
   attempted over the network. On Saipan a report filed in a flooded village
   with no signal must survive a dead battery and a browser restart, so the
   local database is the source of truth and the server is a sync target.

   Stores
     reports  - citizen observations (keyed by local uuid)
     cache    - last successful payload per feed key, with a timestamp
     meta     - small key/value settings (device id, model weights, prefs)
   ========================================================================== */

const DB_NAME = 'son-db';
const DB_VERSION = 1;

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in self)) {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (ev) => {
      const db = req.result;
      if (!db.objectStoreNames.contains('reports')) {
        const s = db.createObjectStore('reports', { keyPath: 'id' });
        s.createIndex('by_time', 'created_at');
        s.createIndex('by_sync', 'sync_state');
        s.createIndex('by_village', 'village_id');
        s.createIndex('by_category', 'category');
      }
      if (!db.objectStoreNames.contains('cache')) {
        db.createObjectStore('cache', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
      void ev;
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  return dbPromise;
}

/* Run `fn(store)` inside a transaction and resolve with the IDBRequest result
   once the transaction actually commits. */
function tx(storeName, mode, fn) {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    const store = t.objectStore(storeName);
    let request;
    try {
      request = fn(store);
    } catch (err) {
      reject(err);
      return;
    }
    t.oncomplete = () => resolve(request ? request.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

/* --------------------------------------------------------------------------
   localStorage fallback. Private windows and locked-down site data can make
   IndexedDB throw on open; the app must still work for the current session.
   -------------------------------------------------------------------------- */

const memFallback = { reports: new Map(), cache: new Map(), meta: new Map() };
let useFallback = false;

openDB().catch(() => {
  useFallback = true;
  console.warn('[SON] IndexedDB unavailable, running in-memory for this session');
});

/* ========================== Reports ====================================== */

export function uuid() {
  if (crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return 'r-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

export async function putReport(report) {
  if (useFallback) { memFallback.reports.set(report.id, report); return report; }
  try {
    await tx('reports', 'readwrite', (s) => s.put(report));
  } catch (err) {
    memFallback.reports.set(report.id, report);
    console.warn('[SON] report write fell back to memory', err);
  }
  return report;
}

export async function allReports() {
  if (useFallback) return [...memFallback.reports.values()].sort(byNewest);
  try {
    const rows = await tx('reports', 'readonly', (s) => s.getAll());
    const merged = [...(rows || []), ...memFallback.reports.values()];
    return dedupeById(merged).sort(byNewest);
  } catch (err) {
    console.warn('[SON] report read failed', err);
    return [...memFallback.reports.values()].sort(byNewest);
  }
}

function dedupeById(list) {
  const seen = new Map();
  for (const r of list) if (r && r.id) seen.set(r.id, r);
  return [...seen.values()];
}

function byNewest(a, b) {
  return new Date(b.created_at) - new Date(a.created_at);
}

export async function pendingReports() {
  const all = await allReports();
  return all.filter((r) => r.sync_state === 'pending');
}

export async function deleteReport(id) {
  if (useFallback) { memFallback.reports.delete(id); return; }
  try { await tx('reports', 'readwrite', (s) => s.delete(id)); }
  catch (err) { memFallback.reports.delete(id); void err; }
}

export async function markSynced(id) {
  const all = await allReports();
  const r = all.find((x) => x.id === id);
  if (!r) return;
  r.sync_state = 'synced';
  r.synced_at = new Date().toISOString();
  await putReport(r);
}

/* ========================== Feed cache =================================== */

export async function cacheSet(key, payload) {
  const row = { key, payload, cached_at: new Date().toISOString() };
  if (useFallback) { memFallback.cache.set(key, row); return row; }
  try { await tx('cache', 'readwrite', (s) => s.put(row)); }
  catch (err) { memFallback.cache.set(key, row); void err; }
  return row;
}

export async function cacheGet(key) {
  if (useFallback) return memFallback.cache.get(key) || null;
  try {
    const row = await tx('cache', 'readonly', (s) => s.get(key));
    return row || memFallback.cache.get(key) || null;
  } catch (err) {
    void err;
    return memFallback.cache.get(key) || null;
  }
}

/* ========================== Meta / settings =============================== */

export async function metaSet(key, value) {
  const row = { key, value };
  if (useFallback) { memFallback.meta.set(key, row); return; }
  try { await tx('meta', 'readwrite', (s) => s.put(row)); }
  catch (err) { memFallback.meta.set(key, row); void err; }
}

export async function metaGet(key, fallback = null) {
  if (useFallback) {
    const row = memFallback.meta.get(key);
    return row ? row.value : fallback;
  }
  try {
    const row = await tx('meta', 'readonly', (s) => s.get(key));
    if (row) return row.value;
    const mem = memFallback.meta.get(key);
    return mem ? mem.value : fallback;
  } catch (err) {
    void err;
    return fallback;
  }
}

/* Anonymous, device-local observer id. No account, no PII: a field app that
   demands a login before letting someone flag a live wire is a broken app. */
export async function observerId() {
  let id = await metaGet('observer_id');
  if (!id) {
    id = 'obs-' + Math.random().toString(36).slice(2, 8).toUpperCase();
    await metaSet('observer_id', id);
  }
  return id;
}

export async function storageEstimate() {
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const e = await navigator.storage.estimate();
      return { used: e.usage || 0, quota: e.quota || 0 };
    }
  } catch (err) { void err; }
  return null;
}

export async function clearAllLocal() {
  for (const name of ['reports', 'cache', 'meta']) {
    try { await tx(name, 'readwrite', (s) => s.clear()); } catch (err) { void err; }
  }
  memFallback.reports.clear();
  memFallback.cache.clear();
  memFallback.meta.clear();
}
