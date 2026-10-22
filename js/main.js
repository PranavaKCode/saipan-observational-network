/* ==========================================================================
   main.js - application core
   Boot, state, the five views, and the wiring between them.
   ========================================================================== */

import {
  weatherNow, marineNow, nwsForecast, nwsAlerts, quakes,
  degreeHeatingWeeks, compass, kmhToMph, cToF, todayIndex,
  GIBS_LAYERS, gibsDefaultDate, CORAL_MMM, SAIPAN,
} from './feeds.js';

import {
  buildDataset, train, explain, liveFeatures, villageRisk,
  SCENARIOS, FEATURES, VULN_WEIGHTS, ELEV_HALF_M, HEADS, saveModel, loadModel, band,
} from './model.js';

import { aggregate, reliability, restoreExpectation, STATUS } from './grid.js';
import { loadCartoKey } from './config.js';
import { exportCsv, exportJson, openSitrep } from './export.js';
import { buildDemoReports, DEMO_STORY } from './demo.js';
import { SaipanMap, nearestVillage } from './map.js';
import { allReports, putReport, uuid, observerId, pendingReports, storageEstimate, clearAllLocal, metaSet, metaGet } from './store.js';
import { openComposer, resolveReport, renderReportList, flushQueue, syncEndpoint, setSyncEndpoint } from './reports.js';
import {
  icon, fmt, fmtInt, pct, ago, dur, localTime, escapeHtml, toast, openSheet,
  sparkline, gauge, lossChart, dhwStrip, metricTile, badge, staleNote, emptyState, token,
} from './ui.js';

/* ==========================================================================
   State
   ========================================================================== */

const S = {
  island: null,
  science: null,
  sar: null,
  feeds: { weather: null, marine: null, forecast: null, alerts: null, quakes: null },
  derived: { dhw: null, features: null, risk: null, ici: null, grid: null, rel: null },
  model: null,
  modelState: 'idle',      // idle | training | ready | failed
  modelError: null,
  head: 'nowcast',
  scenario: 'now',
  custom: null,       // hand-dialled scenario features
  reports: [],
  view: 'pulse',
  crisis: false,
  map: null,
  mapLayerKey: 'truecolor',
  mapOverlay: 'risk',
  pickedPoint: null,
};

/* ==========================================================================
   Boot
   ========================================================================== */

async function boot() {
  wireChrome();

  try {
    const [island, science] = await Promise.all([
      fetch('data/island.json').then((r) => r.json()),
      fetch('data/science.json').then((r) => r.json()),
    ]);
    S.island = island;
    S.science = science;

    /* Optional: absent if tools/sar_yutu.py has not been run. */
    S.sar = await fetch('data/sar-yutu.json').then((r) => (r.ok ? r.json() : null)).catch(() => null);
  } catch (err) {
    document.getElementById('view-pulse').innerHTML =
      `<div class="card"><h2>Could not load island data</h2><p>${escapeHtml(err.message)}</p></div>`;
    return;
  }

  /* Pick up the deployment's CARTO key if this checkout has one. Absent on a
     fresh clone, which is fine - the basemap falls back to unkeyed tiles. */
  await loadCartoKey();
  S.crisis = (await metaGet('crisis_mode', false)) === true;
  document.body.classList.toggle('crisis', S.crisis);

  S.reports = await allReports();

  /* Keep the demo coherent across a reload. Without this the reports still
     describe a storm while the model re-scores against a calm live day, and
     the risk map goes blank underneath the flooding reports. */
  if (S.reports.some((r) => r.demo)) S.scenario = 'trop';

  render();                      // paint the shell immediately
  switchView('pulse');           // same arrival treatment as any other view

  await handleDeepLink();        // honour the PWA shortcuts
  await refreshFeeds();          // then fill it with live data
  await bootModel();
  registerServiceWorker();
  scheduleRefresh();
}

/* The manifest advertises shortcuts straight to a flood report, a power report
   and the grid view. Those are promises to the home screen, so they have to
   actually land somewhere. */
async function handleDeepLink() {
  const params = new URLSearchParams(location.search);

  /* ?demo=1 loads the scenario on arrival. The demo data lives in IndexedDB
     per device, so without this a fresh machine - a judge's laptop, a capture
     run, a phone passed across a table - opens to a correct but empty app. */
  if (params.get('demo') === '1' && !S.reports.some((r) => r.demo)) {
    await loadDemoScenario();
  }

  const view = params.get('view');
  if (view && document.getElementById('view-' + view)) switchView(view);

  const report = params.get('report');
  if (report && S.science.report_categories.some((c) => c.id === report)) {
    switchView('field');
    newReport({ category: report });
  }

  if (view || report) {
    history.replaceState(null, '', location.pathname);
  }
}

function emptyFeed() {
  return { data: null, stale: true, at: null, error: 'skipped in crisis mode' };
}

/**
 * Crisis mode. Written for the case this whole app exists for: the network is
 * throttled or barely up, the battery is finite, and the only things that
 * matter are the current conditions, the official alert, and being able to
 * file a report.
 *
 * It does not pretend to report megabytes saved - that number would be made
 * up. It states what it switches off.
 */
async function setCrisis(on, { persist = true } = {}) {
  S.crisis = !!on;
  if (persist) await metaSet('crisis_mode', S.crisis);

  document.body.classList.toggle('crisis', S.crisis);

  if (S.map) {
    S.map.toggleGibs(!S.crisis);
    S.map.setBase(S.crisis ? 'carto' : 'esri');
  }

  restartRefresh();
  await refreshFeeds();
  render();

  toast(S.crisis
    ? 'Crisis mode on: satellite imagery off, feeds trimmed, updates hourly'
    : 'Crisis mode off: full imagery and feeds restored', 'ok', 4200);
}

let refreshTimer = null;

function scheduleRefresh() {
  restartRefresh();
}

function restartRefresh() {
  clearInterval(refreshTimer);
  /* Ten minutes normally; hourly in crisis mode, where every avoidable
     request costs battery and bandwidth someone may need later. */
  const every = S.crisis ? 60 * 60e3 : 10 * 60e3;
  refreshTimer = setInterval(() => { if (navigator.onLine) refreshFeeds(); }, every);
}

/* ==========================================================================
   Feeds
   ========================================================================== */

async function refreshFeeds() {
  setNet(navigator.onLine ? 'syncing' : 'offline');

  const lean = S.crisis;

  /* In crisis mode only the two feeds that drive a decision are fetched:
     conditions and the official alert. The forecast narrative, seismicity
     and the 92-day marine history are comfort, not information someone
     needs while deciding whether to move. */
  const [weather, marine, forecast, alerts, qk] = await Promise.all([
    weatherNow(lean),
    marineNow(lean),
    lean ? Promise.resolve(S.feeds.forecast || emptyFeed()) : nwsForecast(),
    nwsAlerts(),
    lean ? Promise.resolve(S.feeds.quakes || emptyFeed()) : quakes(),
  ]);

  S.feeds = { weather, marine, forecast, alerts, quakes: qk };

  /* Lean marine payloads carry no daily series, so degree heating weeks are
     left at their last computed value rather than recomputed from nothing. */
  if (marine.data && marine.data.daily) {
    S.derived.dhw = degreeHeatingWeeks(
      marine.data.daily.time,
      marine.data.daily.sea_surface_temperature_mean,
      CORAL_MMM,
    );
  }

  recompute();
  render();
  setNet(navigator.onLine ? 'online' : 'offline');
}

/* ==========================================================================
   Model lifecycle
   ========================================================================== */

async function bootModel() {
  const cached = await loadModel(S.head);
  const fresh = cached && Date.now() - new Date(cached.trainedAt).getTime() < 7 * 864e5;

  if (fresh) {
    S.model = cached;
    S.modelState = 'ready';
    recompute();
    render();
    return;
  }

  await trainModel();
}

async function trainModel(head = S.head) {
  S.modelState = 'training';
  S.modelError = null;
  render();

  try {
    const floods = S.reports.filter((r) => r.category === 'flood');
    const dataset = await buildDataset(floods, head);

    /* Trained in slices with a frame yielded between them, so the progress bar
       actually moves and the UI stays usable on a phone. */
    const SLICES = 4;
    const perSlice = 90;
    let model = null;

    for (let i = 0; i < SLICES; i++) {
      model = train(dataset, {
        epochs: perSlice,
        init: model ? { weights: model.weights, bias: model.bias, history: model.history, epochsDone: model.epochsDone } : null,
        onEpoch: (epoch, loss, total) => {
          void total;
          paintTrainProgress((i * perSlice + (epoch % perSlice)) / (SLICES * perSlice), loss);
        },
      });
      await new Promise((r) => requestAnimationFrame(r));
    }

    model.head = head;
    S.model = model;
    S.modelState = 'ready';
    await saveModel(model);
  } catch (err) {
    S.modelState = 'failed';
    S.modelError = err.message || String(err);
  }

  recompute();
  render();
}

function paintTrainProgress(frac, loss) {
  const bar = document.querySelector('#train-bar i');
  const label = document.querySelector('#train-label');
  if (bar) bar.style.width = (frac * 100).toFixed(0) + '%';
  if (label) label.textContent = `training ${(frac * 100).toFixed(0)}%  loss ${loss.toFixed(4)}`;
}

/* ==========================================================================
   Derived values
   ========================================================================== */

function recompute() {
  const w = S.feeds.weather && S.feeds.weather.data;

  if (S.model && w) {
    S.derived.features = liveFeatures(w, S.model.presMedian);
  }

  if (S.model && S.derived.features) {
    const scenario = SCENARIOS.find((x) => x.id === S.scenario);
    const features = S.scenario === 'custom' && S.custom
      ? S.custom
      : (scenario && scenario.f ? scenario.f : S.derived.features);

    /* Swell is not a model feature; it feeds the surge term. Scenarios carry a
       representative sea state, and a hand-dialled one scales it with wind
       rather than leaving it at today's calm. */
    const wave = S.scenario === 'custom' && S.custom
      ? Math.min(10, 1 + (S.custom.windMax || 0) / 20)
      : scenario && scenario.f
        ? (S.scenario === 'yutu' ? 9 : S.scenario === 'trop' ? 5 : S.scenario === 'soudelor' ? 6 : 2)
        : currentWave();

    S.derived.risk = villageRisk(S.model, features, S.island.villages, {
      waveHeight: wave,
      reportsByVillage: recentFloodCounts(),
    });
    S.derived.activeFeatures = features;
  }

  S.derived.grid = aggregate(S.reports, S.island);
  S.derived.rel = reliability(S.reports, S.island);
  S.derived.ici = islandConditionIndex();
}

/** Rain summed over the N days before `ti`, independent of the model. */
function priorRain(daily, ti, days) {
  const p = daily.precipitation_sum || [];
  let total = 0;
  for (let k = 1; k <= days; k++) {
    const idx = ti - k;
    if (idx >= 0 && p[idx] != null) total += p[idx];
  }
  return total;
}

function currentWave() {
  const m = S.feeds.marine && S.feeds.marine.data;
  return (m && m.current && m.current.wave_height) || 0;
}

function currentSST() {
  const m = S.feeds.marine && S.feeds.marine.data;
  return (m && m.current && m.current.sea_surface_temperature) || null;
}

