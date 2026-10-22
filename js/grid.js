/* ==========================================================================
   grid.js - utility status from crowd reports
   --------------------------------------------------------------------------
   The problem this solves, in the words of residents: outages happen, nobody
   can tell how widespread they are, and there is no record afterwards. One
   household cannot tell a blown breaker from a feeder trip.

   The approach: treat each report as a noisy sensor and require corroboration
   before claiming a village is out. Two independent observers inside a short
   window is the bar for "down"; a single report is "reported", not fact. The
   distinction is kept visible in the UI, because a status map that overstates
   its confidence is worse than none.

   The aggregation then rolls village states up to CUC feeders, which is where
   a real fault usually lives: if most villages on one feeder report loss at
   once, that is a feeder event rather than thirty coincidences.

   It also builds the part residents actually asked for: a record. Outage
   counts, median restore time per feeder, and observed uptime per village,
   so "the power is always off in Kagman" becomes a number someone can act on.
   ========================================================================== */

const HOUR = 3600e3;

/* A report older than this stops counting toward live status. Long enough to
   cover a real multi-hour outage, short enough that yesterday is history. */
const LIVE_WINDOW_H = 6;

/* Two separate observers to call a village down. */
const CORROBORATION = 2;

export const STATUS = {
  up:       { key: 'up',       label: 'Service normal',   tone: 'ok',    color: 'var(--ok)',     cssVar: '--ok' },
  reported: { key: 'reported', label: 'Single report',    tone: 'watch', color: 'var(--watch)',  cssVar: '--watch' },
  degraded: { key: 'degraded', label: 'Degraded',         tone: 'warn',  color: 'var(--warn)',   cssVar: '--warn' },
  down:     { key: 'down',     label: 'Outage confirmed', tone: 'crit',  color: 'var(--crit)',   cssVar: '--crit' },
  unknown:  { key: 'unknown',  label: 'No data',          tone: 'mute',  color: 'var(--text-3)', cssVar: '--text-3' },
};

function hoursAgo(iso, now) {
  return (now - new Date(iso).getTime()) / HOUR;
}

/**
 * Live utility state per village and per feeder.
 *
 * @param {object[]} reports  all local reports
 * @param {object}   island   island.json
 * @param {number}   nowMs
 */
export function aggregate(reports, island, nowMs = Date.now()) {
  const byVillage = new Map();

  for (const v of island.villages) {
    byVillage.set(v.id, {
      village: v,
      power: emptyChannel(),
      water: emptyChannel(),
      hazards: [],
    });
  }

  for (const r of reports) {
    const slot = byVillage.get(r.village_id);
    if (!slot) continue;

    const age = hoursAgo(r.created_at, nowMs);

    if (r.category === 'downed-line' || r.category === 'road') {
      if (age <= 48 && r.status !== 'resolved') slot.hazards.push(r);
      continue;
    }

    const channel = r.category === 'power' ? slot.power
      : r.category === 'water' ? slot.water
      : null;
    if (!channel) continue;

    channel.all.push(r);
    if (age <= LIVE_WINDOW_H) {
      if (r.status === 'resolved') channel.restores.push(r);
      else channel.live.push(r);
    }
  }

  const villages = [];
  for (const slot of byVillage.values()) {
    villages.push({
      id: slot.village.id,
      name: slot.village.name,
      lat: slot.village.lat,
      lon: slot.village.lon,
      pop: slot.village.pop,
      feeder: slot.village.feeder,
      water_zone: slot.village.water_zone,
      power: resolveChannel(slot.power, nowMs),
      water: resolveChannel(slot.water, nowMs),
      hazards: slot.hazards,
    });
  }

  const feeders = island.feeders.map((f) => {
    const members = villages.filter((v) => v.feeder === f.id);
    const down = members.filter((v) => v.power.status === 'down');
    const anyReport = members.filter((v) => v.power.status !== 'up' && v.power.status !== 'unknown');

    /* A majority of a feeder's villages reporting loss at once points at the
       feeder, not at thirty simultaneous household faults. */
    const share = members.length ? down.length / members.length : 0;
    const status = share >= 0.5 ? 'down' : down.length ? 'degraded' : anyReport.length ? 'reported' : 'up';

    return {
      ...f,
      villages: members.map((m) => m.id),
      villagesDown: down.map((m) => m.id),
      popAffected: down.reduce((a, m) => a + (m.pop || 0), 0),
      share,
      status,
      inferred: share >= 0.5,
    };
  });

  const downFeeders = feeders.filter((f) => f.status === 'down');
  const islandWide = downFeeders.length >= Math.ceil(island.feeders.length * 0.75);

  const popNoPower = villages.filter((v) => v.power.status === 'down').reduce((a, v) => a + (v.pop || 0), 0);
  const popNoWater = villages.filter((v) => v.water.status === 'down').reduce((a, v) => a + (v.pop || 0), 0);
  const totalPop = island.villages.reduce((a, v) => a + (v.pop || 0), 0);

  return {
    villages,
    feeders,
    islandWide,
    headline: islandWide
      ? 'Island-wide power event indicated'
      : downFeeders.length
        ? `${downFeeders.length} feeder${downFeeders.length > 1 ? 's' : ''} reporting outage`
        : villages.some((v) => v.power.status !== 'up' && v.power.status !== 'unknown')
          ? 'Localised reports, not yet corroborated'
          : 'No active outage reports',
    popNoPower,
    popNoWater,
    pctNoPower: totalPop ? popNoPower / totalPop : 0,
    hazardCount: villages.reduce((a, v) => a + v.hazards.length, 0),
    updatedAt: new Date(nowMs).toISOString(),
  };
}

