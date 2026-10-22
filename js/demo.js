/* ==========================================================================
   demo.js - a coherent scenario, clearly marked as one
   --------------------------------------------------------------------------
   An app like this is hard to show. Most of the time Saipan is fine: the risk
   scores sit near zero, nobody has filed anything, and the grid is up. That
   is the correct reading of a calm Tuesday and a terrible demonstration.

   So this seeds a single consistent story - a tropical storm passing close
   overnight - across every view at once, instead of scattering unrelated rows
   about. Flooding appears in the basins that actually flood, outages follow
   real feeder groupings, turbidity shows up downstream of the runoff, and the
   fish kill is in the lagoon the runoff drains into. A viewer can follow cause
   to effect across tabs, which is the thing worth showing.

   Every record carries `demo: true`. The app badges them, a banner stays up
   while any are present, and one tap removes them. Nothing here is ever
   presented as a real observation, because the credibility of the real
   features depends on that line staying bright.
   ========================================================================== */

import { uuid } from './store.js';

/* Observers are stable per village so corroboration behaves sensibly: the
   same person reporting twice is not two independent accounts. */
function observer(tag, n) {
  return `demo-${tag}${n}`;
}

function jitter(v, amount) {
  return v + (Math.random() - 0.5) * amount;
}

/**
 * Build the scenario.
 *
 * @param {object} island   island.json
 * @param {number} nowMs
 * @returns {object[]} reports, all tagged demo
 */