function recentFloodCounts() {
  const cutoff = Date.now() - 24 * 3600e3;
  const counts = {};
  for (const r of S.reports) {
    if (r.category !== 'flood' || r.status === 'resolved') continue;
    if (new Date(r.created_at).getTime() < cutoff) continue;
    if (!r.village_id) continue;
    counts[r.village_id] = (counts[r.village_id] || 0) + 1;
  }
  return counts;
}

function activeAlerts() {
  const a = S.feeds.alerts && S.feeds.alerts.data;
  return (a && a.features) || [];
}

/**
 * Island Condition Index - one 0-100 number for "how is Saipan doing".
 * Weights are declared here and shown in the UI so the number can be argued
 * with rather than taken on faith. Higher is better.
 */
function islandConditionIndex() {
  const parts = [];

  const hazard = S.derived.risk ? S.derived.risk.hazard : null;
  parts.push({
    key: 'flood', label: 'Flood hazard', weight: 0.30,
    score: hazard == null ? null : 1 - Math.min(1, hazard * 1.6),
    detail: hazard == null ? 'model not ready' : `model p=${fmt(hazard, 3)}`,
  });

  const dhw = S.derived.dhw ? S.derived.dhw.dhw : null;
  parts.push({
    key: 'reef', label: 'Reef heat stress', weight: 0.25,
    score: dhw == null ? null : 1 - Math.min(1, dhw / 8),
    detail: dhw == null ? 'no SST history' : `${fmt(dhw, 1)} DHW`,
  });

  const g = S.derived.grid;
  const utilityScore = g ? 1 - Math.min(1, g.pctNoPower * 2.2 + (g.popNoWater ? 0.15 : 0)) : null;
  parts.push({
    key: 'utility', label: 'Utility service', weight: 0.25,
    score: utilityScore,
    detail: g ? g.headline : 'no reports',
  });

  const alerts = activeAlerts();
  const severe = alerts.filter((a) => /warning/i.test(a.properties.event)).length;
  parts.push({
    key: 'alerts', label: 'Weather alerts', weight: 0.10,
    score: 1 - Math.min(1, severe * 0.5 + (alerts.length - severe) * 0.2),
    detail: alerts.length ? `${alerts.length} active` : 'none active',
  });

  const wave = currentWave();
  parts.push({
    key: 'marine', label: 'Sea state', weight: 0.10,
    score: 1 - Math.min(1, Math.max(0, wave - 1) / 5),
    detail: `${fmt(wave, 1)} m swell`,
  });

  const usable = parts.filter((p) => p.score != null);
  const wsum = usable.reduce((a, p) => a + p.weight, 0) || 1;
  const score = usable.reduce((a, p) => a + p.score * p.weight, 0) / wsum;

  return {
    score: Math.round(score * 100),
    parts,
    state: score >= 0.8 ? 'Settled' : score >= 0.62 ? 'Watchful' : score >= 0.42 ? 'Strained' : 'Emergency',
    tone: score >= 0.8 ? 'ok' : score >= 0.62 ? 'watch' : score >= 0.42 ? 'warn' : 'crit',
  };
}

/* ==========================================================================
   Render dispatch
   ========================================================================== */

function render() {
  renderPulse();
  renderMapView();
  renderField();
  renderModelView();
  renderGridView();
  paintQueueBadges();
}

/* ========================== Pulse (dashboard) =========================== */

function renderPulse() {
  const host = document.getElementById('view-pulse');
  if (!host) return;

  const w = S.feeds.weather && S.feeds.weather.data;
  const m = S.feeds.marine && S.feeds.marine.data;
  const ici = S.derived.ici;
  const dhw = S.derived.dhw;
  const alerts = activeAlerts();

  const cur = (w && w.current) || {};
  const daily = (w && w.daily) || null;
  const ti = daily ? todayIndex(daily.time) : 0;

  const rainToday = daily ? daily.precipitation_sum[ti] : null;
  const rainSeries = daily ? daily.precipitation_sum.slice(Math.max(0, ti - 6), ti + 1) : [];
  const sst = currentSST();
  const wave = currentWave();

  const riskTop = S.derived.risk ? S.derived.risk.villages.slice(0, 5) : [];

  host.innerHTML = `
    <div class="view-head">
      <h1>Island pulse ${staleNote(S.feeds.weather)}</h1>
      <p class="lede">Saipan, ${localTime(new Date().toISOString())} ChST &middot; live feeds with offline fallback</p>
    </div>

    ${S.reports.some((r) => r.demo) ? `
      <div class="card demo-banner">
        <div class="card-head">
          <span style="color:var(--crit)">${icon('info', 18)}</span>
          <h2>Demo scenario loaded</h2>
          <button class="btn btn-sm btn-ghost" id="demo-off">Remove</button>
        </div>
        <p style="margin:0">${escapeHtml(DEMO_STORY)} Every report below is synthetic and tagged
        as demo data. Conditions, satellite imagery, the radar layer and the trained model are
        real and unaffected.</p>
      </div>` : ''}

    ${S.crisis ? `
      <div class="card crisis-banner">
        <div class="card-head">
          <span style="color:var(--watch)">${icon('shield', 18)}</span>
          <h2>Crisis mode</h2>
          <button class="btn btn-sm btn-ghost" id="crisis-off">Turn off</button>
        </div>
        <p style="margin:0">Satellite imagery is off, feeds are trimmed to conditions and official
        alerts, and updates run hourly instead of every ten minutes. Reporting works exactly as
        normal. Reef heat stress needs 12 weeks of history, so it is paused.</p>
      </div>` : ''}

    ${alerts.length ? alertBanner(alerts) : ''}

    <div class="dash-split">
      <div>
        <div class="card">
          <div class="card-head">
            <span class="card-kicker">Island condition index</span>
          </div>
          ${ici ? renderICI(ici) : '<div class="skeleton" style="height:120px"></div>'}
          <div class="source-note">
            A weighted composite, not an official index. Weights:
            ${ici ? ici.parts.map((p) => `${escapeHtml(p.label)} ${pct(p.weight)}`).join(' &middot; ') : ''}.
            Higher is better.
          </div>
        </div>

        <div class="card">
          <div class="card-head"><h2>Right now</h2>${staleNote(S.feeds.marine)}</div>
          <div class="grid grid-4">
            ${metricTile({
              label: 'Rain today', iconName: 'water',
              value: fmt(rainToday, 1), unit: 'mm',
              sub: daily ? `${fmt(priorRain(daily, ti, 3), 0)} mm prior 3 days` : '',
              tone: rainToday > 50 ? 'alert' : rainToday > 25 ? 'warn' : 'ok',
              spark: sparkline(rainSeries),
            })}
            ${metricTile({
              label: 'Wind', iconName: 'wave',
              value: fmt(kmhToMph(cur.wind_speed_10m), 0), unit: 'mph',
              sub: `${compass(cur.wind_direction_10m)} &middot; gusts ${fmt(kmhToMph(cur.wind_gusts_10m), 0)} mph`,
              tone: cur.wind_gusts_10m > 90 ? 'alert' : cur.wind_gusts_10m > 55 ? 'warn' : 'ok',
            })}
            ${metricTile({
              label: 'Air', iconName: 'cloud',
              value: fmt(cToF(cur.temperature_2m), 0), unit: '°F',
              sub: `${fmt(cur.relative_humidity_2m, 0)}% humidity &middot; ${fmt(cur.surface_pressure, 0)} hPa`,
              tone: 'ok',
            })}
            ${metricTile({
              label: 'Sea surface', iconName: 'droplet',
              value: fmt(sst, 1), unit: '°C',
              sub: dhw ? `${fmt(dhw.dhw, 1)} DHW &middot; MMM ${CORAL_MMM}&deg;C` : '',
              tone: dhw ? dhw.alert.tone : 'ok',
            })}
            ${metricTile({
              label: 'Swell', iconName: 'wave',
              value: fmt(wave, 1), unit: 'm',
              sub: m && m.current ? `${fmt(m.current.wave_period, 0)} s &middot; ${compass(m.current.wave_direction)}` : '',
              tone: wave > 4 ? 'alert' : wave > 2.5 ? 'warn' : 'ok',
            })}
            ${metricTile({
              label: 'Flood hazard', iconName: 'brain',
              value: S.derived.risk ? riskScore(S.derived.risk.hazard) : '--', unit: '%',
              sub: S.modelState === 'ready' ? `${HEADS[S.head].label}` : S.modelState,
              tone: S.derived.risk ? band(S.derived.risk.hazard).key : 'ok',
            })}
          </div>
        </div>

        ${renderForecastCard()}
      </div>

      <div>
        ${renderReefCard()}
        ${renderGridSummaryCard()}
        ${riskTop.length ? `
          <div class="card">
            <div class="card-head">
              <h2>Villages to watch</h2>
              <button class="btn btn-sm btn-ghost" data-goto="model">Model</button>
            </div>
            <div class="list">
              ${riskTop.map((v) => `
                <div class="list-item">
                  <span class="status-dot ${v.band.key}"></span>
                  <span class="list-item-main">
                    <span class="list-item-title">${escapeHtml(v.name)}
                      ${v.confirmed ? badge(`${v.confirmations} report${v.confirmations > 1 ? 's' : ''}`, 'info') : ''}
                    </span>
                    <span class="list-item-sub">~${fmtInt(v.pop)} residents &middot; ${v.elev_m} m &middot; feeder ${escapeHtml(v.feeder)}</span>
                  </span>
                  <span class="list-item-meta" style="color:${v.band.color}">${v.risk100}</span>
                </div>`).join('')}
            </div>
            <div class="source-note">
              Population exposed at moderate risk or above:
              <strong>${fmtInt(S.derived.risk.populationExposed)}</strong>
              across ${S.derived.risk.villagesAtRisk} villages.
            </div>
          </div>` : ''}

        ${renderQuakeCard()}
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <h2>Recent observations</h2>
        <span class="card-kicker">${S.reports.length} total</span>
        <button class="btn btn-sm btn-primary" data-report-new>${icon('report', 14)} Report</button>
      </div>
      ${renderReportList(S.reports, S.science.report_categories, { limit: 6, onPick: showReport })}
    </div>

    <div class="source-note">
      <strong>Sources:</strong> Open-Meteo (ICON/GFS forecast, ERA5 archive, marine waves and SST),
      NOAA/NWS Guam office ${SAIPAN.nwsGrid} zone ${SAIPAN.nwsZone}, USGS earthquake catalog,
      NASA EOSDIS GIBS imagery. Coral alert levels follow NOAA Coral Reef Watch thresholds
      against a ${CORAL_MMM}&deg;C monthly maximum.
    </div>`;

  const demoOff = host.querySelector('#demo-off');
  if (demoOff) demoOff.addEventListener('click', () => purgeDemo());

  const crisisOff = host.querySelector('#crisis-off');
  if (crisisOff) crisisOff.addEventListener('click', () => setCrisis(false));

  wireViewButtons(host);
}

