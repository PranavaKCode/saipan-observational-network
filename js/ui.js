/* ==========================================================================
   ui.js - rendering primitives
   --------------------------------------------------------------------------
   Inline SVG icons, toasts, the bottom sheet, formatters and small charts.
   No chart library: each of these is a few dozen lines of SVG and stays
   legible offline with nothing extra to cache.

   Everything that draws colour reads it from the CSS custom properties, so a
   chart is correct in both themes without a second code path.
   ========================================================================== */

/* ========================== Icons ======================================== */

const ICON_PATHS = {
  dashboard: '<path d="M3 12h3.6l2.4 6.5L13 5.5l2.3 6.5H21"/>',
  map: '<path d="M9 3.5 3.5 6v14.5L9 18l6 2.5 5.5-2.5V3.5L15 6 9 3.5Z"/><path d="M9 3.5V18M15 6v14.5"/>',
  report: '<path d="M12 21s7-5.8 7-11a7 7 0 1 0-14 0c0 5.2 7 11 7 11Z"/><circle cx="12" cy="10" r="2.6"/>',
  reef: '<path d="M4 20c2-6 4-3 4-9M12 20c0-8 2-5 2-11M20 20c-2-6-4-3-4-9"/><path d="M2 20h20"/>',
  grid: '<path d="M13 2.5 5.5 13H11l-1 8.5L18.5 11H13l1-8.5Z"/>',
  water: '<path d="M12 3.2s6 6.4 6 10.3A6 6 0 0 1 6 13.5c0-3.9 6-10.3 6-10.3Z"/>',
  droplet: '<path d="M12 3.2s6 6.4 6 10.3A6 6 0 0 1 6 13.5c0-3.9 6-10.3 6-10.3Z"/>',
  bolt: '<path d="M13 2.5 5.5 13H11l-1 8.5L18.5 11H13l1-8.5Z"/>',
  alert: '<path d="M10.3 3.9 2.6 17.2A2 2 0 0 0 4.3 20.2h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9.3v4"/><circle cx="12" cy="16.6" r="0.9" fill="currentColor" stroke="none"/>',
  road: '<path d="M4.5 21 8 3h8l3.5 18"/><path d="M12 5.5v2.8M12 11.1v2.8M12 16.7v2.8"/>',
  coral: '<path d="M12 21c0-6-3-6-3-11a3 3 0 0 1 6 0c0 5-3 5-3 11Z"/><path d="M6 21c0-4-2-4-2-7M18 21c0-4 2-4 2-7"/>',
  bug: '<path d="M8 8.5a4 4 0 0 1 8 0"/><rect x="7" y="8.5" width="10" height="10" rx="5"/><path d="M9.5 5.6 8.6 4M14.5 5.6l.9-1.6M7 11.5H4M20 11.5h-3M7 15.5H4.3M19.7 15.5H17M9 19.6l-.8 1.5M15 19.6l.8 1.5"/>',
  wave: '<path d="M2 11c2.4-3 4.8-3 7.2 0s4.8 3 7.2 0 2.4-3 5.6 0"/><path d="M2 17c2.4-3 4.8-3 7.2 0s4.8 3 7.2 0 2.4-3 5.6 0"/>',
  cloud: '<path d="M6.5 18h10.2a3.8 3.8 0 0 0 .4-7.6 5.8 5.8 0 0 0-11-1.5A3.6 3.6 0 0 0 6.5 18Z"/>',
  trash: '<path d="M4 6.5h16M9.5 6.5V4h5v2.5M6.5 6.5 7.6 20h8.8l1.1-13.5"/>',
  fish: '<path d="M3 12s4-5.5 9.5-5.5c3.8 0 6.6 2.8 7.5 5.5-.9 2.7-3.7 5.5-7.5 5.5C7 17.5 3 12 3 12Z"/><circle cx="15.6" cy="10.8" r="0.9" fill="currentColor" stroke="none"/>',
  camera: '<rect x="3" y="7" width="18" height="13" rx="3"/><circle cx="12" cy="13.5" r="3.4"/><path d="M8.3 7 9.6 4.2h4.8L15.7 7"/>',
  gps: '<circle cx="12" cy="12" r="7.6"/><circle cx="12" cy="12" r="2.6" fill="currentColor" stroke="none"/><path d="M12 1.8v2.6M12 19.6v2.6M1.8 12h2.6M19.6 12h2.6"/>',
  check: '<path d="m4.5 12.8 4.8 4.7L19.5 7"/>',
  x: '<path d="M5.5 5.5 18.5 18.5M18.5 5.5 5.5 18.5"/>',
  wifi: '<path d="M3 9.2a15 15 0 0 1 18 0M6.4 12.6a10 10 0 0 1 11.2 0M9.7 16a5 5 0 0 1 4.6 0"/><circle cx="12" cy="19.3" r="0.9" fill="currentColor" stroke="none"/>',
  wifiOff: '<path d="M3 3l18 18"/><path d="M9.7 16a5 5 0 0 1 4.6 0M6.4 12.6a10 10 0 0 1 3.4-1.9M3 9.2a15 15 0 0 1 5-3M14.2 6.5a15 15 0 0 1 6.8 2.7"/><circle cx="12" cy="19.3" r="0.9" fill="currentColor" stroke="none"/>',
  sync: '<path d="M20.5 12a8.5 8.5 0 1 1-2.8-6.3"/><path d="M20.5 4.2v5h-5"/>',
  brain: '<path d="M4 19V8M9.5 19V4M15 19v-7M20.5 19v-9"/>',
  clock: '<circle cx="12" cy="12" r="8.6"/><path d="M12 7v5.3l3.4 2"/>',
  layers: '<path d="m12 3.2 8.6 4.6-8.6 4.6-8.6-4.6 8.6-4.6Z"/><path d="m3.4 13 8.6 4.6 8.6-4.6"/>',
  info: '<circle cx="12" cy="12" r="8.6"/><path d="M12 11.2v5.4"/><circle cx="12" cy="8" r="0.95" fill="currentColor" stroke="none"/>',
  satellite: '<path d="m7.2 11 5.4-5.4 3.2 3.2-5.4 5.4-3.2-3.2Z"/><path d="m4.4 13.8 3.2 3.2M13.6 4.6l3.2 3.2"/><path d="M14.6 15.4a4.4 4.4 0 0 1-4.4 4.4M19 19.8a8.8 8.8 0 0 1-8.8 0"/>',
  download: '<path d="M12 3.4v12"/><path d="m7.2 10.8 4.8 4.8 4.8-4.8"/><path d="M4.2 20.2h15.6"/>',
  users: '<circle cx="9.2" cy="8" r="3.4"/><path d="M3 20c0-3.4 2.8-5.6 6.2-5.6S15.4 16.6 15.4 20"/><path d="M16.2 5.2a3.4 3.4 0 0 1 0 5.6M18.6 20c0-2.5-.9-4.3-2.4-5.4"/>',
  flag: '<path d="M5.5 21V3.8M5.5 3.8h10.2l-1.5 4 1.5 4H5.5"/>',
  shield: '<path d="M12 3.2 5.2 6v6c0 4.4 2.9 7.6 6.8 8.8 3.9-1.2 6.8-4.4 6.8-8.8V6L12 3.2Z"/>',
  sun: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.6v2.2M12 19.2v2.2M4.2 12H2M22 12h-2.2M6.1 6.1 4.5 4.5M19.5 19.5l-1.6-1.6M17.9 6.1l1.6-1.6M4.5 19.5l1.6-1.6"/>',
  moon: '<path d="M20 14.2A8.4 8.4 0 0 1 9.8 4a8.6 8.6 0 1 0 10.2 10.2Z"/>',
};

