/* ==========================================================================
   reports.js - the citizen observation pipeline
   --------------------------------------------------------------------------
   Rules this flow is built around, learned from how field reporting actually
   fails:

     1. Never block on the network. The report is written to IndexedDB before
        anything else happens. A resident standing in a flooded street on a
        dead cell site must still be able to file.
     2. Never block on an account. Observers get a device-local anonymous id.
     3. Photographs are downscaled on device. A 12 MP phone photo would blow
        past the storage quota after a dozen reports, and the useful signal
        (how deep, how bleached, which species) survives 1024 px easily.
     4. Location can come from GPS or from tapping the map, because GPS inside
        a concrete building is often worse than a person's own knowledge.
     5. Nothing is invented. If there is no sync endpoint configured, the UI
        says the report is stored on the device - it does not claim to have
        sent it anywhere.
   ========================================================================== */

import { putReport, uuid, observerId, pendingReports, markSynced, metaGet, metaSet } from './store.js';
import { nearestVillage } from './map.js';
import { icon, escapeHtml, toast, openSheet, emptyState } from './ui.js';

const MAX_PHOTO_PX = 1024;
const PHOTO_QUALITY = 0.68;

/* ==========================================================================
   Photo handling
   ========================================================================== */

export function compressImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read that file'));

    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Could not decode that image'));
      img.onload = () => {
        const scale = Math.min(1, MAX_PHOTO_PX / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);

        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);

        try {
          resolve(canvas.toDataURL('image/jpeg', PHOTO_QUALITY));
        } catch (err) {
          reject(err);
        }
      };
      img.src = reader.result;
    };

    reader.readAsDataURL(file);
  });
}

/* ==========================================================================
   Geolocation
   ========================================================================== */

export function getPosition({ timeout = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('This device has no geolocation'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({
        lat: +pos.coords.latitude.toFixed(6),
        lon: +pos.coords.longitude.toFixed(6),
        accuracy: pos.coords.accuracy,
      }),
      (err) => reject(new Error(err.message || 'Location unavailable')),
      { enableHighAccuracy: true, timeout, maximumAge: 30000 },
    );
  });
}

/* ==========================================================================
   Composer
   ========================================================================== */

/**
 * @param {object} opts
 *   categories  report_categories from science.json
 *   villages    island.villages
 *   invasives   invasive_watchlist
 *   prefill     { category, lat, lon }
 *   onSaved     callback(report)
 */