function renderICI(ici) {
  const varName = { ok: '--ok', watch: '--watch', warn: '--warn', crit: '--crit' }[ici.tone];
  const color = `var(${varName})`;

  return `<div class="ici">
    <div class="ici-dial">
      ${gauge(ici.score / 100, { color: token(varName, '#888') })}
      <div class="ici-center">
        <div class="ici-score" style="color:${color}">${ici.score}</div>
        <div class="ici-of">of 100</div>
      </div>
    </div>
    <div class="ici-body">
      <div class="ici-state" style="color:${color}">${escapeHtml(ici.state)}</div>
      <div class="ici-why">${ici.parts.filter((p) => p.score != null && p.score < 0.6)
        .map((p) => escapeHtml(p.label.toLowerCase()))
        .join(', ') || 'no component in the red'}</div>
      <div class="ici-drivers">
        ${ici.parts.map((p) => {
          const v = p.score == null ? 0 : p.score;
          const c = v > 0.75 ? 'var(--ok)' : v > 0.5 ? 'var(--watch)' : v > 0.3 ? 'var(--warn)' : 'var(--crit)';
          return `<div class="driver">
            <span class="driver-name">${escapeHtml(p.label)}</span>
            <span class="driver-bar"><i style="width:${(v * 100).toFixed(0)}%;background:${c}"></i></span>
            <span class="driver-val">${p.score == null ? 'n/a' : Math.round(v * 100)}</span>
          </div>`;
        }).join('')}
      </div>
    </div>
  </div>`;
}

function alertBanner(alerts) {
  return alerts.slice(0, 3).map((a) => {
    const p = a.properties;
    const tone = /warning/i.test(p.event) ? 'crit' : /watch/i.test(p.event) ? 'warn' : 'info';
    return `<div class="card" style="border-color:rgba(224,36,94,.4);margin-bottom:12px">
      <div class="card-head">
        <span style="color:var(--alert)">${icon('alert', 18)}</span>
        <h2>${escapeHtml(p.event)}</h2>
        ${badge(tone === 'crit' ? 'warning' : 'advisory', tone)}
      </div>
      <p style="margin:0">${escapeHtml((p.headline || '').slice(0, 220))}</p>
      <div class="source-note">
        ${escapeHtml(p.areaDesc || '')} &middot; issued ${ago(p.sent)} &middot; National Weather Service
      </div>
    </div>`;
  }).join('');
}

function renderForecastCard() {
  const f = S.feeds.forecast && S.feeds.forecast.data;
  const periods = (f && f.properties && f.properties.periods) || [];
  if (!periods.length) return '';

  return `<div class="card">
    <div class="card-head">
      <h2>NWS forecast</h2>
      <span class="card-kicker">office ${SAIPAN.nwsGrid}</span>
      ${staleNote(S.feeds.forecast)}
    </div>
    <div class="list">
      ${periods.slice(0, 5).map((p) => `
        <div class="list-item">
          <span class="list-item-main">
            <span class="list-item-title">${escapeHtml(p.name)}</span>
            <span class="list-item-sub">${escapeHtml(p.shortForecast)} &middot; wind ${escapeHtml(p.windSpeed || '')} ${escapeHtml(p.windDirection || '')}</span>
          </span>
          <span class="list-item-meta">${p.temperature}&deg;${p.temperatureUnit}</span>
        </div>`).join('')}
    </div>
  </div>`;
}

function renderReefCard() {
  const d = S.derived.dhw;
  if (!d) return '';

  const scale = S.science.bleaching_scale;
  const tone = d.alert.tone;
  const color = { ok: 'var(--ok)', watch: 'var(--watch)', warn: 'var(--warn)', alert: 'var(--alert)', crit: 'var(--crit)' }[tone];

  return `<div class="card">
    <div class="card-head">
      <span style="color:${color}">${icon('coral', 18)}</span>
      <h2>Coral heat stress</h2>
      ${badge(d.alert.code, tone)}
    </div>

    <div class="row" style="align-items:flex-end;gap:14px;margin-bottom:9px">
      <div>
        <div class="metric-label">Degree heating weeks</div>
        <div class="metric-value" style="color:${color}">${fmt(d.dhw, 1)}<span class="unit">&deg;C-weeks</span></div>
      </div>
      <div class="spacer"></div>
      <div style="text-align:right">
        <div class="metric-label">Latest SST</div>
        <div class="metric-value" style="font-size:1.1rem">${fmt(d.latestSST, 1)}<span class="unit">&deg;C</span></div>
      </div>
    </div>

    ${dhwStrip(d.series, d.mmm)}
    <div class="row" style="font-size:.62rem;color:var(--text-3);margin-top:4px">
      <span>${d.window[0]}</span><span class="spacer"></span><span>${d.window[1]}</span>
    </div>

    <div class="alert-ladder" style="margin-top:11px">
      ${scale.map((lv) => {
        const current = lv.level === d.alert.level;
        const c = ['var(--ok)', 'var(--watch)', 'var(--warn)', 'var(--alert)', 'var(--crit)'][lv.level];
        return `<div class="ladder-row ${current ? 'current' : ''}" style="color:${current ? c : 'var(--text-3)'}">
          <span class="ladder-code">${escapeHtml(lv.code)}</span>
          <span class="ladder-action">${escapeHtml(lv.action)}</span>
        </div>`;
      }).join('')}
    </div>

    <div class="source-note">
      ${d.daysAboveMMM} of the last ${d.days} days ran above the ${d.mmm}&deg;C monthly maximum.
      DHW follows the NOAA Coral Reef Watch definition, computed here from Open-Meteo marine SST.
      <strong>Not an official NOAA product.</strong>
    </div>
  </div>`;
}

function renderGridSummaryCard() {
  const g = S.derived.grid;
  if (!g) return '';

  const tone = g.islandWide ? 'crit' : g.popNoPower ? 'warn' : 'ok';

  return `<div class="card">
    <div class="card-head">
      <span style="color:var(--watch)">${icon('grid', 18)}</span>
      <h2>Utilities</h2>
      ${badge(g.islandWide ? 'island-wide' : g.popNoPower ? 'localised' : 'normal', tone)}
    </div>
    <p style="margin-bottom:9px">${escapeHtml(g.headline)}</p>
    <div class="grid grid-3">
      ${metricTile({ label: 'No power', value: fmtInt(g.popNoPower), unit: 'ppl', tone: g.popNoPower ? 'alert' : 'ok' })}
      ${metricTile({ label: 'No water', value: fmtInt(g.popNoWater), unit: 'ppl', tone: g.popNoWater ? 'warn' : 'ok' })}
      ${metricTile({ label: 'Hazards', value: fmtInt(g.hazardCount), unit: 'open', tone: g.hazardCount ? 'warn' : 'ok' })}
    </div>
    <button class="btn btn-sm btn-ghost btn-block" style="margin-top:9px" data-goto="grid">Open grid status</button>
  </div>`;
}

function renderQuakeCard() {
  const q = S.feeds.quakes && S.feeds.quakes.data;
  const list = (q && q.features) || [];
  if (!list.length) return '';

  return `<div class="card">
    <div class="card-head">
      <h2>Seismicity</h2>
      <span class="card-kicker">M4+ within 500 km, 30 days</span>
    </div>
    <div class="list">
      ${list.slice(0, 4).map((f) => `
        <div class="list-item">
          <span class="list-item-main">
            <span class="list-item-title">M${fmt(f.properties.mag, 1)}</span>
            <span class="list-item-sub">${escapeHtml(f.properties.place || '')} &middot; ${fmt(f.geometry.coordinates[2], 0)} km deep</span>
          </span>
          <span class="list-item-meta">${ago(new Date(f.properties.time).toISOString())}</span>
        </div>`).join('')}
    </div>
  </div>`;
}

/* ========================== Map view ==================================== */

function renderMapView() {
  const host = document.getElementById('view-map');
  if (!host) return;

  if (!host.dataset.built) {
    host.innerHTML = `
      <div class="view-head">
        <h1>Satellite and field map</h1>
        <p class="lede">NASA daily imagery with a date scrubber, over live model risk and citizen reports.</p>
      </div>

      <div class="map-wrap">
        <div id="map" class="map-el"></div>

        <div class="map-toolbar">
          <div class="map-panel">
            <div class="chipset" id="map-overlays">
              <button class="chip active" data-overlay="risk">Flood risk</button>
              <button class="chip active" data-overlay="reports">Reports</button>
              <button class="chip" data-overlay="grid">Utilities</button>
              <button class="chip" data-overlay="reef">Reef sites</button>
              ${S.sar ? '<button class="chip" data-overlay="sar">Yutu radar</button>' : ''}
            </div>
          </div>
          <div class="map-panel">
            <div class="chipset" id="map-bases">
              <button class="chip active" data-base="esri">Imagery</button>
              <button class="chip" data-base="carto">Plain</button>
              <button class="chip active" data-gibs-toggle>NASA layer</button>
            </div>
          </div>
        </div>

        <div class="map-panel map-legend" id="map-legend"></div>

        <div class="map-panel time-scrubber">
          <div class="scrub-label">
            <span>${icon('satellite', 12)} <span id="scrub-layer">VIIRS true colour</span></span>
            <span class="scrub-state" id="gibs-state"></span>
            <span class="spacer"></span>
            <span class="scrub-date" id="scrub-date"></span>
          </div>
          <input type="range" id="scrub" min="0" max="0" step="1">
          <div class="chipset" id="event-jumps" style="margin-top:5px"></div>
        </div>
      </div>

      <div class="card" style="margin-top:12px">
        <div class="card-head">
          <h2>NASA layer</h2>
          <div class="seg" id="gibs-layers" role="tablist">
            ${Object.entries(GIBS_LAYERS).map(([k, v], i) => `
              <button role="tab" data-gibs="${k}" aria-selected="${i === 0}">${escapeHtml(v.label)}</button>`).join('')}
          </div>
        </div>
        <p id="gibs-blurb" style="margin:0 0 10px">${GIBS_LAYERS.truecolor.blurb}</p>

        <label style="display:block;font-size:.64rem;letter-spacing:.12em;
                      text-transform:uppercase;color:var(--text-3);margin-bottom:2px">
          Layer opacity
        </label>
        <input type="range" id="gibs-opacity" min="0" max="100" step="5" value="60">
        <div class="field-hint">
          True colour resolves at about 375 m per pixel, and the daily composite is stitched from
          separate orbital passes, so close in it reads as haze with visible seams where two passes
          met. The layer fades itself out past the zoom where it still means something and stops
          requesting tiles; zoom out to bring it back. This slider sets its strength while visible.
        </div>
        <div class="source-note">
          Tap anywhere on the map to drop a pin and file a report from that exact spot - useful when
          GPS is unreliable indoors or under canopy.
        </div>
      </div>`;
    host.dataset.built = '1';
  }

  if (S.view === 'map' && !S.map) {
    S.map = new SaipanMap('map', {
      onVillageClick: (id) => showVillage(id),
      onMapClick: (latlng) => onMapPick(latlng),
    });
    S.map.init();

    /* The coastline mask ships with the radar product, so the risk surface can
       be clipped to land. Absent until tools/sar_yutu.py has been run, in
       which case the map simply falls back to the village markers. */
    if (S.sar && S.sar.land_mask) {
      S.map.loadLandMask(S.sar.land_mask).then(() => {
        S.map.drawRiskSurface(S.derived.risk);
      });
    }

    /* The layer fades itself out past its native resolution. Without saying so,
       a reader who left the toggle on would just see it stop working. */
    S.map.onGibsVisibility = (st) => {
      const el = document.getElementById('gibs-state');
      const chip = document.querySelector('[data-gibs-toggle]');
      if (chip) chip.dataset.faded = String(st.fadedByZoom);
      if (!el) return;
      if (!st.enabled) { el.textContent = 'off'; return; }
      el.textContent = st.fadedByZoom
        ? `too coarse past zoom ${st.native + 2} — zoom out to see it`
        : '';
    };

    buildScrubber();
    wireMapControls();
  }

  if (S.map) {
    /* Radar first: it is background context under the markers, not over them.
       Then the interpolated risk field, then the point markers on top. */
    S.map.drawSar(S.sar);
    S.map.drawRiskSurface(S.derived.risk);
    S.map.drawRisk(S.derived.risk);
    S.map.drawReports(S.reports, S.science.report_categories);
    S.map.drawGrid(S.derived.grid, S.island);
    S.map.drawReefs(S.science.reef_sites, S.derived.dhw ? S.derived.dhw.alert.level : 0);
    paintLegend();
  }
}