export function icon(name, size = 20, cls = '') {
  const path = ICON_PATHS[name] || ICON_PATHS.info;
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor"
    stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" class="${cls}" aria-hidden="true">${path}</svg>`;
}

/* ========================== Theme tokens ================================= */

/** Read a CSS custom property, so charts follow the active theme. */
export function token(name, fallback = '#888') {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  } catch {
    return fallback;
  }
}

/* ========================== Formatters =================================== */

export function fmt(value, digits = 1, dash = '--') {
  if (value == null || Number.isNaN(value)) return dash;
  return Number(value).toFixed(digits);
}

export function fmtInt(value, dash = '--') {
  if (value == null || Number.isNaN(value)) return dash;
  return Math.round(value).toLocaleString('en-US');
}

export function pct(value, digits = 0) {
  if (value == null || Number.isNaN(value)) return '--';
  return (value * 100).toFixed(digits) + '%';
}

export function ago(iso) {
  if (!iso) return 'never';
  const secs = (Date.now() - new Date(iso).getTime()) / 1000;
  if (secs < 45) return 'just now';
  if (secs < 5400) return Math.round(secs / 60) + 'm ago';
  if (secs < 172800) return Math.round(secs / 3600) + 'h ago';
  return Math.round(secs / 86400) + 'd ago';
}