function emptyChannel() {
  return { all: [], live: [], restores: [] };
}

function resolveChannel(channel, nowMs) {
  const observers = new Set(channel.live.map((r) => r.observer_id));
  const restoreObservers = new Set(channel.restores.map((r) => r.observer_id));

  const newestLive = channel.live.reduce(
    (acc, r) => (!acc || r.created_at > acc.created_at ? r : acc),
    null,
  );
  const newestRestore = channel.restores.reduce(
    (acc, r) => (!acc || r.created_at > acc.created_at ? r : acc),
    null,
  );

  /* A restore newer than the newest outage report clears the village. */
  if (newestRestore && (!newestLive || newestRestore.created_at > newestLive.created_at)) {
    return {
      status: 'up',
      observers: restoreObservers.size,
      since: null,
      lastReport: newestRestore.created_at,
      confidence: confidenceOf(restoreObservers.size, hoursAgo(newestRestore.created_at, nowMs)),
      note: 'Restoration reported',
      reports: channel.live.length + channel.restores.length,
    };
  }

  if (!channel.live.length) {
    return {
      status: channel.all.length ? 'up' : 'unknown',
      observers: 0,
      since: null,
      lastReport: channel.all.length ? channel.all[0].created_at : null,
      confidence: channel.all.length ? 0.4 : 0,
      note: channel.all.length ? 'No reports in the live window' : 'Never reported from here',
      reports: channel.all.length,
    };
  }

  const oldestLive = channel.live.reduce((a, r) => (r.created_at < a.created_at ? r : a), channel.live[0]);
  const partial = channel.live.every((r) => r.detail && r.detail.partial);
  const lowPressureOnly = channel.live.every((r) => r.detail && r.detail.pressure === 'low');

  let status;
  if (observers.size >= CORROBORATION) status = lowPressureOnly ? 'degraded' : 'down';
  else if (partial || lowPressureOnly) status = 'degraded';
  else status = 'reported';

  return {
    status,
    observers: observers.size,
    since: oldestLive.created_at,
    lastReport: newestLive.created_at,
    durationH: +hoursAgo(oldestLive.created_at, nowMs).toFixed(1),
    confidence: confidenceOf(observers.size, hoursAgo(newestLive.created_at, nowMs)),
    note: observers.size >= CORROBORATION
      ? `${observers.size} independent observers`
      : 'Awaiting a second observer',
    reports: channel.live.length,
  };
}

/* More observers raise confidence, age lowers it. Saturates near 0.95 - the
   crowd is never certain and the UI should not claim it is. */
function confidenceOf(observers, ageH) {
  if (!observers) return 0;
  const corroboration = 1 - Math.pow(0.45, observers);
  const freshness = Math.max(0.25, 1 - ageH / (LIVE_WINDOW_H * 1.5));
  return +Math.min(0.95, corroboration * freshness).toFixed(2);
}

/* ==========================================================================
   Reliability record - the accountability half
   ========================================================================== */

/**
 * Per-village and per-feeder history from closed outage episodes.
 * An episode is a run of reports for one village and channel, closed either by
 * a restoration report or by a gap longer than `gapH`.
 */