export function openComposer(opts) {
  const { categories, villages, invasives = [], prefill = {}, onSaved } = opts;

  const state = {
    category: prefill.category || null,
    severity: 2,
    lat: prefill.lat ?? null,
    lon: prefill.lon ?? null,
    accuracy: null,
    village: null,
    photo: null,
    note: '',
    detail: {},
    status: 'open',
  };

  if (state.lat != null) {
    const near = nearestVillage(state.lat, state.lon, villages);
    if (near) state.village = near.village;
  }

  const body = `
    <div class="field">
      <label>What are you reporting?</label>
      <div class="cat-grid" id="cmp-cats">
        ${categories.map((c) => `
          <button type="button" class="cat-tile" data-cat="${c.id}"
            aria-pressed="${state.category === c.id}">
            <span class="cat-ink" style="color:${c.color}">${icon(c.icon, 20)}</span>
            <span>${escapeHtml(c.label)}</span>
          </button>`).join('')}
      </div>
    </div>

    <div id="cmp-prompt" class="field-hint" style="margin:-4px 0 12px"></div>

    <div class="field">
      <label>How bad is it?</label>
      <div class="sev-scale" id="cmp-sev">
        <button type="button" data-sev="1" aria-pressed="false">Minor</button>
        <button type="button" data-sev="2" aria-pressed="true">Moderate</button>
        <button type="button" data-sev="3" aria-pressed="false">Serious</button>
        <button type="button" data-sev="4" aria-pressed="false">Severe</button>
      </div>
    </div>

    <div id="cmp-extra"></div>

    <div class="field">
      <label>Where?</label>
      <div class="geo-strip" id="cmp-geo">
        ${icon('gps', 15)}<span id="cmp-geo-text">No location yet</span>
        <span class="spacer"></span>
        <button type="button" class="btn btn-sm" id="cmp-locate">Use GPS</button>
      </div>
      <div class="field-hint">No GPS signal? Close this and tap the spot on the map, then report from there.</div>
    </div>

    <div class="field">
      <label>Village</label>
      <select id="cmp-village">
        <option value="">Choose a village</option>
        ${villages.map((v) => `<option value="${v.id}">${escapeHtml(v.name)}</option>`).join('')}
      </select>
    </div>

    <div class="field">
      <label>Photo (optional)</label>
      <div id="cmp-photo-host">
        <label class="photo-drop" for="cmp-photo" style="display:block;cursor:pointer">
          ${icon('camera', 24)}
          <div>Tap to add a photo</div>
          <div style="font-size:.7rem;opacity:.7;margin-top:3px">Resized on your device, never uploaded automatically</div>
        </label>
      </div>
      <input type="file" id="cmp-photo" accept="image/*" capture="environment" class="sr-only">
    </div>

    <div class="field">
      <label>Notes (optional)</label>
      <textarea id="cmp-note" placeholder="Anything a responder would want to know: how deep, how long, what you can see."></textarea>
    </div>

    <div class="source-note">
      Stored on this device first. ${icon('shield', 11)} No account, no personal details, and your
      observer id is a random code generated locally.
    </div>`;

  const footer = `
    <button class="btn btn-ghost" data-close>Cancel</button>
    <button class="btn btn-primary" id="cmp-save">File report</button>`;

  openSheet({
    title: 'New observation',
    body,
    footer,
    onMount(sheet, close) {
      const promptEl = sheet.querySelector('#cmp-prompt');
      const extraEl = sheet.querySelector('#cmp-extra');
      const geoText = sheet.querySelector('#cmp-geo-text');
      const geoStrip = sheet.querySelector('#cmp-geo');
      const villageSel = sheet.querySelector('#cmp-village');

      function paintCategory() {
        sheet.querySelectorAll('[data-cat]').forEach((b) => {
          b.setAttribute('aria-pressed', String(b.dataset.cat === state.category));
        });
        const cat = categories.find((c) => c.id === state.category);
        promptEl.textContent = cat ? cat.prompt : '';
        extraEl.innerHTML = cat ? extraFields(cat, invasives) : '';
        wireExtras();
      }

      function wireExtras() {
        extraEl.querySelectorAll('[data-detail]').forEach((input) => {
          input.addEventListener('input', () => {
            const key = input.dataset.detail;
            state.detail[key] = input.type === 'checkbox' ? input.checked : input.value;
          });
        });
      }

      function paintGeo() {
        if (state.lat == null) {
          geoText.textContent = 'No location yet';
          geoStrip.classList.remove('ok');
          return;
        }
        geoText.textContent = `${state.lat.toFixed(5)}, ${state.lon.toFixed(5)}`
          + (state.accuracy ? ` (+/-${Math.round(state.accuracy)} m)` : '');
        geoStrip.classList.add('ok');

        const near = nearestVillage(state.lat, state.lon, villages);
        if (near) {
          state.village = near.village;
          villageSel.value = near.village.id;
        }
      }

      sheet.querySelectorAll('[data-cat]').forEach((b) => {
        b.addEventListener('click', () => { state.category = b.dataset.cat; paintCategory(); });
      });

      sheet.querySelectorAll('[data-sev]').forEach((b) => {
        b.addEventListener('click', () => {
          state.severity = Number(b.dataset.sev);
          sheet.querySelectorAll('[data-sev]').forEach((x) => {
            x.setAttribute('aria-pressed', String(x === b));
          });
        });
      });

      sheet.querySelector('#cmp-locate').addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        btn.textContent = 'Locating...';
        btn.disabled = true;
        try {
          const pos = await getPosition();
          Object.assign(state, pos);
          paintGeo();
          toast('Location captured', 'ok');
        } catch (err) {
          toast(err.message, 'warn');
        } finally {
          btn.textContent = 'Use GPS';
          btn.disabled = false;
        }
      });

      villageSel.addEventListener('change', () => {
        state.village = villages.find((v) => v.id === villageSel.value) || null;
        /* No GPS: fall back to the village centroid so the report still maps. */
        if (state.lat == null && state.village) {
          state.lat = state.village.lat;
          state.lon = state.village.lon;
          state.accuracy = null;
          geoText.textContent = `${state.village.name} centre (approximate)`;
          geoStrip.classList.add('ok');
        }
      });

      sheet.querySelector('#cmp-photo').addEventListener('change', async (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        try {
          state.photo = await compressImage(file);
          sheet.querySelector('#cmp-photo-host').innerHTML = `
            <div class="photo-preview">
              <img src="${state.photo}" alt="Attached photo">
              <button type="button" id="cmp-photo-clear" aria-label="Remove photo">${icon('x', 14)}</button>
            </div>`;
          sheet.querySelector('#cmp-photo-clear').addEventListener('click', () => {
            state.photo = null;
            close();
            openComposer({ ...opts, prefill: { category: state.category, lat: state.lat, lon: state.lon } });
          });
        } catch (err) {
          toast(err.message || 'Could not attach that photo', 'err');
        }
      });

      sheet.querySelector('#cmp-note').addEventListener('input', (e) => {
        state.note = e.target.value.slice(0, 1200);
      });

      sheet.querySelector('#cmp-save').addEventListener('click', async () => {
        if (!state.category) { toast('Pick what you are reporting first', 'warn'); return; }
        if (!state.village && state.lat == null) { toast('Add a location or pick a village', 'warn'); return; }

        const report = await saveReport(state);
        close();
        toast('Report filed and stored on this device', 'ok');
        if (onSaved) onSaved(report);
      });

      paintCategory();
      paintGeo();
      if (state.village) villageSel.value = state.village.id;
    },
  });
}