export function dur(hours) {
  if (hours == null) return '--';
  if (hours < 1) return Math.round(hours * 60) + ' min';
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  return m ? `${h}h ${m}m` : `${h}h`;
}

export function localTime(iso) {
  try {
    return new Date(iso).toLocaleString('en-US', {
      timeZone: 'Pacific/Saipan',
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
  } catch { return iso; }
}

export function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/* ========================== Toasts ======================================= */

export function toast(message, kind = 'ok', ms = 3400) {
  const host = document.getElementById('toasts');
  if (!host) return;

  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  const ic = kind === 'err' ? 'alert' : kind === 'warn' ? 'info' : 'check';
  el.innerHTML = icon(ic, 16) + '<span>' + escapeHtml(message) + '</span>';
  host.appendChild(el);

  setTimeout(() => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 220);
  }, ms);
}

/* ========================== Bottom sheet =================================
   On a phone the sheet can be dragged away. The panel tracks the pointer 1:1,
   resists past the top edge, and on release projects where the throw was
   going before deciding to dismiss or settle back - so the gesture and the
   animation are one continuous motion rather than two separate things.
   ========================================================================== */

let sheetCloser = null;

export function openSheet({ title, body, footer, onMount }) {
  closeSheet();

  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-backdrop';

  const sheet = document.createElement('div');
  sheet.className = 'sheet';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('aria-label', title || 'Panel');
  sheet.innerHTML = `
    <div class="sheet-handle">
      <div class="sheet-grip"></div>
      <div class="sheet-head">
        <h2>${escapeHtml(title || '')}</h2>
        <button class="icon-btn" data-close aria-label="Close">${icon('x', 16)}</button>
      </div>
    </div>
    <div class="sheet-body">${body || ''}</div>
    ${footer ? `<div class="sheet-foot">${footer}</div>` : ''}`;

  document.body.appendChild(backdrop);
  document.body.appendChild(sheet);
  document.body.style.overflow = 'hidden';

  requestAnimationFrame(() => {
    backdrop.classList.add('open');
    sheet.classList.add('open');
  });

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    backdrop.classList.remove('open');
    sheet.classList.remove('open');
    sheet.style.transform = '';
    document.body.style.overflow = '';
    setTimeout(() => { backdrop.remove(); sheet.remove(); }, 360);
    document.removeEventListener('keydown', onKey);
    sheetCloser = null;
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };

  backdrop.addEventListener('click', close);
  sheet.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
  document.addEventListener('keydown', onKey);
  sheetCloser = close;

  attachSheetDrag(sheet, backdrop, close);

  if (onMount) onMount(sheet, close);
  return close;
}