function buildScrubber() {
  const scrub = document.getElementById('scrub');
  const dateEl = document.getElementById('scrub-date');
  if (!scrub) return;

  /* 400 days of history at daily resolution, ending two days back where GIBS
     composites are reliably published. */
  const DAYS = 400;
  scrub.max = String(DAYS);
  scrub.value = String(DAYS);

  const dateFor = (idx) => {
    const end = new Date(gibsDefaultDate() + 'T00:00:00Z').getTime();
    return new Date(end - (DAYS - idx) * 864e5).toISOString().slice(0, 10);
  };

  const paint = () => {
    const d = dateFor(Number(scrub.value));
    dateEl.textContent = d;
    if (S.map) S.map.setGibs(null, d);
  };

  scrub.addEventListener('input', () => {
    dateEl.textContent = dateFor(Number(scrub.value));
  });
  scrub.addEventListener('change', paint);
  paint();

  /* Jump straight to the dates that matter here. */
  const jumps = document.getElementById('event-jumps');
  if (jumps) {
    jumps.innerHTML = S.science.timeline
      .filter((t) => t.kind === 'typhoon')
      .map((t) => `<button class="chip" data-jump="${t.gibs_date}">${escapeHtml(t.title.replace('Super Typhoon ', '').replace('Typhoon ', ''))}</button>`)
      .join('') + '<button class="chip" data-jump="latest">Latest</button>';

    jumps.querySelectorAll('[data-jump]').forEach((b) => {
      b.addEventListener('click', () => {
        const target = b.dataset.jump === 'latest' ? gibsDefaultDate() : b.dataset.jump;
        dateEl.textContent = target;
        if (S.map) S.map.setGibs(null, target);
        /* Dates older than the slider window still load; the slider just
           parks at its floor rather than lying about the position. */
        const end = new Date(gibsDefaultDate() + 'T00:00:00Z').getTime();
        const idx = 400 - Math.round((end - new Date(target + 'T00:00:00Z').getTime()) / 864e5);
        scrub.value = String(Math.max(0, Math.min(400, idx)));
        toast(`Imagery set to ${target}`, 'ok');
      });
    });
  }
}

function wireMapControls() {
  document.querySelectorAll('#map-overlays [data-overlay]').forEach((b) => {
    b.addEventListener('click', () => {
      const on = !b.classList.contains('active');
      b.classList.toggle('active', on);
      if (S.map) {
        S.map.toggleGroup(b.dataset.overlay, on);
        if (b.dataset.overlay === 'risk') S.map.toggleGroup('surface', on);
      }
      paintLegend();
    });
  });

  document.querySelectorAll('#map-bases [data-base]').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('#map-bases [data-base]').forEach((x) => x.classList.toggle('active', x === b));
      if (S.map) S.map.setBase(b.dataset.base);
    });
  });

  const gibsToggle = document.querySelector('[data-gibs-toggle]');
  if (gibsToggle) {
    gibsToggle.addEventListener('click', () => {
      const on = !gibsToggle.classList.contains('active');
      gibsToggle.classList.toggle('active', on);
      if (S.map) S.map.toggleGibs(on);
    });
  }

  const opacity = document.getElementById('gibs-opacity');
  if (opacity) {
    opacity.addEventListener('input', () => {
      if (S.map) S.map.setGibsOpacity(Number(opacity.value) / 100);
    });
  }

  document.querySelectorAll('#gibs-layers [data-gibs]').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('#gibs-layers [data-gibs]').forEach((x) => {
        x.setAttribute('aria-selected', String(x === b));
      });
      const key = b.dataset.gibs;
      S.mapLayerKey = key;
      if (S.map) S.map.setGibs(key, null);
      document.getElementById('gibs-blurb').textContent = GIBS_LAYERS[key].blurb;
      document.getElementById('scrub-layer').textContent = GIBS_LAYERS[key].label;
    });
  });
}

function paintLegend() {
  const el = document.getElementById('map-legend');
  if (!el) return;

  const active = [...document.querySelectorAll('#map-overlays [data-overlay].active')].map((b) => b.dataset.overlay);
  const rows = [];

  if (active.includes('risk')) {
    rows.push('<div class="card-kicker" style="margin-bottom:4px">Flood risk surface</div>');
    for (const r of [0.85, 0.65, 0.45, 0.25, 0.05]) {
      const b = band(r);
      rows.push(`<div class="legend-row"><span class="legend-swatch" style="background:${b.color}"></span>${b.label}</div>`);
    }
  }
  if (active.includes('grid')) {
    rows.push('<div class="card-kicker" style="margin:6px 0 4px">Utilities (power|water)</div>');
    for (const k of ['up', 'reported', 'degraded', 'down', 'unknown']) {
      rows.push(`<div class="legend-row"><span class="legend-swatch" style="background:${STATUS[k].color}"></span>${STATUS[k].label}</div>`);
    }
  }
  if (active.includes('sar')) {
    rows.push('<div class="card-kicker" style="margin:6px 0 4px">Yutu radar change</div>');
    rows.push('<div class="legend-row"><span class="legend-swatch" style="background:#d46a1f"></span>3 dB anomaly</div>');
    rows.push('<div class="legend-row"><span class="legend-swatch" style="background:#b4213f"></span>12 dB or more</div>');
    rows.push('<div class="legend-row" style="margin-top:3px;opacity:.75">Surface change, not flooding</div>');
  }
  if (active.includes('reports')) {
    rows.push('<div class="legend-row" style="margin-top:6px;opacity:.75">Hollow marker = queued offline</div>');
  }

  el.innerHTML = rows.join('') || '<div class="legend-row">No overlays active</div>';
}

function onMapPick(latlng) {
  S.pickedPoint = { lat: +latlng.lat.toFixed(6), lon: +latlng.lng.toFixed(6) };
  if (S.map) S.map.marker(S.pickedPoint.lat, S.pickedPoint.lon);

  const near = nearestVillage(S.pickedPoint.lat, S.pickedPoint.lon, S.island.villages);

  openSheet({
    title: 'Dropped pin',
    body: `
      <div class="geo-strip ok" style="margin-bottom:12px">
        ${icon('gps', 15)} ${S.pickedPoint.lat.toFixed(5)}, ${S.pickedPoint.lon.toFixed(5)}
      </div>
      <p>Nearest village: <strong>${escapeHtml(near ? near.village.name : 'unknown')}</strong>
        ${near ? `<span style="color:var(--text-3)">(${fmt(near.distanceKm, 2)} km)</span>` : ''}</p>
      <p style="color:var(--text-3);font-size:.8rem">File an observation at this exact point, or zoom the
      map in to double-check before reporting.</p>`,
    footer: `<button class="btn btn-ghost" data-close>Close</button>
             <button class="btn btn-primary" id="pin-report">Report here</button>`,
    onMount(sheet, close) {
      sheet.querySelector('#pin-report').addEventListener('click', () => {
        close();
        newReport({ lat: S.pickedPoint.lat, lon: S.pickedPoint.lon });
      });
    },
  });
}

/* ========================== Field view (reporting) ====================== */

function renderField() {
  const host = document.getElementById('view-field');
  if (!host) return;

  const cats = S.science.report_categories;
  const byGroup = { hazard: [], utility: [], science: [] };
  for (const c of cats) (byGroup[c.group] || byGroup.science).push(c);

  const pendingCount = S.reports.filter((r) => r.sync_state === 'pending').length;

  host.innerHTML = `
    <div class="view-head">
      <h1>Field reporting</h1>
      <p class="lede">Works with no signal. Everything is written to this device first.</p>
    </div>

    <div class="card">
      <div class="card-head"><h2>File an observation</h2></div>
      ${['hazard', 'utility', 'science'].map((g) => `
        <div style="margin-bottom:12px">
          <div class="card-kicker" style="margin-bottom:6px">${
            g === 'hazard' ? 'Immediate hazards' : g === 'utility' ? 'Utility service' : 'Science and environment'
          }</div>
          <div class="cat-grid">
            ${byGroup[g].map((c) => `
              <button class="cat-tile" data-newcat="${c.id}">
                <span class="cat-ink" style="color:${c.color}">${icon(c.icon, 20)}</span>
                <span>${escapeHtml(c.label)}</span>
              </button>`).join('')}
          </div>
        </div>`).join('')}
      <div class="source-note">
        ${icon('shield', 11)} Anonymous by design: a random local observer id, no account, no contact details.
        Never approach a downed line - report it from a distance of at least 10 m.
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <h2>My observations</h2>
        ${pendingCount ? badge(`${pendingCount} on device`, 'watch') : ''}
        <button class="btn btn-sm btn-ghost" id="field-sync">${icon('sync', 13)} Sync</button>
      </div>
      ${renderReportList(S.reports, cats, { limit: 40, onPick: showReport })}
    </div>

    <div class="card">
      <div class="card-head">
        <span style="color:var(--accent)">${icon('bug', 18)}</span>
        <h2>Invasive species watchlist</h2>
        <span class="card-kicker">${S.science.invasive_watchlist.length} species</span>
      </div>
      <div class="list">
        ${S.science.invasive_watchlist.map((s) => `
          <button class="list-item" data-species="${s.id}">
            <span class="status-dot ${s.severity === 'critical' ? 'crit' : s.severity === 'high' ? 'alert' : 'watch'}"></span>
            <span class="list-item-main">
              <span class="list-item-title">${escapeHtml(s.name)}</span>
              <span class="list-item-sub"><em>${escapeHtml(s.sci)}</em> &middot; ${escapeHtml(s.type)}</span>
            </span>
            <span class="list-item-meta">${escapeHtml(s.severity)}</span>
          </button>`).join('')}
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <span style="color:var(--accent)">${icon('coral', 18)}</span>
        <h2>Reef monitoring sites</h2>
        <span class="card-kicker">${S.science.reef_sites.length} sites</span>
      </div>
      <div class="list">
        ${S.science.reef_sites.map((s) => `
          <button class="list-item" data-reef="${s.id}">
            <span class="list-item-main">
              <span class="list-item-title">${escapeHtml(s.name)}</span>
              <span class="list-item-sub">${s.depth_m} m &middot; ${escapeHtml(s.habitat)}</span>
            </span>
            <span class="list-item-meta">${icon('map', 14)}</span>
          </button>`).join('')}
      </div>
    </div>`;

  host.querySelectorAll('[data-newcat]').forEach((b) => {
    b.addEventListener('click', () => newReport({ category: b.dataset.newcat }));
  });

  host.querySelectorAll('[data-species]').forEach((b) => {
    b.addEventListener('click', () => showSpecies(b.dataset.species));
  });

  host.querySelectorAll('[data-reef]').forEach((b) => {
    b.addEventListener('click', () => showReef(b.dataset.reef));
  });

  const syncBtn = host.querySelector('#field-sync');
  if (syncBtn) syncBtn.addEventListener('click', doSync);
}