/* Category-specific follow-up questions. Kept short: a long form in the rain
   is a form nobody finishes. */
function extraFields(cat, invasives) {
  const f = cat.fields || [];
  const bits = [];

  if (f.includes('depth_cm')) {
    bits.push(numField('depth_cm', 'Water depth (cm)', 'Ankle 10, knee 45, waist 95'));
  }
  if (f.includes('road_passable') || f.includes('passable')) {
    bits.push(selField('passable', 'Can vehicles pass?', ['Yes', 'Only high clearance', 'No']));
  }
  if (f.includes('started_at')) {
    bits.push(selField('started', 'When did it start?', ['Just now', 'Within the hour', '1-3 hours ago', 'More than 3 hours']));
  }
  if (f.includes('partial')) {
    bits.push(selField('partial', 'How widespread?', ['My whole street', 'Only my building', 'Not sure']));
  }
  if (f.includes('pressure')) {
    bits.push(selField('pressure', 'Water state', ['No water at all', 'Low pressure', 'Back on now']));
  }
  if (f.includes('sparking')) {
    bits.push(selField('sparking', 'Is it sparking or arcing?', ['No', 'Yes', 'Cannot tell from a safe distance']));
  }
  if (f.includes('blocking')) {
    bits.push(selField('blocking', 'Is it blocking the road?', ['No', 'Partly', 'Fully']));
  }
  if (f.includes('cause')) {
    bits.push(selField('cause', 'Cause', ['Debris', 'Fallen tree', 'Flooding', 'Landslide', 'Other']));
  }
  if (f.includes('pct_bleached')) {
    bits.push(selField('pct_bleached', 'Share of colonies pale or white', ['Under 10%', '10-30%', '30-60%', 'Over 60%']));
  }
  if (f.includes('depth_m')) {
    bits.push(numField('depth_m', 'Depth observed (m)', 'Snorkel depth is usually 1-5 m'));
  }
  if (f.includes('taxa')) {
    bits.push(selField('taxa', 'Coral type', ['Staghorn (Acropora)', 'Massive (Porites)', 'Plating (Montipora)', 'Mixed', 'Not sure']));
  }
  if (f.includes('species')) {
    bits.push(`<div class="field"><label>Species</label>
      <select data-detail="species">
        <option value="">Choose from the watchlist</option>
        ${invasives.map((s) => `<option value="${s.id}">${escapeHtml(s.name)} (${escapeHtml(s.sci)})</option>`).join('')}
        <option value="other">Something else, see notes</option>
      </select></div>`);
  }
  if (f.includes('count')) {
    bits.push(numField('count', 'How many did you see?', 'A rough count is fine'));
  }
  if (f.includes('scarp_cm')) {
    bits.push(numField('scarp_cm', 'Scarp height or cutback (cm)', ''));
  }
  if (f.includes('visibility_m')) {
    bits.push(numField('visibility_m', 'Underwater visibility (m)', 'Clear water here is often over 15 m'));
  }
  if (f.includes('volume')) {
    bits.push(selField('volume', 'Roughly how much?', ['A bagful', 'A pickup load', 'More than a pickup load']));
  }

  return bits.join('');
}