export function closeSheet() {
  if (sheetCloser) sheetCloser();
}

/** Apple's momentum projection: where would this throw come to rest? */
function project(velocity, decelerationRate = 0.998) {
  return (velocity / 1000) * decelerationRate / (1 - decelerationRate);
}

/** Progressive resistance past a boundary, rather than a hard stop. */
function rubberband(overshoot, dimension, constant = 0.55) {
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
}

function attachSheetDrag(sheet, backdrop, close) {
  const handle = sheet.querySelector('.sheet-handle');
  if (!handle) return;

  /* The drag gesture belongs to the phone layout, where the sheet is anchored
     to the bottom edge. On desktop it is a centred dialog and dragging it
     down would be meaningless. */
  const isSheetLayout = () => window.matchMedia('(max-width: 759px)').matches;

  let dragging = false;
  let startY = 0;
  let offset = 0;
  let history = [];

  handle.addEventListener('pointerdown', (e) => {
    if (!isSheetLayout() || e.button != null && e.button !== 0) return;
    dragging = true;
    startY = e.clientY;
    offset = 0;
    history = [{ y: e.clientY, t: performance.now() }];
    handle.setPointerCapture(e.pointerId);
    sheet.classList.add('dragging');
  });

  handle.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const raw = e.clientY - startY;
    const height = sheet.offsetHeight || 1;

    /* Downward tracks the finger exactly; upward resists, because there is
       nothing above the sheet to reveal. */
    offset = raw >= 0 ? raw : -rubberband(-raw, height);
    sheet.style.transform = `translate3d(0, ${offset}px, 0)`;
    backdrop.style.opacity = String(Math.max(0, 1 - offset / height));

    history.push({ y: e.clientY, t: performance.now() });
    if (history.length > 6) history.shift();
  });

  const release = (e) => {
    if (!dragging) return;
    dragging = false;
    sheet.classList.remove('dragging');
    try { handle.releasePointerCapture(e.pointerId); } catch { /* already released */ }

    const height = sheet.offsetHeight || 1;

    /* Velocity from the last few samples, not just the final pair, so one
       jittery event cannot decide the outcome. */
    const last = history[history.length - 1];
    const first = history[0];
    const dt = last && first ? (last.t - first.t) / 1000 : 0;
    const velocity = dt > 0 ? (last.y - first.y) / dt : 0;

    const projected = offset + project(velocity);

    if (projected > height * 0.4 || velocity > 650) {
      /* Dismiss along the same path it arrived on, carrying the throw's speed
         into the exit so there is no seam between gesture and animation. */
      const remaining = Math.max(1, height - offset);
      const ms = Math.min(420, Math.max(140, (remaining / Math.max(Math.abs(velocity), 320)) * 1000));
      sheet.style.transition = `transform ${ms}ms cubic-bezier(0.32, 0.72, 0, 1)`;
      sheet.style.transform = `translate3d(0, ${height}px, 0)`;
      backdrop.style.opacity = '0';
      setTimeout(close, ms * 0.72);
    } else {
      sheet.style.transition = '';
      sheet.style.transform = '';
      backdrop.style.opacity = '';
    }
  };

  handle.addEventListener('pointerup', release);
  handle.addEventListener('pointercancel', release);
}

/* ========================== Charts ======================================= */

