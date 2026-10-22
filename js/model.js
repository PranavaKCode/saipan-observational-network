/* ==========================================================================
   model.js - flood-impact model, trained in the browser
   --------------------------------------------------------------------------
   WHAT THIS IS
     Logistic regression over daily weather features, trained client-side by
     full-batch gradient descent on ERA5 reanalysis for Saipan (Open-Meteo
     archive API, 2015 to yesterday, ~4,300 days). Two heads:

       nowcast  - "today is behaving like a high-impact rainfall day".
                  Uses today's rain, so it is a DIAGNOSTIC, not a forecast.
                  Its headline AUC is flattered because the proxy label is
                  itself built from today's rainfall. Stated plainly in the UI.

       outlook  - "tomorrow will be a high-impact day", using only today and
                  earlier. No leakage, so this is a real forecast and its
                  skill is honestly much lower (test AUC ~0.89, and it beats
                  a climatology baseline on Brier score by ~27%).

     The island-wide probability is then downscaled to villages through an
     explicit hazard x vulnerability formula built from elevation, drainage,
     documented flood history and coastal exposure. Both halves are
     inspectable in the UI - there is no hidden scoring.

     Elevation and drainage are measured: SRTM 30 m sampled over each
     village's built-up ground, drainage derived from the local slope. Five
     villages have too few mapped buildings to measure and keep their hand
     estimates; every village carries terrain_src saying which it is. Flood
     history is an estimate everywhere - 0.44 of the vulnerability index
     therefore still rests on a judgement, which is the largest single soft
     spot in this model. See README.md, Data provenance.

   WHAT THIS IS NOT
     It is not trained on observed floods, because no open per-village flood
     record exists for Saipan. The default labels are a PROXY: days in the
     upper tail of the rainfall distribution.

     Fixing that is the point of the app. Every flood report a resident files
     becomes a real observed label for its date, taking precedence over the
     proxy, so the training set gets less synthetic with use.

   CALIBRATION
     Positives are ~3% of days, so training uses class weights or the model
     would predict "no flood" forever and score 97% accuracy. Class weighting
     inflates the probabilities, so inference applies a prior-correcting logit
     shift of -ln(wPos/wNeg). Ranking comes from the weighted fit, calibrated
     probabilities come after the shift.

   WHY LOGISTIC REGRESSION
     It trains in under a second on a phone, runs offline, and its weights are
     readable - a manager can check that antecedent rain outweighs wind and
     argue with it. On ~4k rows a deep net would be harder to defend and no
     better.
   ========================================================================== */

import { archive } from './feeds.js';
import { metaGet, metaSet } from './store.js';

export const FEATURES = [
  { key: 'rain1',     label: 'Rain today',        unit: 'mm',   hint: 'Daily precipitation total' },
  { key: 'rain3',     label: 'Rain prior 3 days', unit: 'mm',   hint: 'Antecedent wetness, drives saturation' },
  { key: 'rain7',     label: 'Rain prior 7 days', unit: 'mm',   hint: 'Longer-term soil and aquifer wetness' },
  { key: 'wetHours',  label: 'Wet hours',         unit: 'h',    hint: 'Hours with measurable rain, a duration proxy' },
  { key: 'windMax',   label: 'Max wind',          unit: 'km/h', hint: 'Storm intensity and debris potential' },
  { key: 'presAnom',  label: 'Pressure deficit',  unit: 'hPa',  hint: 'How far below the local median pressure sits' },
  { key: 'presTrend', label: 'Pressure trend',    unit: 'hPa',  hint: 'Change since yesterday. Falling pressure means an approaching system' },
  { key: 'wetSeason', label: 'Wet season',        unit: '0/1',  hint: 'July to November, when typhoons track through' },
];

export const HEADS = {
  nowcast: { id: 'nowcast', offset: 0, label: 'Today (diagnostic)', note: 'Includes today’s rainfall, so it describes conditions rather than predicting them.' },
  outlook: { id: 'outlook', offset: 1, label: 'Tomorrow (forecast)', note: 'Uses only today and earlier. A genuine forecast, with genuinely lower skill.' },
};