export function reliability(reports, island, { windowDays = 90, gapH = 4 } = {}) {
  const since = Date.now() - windowDays * 864e5;
  const byKey = new Map();

  const relevant = reports
    .filter((r) => (r.category === 'power' || r.category === 'water'))
    .filter((r) => new Date(r.created_at).getTime() >= since)
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

  for (const r of relevant) {
    const key = r.village_id + ':' + r.category;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(r);
  }

  const episodes = [];
  for (const [key, rows] of byKey) {
    const [villageId, channel] = key.split(':');
    let current = null;

    for (const r of rows) {
      const t = new Date(r.created_at).getTime();

      if (r.status === 'resolved') {
        if (current) {
          current.end = t;
          current.closedBy = 'restore-report';
          episodes.push(finishEpisode(current, villageId, channel));
          current = null;
        }
        continue;
      }

      if (current && t - current.last <= gapH * HOUR) {
        current.last = t;
        current.reports++;
        current.observers.add(r.observer_id);
      } else {
        if (current) {
          current.end = current.last + gapH * HOUR / 2;  // midpoint of the gap
          current.closedBy = 'report-gap';
          episodes.push(finishEpisode(current, villageId, channel));
        }
        current = { start: t, last: t, reports: 1, observers: new Set([r.observer_id]) };
      }
    }

    if (current) {
      current.end = null;              // still open
      current.closedBy = 'open';
      episodes.push(finishEpisode(current, villageId, channel));
    }
  }

  const villages = island.villages.map((v) => {
    const own = episodes.filter((e) => e.village_id === v.id);
    const power = own.filter((e) => e.channel === 'power');
    const water = own.filter((e) => e.channel === 'water');
    const closedPower = power.filter((e) => e.durationH != null);

    const outageHours = closedPower.reduce((a, e) => a + e.durationH, 0);
    const windowHours = windowDays * 24;

    return {
      id: v.id,
      name: v.name,
      feeder: v.feeder,
      water_zone: v.water_zone,
      pop: v.pop,
      powerEpisodes: power.length,
      waterEpisodes: water.length,
      medianRestoreH: medianOf(closedPower.map((e) => e.durationH)),
      longestH: closedPower.length ? Math.max(...closedPower.map((e) => e.durationH)) : null,
      observedUptime: windowHours ? 1 - Math.min(1, outageHours / windowHours) : null,
      episodesPerMonth: +(power.length / (windowDays / 30)).toFixed(2),
      sampleSize: power.length,
    };
  });

  const feeders = island.feeders.map((f) => {
    const ids = island.villages.filter((v) => v.feeder === f.id).map((v) => v.id);
    const eps = episodes.filter((e) => ids.includes(e.village_id) && e.channel === 'power' && e.durationH != null);
    return {
      id: f.id,
      name: f.name,
      episodes: eps.length,
      medianRestoreH: medianOf(eps.map((e) => e.durationH)),
      p90RestoreH: percentileOf(eps.map((e) => e.durationH), 0.9),
      sampleSize: eps.length,
    };
  });

  return {
    windowDays,
    episodes: episodes.sort((a, b) => b.start - a.start),
    villages: villages.sort((a, b) => (b.powerEpisodes - a.powerEpisodes) || (b.pop - a.pop)),
    feeders,
    totals: {
      powerEpisodes: episodes.filter((e) => e.channel === 'power').length,
      waterEpisodes: episodes.filter((e) => e.channel === 'water').length,
      medianRestoreH: medianOf(episodes.filter((e) => e.channel === 'power' && e.durationH != null).map((e) => e.durationH)),
    },
  };
}

function finishEpisode(cur, villageId, channel) {
  const durationH = cur.end ? +((cur.end - cur.start) / HOUR).toFixed(2) : null;
  return {
    village_id: villageId,
    channel,
    start: cur.start,
    end: cur.end,
    durationH,
    reports: cur.reports,
    observers: cur.observers.size,
    closedBy: cur.closedBy,
    open: cur.end == null,
  };
}

function medianOf(values) {
  const a = values.filter((v) => v != null).slice().sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = Math.floor(a.length / 2);
  return +(a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2).toFixed(2);
}

function percentileOf(values, p) {
  const a = values.filter((v) => v != null).slice().sort((x, y) => x - y);
  if (!a.length) return null;
  const idx = Math.min(a.length - 1, Math.floor(a.length * p));
  return +a[idx].toFixed(2);
}

/**
 * What a resident should expect right now: how long outages like this one have
 * historically lasted on this feeder. Falls back to the island median, then to
 * a documented CUC pattern, and says which basis it used.
 */
export function restoreExpectation(villageId, island, rel) {
  const v = island.villages.find((x) => x.id === villageId);
  if (!v) return null;

  const feeder = rel.feeders.find((f) => f.id === v.feeder);
  if (feeder && feeder.sampleSize >= 3) {
    return {
      basis: 'feeder-history',
      label: `Typical on ${v.feeder}`,
      medianH: feeder.medianRestoreH,
      p90H: feeder.p90RestoreH,
      n: feeder.sampleSize,
    };
  }

  if (rel.totals.medianRestoreH != null && rel.totals.powerEpisodes >= 3) {
    return {
      basis: 'island-history',
      label: 'Typical island-wide',
      medianH: rel.totals.medianRestoreH,
      p90H: null,
      n: rel.totals.powerEpisodes,
    };
  }

  /* No local history yet. CUC has publicly described water needing two to
     three hours to re-pressurise after an island-wide power loss, so that is
     the stated starting expectation until this network has its own numbers. */
  return {
    basis: 'documented-pattern',
    label: 'No local history yet',
    medianH: 2.5,
    p90H: null,
    n: 0,
    note: 'CUC has publicly described water systems needing roughly 2-3 hours to re-pressurise after island-wide power loss.',
  };
}