function showSpecies(id) {
  const s = S.science.invasive_watchlist.find((x) => x.id === id);
  if (!s) return;

  openSheet({
    title: s.name,
    body: `
      <div class="row row-wrap" style="margin-bottom:10px">
        ${badge(s.severity, s.severity === 'critical' ? 'crit' : s.severity === 'high' ? 'alert' : 'watch')}
        ${badge(s.type, 'mute')}
      </div>
      <p><em>${escapeHtml(s.sci)}</em></p>
      <p><strong>Why it matters.</strong> ${escapeHtml(s.why)}</p>
      <div class="card" style="box-shadow:none">
        <div class="card-kicker" style="margin-bottom:6px">How to identify</div>
        <ul style="margin:0;padding-left:18px;color:var(--text-2);font-size:.82rem">
          ${s.id_hints.map((h) => `<li>${escapeHtml(h)}</li>`).join('')}
        </ul>
      </div>
      <p style="margin-top:10px;font-size:.8rem"><strong>Do not confuse with:</strong> ${escapeHtml(s.confuse_with)}</p>`,
    footer: `<button class="btn btn-ghost" data-close>Close</button>
             <button class="btn btn-primary" id="sp-report">Report a sighting</button>`,
    onMount(sheet, close) {
      sheet.querySelector('#sp-report').addEventListener('click', () => {
        close();
        newReport({ category: 'invasive' });
      });
    },
  });
}

function showReef(id) {
  const s = S.science.reef_sites.find((x) => x.id === id);
  if (!s) return;
  const d = S.derived.dhw;

  openSheet({
    title: s.name,
    body: `
      <div class="row row-wrap" style="margin-bottom:10px">
        ${badge(s.depth_m + ' m', 'info')}
        ${d ? badge('island ' + d.alert.code, d.alert.tone) : ''}
      </div>
      <p>${escapeHtml(s.status_note)}</p>
      <dl class="kv">
        <dt>habitat</dt><dd>${escapeHtml(s.habitat)}</dd>
        <dt>indicator</dt><dd>${escapeHtml(s.indicator_taxa)}</dd>
        <dt>pressures</dt><dd>${s.pressures.map(escapeHtml).join(', ')}</dd>
        <dt>position</dt><dd>${s.lat.toFixed(4)}, ${s.lon.toFixed(4)}</dd>
      </dl>
      <div class="source-note">
        Heat stress shown is island-wide, computed from a single offshore SST pixel.
        Shallow reef flats heat faster than this average, deeper slopes slower.
      </div>`,
    footer: `<button class="btn btn-ghost" data-close>Close</button>
             <button class="btn btn-primary" id="reef-report">Log a survey here</button>`,
    onMount(sheet, close) {
      sheet.querySelector('#reef-report').addEventListener('click', () => {
        close();
        newReport({ category: 'bleaching', lat: s.lat, lon: s.lon });
      });
    },
  });
}

/* ========================== Model view ================================== */

function renderModelView() {
  const host = document.getElementById('view-model');
  if (!host) return;

  const m = S.model;
  const risk = S.derived.risk;

  host.innerHTML = `
    <div class="view-head">
      <h1>Flood impact model</h1>
      <p class="lede">Logistic regression trained in your browser on ERA5 reanalysis for Saipan.</p>
    </div>

    <div class="card">
      <div class="card-head">
        <span style="color:var(--accent)">${icon('brain', 18)}</span>
        <h2>Training</h2>
        ${m ? badge('ready', 'ok') : badge(S.modelState, S.modelState === 'failed' ? 'crit' : 'watch')}
      </div>

      ${S.modelState === 'training' ? `
        <div class="train-strip">
          <span id="train-label">preparing...</span>
          <span class="train-bar" id="train-bar"><i style="width:2%"></i></span>
        </div>` : ''}

      ${S.modelState === 'failed' ? `
        <p style="color:var(--alert)">${escapeHtml(S.modelError || 'Training failed')}</p>
        <button class="btn btn-sm" id="retrain">Try again</button>` : ''}

      ${m ? `
        <div class="seg" id="head-switch" style="margin-bottom:11px">
          ${Object.values(HEADS).map((h) => `
            <button data-head="${h.id}" aria-selected="${S.head === h.id}">${escapeHtml(h.label)}</button>`).join('')}
        </div>
        <p style="font-size:.8rem">${escapeHtml(HEADS[S.head].note)}</p>

        <div class="grid grid-4" style="margin-bottom:11px">
          ${metricTile({ label: 'Test AUC', value: fmt(m.metrics.auc, 3), tone: 'ok', sub: 'ranking skill' })}
          ${metricTile({ label: 'Recall', value: pct(m.metrics.recall), sub: 'of high-impact days caught' })}
          ${metricTile({ label: 'Precision', value: pct(m.metrics.precision), sub: 'of alarms that verified' })}
          ${metricTile({
            label: 'Brier skill', value: fmt(m.metrics.brierSkill, 2),
            sub: 'vs climatology', tone: m.metrics.brierSkill > 0 ? 'ok' : 'warn',
          })}
        </div>

        ${lossChart(m.history)}
        <div class="row" style="font-size:.62rem;color:var(--text-3)">
          <span>epoch 0</span><span class="spacer"></span><span>loss curve</span>
          <span class="spacer"></span><span>epoch ${m.epochsDone || m.history[m.history.length - 1].epoch}</span>
        </div>

        <dl class="kv" style="margin-top:11px">
          <dt>trained on</dt><dd>${fmtInt(m.nTrain)} days (${m.span[0]} to ${m.span[1]})</dd>
          <dt>held out</dt><dd>${fmtInt(m.nTest)} days, strictly later in time</dd>
          <dt>positives</dt><dd>${fmtInt(m.positives)} high-impact days (${pct(m.metrics.positiveRate, 1)} of held-out days)</dd>
          <dt>observed</dt><dd>${m.observedLabels} label${m.observedLabels === 1 ? '' : 's'} from citizen flood reports</dd>
          <dt>threshold</dt><dd>${m.tailThreshold} mm/day (97th percentile of the record)</dd>
          <dt>trained</dt><dd>${ago(m.trainedAt)} on this device</dd>
        </dl>

        <details class="disclosure" style="margin-top:11px">
          <summary>${icon('info', 14)} What this model can and cannot tell you</summary>
          <div>
            <p><strong>The labels are a proxy.</strong> No open per-village flood record exists for
            Saipan, so a day counts as high-impact when its rainfall lands in the top 3% of the
            2015-present record, or the two-day total clears 75 mm. The model therefore learns
            "extreme rainfall day", which is a strong but imperfect stand-in for "flooding happened".</p>
            <p><strong>The today head is a diagnostic, not a forecast.</strong> It uses today's
            rainfall, which is part of how the label is built, so its AUC is flattered. Judge the
            forecasting claim on the tomorrow head instead: no leakage, much lower skill, and it
            still beats a climatology baseline on Brier score.</p>
            <p><strong>Every flood report you file becomes a real label.</strong> Observed dates
            override the proxy on retrain, so the training set gets less synthetic with use. That
            is the whole point of pairing a model with a reporting network.</p>
            <p><strong>Probabilities are prior-corrected.</strong> Training weights the rare
            positive class up, which inflates raw outputs; inference subtracts
            ln(wPos/wNeg) = ${fmt(m.priorShift, 2)} from the logit so the displayed numbers are
            calibrated rather than alarmist.</p>
          </div>
        </details>

        <button class="btn btn-sm btn-ghost" style="margin-top:10px" id="retrain">
          ${icon('sync', 13)} Retrain with my reports included
        </button>` : ''}
    </div>

    ${m ? `
      <div class="card">
        <div class="card-head"><h2>What the model learned</h2></div>
        <div class="weights">
          ${m.weights.map((wt, i) => {
            const f = FEATURES[i];
            const maxAbs = Math.max(...m.weights.map(Math.abs)) || 1;
            const width = (Math.abs(wt) / maxAbs) * 48;
            return `<div class="weight-row" title="${escapeHtml(f.hint)}">
              <span class="weight-name">${escapeHtml(f.label)}</span>
              <span class="weight-track">
                <span class="zero"></span>
                <i class="${wt >= 0 ? 'pos' : 'neg'}" style="width:${width.toFixed(1)}%;${wt >= 0 ? 'left:50%' : 'right:50%'}"></i>
              </span>
              <span class="weight-val">${wt >= 0 ? '+' : ''}${fmt(wt, 2)}</span>
            </div>`;
          }).join('')}
        </div>
        <div class="source-note">
          Standardised coefficients, so magnitudes are comparable. Positive pushes toward a
          high-impact day. Features are z-scored on the training split only.
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <h2>Scenario</h2>
          <span class="card-kicker">projected impact</span>
        </div>
        <div class="scenario-pills" id="scenario-pills">
          ${SCENARIOS.map((sc) => `
            <button class="chip ${S.scenario === sc.id ? 'active' : ''}" data-scenario="${sc.id}">
              ${escapeHtml(sc.label)}
            </button>`).join('')}
          <button class="chip ${S.scenario === 'custom' ? 'active' : ''}" data-scenario="custom">
            Dial your own
          </button>
        </div>
        <p style="margin:9px 0 0;font-size:.82rem">
          ${escapeHtml(S.scenario === 'custom'
            ? 'Move a slider and the model re-scores all 31 villages as you drag.'
            : SCENARIOS.find((x) => x.id === S.scenario).desc)}
        </p>

        ${S.scenario === 'custom' ? renderScenarioSliders() : ''}

        ${risk ? `
          <div class="grid grid-3" style="margin-top:11px">
            ${metricTile({
              label: 'Island hazard', value: `<span id="sc-hazard">${riskScore(risk.hazard)}</span>`,
              unit: '%', tone: band(risk.hazard).key,
            })}
            ${metricTile({
              label: 'People exposed', value: `<span id="sc-exposed">${fmtInt(risk.populationExposed)}</span>`,
              sub: 'moderate risk or above', tone: risk.populationExposed > 8000 ? 'alert' : 'watch',
            })}
            ${metricTile({
              label: 'Villages', value: `<span id="sc-villages">${risk.villagesAtRisk}</span>`,
              unit: `/ ${S.island.villages.length}`,
              sub: 'at risk', tone: risk.villagesAtRisk > 8 ? 'alert' : 'ok',
            })}
          </div>

          ${renderWhy()}

          <div class="table-scroll" style="margin-top:11px">
            <table class="vtable">
              <thead><tr>
                <th>Village</th><th>Risk (relative)</th><th class="num">Score</th>
                <th class="num">Pop</th><th class="num">Elev</th><th>Driver</th>
              </tr></thead>
              <tbody id="risk-rows">
                ${riskRows(risk)}
              </tbody>
            </table>
          </div>

          <div class="source-note">
            Village risk = island hazard x (0.35 + 1.25 x vulnerability), plus a surge term for low
            coastal villages when swell exceeds 2.5 m. Vulnerability weights:
            ${Object.entries(VULN_WEIGHTS).map(([k, v]) => `${k.replace('_', ' ')} ${pct(v)}`).join(' &middot; ')}.
            Elevation enters as 1/(1 + h/${ELEV_HALF_M}), so exposure halves by ${ELEV_HALF_M} m and keeps
            falling after; elevation and drainage are measured from a 30 m DEM, flood history is not.
            Two or more ground reports in 24 h floor a village at High regardless of the model.
            Bars are scaled to the highest village for the selected scenario; the score column is the
            absolute probability. On a settled day every absolute score sits near zero, which is the
            correct answer rather than a broken gauge - switch scenario to see the model respond.
          </div>` : ''}
      </div>` : ''}`;

  const retrain = host.querySelector('#retrain');
  if (retrain) retrain.addEventListener('click', () => trainModel());

  host.querySelectorAll('#scenario-pills [data-scenario]').forEach((b) => {
    b.addEventListener('click', () => {
      S.scenario = b.dataset.scenario;
      if (S.scenario === 'custom') seedCustom();
      recompute();
      renderModelView();
      renderMapView();
    });
  });

  wireScenarioSliders(host);

  host.querySelectorAll('#head-switch [data-head]').forEach((b) => {
    b.addEventListener('click', async () => {
      S.head = b.dataset.head;
      const cached = await loadModel(S.head);
      if (cached) {
        S.model = cached;
        S.modelState = 'ready';
        recompute();
        render();
      } else {
        trainModel(S.head);
      }
    });
  });

  host.querySelectorAll('[data-village]').forEach((row) => {
    row.addEventListener('click', () => showVillage(row.dataset.village));
  });
}