/* Proxy-label threshold: a day is high-impact if its rainfall sits in the top
   3% of the record, or the two-day total clears 75 mm. Both rainfall-derived,
   hence "proxy". For Saipan 2015-2026 the tail threshold lands near 26 mm. */
const PROXY_PERCENTILE = 0.97;
const PROXY_2DAY_MM = 75;

const TRAIN_START = '2015-01-01';

/* ==========================================================================
   Dataset construction
   ========================================================================== */

function quantile(sorted, q) {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function median(values) {
  const a = values.filter((v) => v != null).slice().sort((x, y) => x - y);
  return a.length ? quantile(a, 0.5) : null;
}

/**
 * Pull ERA5 history and build a supervised dataset.
 * @param {object[]} floodReports  local reports, category 'flood'
 * @param {string}   head          'nowcast' | 'outlook'
 */
export async function buildDataset(floodReports = [], head = 'nowcast') {
  const offset = (HEADS[head] || HEADS.nowcast).offset;
  const end = new Date(Date.now() - 864e5).toISOString().slice(0, 10);

  const res = await archive(TRAIN_START, end);
  if (!res.data || !res.data.daily) {
    throw new Error('Historical weather unavailable and nothing cached yet: ' + (res.error || 'no data'));
  }

  const d = res.data.daily;
  const n = d.time.length;
  const precip = d.precipitation_sum || [];
  const hours = d.precipitation_hours || [];
  const wind = d.wind_speed_10m_max || [];
  const pres = d.surface_pressure_mean || [];

  /* ERA5 pressure here is at the grid-cell elevation (~233 m), not reduced to
     sea level, so the median sits near 964 hPa rather than 1013. Anomalies are
     taken against this local median so training and inference agree. */
  const presMedian = median(pres) ?? 1010;

  const observedFloodDates = new Set(
    floodReports
      .filter((r) => r && r.category === 'flood' && r.created_at)
      .map((r) => String(r.created_at).slice(0, 10)),
  );

  const tailThreshold = quantile(precip.filter((v) => v != null).slice().sort((a, b) => a - b), PROXY_PERCENTILE);
  const at = (arr, i) => (i >= 0 && i < arr.length && arr[i] != null ? arr[i] : 0);

  const rows = [];
  for (let i = 7; i < n - offset; i++) {
    const rain1 = at(precip, i);
    const rain3 = at(precip, i - 1) + at(precip, i - 2) + at(precip, i - 3);
    const rain7 = rain3 + at(precip, i - 4) + at(precip, i - 5) + at(precip, i - 6) + at(precip, i - 7);
    const month = Number(d.time[i].slice(5, 7));
    const pNow = pres[i] != null ? pres[i] : presMedian;
    const pPrev = pres[i - 1] != null ? pres[i - 1] : presMedian;

    const x = {
      rain1,
      rain3,
      rain7,
      wetHours: at(hours, i),
      windMax: at(wind, i),
      presAnom: Math.max(0, presMedian - pNow),
      presTrend: pNow - pPrev,
      wetSeason: month >= 7 && month <= 11 ? 1 : 0,
    };

    /* The labelled day is `offset` days after the feature day. */
    const li = i + offset;
    const labelDate = d.time[li];
    const labelRain = at(precip, li);
    const twoDay = labelRain + at(precip, li - 1);

    const proxy = labelRain >= tailThreshold || twoDay >= PROXY_2DAY_MM ? 1 : 0;
    const observed = observedFloodDates.has(labelDate);

    rows.push({
      date: d.time[i],
      labelDate,
      x,
      y: observed ? 1 : proxy,
      labelSource: observed ? 'observed' : 'proxy',
    });
  }

  return {
    head,
    rows,
    presMedian,
    tailThreshold: +tailThreshold.toFixed(1),
    stale: res.stale,
    cachedAt: res.at,
    observedCount: rows.filter((r) => r.labelSource === 'observed').length,
    positives: rows.filter((r) => r.y === 1).length,
    span: [rows.length ? rows[0].date : null, rows.length ? rows[rows.length - 1].date : null],
  };
}

/* ==========================================================================
   Standardisation - fitted on the training split only, never on test
   ========================================================================== */

function fitScaler(rows) {
  const stats = {};
  for (const f of FEATURES) {
    const vals = rows.map((r) => r.x[f.key]);
    const mean = vals.reduce((a, b) => a + b, 0) / (vals.length || 1);
    const variance = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / (vals.length || 1);
    stats[f.key] = { mean, sd: Math.sqrt(variance) || 1 };
  }
  return stats;
}

function encode(x, scaler) {
  return FEATURES.map((f) => ((x[f.key] ?? 0) - scaler[f.key].mean) / scaler[f.key].sd);
}

/* ==========================================================================
   Training
   ========================================================================== */

const sigmoid = (z) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));

