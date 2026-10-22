/* ==========================================================================
   export.js - taking the picture out of the app
   --------------------------------------------------------------------------
   Two formats for two readers. CSV goes to whoever wants to do their own
   analysis on the reports. The situation report is for a human being in a
   meeting who needs one page.

   Both carry the same disclaimer, prominently and un-skippably. A document
   that looks official and is not is actively dangerous during an emergency,
   so neither is allowed to imply it came from CUC, BECQ, NWS or FEMA. The
   value here is that the numbers are traceable, not that they are official.
   ========================================================================== */

import { verification } from './reports.js';
import { compass, cToF, kmhToMph, SAIPAN } from './feeds.js';
import { fmt, fmtInt, dur, localTime, escapeHtml, toast } from './ui.js';

const DISCLAIMER =
  'Community-generated from citizen reports and open data. NOT an official product of CUC, '
  + 'BECQ, DCRM, NWS, FEMA or any emergency service. In an emergency, contact the authorities.';

/* ========================== CSV ========================================== */

function csvCell(v) {
  const str = v == null ? '' : String(v);
  return /[",\n]/.test(str) ? '"' + str.replace(/"/g, '""') + '"' : str;
}

function download(filename, text, type) {
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function exportCsv(ctx) {
  const reports = ctx.reports || [];
  const cols = ['created_at', 'category', 'severity', 'status', 'verification', 'observers',
    'village_id', 'village_name', 'lat', 'lon', 'accuracy_m', 'observer_id',
    'sync_state', 'demo', 'note'];

  const lines = ['# ' + DISCLAIMER, cols.join(',')];
  for (const r of reports) {
    const v = verification(r, reports);
    lines.push([
      r.created_at, r.category, r.severity, r.status, v.key, v.observers,
      r.village_id, r.village_name, r.lat, r.lon, r.accuracy,
      r.observer_id, r.sync_state, r.demo ? 'yes' : 'no', r.note,
    ].map(csvCell).join(','));
  }

  download(`son-reports-${new Date().toISOString().slice(0, 10)}.csv`,
    lines.join('\n'), 'text/csv;charset=utf-8');
  toast(`Exported ${reports.length} reports as CSV`, 'ok');
}

export function exportJson(ctx) {
  const payload = {
    exported_at: new Date().toISOString(),
    app: 'Saipan Observational Network',
    island: 'Saipan, CNMI',
    disclaimer: DISCLAIMER,
    count: (ctx.reports || []).length,
    reports: (ctx.reports || []).map((r) => ({
      ...r,
      photo: r.photo ? '[photo omitted from export]' : null,
      verification: verification(r, ctx.reports).key,
    })),
  };
  download(`son-reports-${new Date().toISOString().slice(0, 10)}.json`,
    JSON.stringify(payload, null, 2), 'application/json');
  toast('Export started', 'ok');
}

/* ========================== Situation report ============================= */

const SEVERITY = ['', 'Minor', 'Moderate', 'Serious', 'Severe'];

export function openSitrep(ctx) {
  /* Opened before the document is built: a popup blocker only lets this
     through while the click is still being handled. */
  const win = window.open('', '_blank');
  if (!win) {
    toast('Allow pop-ups to open the situation report', 'warn');
    return;
  }

  win.document.write(buildSitrep(ctx));
  win.document.close();
}

export function buildSitrep(ctx) {
  const { derived = {}, feeds = {}, science = {}, reports = [] } = ctx;
  const ici = derived.ici;
  const risk = derived.risk;
  const grid = derived.grid;
  const dhw = derived.dhw;

  const cur = (feeds.weather && feeds.weather.data && feeds.weather.data.current) || {};
  const alerts = (feeds.alerts && feeds.alerts.data && feeds.alerts.data.features) || [];
  const now = new Date();

  const open = reports.filter((r) => r.status !== 'resolved');
  const atRisk = risk ? risk.villages.filter((v) => v.risk >= 0.35) : [];
  const outages = grid
    ? grid.villages.filter((v) => v.power.status !== 'up' && v.power.status !== 'unknown')
    : [];

  const catLabel = (id) => {
    const c = (science.report_categories || []).find((x) => x.id === id);
    return c ? c.label : id;
  };

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Saipan situation report ${now.toISOString().slice(0, 10)}</title>
<style>
  :root { color-scheme: light; }
  body { font: 12px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; color: #111;
         margin: 32px; max-width: 900px; background: #fff; }
  h1 { font-size: 20px; margin: 0 0 2px; letter-spacing: -0.02em; }
  h2 { font-size: 11px; margin: 22px 0 7px; text-transform: uppercase;
       letter-spacing: 0.07em; color: #555; }
  .meta { color: #555; font-size: 11px; margin-bottom: 14px; }
  .warn { border: 1.5px solid #b4213f; color: #8d1631; background: #fdf2f4;
          padding: 9px 11px; border-radius: 6px; font-size: 11px; margin-bottom: 18px; }
  table { border-collapse: collapse; width: 100%; font-size: 11.5px; }
  th { text-align: left; border-bottom: 1.5px solid #333; padding: 5px 7px 5px 0;
       font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; color: #555; }
  td { border-bottom: 1px solid #e3e3e3; padding: 5px 7px 5px 0; vertical-align: top; }
  .num { text-align: right; font-variant-numeric: tabular-nums; padding-right: 14px; }
  dl.kv { display: grid; grid-template-columns: auto 1fr; gap: 3px 16px; font-size: 11.5px; margin: 0; }
  dl.kv dt { color: #555; } dl.kv dd { margin: 0; }
  .none { color: #555; font-style: italic; }
  footer { margin-top: 26px; padding-top: 10px; border-top: 1px solid #ccc;
           color: #555; font-size: 10px; }
  @media print { body { margin: 14mm; } .noprint { display: none; } }
</style></head><body>

<h1>Saipan situation report</h1>
<div class="meta">${escapeHtml(localTime(now.toISOString()))} ChST &middot; generated on device</div>

<div class="warn"><strong>Not an official document.</strong> ${escapeHtml(DISCLAIMER)}</div>

<h2>Island condition</h2>
<dl class="kv">
  <dt>Condition index</dt><dd>${ici ? `${ici.score} of 100 &mdash; ${escapeHtml(ici.state)}` : 'unavailable'}</dd>
  <dt>Air</dt><dd>${fmt(cToF(cur.temperature_2m), 0)} &deg;F, ${fmt(cur.relative_humidity_2m, 0)}% humidity, ${fmt(cur.surface_pressure, 0)} hPa</dd>
  <dt>Wind</dt><dd>${fmt(kmhToMph(cur.wind_speed_10m), 0)} mph ${escapeHtml(compass(cur.wind_direction_10m))}, gusting ${fmt(kmhToMph(cur.wind_gusts_10m), 0)} mph</dd>
  <dt>Sea</dt><dd>${fmt(ctx.wave, 1)} m swell, surface ${fmt(ctx.sst, 1)} &deg;C</dd>
  <dt>Reef heat stress</dt><dd>${dhw ? `${fmt(dhw.dhw, 1)} &deg;C-weeks &mdash; ${escapeHtml(dhw.alert.code)}` : 'unavailable'}</dd>
  <dt>Active alerts</dt><dd>${alerts.length ? alerts.map((a) => escapeHtml(a.properties.event)).join('; ') : 'none'}</dd>
</dl>

<h2>Villages at moderate risk or above (${atRisk.length})</h2>
${atRisk.length ? `<table><thead><tr>
  <th>Village</th><th>Band</th><th class="num">Score</th><th class="num">Population</th>
  <th class="num">Elevation</th><th>Basis</th></tr></thead><tbody>
  ${atRisk.map((v) => `<tr><td>${escapeHtml(v.name)}</td><td>${escapeHtml(v.band.label)}</td>
    <td class="num">${v.risk100}</td><td class="num">${fmtInt(v.pop)}</td>
    <td class="num">${v.elev_m} m</td><td>${escapeHtml(v.drivenBy)}</td></tr>`).join('')}
  </tbody></table>
  <p style="font-size:10.5px;color:#555">Population exposed:
  <strong>${fmtInt(risk.populationExposed)}</strong>. Scenario:
  ${escapeHtml(ctx.scenarioLabel || 'live')}.</p>`
    : '<p class="none">No village currently scores at moderate risk or above.</p>'}

<h2>Utility status</h2>
<p>${escapeHtml(grid ? grid.headline : 'no data')}</p>
${outages.length ? `<table><thead><tr>
  <th>Village</th><th>Power</th><th>Water</th><th class="num">Observers</th>
  <th class="num">Out for</th></tr></thead><tbody>
  ${outages.map((v) => `<tr><td>${escapeHtml(v.name)}</td><td>${escapeHtml(v.power.status)}</td>
    <td>${escapeHtml(v.water.status)}</td><td class="num">${v.power.observers}</td>
    <td class="num">${v.power.durationH ? escapeHtml(dur(v.power.durationH)) : '&mdash;'}</td></tr>`).join('')}
  </tbody></table>`
    : '<p class="none">No corroborated outages.</p>'}

<h2>Open reports (${open.length})</h2>
${open.length ? `<table><thead><tr>
  <th>Filed</th><th>Type</th><th>Village</th><th>Severity</th><th>Verification</th><th>Note</th>
  </tr></thead><tbody>
  ${open.slice(0, 60).map((r) => {
    const v = verification(r, reports);
    return `<tr><td>${escapeHtml(localTime(r.created_at))}</td>
      <td>${escapeHtml(catLabel(r.category))}${r.demo ? ' <em>(demo data)</em>' : ''}</td>
      <td>${escapeHtml(r.village_name || '--')}</td>
      <td>${escapeHtml(SEVERITY[r.severity] || '--')}</td>
      <td>${escapeHtml(v.label)}${v.observers > 1 ? ' (' + v.observers + ')' : ''}</td>
      <td>${escapeHtml((r.note || '').slice(0, 70))}</td></tr>`;
  }).join('')}
  </tbody></table>`
    : '<p class="none">No open reports.</p>'}

<footer>
  Conditions from Open-Meteo and the National Weather Service (office GUM, zone
  ${escapeHtml(SAIPAN.nwsZone)}). Reef heat stress follows the NOAA Coral Reef Watch definition
  but is not a NOAA product. Village risk is a model estimate; the project README records which
  inputs are measured and which remain estimates. Reports are unverified citizen accounts, shown
  with the corroboration level the network could establish.
</footer>

<p class="noprint" style="margin-top:20px">
  <button onclick="window.print()" style="padding:8px 14px;font:inherit">Print or save as PDF</button>
</p>
</body></html>`;
}