/* Percentages below 10 keep a decimal. A calm day genuinely scores near zero,
   and rounding that to a flat "0" everywhere makes a correct answer look like a
   broken gauge. */
function riskScore(p) {
  const v = (p || 0) * 100;
  if (v >= 10) return String(Math.round(v));
  if (v >= 0.1) return v.toFixed(1);
  return v > 0 ? '<0.1' : '0';
}

/* The four inputs a person actually reasons about. Antecedent rain and wet
   hours follow from them rather than demanding their own sliders: nobody
   thinks in "wet hours", and an interface with eight sliders is a form. */
const DIALS = [
  { key: 'rain1',    label: 'Rain today',        min: 0, max: 250, step: 5, unit: 'mm' },
  { key: 'rain3',    label: 'Rain prior 3 days', min: 0, max: 200, step: 5, unit: 'mm' },
  { key: 'windMax',  label: 'Max wind',          min: 0, max: 200, step: 5, unit: 'km/h' },
  { key: 'presAnom', label: 'Pressure deficit',  min: 0, max: 60,  step: 1, unit: 'hPa' },
];

/** Seed the dials from whatever is on screen, so dragging starts from there. */
function seedCustom() {
  const base = S.derived.activeFeatures || S.derived.features || {};
  S.custom = {
    rain1: Math.round(base.rain1 || 0),
    rain3: Math.round(base.rain3 || 0),
    rain7: Math.round(base.rain7 || 0),
    wetHours: base.wetHours || 0,
    windMax: Math.round(base.windMax || 0),
    presAnom: Math.round(base.presAnom || 0),
    presTrend: base.presTrend || 0,
    wetSeason: base.wetSeason ?? 1,
  };
}

function renderScenarioSliders() {
  if (!S.custom) seedCustom();
  return `<div class="dials" id="dials">
    ${DIALS.map((d) => `
      <div class="dial">
        <label for="dial-${d.key}">
          ${escapeHtml(d.label)}
          <output id="out-${d.key}">${Math.round(S.custom[d.key])} ${escapeHtml(d.unit)}</output>
        </label>
        <input type="range" id="dial-${d.key}" data-dial="${d.key}"
               min="${d.min}" max="${d.max}" step="${d.step}" value="${S.custom[d.key]}">
      </div>`).join('')}
    <div class="field-hint" style="grid-column:1/-1">
      Rain over 7 days and wet hours are carried from the live reading rather than dialled, so a
      scenario stays physically coherent. Swell scales with wind to drive the surge term.
    </div>
  </div>`;
}

function wireScenarioSliders(host) {
  const dials = host.querySelector('#dials');
  if (!dials) return;

  let frame = null;
  dials.querySelectorAll('[data-dial]').forEach((input) => {
    input.addEventListener('input', () => {
      const key = input.dataset.dial;
      const meta = DIALS.find((d) => d.key === key);
      S.custom[key] = Number(input.value);

      /* Keep the derived features consistent with what was dialled: a week's
         rain cannot be less than the three days inside it. */
      S.custom.rain7 = Math.max(S.custom.rain7, S.custom.rain3);
      S.custom.wetHours = Math.min(24, Math.round(S.custom.rain1 / 8));

      const out = host.querySelector(`#out-${key}`);
      if (out) out.textContent = `${Math.round(S.custom[key])} ${meta.unit}`;

      /* Recompute on a frame so a drag stays at pointer rate instead of
         queueing one full re-score per input event. */
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        recompute();
        paintScenarioOutputs(host);
        if (S.map) {
          S.map.drawRiskSurface(S.derived.risk);
          S.map.drawRisk(S.derived.risk);
        }
      });
    });
  });
}

/* Repaint only the numbers and rows the dials affect. Re-rendering the whole
   view mid-drag would tear the slider out from under the pointer. */
function paintScenarioOutputs(host) {
  const risk = S.derived.risk;
  if (!risk) return;

  const set = (sel, text) => { const el = host.querySelector(sel); if (el) el.textContent = text; };
  set('#sc-hazard', riskScore(risk.hazard));
  set('#sc-exposed', fmtInt(risk.populationExposed));
  set('#sc-villages', String(risk.villagesAtRisk));

  const body = host.querySelector('#risk-rows');
  if (body) body.innerHTML = riskRows(risk);
}

function riskRows(risk) {
  return risk.villages.map((v) => `
                  <tr data-village="${v.id}">
                    <td>${escapeHtml(v.name)}</td>
                    <td><div class="bar-cell">
                      <span class="track"><i class="fill" style="width:${((v.relative || 0) * 100).toFixed(0)}%;background:${v.band.color}"></i></span>
                    </div></td>
                    <td class="num" style="color:${v.band.color}">${riskScore(v.risk)}</td>
                    <td class="num">${fmtInt(v.pop)}</td>
                    <td class="num">${v.elev_m}</td>
                    <td>${v.drivenBy === 'observations'
                      ? `<span class="badge badge-info">${v.confirmations} report${v.confirmations > 1 ? 's' : ''}</span>`
                      : '<span style="color:var(--text-3);font-size:.72rem">model</span>'}</td>
                  </tr>`).join('');
}

function renderWhy() {
  if (!S.model || !S.derived.activeFeatures) return '';
  const contribs = explain(S.model, S.derived.activeFeatures).slice(0, 4);

  return `<details class="disclosure" style="margin-top:11px">
    <summary>${icon('info', 14)} Why this number, right now</summary>
    <div>
      <p style="font-size:.78rem">Largest contributions to the logit for the active scenario:</p>
      <dl class="kv">
        ${contribs.map((c) => `
          <dt>${escapeHtml(c.label)}</dt>
          <dd>${fmt(c.raw, 1)} ${escapeHtml(c.unit)}
            <span style="color:var(--text-3)">(z ${c.z >= 0 ? '+' : ''}${c.z}, weight ${c.weight >= 0 ? '+' : ''}${c.weight})</span>
            &rarr; <strong style="color:${c.contribution >= 0 ? 'var(--alert)' : 'var(--accent)'}">
            ${c.contribution >= 0 ? '+' : ''}${fmt(c.contribution, 2)}</strong></dd>`).join('')}
      </dl>
    </div>
  </details>`;
}

function showVillage(id) {
  const v = S.island.villages.find((x) => x.id === id);
  if (!v) return;

  const r = S.derived.risk ? S.derived.risk.villages.find((x) => x.id === id) : null;
  const g = S.derived.grid ? S.derived.grid.villages.find((x) => x.id === id) : null;
  const rel = S.derived.rel ? S.derived.rel.villages.find((x) => x.id === id) : null;
  const expect = S.derived.rel ? restoreExpectation(id, S.island, S.derived.rel) : null;
  const zone = S.island.water_zones.find((z) => z.id === v.water_zone);

  openSheet({
    title: v.name,
    body: `
      <div class="row row-wrap" style="margin-bottom:11px">
        ${r ? badge(r.band.label + ' flood risk', r.band.key) : ''}
        ${badge('feeder ' + v.feeder, 'mute')}
        ${badge(v.elev_m + ' m', 'info')}
      </div>

      <p>${escapeHtml(v.notes)}</p>

      ${r ? `
        <div class="card" style="box-shadow:none;margin-bottom:11px">
          <div class="card-kicker" style="margin-bottom:7px">Risk breakdown</div>
          <div class="ici-drivers">
            ${Object.entries(r.vulnerability.parts).map(([k, val]) => `
              <div class="driver">
                <span class="driver-name">${escapeHtml(k.replace('_', ' '))}</span>
                <span class="driver-bar"><i style="width:${(val / 0.44 * 100).toFixed(0)}%;background:var(--accent)"></i></span>
                <span class="driver-val">${fmt(val, 2)}</span>
              </div>`).join('')}
          </div>
          <dl class="kv" style="margin-top:9px">
            <dt>vulnerability</dt><dd>${fmt(r.vulnerability.score, 3)}</dd>
            <dt>surge term</dt><dd>${fmt(r.surge, 3)}</dd>
            <dt>final score</dt><dd><strong style="color:${r.band.color}">${r.risk100}/100</strong> (${r.drivenBy})</dd>
          </dl>
        </div>` : ''}

      ${g ? `
        <div class="card" style="box-shadow:none;margin-bottom:11px">
          <div class="card-kicker" style="margin-bottom:7px">Utility status</div>
          <dl class="kv">
            <dt>power</dt><dd><strong style="color:${STATUS[g.power.status].color}">${STATUS[g.power.status].label}</strong>
              <span style="color:var(--text-3)">${escapeHtml(g.power.note)}</span></dd>
            <dt>water</dt><dd><strong style="color:${STATUS[g.water.status].color}">${STATUS[g.water.status].label}</strong>
              <span style="color:var(--text-3)">${escapeHtml(g.water.note)}</span></dd>
            <dt>zone</dt><dd>${escapeHtml(zone ? zone.name : v.water_zone)} &middot; ${escapeHtml(zone ? zone.typical_window : '')}</dd>
            ${rel && rel.powerEpisodes ? `
              <dt>history</dt><dd>${rel.powerEpisodes} power episode${rel.powerEpisodes > 1 ? 's' : ''} in
                ${S.derived.rel.windowDays} days &middot; median ${dur(rel.medianRestoreH)}</dd>` : ''}
            ${expect ? `<dt>expect</dt><dd>${escapeHtml(expect.label)}: ${dur(expect.medianH)}
              <span style="color:var(--text-3)">(n=${expect.n}, ${escapeHtml(expect.basis)})</span></dd>` : ''}
          </dl>
        </div>` : ''}

      <div class="source-note">
        ${v.terrain_src === 'measured'
          ? `Elevation ${v.elev_m}&nbsp;m and slope ${v.slope_pct}% are measured from the SRTM 30&nbsp;m
             DEM over this village's built-up ground${v.coord_src === 'osm-place-node'
               ? ', anchored on its OpenStreetMap place node' : ''}; the drainage score is derived
             from that slope. Flood history is still a prototype estimate.`
          : `Elevation, drainage and flood-history values for this village are prototype estimates &mdash;
             too few buildings are mapped near its coordinate to measure it honestly.`}
        See the README for what must be replaced with official CNMI data.
      </div>`,
    footer: `<button class="btn btn-ghost" data-close>Close</button>
             <button class="btn btn-primary" id="v-report">Report from here</button>`,
    onMount(sheet, close) {
      sheet.querySelector('#v-report').addEventListener('click', () => {
        close();
        newReport({ lat: v.lat, lon: v.lon });
      });
    },
  });
}