/**
 * @param {object} dataset  from buildDataset
 * @param {object} opts     { epochs, lr, l2, onEpoch }
 */
export function train(dataset, opts = {}) {
  const epochs = opts.epochs ?? 360;
  const lr = opts.lr ?? 0.32;
  const l2 = opts.l2 ?? 0.004;

  const rows = dataset.rows;
  if (rows.length < 200) throw new Error('Not enough history to train on');

  /* Chronological split. The test block is strictly later than the training
     block, so nothing from the future leaks backwards. */
  const cut = Math.floor(rows.length * 0.8);
  const trainRows = rows.slice(0, cut);
  const testRows = rows.slice(cut);

  const scaler = fitScaler(trainRows);
  const Xtr = trainRows.map((r) => encode(r.x, scaler));
  const ytr = trainRows.map((r) => r.y);

  const posCount = ytr.reduce((a, b) => a + b, 0) || 1;
  const negCount = ytr.length - posCount || 1;
  const wPos = ytr.length / (2 * posCount);
  const wNeg = ytr.length / (2 * negCount);

  /* Warm start lets the caller train in slices and yield a frame between them,
     so a phone keeps a responsive UI and a real progress bar instead of a
     half-second freeze. */
  const w = opts.init ? opts.init.weights.slice() : new Array(FEATURES.length).fill(0);
  let b = opts.init ? opts.init.bias : 0;
  const history = opts.init && opts.init.history ? opts.init.history.slice() : [];
  const epochBase = opts.init ? opts.init.epochsDone || 0 : 0;

  for (let epoch = 0; epoch < epochs; epoch++) {
    const gradW = new Array(FEATURES.length).fill(0);
    let gradB = 0;
    let loss = 0;
    let wsum = 0;

    for (let i = 0; i < Xtr.length; i++) {
      const xi = Xtr[i];
      let z = b;
      for (let j = 0; j < w.length; j++) z += w[j] * xi[j];
      const p = sigmoid(z);
      const y = ytr[i];
      const cw = y === 1 ? wPos : wNeg;

      loss += -cw * (y * Math.log(Math.max(p, 1e-12)) + (1 - y) * Math.log(Math.max(1 - p, 1e-12)));
      wsum += cw;

      const g = cw * (p - y);
      for (let j = 0; j < w.length; j++) gradW[j] += g * xi[j];
      gradB += g;
    }

    for (let j = 0; j < w.length; j++) w[j] -= lr * (gradW[j] / wsum + l2 * w[j]);
    b -= lr * (gradB / wsum);

    if (epoch % 4 === 0 || epoch === epochs - 1) {
      history.push({ epoch: epochBase + epoch, loss: +(loss / wsum).toFixed(5) });
      if (opts.onEpoch) opts.onEpoch(epochBase + epoch, loss / wsum, epochs);
    }
  }

  const model = {
    head: dataset.head,
    weights: w,
    bias: b,
    epochsDone: epochBase + epochs,
    /* Undoes class-weight inflation so displayed probabilities are calibrated. */
    priorShift: Math.log(wPos / wNeg),
    scaler,
    featureKeys: FEATURES.map((f) => f.key),
    presMedian: dataset.presMedian,
    tailThreshold: dataset.tailThreshold,
    trainedAt: new Date().toISOString(),
    nTrain: trainRows.length,
    nTest: testRows.length,
    span: dataset.span,
    observedLabels: dataset.observedCount,
    positives: dataset.positives,
    history,
  };

  model.metrics = evaluate(model, testRows);
  model.trainMetrics = evaluate(model, trainRows);
  return model;
}