/** Sparkline across the full width of its box. */
export function sparkline(values, { w = 160, h = 22, color, fill = true } = {}) {
  const vals = values.filter((v) => v != null);
  if (vals.length < 2) return '';

  const stroke = color || token('--accent', '#0f6fde');
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const range = max - min || 1;
  const step = w / (vals.length - 1);

  const pts = vals.map((v, i) => `${(i * step).toFixed(1)},${(h - ((v - min) / range) * (h - 3) - 1.5).toFixed(1)}`);
  const line = `M${pts.join(' L')}`;

  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none" aria-hidden="true">
    ${fill ? `<path d="${line} L${w},${h} L0,${h} Z" fill="${stroke}" opacity=".14"/>` : ''}
    <path d="${line}" fill="none" stroke="${stroke}" stroke-width="1.5"
          stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
  </svg>`;
}

/** Donut gauge, 0..1. */
export function gauge(value, { size = 120, stroke = 9, color, track } = {}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(1, value || 0));
  const fg = color || token('--accent', '#0f6fde');
  const bg = track || token('--surface-3', '#e7eaef');

  return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" aria-hidden="true">
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${bg}" stroke-width="${stroke}"/>
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${fg}" stroke-width="${stroke}"
      stroke-linecap="round" stroke-dasharray="${c}" stroke-dashoffset="${(c * (1 - v)).toFixed(2)}"
      style="transition: stroke-dashoffset .7s cubic-bezier(.32,.72,0,1)"/>
  </svg>`;
}

/** Training loss curve. */
export function lossChart(history, { w = 320, h = 84 } = {}) {
  if (!history || history.length < 2) return '';

  const color = token('--accent', '#0f6fde');
  const losses = history.map((p) => p.loss);
  const max = Math.max(...losses);
  const min = Math.min(...losses);
  const range = max - min || 1;
  const step = w / (history.length - 1);

  const pts = history.map((p, i) => `${(i * step).toFixed(1)},${(h - ((p.loss - min) / range) * (h - 10) - 5).toFixed(1)}`);

  return `<svg class="loss-chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
    <path d="M${pts.join(' L')} L${w},${h} L0,${h} Z" fill="${color}" opacity=".10"/>
    <path d="M${pts.join(' L')}" fill="none" stroke="${color}" stroke-width="1.8"
          stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
  </svg>`;
}

/** Bars for the degree-heating-week window: a sequential heat ramp. */
export function dhwStrip(series, mmm) {
  if (!series || !series.length) return '';

  const cool = token('--accent', '#0f6fde');
  const ramp = [token('--watch', '#c08a00'), token('--warn', '#d46a1f'), token('--crit', '#b4213f')];
  const max = Math.max(1.2, ...series.map((d) => (d.sst == null ? 0 : d.sst - mmm + 0.6)));

  return '<div class="dhw-strip">' + series.map((d) => {
    const over = d.sst == null ? 0 : d.sst - mmm;
    const height = Math.max(2, ((over + 0.6) / max) * 44);
    const color = over <= 0 ? cool : over < 0.5 ? ramp[0] : over < 1 ? ramp[1] : ramp[2];
    const opacity = over <= 0 ? 0.32 : 1;
    return `<i style="height:${height.toFixed(0)}px;background:${color};opacity:${opacity}"
      title="${d.date}: ${d.sst == null ? 'n/a' : d.sst.toFixed(1)} C"></i>`;
  }).join('') + '</div>';
}

/* ========================== Components =================================== */

export function metricTile({ label, value, unit, sub, tone, spark, iconName }) {
  return `<div class="metric" ${tone ? `data-tone="${tone}"` : ''}>
    <div class="metric-label">${iconName ? icon(iconName, 12) : ''}${escapeHtml(label)}</div>
    <div class="metric-value">${value}${unit ? `<span class="unit">${unit}</span>` : ''}</div>
    ${sub ? `<div class="metric-sub">${sub}</div>` : ''}
    ${spark ? `<div class="metric-spark">${spark}</div>` : ''}
  </div>`;
}

export function badge(text, tone = 'mute') {
  return `<span class="badge badge-${tone}">${escapeHtml(text)}</span>`;
}

export function staleNote(res) {
  if (!res || !res.stale) return '';
  const when = res.at ? ago(res.at) : 'unknown age';
  return `<span class="stale-note">${icon('wifiOff', 11)} cached ${when}</span>`;
}

export function emptyState(message, iconName = 'info') {
  return `<div class="empty">${icon(iconName, 26)}<div>${escapeHtml(message)}</div></div>`;
}