function numField(key, label, hint) {
  return `<div class="field">
    <label>${escapeHtml(label)}</label>
    <input type="number" inputmode="decimal" data-detail="${key}" step="any" min="0">
    ${hint ? `<div class="field-hint">${escapeHtml(hint)}</div>` : ''}
  </div>`;
}

function selField(key, label, options) {
  return `<div class="field">
    <label>${escapeHtml(label)}</label>
    <select data-detail="${key}">
      <option value="">Not stated</option>
      ${options.map((o) => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`).join('')}
    </select>
  </div>`;
}

/* ==========================================================================
   Persistence
   ========================================================================== */

export async function saveReport(state) {
  const obs = await observerId();

  const report = {
    id: uuid(),
    created_at: new Date().toISOString(),
    observer_id: obs,
    category: state.category,
    severity: state.severity,
    lat: state.lat,
    lon: state.lon,
    accuracy: state.accuracy,
    village_id: state.village ? state.village.id : null,
    village_name: state.village ? state.village.name : null,
    note: state.note || '',
    detail: state.detail || {},
    photo: state.photo || null,
    status: state.status || 'open',
    sync_state: 'pending',
    app_version: 1,
  };

  await putReport(report);
  return report;
}

/** Mark an outage report resolved, which closes the episode for reliability. */
export async function resolveReport(report) {
  const obs = await observerId();
  const closing = {
    ...report,
    id: uuid(),
    created_at: new Date().toISOString(),
    observer_id: obs,
    status: 'resolved',
    note: 'Service restored',
    photo: null,
    sync_state: 'pending',
  };
  await putReport(closing);
  return closing;
}

/* ==========================================================================
   Sync
   --------------------------------------------------------------------------
   There is no server behind this build. Rather than fake a successful upload,
   the queue stays honest: if no endpoint is configured, reports remain on the
   device and the UI says so. Set one in Settings and the same queue starts
   draining to it.
   ========================================================================== */

export async function syncEndpoint() {
  return metaGet('sync_endpoint', '');
}

export async function setSyncEndpoint(url) {
  await metaSet('sync_endpoint', url || '');
}

export async function flushQueue() {
  const endpoint = await syncEndpoint();
  const queued = await pendingReports();

  if (!queued.length) return { sent: 0, queued: 0, reason: 'empty' };
  if (!endpoint) return { sent: 0, queued: queued.length, reason: 'no-endpoint' };
  if (!navigator.onLine) return { sent: 0, queued: queued.length, reason: 'offline' };

  let sent = 0;
  for (const r of queued) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(r),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      await markSynced(r.id);
      sent++;
    } catch (err) {
      void err;
      break;   // stop on the first failure, keep the rest queued in order
    }
  }

  return { sent, queued: queued.length - sent, reason: sent ? 'ok' : 'failed' };
}

/* ==========================================================================
   Verification
   --------------------------------------------------------------------------
   A report is one person's account. Two people who do not know each other
   describing the same thing in the same place within a few hours is a much
   stronger claim, and the interface should say which of those it is holding.

   The tiers below are earned from evidence the app actually has: independent
   observers, proximity, recency. There is deliberately no tier for satellite
   or sensor cross-validation, because this build has neither - adding a badge
   that implies a confirmation nobody performed would be worse than showing
   no badge at all.
   ========================================================================== */

const CORROBORATE_KM = 1.5;
const CORROBORATE_H = 6;

export const VERIFICATION = {
  resolved:     { key: 'resolved',     label: 'Resolved',     tone: 'ok' },
  corroborated: { key: 'corroborated', label: 'Corroborated', tone: 'info' },
  single:       { key: 'single',       label: 'Single report', tone: 'watch' },
};

function separationKm(a, b) {
  if (a.lat == null || b.lat == null) return Infinity;
  const dLat = (a.lat - b.lat) * 111.32;
  const dLon = (a.lon - b.lon) * 111.32 * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot(dLat, dLon);
}

/**
 * Classify one report against the rest.
 * @returns {{key:string,label:string,tone:string,observers:number,note:string}}
 */
export function verification(report, all) {
  if (report.status === 'resolved') {
    return { ...VERIFICATION.resolved, observers: 1, note: 'Marked resolved by an observer' };
  }

  const t = new Date(report.created_at).getTime();
  const others = new Set();

  for (const other of all) {
    if (other.id === report.id) continue;
    if (other.category !== report.category) continue;
    if (other.observer_id === report.observer_id) continue;
    if (other.status === 'resolved') continue;
    if (Math.abs(new Date(other.created_at).getTime() - t) > CORROBORATE_H * 3600e3) continue;
    if (separationKm(report, other) > CORROBORATE_KM) continue;
    others.add(other.observer_id);
  }

  if (others.size >= 1) {
    const n = others.size + 1;
    return {
      ...VERIFICATION.corroborated,
      observers: n,
      note: `${n} independent observers within ${CORROBORATE_KM} km and ${CORROBORATE_H} h`,
    };
  }

  return {
    ...VERIFICATION.single,
    observers: 1,
    note: 'One account, not yet corroborated by another observer',
  };
}

/* ==========================================================================
   Report list rendering
   ========================================================================== */

export function renderReportList(reports, categories, { limit = 50, onPick } = {}) {
  if (!reports.length) {
    return emptyState('No observations yet. Everything you file is stored on this device.', 'report');
  }

  const catById = new Map(categories.map((c) => [c.id, c]));
  const rows = reports.slice(0, limit).map((r) => {
    const cat = catById.get(r.category) || { label: r.category, color: 'var(--ok)', icon: 'info' };
    const sev = ['', 'Minor', 'Moderate', 'Serious', 'Severe'][r.severity] || '';
    const v = verification(r, reports);

    return `<button class="list-item" data-report="${r.id}">
      <span class="list-icon" style="color:${cat.color}">${icon(cat.icon || 'info', 17)}</span>
      <span class="list-item-main">
        <span class="list-item-title">
          ${escapeHtml(cat.label)}
          <span class="badge badge-${v.tone}" title="${escapeHtml(v.note)}">${escapeHtml(v.label)}${
            v.observers > 1 ? ' &middot; ' + v.observers : ''
          }</span>
          ${r.sync_state === 'pending' ? '<span class="badge badge-mute">on device</span>' : ''}
        </span>
        <span class="list-item-sub">
          ${escapeHtml(r.village_name || 'Unlocated')}${sev ? ' &middot; ' + sev : ''}
          ${r.note ? ' &middot; ' + escapeHtml(r.note.slice(0, 54)) : ''}
        </span>
      </span>
      <span class="list-item-meta">${timeShort(r.created_at)}</span>
    </button>`;
  }).join('');

  const html = `<div class="list" id="report-list">${rows}</div>`;

  if (onPick) {
    setTimeout(() => {
      document.querySelectorAll('#report-list [data-report]').forEach((b) => {
        b.addEventListener('click', () => {
          onPick(reports.find((r) => r.id === b.dataset.report));
        });
      });
    }, 0);
  }

  return html;
}

function timeShort(iso) {
  const secs = (Date.now() - new Date(iso).getTime()) / 1000;
  if (secs < 3600) return Math.max(1, Math.round(secs / 60)) + 'm';
  if (secs < 86400) return Math.round(secs / 3600) + 'h';
  return Math.round(secs / 86400) + 'd';
}