/**
 * @param {object}  model
 * @param {object}  x
 * @param {boolean} calibrated  apply the prior-correcting shift (default true)
 */
export function predictProb(model, x, calibrated = true) {
  let z = calibrated ? model.bias - (model.priorShift || 0) : model.bias;
  for (let j = 0; j < model.weights.length; j++) {
    const key = model.featureKeys[j];
    const s = model.scaler[key];
    z += model.weights[j] * (((x[key] ?? 0) - s.mean) / s.sd);
  }
  return sigmoid(z);
}

/** Per-feature contribution to the logit, for the "why" panel. */
export function explain(model, x) {
  return model.featureKeys.map((key, j) => {
    const s = model.scaler[key];
    const zScore = ((x[key] ?? 0) - s.mean) / s.sd;
    const meta = FEATURES.find((f) => f.key === key);
    return {
      key,
      label: meta ? meta.label : key,
      unit: meta ? meta.unit : '',
      raw: x[key] ?? 0,
      z: +zScore.toFixed(2),
      weight: +model.weights[j].toFixed(3),
      contribution: +(model.weights[j] * zScore).toFixed(3),
    };
  }).sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
}

/* ==========================================================================
   Evaluation
   ========================================================================== */

export function evaluate(model, rows) {
  if (!rows || !rows.length) return null;

  const scored = rows.map((r) => ({
    p: predictProb(model, r.x, true),
    rank: predictProb(model, r.x, false),
    y: r.y,
  }));

  let tp = 0, fp = 0, tn = 0, fn = 0, brier = 0;
  for (const s of scored) {
    const pred = s.rank >= 0.5 ? 1 : 0;   // decision uses the weighted fit
    if (pred === 1 && s.y === 1) tp++;
    else if (pred === 1 && s.y === 0) fp++;
    else if (pred === 0 && s.y === 0) tn++;
    else fn++;
    brier += (s.p - s.y) ** 2;            // calibration uses corrected probs
  }

  const precision = tp + fp ? tp / (tp + fp) : 0;
  const recall = tp + fn ? tp / (tp + fn) : 0;
  const baseRate = scored.filter((s) => s.y === 1).length / rows.length;
  const brierMean = brier / rows.length;
  const brierClimo = scored.reduce((a, s) => a + (baseRate - s.y) ** 2, 0) / rows.length;

  return {
    n: rows.length,
    accuracy: (tp + tn) / rows.length,
    precision,
    recall,
    f1: precision + recall ? (2 * precision * recall) / (precision + recall) : 0,
    auc: rocAuc(scored),
    brier: brierMean,
    /* Fraction of climatology's squared error removed. Above 0 beats
       "just predict the historical base rate every day". */
    brierSkill: brierClimo ? 1 - brierMean / brierClimo : null,
    confusion: { tp, fp, tn, fn },
    positiveRate: baseRate,
  };
}

/** Rank-based ROC AUC (Mann-Whitney U), ties averaged. */
function rocAuc(scored) {
  const pos = scored.filter((s) => s.y === 1).length;
  const neg = scored.length - pos;
  if (!pos || !neg) return null;

  const sorted = scored.slice().sort((a, b) => a.rank - b.rank);
  const ranks = new Array(sorted.length);
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1].rank === sorted[i].rank) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[k] = avg;
    i = j + 1;
  }

  let rankSumPos = 0;
  for (let k = 0; k < sorted.length; k++) if (sorted[k].y === 1) rankSumPos += ranks[k];
  return (rankSumPos - (pos * (pos + 1)) / 2) / (pos * neg);
}

/* ==========================================================================
   Village downscaling: risk = hazard x vulnerability
   ========================================================================== */

export const VULN_WEIGHTS = {
  flood_history: 0.44,  // where it has flooded, it floods again
  elevation:     0.24,  // low ground ponds and takes surge
  drainage:      0.21,  // karst infiltration vs filled coastal plain
  coastal:       0.11,  // surge and wave overtopping exposure
};