/* ========================== Grid view =================================== */

function renderGridView() {
  const host = document.getElementById('view-grid');
  if (!host) return;

  const g = S.derived.grid;
  const rel = S.derived.rel;
  if (!g) return;

  host.innerHTML = `
    <div class="view-head">
      <h1>Grid and water status</h1>
      <p class="lede">Built from resident reports. Two independent observers are required before a
      village is called out.</p>
    </div>

    <div class="card">
      <div class="card-head">
        <span style="color:${g.islandWide ? 'var(--crit)' : 'var(--watch)'}">${icon('bolt', 18)}</span>
        <h2>${escapeHtml(g.headline)}</h2>
        ${badge(ago(g.updatedAt), 'mute')}
      </div>
      <div class="grid grid-4">
        ${metricTile({ label: 'Without power', value: fmtInt(g.popNoPower), unit: 'ppl',
          sub: pct(g.pctNoPower, 1) + ' of island', tone: g.popNoPower ? 'crit' : 'ok' })}
        ${metricTile({ label: 'Without water', value: fmtInt(g.popNoWater), unit: 'ppl', tone: g.popNoWater ? 'warn' : 'ok' })}
        ${metricTile({ label: 'Open hazards', value: fmtInt(g.hazardCount), tone: g.hazardCount ? 'warn' : 'ok' })}
        ${metricTile({ label: 'Reports used', value: fmtInt(S.reports.filter((r) => r.category === 'power' || r.category === 'water').length) })}
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h2>Feeders</h2><span class="card-kicker">CUC distribution</span></div>
      <div class="list">
        ${g.feeders.map((f) => {
          const tone = f.status === 'down' ? 'crit' : f.status === 'degraded' ? 'warn' : f.status === 'reported' ? 'watch' : 'ok';
          const relF = rel.feeders.find((x) => x.id === f.id);
          return `<div class="list-item">
            <span class="status-dot ${tone === 'crit' ? 'crit' : tone === 'warn' ? 'warn' : tone === 'watch' ? 'watch' : 'ok'}"></span>
            <span class="list-item-main">
              <span class="list-item-title">${escapeHtml(f.name)}
                ${f.inferred ? badge('feeder-level event inferred', 'crit') : ''}</span>
              <span class="list-item-sub">
                ${f.villages.length} villages &middot; source ${escapeHtml(f.source)}
                ${f.popAffected ? ` &middot; ${fmtInt(f.popAffected)} affected` : ''}
                ${relF && relF.sampleSize ? ` &middot; median restore ${dur(relF.medianRestoreH)} (n=${relF.sampleSize})` : ''}
              </span>
            </span>
            <span class="list-item-meta">${escapeHtml(f.status)}</span>
          </div>`;
        }).join('')}
      </div>
      <div class="source-note">
        Feeder membership is a prototype approximation, not CUC's switching diagram. When at least
        half the villages on one feeder report loss together, the app infers a feeder-level fault
        instead of many unrelated household faults.
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <h2>Village status</h2>
        <button class="btn btn-sm btn-primary" data-report-new>${icon('report', 13)} Report outage</button>
      </div>
      <div class="table-scroll">
        <table class="vtable">
          <thead><tr>
            <th>Village</th><th>Power</th><th>Water</th>
            <th class="num">Obs</th><th class="num">Conf</th><th class="num">Out for</th>
          </tr></thead>
          <tbody>
            ${g.villages
              .slice()
              .sort((a, b) => rank(b.power.status) - rank(a.power.status) || b.pop - a.pop)
              .map((v) => `
                <tr data-village="${v.id}">
                  <td>${escapeHtml(v.name)}</td>
                  <td><span class="row" style="gap:5px">
                    <span class="status-dot ${dotFor(v.power.status)}"></span>
                    <span style="font-size:.74rem">${escapeHtml(v.power.status)}</span></span></td>
                  <td><span class="row" style="gap:5px">
                    <span class="status-dot ${dotFor(v.water.status)}"></span>
                    <span style="font-size:.74rem">${escapeHtml(v.water.status)}</span></span></td>
                  <td class="num">${v.power.observers}</td>
                  <td class="num">${v.power.confidence ? fmt(v.power.confidence, 2) : '--'}</td>
                  <td class="num">${v.power.durationH ? dur(v.power.durationH) : '--'}</td>
                </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <h2>Reliability record</h2>
        <span class="card-kicker">last ${rel.windowDays} days</span>
      </div>
      ${rel.totals.powerEpisodes ? `
        <div class="grid grid-3" style="margin-bottom:11px">
          ${metricTile({ label: 'Power episodes', value: fmtInt(rel.totals.powerEpisodes) })}
          ${metricTile({ label: 'Water episodes', value: fmtInt(rel.totals.waterEpisodes) })}
          ${metricTile({ label: 'Median restore', value: dur(rel.totals.medianRestoreH) })}
        </div>
        <div class="table-scroll">
          <table class="vtable">
            <thead><tr>
              <th>Village</th><th class="num">Episodes</th><th class="num">Per month</th>
              <th class="num">Median restore</th><th class="num">Longest</th><th>Observed uptime</th>
            </tr></thead>
            <tbody>
              ${rel.villages.filter((v) => v.powerEpisodes || v.waterEpisodes).map((v) => `
                <tr data-village="${v.id}">
                  <td>${escapeHtml(v.name)}</td>
                  <td class="num">${v.powerEpisodes}</td>
                  <td class="num">${v.episodesPerMonth}</td>
                  <td class="num">${dur(v.medianRestoreH)}</td>
                  <td class="num">${dur(v.longestH)}</td>
                  <td><div class="bar-cell">
                    <span class="track"><i class="fill" style="width:${((v.observedUptime ?? 1) * 100).toFixed(1)}%;
                      background:${(v.observedUptime ?? 1) > 0.98 ? 'var(--ok)' : (v.observedUptime ?? 1) > 0.94 ? 'var(--watch)' : 'var(--alert)'}"></i></span>
                    <span style="font-size:.68rem">${pct(v.observedUptime, 2)}</span>
                  </div></td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
        <div class="source-note">
          <strong>Observed uptime is not CUC's uptime.</strong> It is the share of the window in which
          this network held no corroborated outage report for that village, so it depends entirely on
          how many people report. Treat small sample sizes with care: the n is shown for every median.
        </div>` : `
        ${emptyState('No outage history yet. File power or water reports and the record builds itself.', 'clock')}
        <button class="btn btn-sm btn-ghost btn-block" style="margin-top:10px" id="load-demo">
          ${icon('users', 13)} Load the demo scenario
        </button>
        <div class="source-note">
          The demo week injects clearly marked synthetic reports so the aggregation, confidence
          scoring and scorecard can be seen working. Every demo row is tagged and can be purged in
          one tap from Settings.
        </div>`}
    </div>`;

  host.querySelectorAll('[data-village]').forEach((row) => {
    row.addEventListener('click', () => showVillage(row.dataset.village));
  });

  const demo = host.querySelector('#load-demo');
  if (demo) demo.addEventListener('click', loadDemoScenario);

  wireViewButtons(host);
}

function rank(status) {
  return { down: 4, degraded: 3, reported: 2, up: 1, unknown: 0 }[status] || 0;
}

function dotFor(status) {
  return { down: 'crit', degraded: 'warn', reported: 'watch', up: 'ok', unknown: 'unknown' }[status] || 'unknown';
}

/* ==========================================================================
   Demo data - clearly labelled, one-tap purge
   ========================================================================== */

/**
 * Load the demo scenario.
 *
 * Most of the time Saipan is fine, which is the correct reading of a calm day
 * and a poor demonstration. This seeds one coherent story across every view so
 * cause and effect can be followed between tabs. Every row is tagged `demo`,
 * badged in the UI, announced by a banner, and removable in one tap.
 */
async function loadDemoScenario() {
  const rows = buildDemoReports(S.island);
  for (const r of rows) await putReport(r);
  await metaSet('demo_loaded', true);

  /* A settled day scores near zero everywhere, so the storm the reports
     describe is also selected in the model. Otherwise the risk map stays
     blank while the reports say the island is flooding. */
  S.scenario = 'trop';

  S.reports = await allReports();
  recompute();
  render();

  if (S.map) {
    S.map.drawRisk(S.derived.risk);
    S.map.drawReports(S.reports, S.science.report_categories);
    S.map.drawGrid(S.derived.grid, S.island);
  }

  toast(`${rows.length} labelled demo reports loaded`, 'warn', 5000);
}

async function purgeDemo() {
  const demo = S.reports.filter((r) => r.demo);
  const { deleteReport } = await import('./store.js');
  for (const r of demo) await deleteReport(r.id);
  await metaSet('demo_loaded', false);

  S.reports = await allReports();
  recompute();
  render();
  toast(`Removed ${demo.length} demo reports`, 'ok');
}

/* ==========================================================================
   Shared actions
   ========================================================================== */

function newReport(prefill = {}) {
  openComposer({
    categories: S.science.report_categories,
    villages: S.island.villages,
    invasives: S.science.invasive_watchlist,
    prefill,
    onSaved: async () => {
      S.reports = await allReports();
      recompute();
      render();
      doSync({ quiet: true });
    },
  });
}

function showReport(r) {
  if (!r) return;
  const cat = S.science.report_categories.find((c) => c.id === r.category) || { label: r.category };
  const details = Object.entries(r.detail || {}).filter(([, v]) => v !== '' && v != null);

  openSheet({
    title: cat.label,
    body: `
      <div class="row row-wrap" style="margin-bottom:11px">
        ${badge(['', 'minor', 'moderate', 'serious', 'severe'][r.severity] || 'unrated', 'mute')}
        ${r.status === 'resolved' ? badge('resolved', 'ok') : badge('open', 'watch')}
        ${r.sync_state === 'pending' ? badge('on device', 'info') : badge('synced', 'ok')}
        ${r.demo ? badge('demo data', 'crit') : ''}
      </div>
      ${r.photo ? `<img src="${r.photo}" alt="" style="width:100%;border-radius:10px;margin-bottom:11px">` : ''}
      ${r.note ? `<p>${escapeHtml(r.note)}</p>` : ''}
      <dl class="kv">
        <dt>when</dt><dd>${localTime(r.created_at)} ChST (${ago(r.created_at)})</dd>
        <dt>where</dt><dd>${escapeHtml(r.village_name || 'unlocated')}
          ${r.lat != null ? `<br><span style="font-size:.7rem">${r.lat.toFixed(5)}, ${r.lon.toFixed(5)}</span>` : ''}</dd>
        <dt>observer</dt><dd>${escapeHtml(r.observer_id)}</dd>
        ${details.map(([k, v]) => `<dt>${escapeHtml(k.replace(/_/g, ' '))}</dt><dd>${escapeHtml(String(v))}</dd>`).join('')}
      </dl>`,
    footer: `
      <button class="btn btn-ghost" data-close>Close</button>
      ${(r.category === 'power' || r.category === 'water') && r.status !== 'resolved'
        ? '<button class="btn btn-primary" id="rp-resolve">Service is back</button>' : ''}`,
    onMount(sheet, close) {
      const btn = sheet.querySelector('#rp-resolve');
      if (btn) {
        btn.addEventListener('click', async () => {
          await resolveReport(r);
          S.reports = await allReports();
          recompute();
          render();
          close();
          toast('Marked restored, episode closed', 'ok');
        });
      }
    },
  });
}

async function doSync({ quiet = false } = {}) {
  const res = await flushQueue();

  if (res.reason === 'no-endpoint') {
    if (!quiet) {
      toast(`${res.queued} report${res.queued === 1 ? '' : 's'} held on device: no sync endpoint set`, 'warn', 4200);
    }
    return;
  }
  if (res.reason === 'offline') {
    if (!quiet) toast('Offline, reports stay queued', 'warn');
    return;
  }
  if (res.sent) {
    S.reports = await allReports();
    render();
    toast(`Synced ${res.sent} report${res.sent === 1 ? '' : 's'}`, 'ok');
  } else if (!quiet && res.reason === 'failed') {
    toast('Sync failed, reports kept on device', 'err');
  }
}

/* ==========================================================================
   Chrome: nav, network state, settings
   ========================================================================== */

function wireChrome() {
  document.querySelectorAll('.tabbar [data-view]').forEach((b) => {
    b.addEventListener('click', () => switchView(b.dataset.view));
  });

  const fab = document.getElementById('settings-btn');
  if (fab) fab.addEventListener('click', openSettings);

  wireTheme();

  window.addEventListener('online', () => {
    setNet('online');
    refreshFeeds();
    doSync({ quiet: true });
  });
  window.addEventListener('offline', () => setNet('offline'));

  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-report-new]');
    if (t) newReport();
  });

  setNet(navigator.onLine ? 'online' : 'offline');
}