export function buildDemoReports(island, nowMs = Date.now()) {
  const byId = new Map(island.villages.map((v) => [v.id, v]));
  const rows = [];

  const add = ({ village, category, severity, hoursAgo, observers = 1, note, detail = {}, status = 'open' }) => {
    const v = byId.get(village);
    if (!v) return;
    for (let i = 0; i < observers; i++) {
      rows.push({
        id: uuid(),
        created_at: new Date(nowMs - hoursAgo * 3600e3 + i * 11 * 60e3).toISOString(),
        observer_id: observer(village.slice(0, 4).toUpperCase(), i + 1),
        category,
        severity,
        lat: +jitter(v.lat, 0.004).toFixed(6),
        lon: +jitter(v.lon, 0.004).toFixed(6),
        accuracy: 8 + Math.round(Math.random() * 20),
        village_id: v.id,
        village_name: v.name,
        note: i === 0 ? note : '',
        detail,
        photo: null,
        status,
        sync_state: 'pending',
        demo: true,
        app_version: 1,
      });
    }
  };

  /* ---- Overnight rain: the southwest basins go first ------------------ */
  add({ village: 'susupe', category: 'flood', severity: 4, hoursAgo: 9, observers: 3,
        note: 'Water across the whole Civic Center lot, past the kerb and still rising at 4am.',
        detail: { depth_cm: '55', passable: 'No' } });
  add({ village: 'chalan-piao', category: 'flood', severity: 3, hoursAgo: 8.5, observers: 2,
        note: 'Standing water in the yards by the lake margin. Same as every heavy rain.',
        detail: { depth_cm: '35', passable: 'Only high clearance' } });
  add({ village: 'chalan-kanoa', category: 'flood', severity: 3, hoursAgo: 8, observers: 3,
        note: 'Beach Road flooded between the church and the market.',
        detail: { depth_cm: '40', passable: 'Only high clearance' } });
  add({ village: 'oleai', category: 'flood', severity: 2, hoursAgo: 7, observers: 2,
        note: 'Ponding on the beach road, drains backing up.',
        detail: { depth_cm: '20', passable: 'Yes' } });
  add({ village: 'garapan', category: 'flood', severity: 3, hoursAgo: 6.5, observers: 2,
        note: 'Ankle deep along the hotel strip, worst at the low point by the park.',
        detail: { depth_cm: '25', passable: 'Yes' } });
  add({ village: 'afetna', category: 'flood', severity: 2, hoursAgo: 6, observers: 1,
        note: 'Water over the access track, not into houses yet.',
        detail: { depth_cm: '18', passable: 'Only high clearance' } });

  /* ---- Wind damage: hazards people need routed around ----------------- */
  add({ village: 'garapan', category: 'downed-line', severity: 4, hoursAgo: 7.5, observers: 2,
        note: 'Pole leaning, line down across the side street. Nobody going near it.',
        detail: { blocking: 'Fully', sparking: 'No' } });
  add({ village: 'san-antonio', category: 'downed-line', severity: 4, hoursAgo: 5.5, observers: 1,
        note: 'Line down in the alley behind the shops, arcing when the wind gusts.',
        detail: { blocking: 'Partly', sparking: 'Yes' } });
  add({ village: 'capitol-hill', category: 'road', severity: 3, hoursAgo: 6, observers: 2,
        note: 'Mud and rock across the hill road, one lane only.',
        detail: { cause: 'Landslide', passable: 'Only high clearance' } });
  add({ village: 'tanapag', category: 'road', severity: 2, hoursAgo: 5, observers: 1,
        note: 'Tree down across the back road.',
        detail: { cause: 'Fallen tree', passable: 'No' } });

  /* ---- Utilities: a feeder event, not thirty coincidences ------------- */
  for (const vid of ['garapan', 'oleai', 'gualo-rai', 'chalan-laulau', 'fina-sisu']) {
    add({ village: vid, category: 'power', severity: 3, hoursAgo: 4.2, observers: 2,
          note: vid === 'garapan' ? 'Whole street out since about 2am.' : '' });
  }
  for (const vid of ['kagman', 'papago', 'laolao']) {
    add({ village: vid, category: 'power', severity: 3, hoursAgo: 3.1, observers: 2,
          note: vid === 'kagman' ? 'Out here too, lights went just after the squall came through.' : '' });
  }
  add({ village: 'kagman', category: 'water', severity: 2, hoursAgo: 2.6, observers: 2,
        note: 'Pressure dropped right after the power went.',
        detail: { pressure: 'Low pressure' } });
  add({ village: 'dandan', category: 'water', severity: 3, hoursAgo: 2.2, observers: 2,
        note: 'Nothing from the tap since this morning.',
        detail: { pressure: 'No water at all' } });

  /* One lone account. It must read as "single report", not as an outage -
     this is the case the corroboration rule exists for. */
  add({ village: 'koblerville', category: 'power', severity: 2, hoursAgo: 0.7, observers: 1,
        note: 'Ours is out, not sure about the neighbours.' });

  /* ---- Downstream effects: runoff into the lagoon --------------------- */
  add({ village: 'garapan', category: 'turbidity', severity: 3, hoursAgo: 5, observers: 2,
        note: 'Brown plume out from the storm drain, maybe 200 m offshore.',
        detail: { visibility_m: '2' } });
  add({ village: 'laolao', category: 'turbidity', severity: 3, hoursAgo: 4.5, observers: 1,
        note: 'Bay is brown right out to the dive site. Sediment off the badlands again.',
        detail: { visibility_m: '3' } });
  add({ village: 'susupe', category: 'fish-kill', severity: 2, hoursAgo: 3.5, observers: 2,
        note: 'Around twenty dead tilapia along the lake edge after the runoff.',
        detail: { count: '20', species: 'Tilapia' } });
  add({ village: 'chalan-kanoa', category: 'debris', severity: 2, hoursAgo: 3, observers: 1,
        note: 'Timber and plastic washed up along Sugar Dock.',
        detail: { volume: 'A pickup load' } });

  /* ---- Science reporting continues through all of it ------------------ */
  add({ village: 'laolao', category: 'bleaching', severity: 3, hoursAgo: 26, observers: 2,
        note: 'Plating colonies pale at 4-6 m, massive Porites still holding colour.',
        detail: { pct_bleached: '30-60%', depth_m: '5', taxa: 'Plating (Montipora)' } });
  add({ village: 'tanapag', category: 'bleaching', severity: 2, hoursAgo: 30, observers: 1,
        note: 'Patchy paling on the reef flat, worse in the shallows at low tide.',
        detail: { pct_bleached: '10-30%', depth_m: '2', taxa: 'Mixed' } });
  add({ village: 'kagman', category: 'invasive', severity: 3, hoursAgo: 20, observers: 2,
        note: 'V-cuts in the coconut fronds along the farm road, several palms affected.',
        detail: { species: 'crb', count: '6' } });
  add({ village: 'dandan', category: 'invasive', severity: 2, hoursAgo: 18, observers: 1,
        note: 'Tiny orange ants dropping out of the trees, stings welt up.',
        detail: { species: 'lfa', count: '' } });
  add({ village: 'san-antonio', category: 'erosion', severity: 3, hoursAgo: 4, observers: 2,
        note: 'Scarp cut back further overnight, roots exposed along the top.',
        detail: { scarp_cm: '60' } });

  /* ---- Closed history, so the reliability record has something ------- */
  const closed = [
    { villages: ['garapan', 'oleai', 'gualo-rai'], cat: 'power', startH: 86, lenH: 3.5, obs: 3 },
    { villages: ['dandan', 'as-perdido'], cat: 'water', startH: 52, lenH: 6, obs: 2 },
    { villages: ['kagman'], cat: 'power', startH: 30, lenH: 2, obs: 2 },
    { villages: ['susupe'], cat: 'power', startH: 61, lenH: 1.5, obs: 2 },
    { villages: ['chalan-kanoa', 'san-antonio'], cat: 'power', startH: 140, lenH: 4, obs: 2 },
  ];

  for (const ep of closed) {
    for (const vid of ep.villages) {
      const v = byId.get(vid);
      if (!v) continue;
      for (let i = 0; i < ep.obs; i++) {
        rows.push({
          id: uuid(),
          created_at: new Date(nowMs - ep.startH * 3600e3 + i * 8 * 60e3).toISOString(),
          observer_id: observer(vid.slice(0, 4).toUpperCase(), i + 1),
          category: ep.cat,
          severity: 3,
          lat: +jitter(v.lat, 0.003).toFixed(6),
          lon: +jitter(v.lon, 0.003).toFixed(6),
          village_id: v.id,
          village_name: v.name,
          note: '',
          detail: ep.cat === 'water' ? { pressure: 'No water at all' } : {},
          photo: null,
          status: 'open',
          sync_state: 'pending',
          demo: true,
          app_version: 1,
        });
      }
      rows.push({
        id: uuid(),
        created_at: new Date(nowMs - (ep.startH - ep.lenH) * 3600e3).toISOString(),
        observer_id: observer(vid.slice(0, 4).toUpperCase(), 1),
        category: ep.cat,
        severity: 1,
        lat: v.lat,
        lon: v.lon,
        village_id: v.id,
        village_name: v.name,
        note: 'Service restored',
        detail: {},
        photo: null,
        status: 'resolved',
        sync_state: 'pending',
        demo: true,
        app_version: 1,
      });
    }
  }

  return rows;
}

/** A one-line account of what the scenario depicts, for the banner. */
export const DEMO_STORY =
  'A tropical storm passed close overnight. The southwest basins are flooded, two feeders are '
  + 'down, runoff has turned the lagoon over, and reef surveys from the previous days are still '
  + 'in the queue.';