/* Height at which elevation has halved a village's flood exposure.
   Elevation was a linear ramp to 120 m while these numbers were estimates.
   Measured against SRTM they run 6 m to 213 m, and a ramp handles that badly
   in both directions: it flattens the bottom of the range, where the whole
   decision lives - 7 m Chalan Kanoa and 13 m Tanapag are not the same village
   in a flood - and it saturates the top, so Marpi, Navy Hill and Capitol Hill
   all collapse to exactly zero and stop being distinguishable at all.
   Exposure really does fall off fast and then keep falling slowly, so this is
   1/(1 + h/15): half weight by 15 m, a tenth of it by 135 m, never quite zero
   because no ground is perfectly safe. Disagree with the 15 and the whole
   curve moves - that is the point of it being one number. */
export const ELEV_HALF_M = 15;

export function vulnerability(v) {
  const elevTerm = 1 / (1 + Math.max(0, v.elev_m || 0) / ELEV_HALF_M);
  const drainTerm = 1 - (v.drainage ?? 0.5);
  const coastTerm = v.coastal ? 1 : 0;

  const parts = {
    flood_history: +(VULN_WEIGHTS.flood_history * (v.flood_history ?? 0)).toFixed(3),
    elevation: +(VULN_WEIGHTS.elevation * elevTerm).toFixed(3),
    drainage: +(VULN_WEIGHTS.drainage * drainTerm).toFixed(3),
    coastal: +(VULN_WEIGHTS.coastal * coastTerm).toFixed(3),
  };

  return {
    score: +(parts.flood_history + parts.elevation + parts.drainage + parts.coastal).toFixed(3),
    parts,
  };
}

/**
 * @param {object}   model
 * @param {object}   features  today's or a scenario's weather features
 * @param {object[]} villages
 * @param {object}   context   { waveHeight, reportsByVillage }
 */
export function villageRisk(model, features, villages, context = {}) {
  const hazard = predictProb(model, features, true);
  const wave = context.waveHeight ?? 0;
  const reports = context.reportsByVillage || {};

  const out = villages.map((v) => {
    const vul = vulnerability(v);

    /* Swell only matters where the land meets it low. */
    const surge = v.coastal && wave > 2.5
      ? Math.min(0.18, (wave - 2.5) * 0.05) * (1 - Math.min(1, (v.elev_m || 0) / 30))
      : 0;

    /* Data assimilation: an observation on the ground outranks the model.
       Two or more recent reports floor the village at 'High'. */
    const confirmations = reports[v.id] || 0;
    const observedFloor = confirmations >= 2 ? 0.72 : confirmations === 1 ? 0.5 : 0;

    const modelled = Math.min(1, hazard * (0.35 + 1.25 * vul.score) + surge);
    const risk = Math.max(modelled, observedFloor);

    return {
      id: v.id,
      name: v.name,
      lat: v.lat,
      lon: v.lon,
      pop: v.pop,
      feeder: v.feeder,
      elev_m: v.elev_m,
      risk: +risk.toFixed(4),
      risk100: Math.round(risk * 100),
      band: band(risk),
      vulnerability: vul,
      surge: +surge.toFixed(3),
      confirmations,
      confirmed: confirmations > 0,
      drivenBy: observedFloor > modelled ? 'observations' : 'model',
    };
  });

  /* When hazard saturates (a category 5 puts every village at 1.0) the primary
     sort degenerates, so vulnerability breaks the tie and the ordering stays
     meaningful at both ends of the range. */
  out.sort((a, b) => (b.risk - a.risk) || (b.vulnerability.score - a.vulnerability.score));

  /* Relative share of the day's highest village, for bar widths. On a calm day
     every absolute risk is near zero - which is the correct answer - but the
     ranking is still worth seeing. Labelled as relative in the UI. */
  const peak = out.length ? out[0].risk : 0;
  for (const v of out) v.relative = peak > 0 ? +(v.risk / peak).toFixed(3) : 0;

  return {
    hazard: +hazard.toFixed(4),
    villages: out,
    populationExposed: out.filter((r) => r.risk >= 0.5).reduce((a, r) => a + (r.pop || 0), 0),
    villagesAtRisk: out.filter((r) => r.risk >= 0.5).length,
    waveHeight: wave,
  };
}

/* `color` drops straight into an inline style; `cssVar` is for callers that
   need a resolved value, such as Leaflet options or canvas. */