/* Three states, matching how the OS thinks about it: follow the system until
   the reader expresses a preference, then honour that preference. */
function wireTheme() {
  const btn = document.getElementById('theme-btn');
  if (!btn) return;

  const systemDark = () => window.matchMedia('(prefers-color-scheme: dark)').matches;
  const current = () => document.documentElement.dataset.theme
    || (systemDark() ? 'dark' : 'light');

  const paint = () => {
    const dark = current() === 'dark';
    btn.innerHTML = icon(dark ? 'moon' : 'sun', 17);
    btn.setAttribute('aria-label', dark ? 'Switch to light appearance' : 'Switch to dark appearance');
  };

  btn.addEventListener('click', () => {
    const next = current() === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('son-theme', next); } catch { /* private mode */ }
    paint();
    /* Charts bake their colours in at render time, so repaint them. */
    render();
    if (S.map) {
      S.map.refreshBasemap();
      S.map.drawRiskSurface(S.derived.risk);
      S.map.drawRisk(S.derived.risk);
      S.map.drawReports(S.reports, S.science.report_categories);
      S.map.drawGrid(S.derived.grid, S.island);
      S.map.drawReefs(S.science.reef_sites, S.derived.dhw ? S.derived.dhw.alert.level : 0);
    }
  });

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (!document.documentElement.dataset.theme) { paint(); render(); }
  });

  paint();
}

function wireViewButtons(scope) {
  scope.querySelectorAll('[data-goto]').forEach((b) => {
    b.addEventListener('click', () => switchView(b.dataset.goto));
  });
}

let enterTimer = null;

function switchView(view) {
  S.view = view;

  document.querySelectorAll('.view').forEach((v) => {
    const isTarget = v.id === 'view-' + view;
    v.classList.toggle('active', isTarget);
    v.classList.toggle('entering', isTarget);
  });

  clearTimeout(enterTimer);
  enterTimer = setTimeout(() => {
    document.querySelectorAll('.view.entering').forEach((v) => v.classList.remove('entering'));
  }, 500);
  document.querySelectorAll('.tabbar [data-view]').forEach((b) => {
    if (b.dataset.view === view) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });

  if (view === 'map') {
    renderMapView();
    if (S.map) setTimeout(() => S.map.resize(), 80);
  }

  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function setNet(state) {
  const pill = document.getElementById('net-pill');
  if (!pill) return;

  pill.dataset.state = state;
  const label = { online: 'live', offline: 'offline', syncing: 'updating' }[state] || state;
  pill.querySelector('.net-label').textContent = label;
  pill.querySelector('.net-icon').innerHTML = icon(state === 'offline' ? 'wifiOff' : 'wifi', 12);
}

async function paintQueueBadges() {
  const queued = await pendingReports();
  const badgeEl = document.getElementById('queue-badge');
  if (badgeEl) badgeEl.dataset.count = String(queued.length);

  const tabDot = document.getElementById('tab-dot-field');
  if (tabDot) tabDot.dataset.count = String(queued.length);
}

async function openSettings() {
  const endpoint = await syncEndpoint();
  const est = await storageEstimate();
  const obs = await observerId();
  const demoCount = S.reports.filter((r) => r.demo).length;

  openSheet({
    title: 'Settings and provenance',
    body: `
      <div class="field">
        <label>Sync endpoint (optional)</label>
        <input type="text" id="set-endpoint" value="${escapeHtml(endpoint)}"
          placeholder="https://your-server.example/reports">
        <div class="field-hint">
          Leave this empty and reports stay on this device only. Set an HTTPS endpoint that accepts
          a JSON POST and the queue drains to it whenever a connection is available.
        </div>
      </div>

      <dl class="kv" style="margin-bottom:14px">
        <dt>observer id</dt><dd>${escapeHtml(obs)} <span style="color:var(--text-3)">(device-local, anonymous)</span></dd>
        <dt>reports held</dt><dd>${S.reports.length} (${S.reports.filter((r) => r.sync_state === 'pending').length} unsent)</dd>
        <dt>storage used</dt><dd>${est ? (est.used / 1048576).toFixed(1) + ' MB of ' + (est.quota / 1048576).toFixed(0) + ' MB' : 'unknown'}</dd>
        <dt>model</dt><dd>${S.model ? `${HEADS[S.model.head].label}, trained ${ago(S.model.trainedAt)}` : 'not trained'}</dd>
        <dt>offline shell</dt><dd>${'serviceWorker' in navigator ? 'service worker available' : 'not supported here'}</dd>
      </dl>

      <details class="disclosure" style="margin-bottom:11px">
        <summary>${icon('info', 14)} Data provenance and honest limits</summary>
        <div>
          <p><strong>Live, real:</strong> weather and marine conditions (Open-Meteo), NWS forecast and
          alerts for zone ${SAIPAN.nwsZone}, USGS seismicity, NASA GIBS imagery, and ERA5 reanalysis
          used for model training.</p>
          <p><strong>Measured, for ${S.island.villages.filter((v) => v.terrain_src === 'measured').length}
          of ${S.island.villages.length} villages:</strong> elevation and slope from the
          <strong>SRTM 30&nbsp;m</strong> digital elevation model (NASA/USGS, via Open-Topo-Data), sampled over the
          ground each village's buildings actually stand on using <strong>OpenStreetMap</strong> footprints; the
          drainage score is derived from that measured slope. Every village says which it is.</p>
          <p><strong>Prototype estimates, must be replaced:</strong> flood-history scores everywhere &mdash; 0.44
          of the vulnerability index still rests on a judgement; elevation and drainage for the
          ${S.island.villages.filter((v) => v.terrain_src !== 'measured').length} villages with too few mapped buildings to measure; the coastal flag, which
          depends on reef and aspect, not distance; village populations; CUC feeder membership and
          water zones; the ${CORAL_MMM}&deg;C bleaching baseline. Sources to swap in are listed in the README.</p>
          <p><strong>Crowd-derived, never authoritative:</strong> every outage and hazard status on
          this map comes from residents, with observer counts and confidence shown. This app is not
          CUC, BECQ, DCRM, NWS or any emergency service. In a real emergency call the authorities.</p>
        </div>
      </details>

      ${demoCount ? `
        <button class="btn btn-danger btn-block" id="set-purge-demo" style="margin-bottom:9px">
          ${icon('trash', 14)} Remove ${demoCount} demo reports
        </button>` : `
        <button class="btn btn-ghost btn-block" id="set-load-demo" style="margin-bottom:9px">
          ${icon('users', 14)} Load the demo scenario
        </button>`}

      <div class="field">
        <label>Crisis mode</label>
        <button class="btn ${S.crisis ? 'btn-primary' : 'btn-ghost'} btn-block" id="set-crisis">
          ${icon('shield', 14)} ${S.crisis ? 'Crisis mode is on' : 'Turn on crisis mode'}
        </button>
        <div class="field-hint">
          For a throttled network or a battery you need to last. Turns off satellite imagery,
          trims the feeds to current conditions and official alerts, and slows updates to hourly.
          Filing and storing reports is untouched.
        </div>
      </div>

      <div class="field">
        <label>Export</label>
        <button class="btn btn-ghost btn-block" id="set-sitrep" style="margin-bottom:7px">
          ${icon('flag', 14)} Situation report (printable)
        </button>
        <button class="btn btn-ghost btn-block" id="set-csv" style="margin-bottom:7px">
          ${icon('download', 14)} Reports as CSV
        </button>
        <button class="btn btn-ghost btn-block" id="set-export">
          ${icon('download', 14)} Reports as JSON
        </button>
        <div class="field-hint">
          Community-generated, for sharing with responders or an agency. It is not an official
          product of CUC, BECQ, FEMA or any emergency service, and says so on the page.
        </div>
      </div>
      <button class="btn btn-danger btn-block" id="set-wipe">
        ${icon('trash', 14)} Erase everything on this device
      </button>`,
    footer: '<button class="btn btn-primary btn-block" data-close>Done</button>',
    onMount(sheet, close) {
      sheet.querySelector('#set-endpoint').addEventListener('change', async (e) => {
        await setSyncEndpoint(e.target.value.trim());
        toast(e.target.value.trim() ? 'Sync endpoint saved' : 'Sync endpoint cleared', 'ok');
      });

      const loadBtn = sheet.querySelector('#set-load-demo');
      if (loadBtn) loadBtn.addEventListener('click', () => { close(); loadDemoScenario(); });

      const purgeBtn = sheet.querySelector('#set-purge-demo');
      if (purgeBtn) purgeBtn.addEventListener('click', () => { close(); purgeDemo(); });

      sheet.querySelector('#set-export').addEventListener('click', () => exportJson(exportContext()));
      sheet.querySelector('#set-csv').addEventListener('click', () => exportCsv(exportContext()));
      sheet.querySelector('#set-sitrep').addEventListener('click', () => openSitrep(exportContext()));
      sheet.querySelector('#set-crisis').addEventListener('click', () => { close(); setCrisis(!S.crisis); });

      sheet.querySelector('#set-wipe').addEventListener('click', async () => {
        if (!confirm('Erase all reports, cached feeds and the trained model from this device?')) return;
        await clearAllLocal();
        S.reports = [];
        S.model = null;
        S.modelState = 'idle';
        recompute();
        render();
        close();
        toast('Local data erased', 'ok');
      });
    },
  });
}



/** Everything the exporters need, assembled in one place. */
function exportContext() {
  const sc = SCENARIOS.find((x) => x.id === S.scenario);
  return {
    reports: S.reports,
    derived: S.derived,
    feeds: S.feeds,
    science: S.science,
    island: S.island,
    wave: currentWave(),
    sst: currentSST(),
    scenarioLabel: S.scenario === 'custom' ? 'hand-dialled' : (sc ? sc.label : 'live'),
  };
}

/* ==========================================================================
   Service worker
   ========================================================================== */

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol === 'file:') return;   // no SW from the filesystem

  navigator.serviceWorker.register('sw.js').catch((err) => {
    console.warn('[SON] service worker registration failed', err);
  });
}

/* ========================================================================== */

boot();