export function band(risk) {
  if (risk >= 0.75) return { key: 'crit',  label: 'Severe',   color: 'var(--crit)',  cssVar: '--crit' };
  if (risk >= 0.55) return { key: 'alert', label: 'High',     color: 'var(--alert)', cssVar: '--alert' };
  if (risk >= 0.35) return { key: 'warn',  label: 'Moderate', color: 'var(--warn)',  cssVar: '--warn' };
  if (risk >= 0.18) return { key: 'watch', label: 'Low',      color: 'var(--watch)', cssVar: '--watch' };
  return { key: 'ok', label: 'Minimal', color: 'var(--ok)', cssVar: '--ok' };
}

/* ==========================================================================
   Scenarios - "what would a Yutu-scale storm do to us"
   Planning inputs, not forecasts. The Soudelor row uses the ERA5 values
   actually recorded for Saipan on 2-3 August 2015.
   ========================================================================== */

export const SCENARIOS = [
  { id: 'now', label: 'Live now', desc: 'Current conditions from the live feeds.' },
  { id: 'heavy', label: 'Heavy rain day', desc: 'Wet-season downpour: 90 mm in a day onto already wet ground.',
    f: { rain1: 90, rain3: 45, rain7: 80, wetHours: 12, windMax: 45, presAnom: 4, presTrend: -2, wetSeason: 1 } },
  { id: 'trop', label: 'Tropical storm', desc: 'Tropical storm passing close: sustained rain and damaging gusts.',
    f: { rain1: 140, rain3: 70, rain7: 110, wetHours: 18, windMax: 85, presAnom: 12, presTrend: -6, wetSeason: 1 } },
  { id: 'soudelor', label: 'Soudelor 2015', desc: 'ERA5 for Saipan, 2 Aug 2015: 64.5 mm of rain, 72 km/h daily max wind.',
    f: { rain1: 64.5, rain3: 9.4, rain7: 30, wetHours: 14, windMax: 72, presAnom: 16, presTrend: -9, wetSeason: 1 } },
  { id: 'yutu', label: 'Yutu scale (Cat 5)', desc: 'Category 5 landfall: extreme rain, destructive wind, deep pressure.',
    f: { rain1: 200, rain3: 95, rain7: 150, wetHours: 22, windMax: 165, presAnom: 45, presTrend: -18, wetSeason: 1 } },
];

/* ==========================================================================
   Feature extraction from the live feeds
   ========================================================================== */

/**
 * Build model features from the live Open-Meteo payload.
 * `presMedian` must come from the trained model so that the pressure anomaly
 * is measured against the same baseline used in training.
 */
export function liveFeatures(weather, presMedian) {
  if (!weather || !weather.daily) return null;

  const d = weather.daily;
  const today = new Date().toISOString().slice(0, 10);
  let i = 0;
  for (let k = 0; k < d.time.length; k++) if (d.time[k] <= today) i = k;

  const p = d.precipitation_sum || [];
  const at = (k) => (k >= 0 && p[k] != null ? p[k] : 0);

  const rain3 = at(i - 1) + at(i - 2) + at(i - 3);
  const month = Number(d.time[i].slice(5, 7));
  const base = presMedian ?? 1010;
  const pNow = (weather.current && weather.current.surface_pressure) || base;

  return {
    rain1: at(i),
    rain3,
    rain7: rain3 + at(i - 4) + at(i - 5) + at(i - 6) + at(i - 7),
    wetHours: (d.precipitation_hours && d.precipitation_hours[i]) || 0,
    windMax: (d.wind_speed_10m_max && d.wind_speed_10m_max[i]) || 0,
    presAnom: Math.max(0, base - pNow),
    presTrend: 0,
    wetSeason: month >= 7 && month <= 11 ? 1 : 0,
    _index: i,
    _date: d.time[i],
  };
}

/* ==========================================================================
   Persistence - a trained model is reusable offline
   ========================================================================== */

export async function saveModel(model) {
  await metaSet('flood_model:' + (model.head || 'nowcast'), model);
}

export async function loadModel(head = 'nowcast') {
  return metaGet('flood_model:' + head, null);
}
