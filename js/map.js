/* ==========================================================================
   map.js - Leaflet map, satellite imagery and overlays
   --------------------------------------------------------------------------
   Base layers
     Esri World Imagery  high-resolution reference imagery
     NASA GIBS           daily satellite composites, driven by a date scrubber
                         so you can slide back to 2 Aug 2015 and watch
                         Soudelor sit on the island
     Carto dark          plain basemap for when imagery is noise

   Overlays are plain circle markers and polylines, deliberately: vector
   circles need no sprite files, so the whole overlay set works from cache
   with the network off.
   ========================================================================== */

import { GIBS_LAYERS, gibsUrl, gibsDefaultDate } from './feeds.js';
import { icon, escapeHtml, fmt, ago, token } from './ui.js';
import { cartoUrl, CARTO_STYLES } from './config.js';

const ISLAND_VIEW = { center: [15.19, 145.75], zoom: 12 };

export class SaipanMap {
  constructor(elId, { onVillageClick, onMapClick } = {}) {
    this.el = document.getElementById(elId);
    this.onVillageClick = onVillageClick;
    this.onMapClick = onMapClick;
    this.gibsDate = gibsDefaultDate();
    this.gibsKey = 'truecolor';
    this.gibsEnabled = true;
    this.layers = {};
    this.groups = {};
    this.map = null;
  }

  init() {
    if (!this.el || this.map) return this.map;

    this.map = L.map(this.el, {
      center: ISLAND_VIEW.center,
      zoom: ISLAND_VIEW.zoom,
      /* Default top-left zoom buttons sit underneath the layer toolbar, so the
         control is placed out of the way rather than fighting it. */
      zoomControl: false,
      attributionControl: true,
      preferCanvas: true,
    });
    L.control.zoom({ position: 'bottomright' }).addTo(this.map);

    this.layers.esri = L.tileLayer(
      'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      { maxZoom: 18, attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics' },
    );

    this.layers.carto = this.buildCartoLayer();

    this.layers.gibs = this.buildGibsLayer();

    this.layers.esri.addTo(this.map);
    this.gibsEnabled = true;
    this.map.on('zoomend', () => this.applyGibsVisibility());
    this.applyGibsVisibility();

    for (const name of ['risk', 'reports', 'grid', 'reef', 'infra', 'sar']) {
      this.groups[name] = L.layerGroup();
    }
    this.groups.risk.addTo(this.map);
    this.groups.reports.addTo(this.map);

    if (this.onMapClick) {
      this.map.on('click', (e) => this.onMapClick(e.latlng));
    }

    /* Leaflet mis-sizes itself when its container was hidden at init, which is
       exactly what a tabbed layout does. */
    setTimeout(() => this.map.invalidateSize(), 60);

    return this.map;
  }

  /** Which CARTO style matches the active theme. */
  cartoStyle() {
    const explicit = document.documentElement.dataset.theme;
    const dark = explicit
      ? explicit === 'dark'
      : window.matchMedia('(prefers-color-scheme: dark)').matches;
    return dark ? CARTO_STYLES.dark : CARTO_STYLES.light;
  }

  buildCartoLayer() {
    return L.tileLayer(cartoUrl(this.cartoStyle()), {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors, &copy; CARTO',
      /* If the key is rejected or the quota is spent, a blank tile keeps the
         map usable rather than filling it with broken images; Esri imagery
         remains available as a base that needs no key. */
      errorTileUrl: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
    });
  }

  /** Swap the plain basemap when the reader changes theme. */
  refreshBasemap() {
    if (!this.map) return;
    const wasVisible = this.map.hasLayer(this.layers.carto);
    if (wasVisible) this.map.removeLayer(this.layers.carto);
    this.layers.carto = this.buildCartoLayer();
    if (wasVisible) {
      this.layers.carto.addTo(this.map);
      this.layers.carto.bringToBack();
      if (this.map.hasLayer(this.layers.gibs)) this.layers.gibs.bringToFront();
    }
  }

  /* The ceiling the reader set with the opacity slider, before zoom fading. */
  gibsCeiling() {
    return this.gibsOpacity ?? (this.gibsKey === 'truecolor' ? 0.6 : 0.55);
  }

  /**
   * How much of that ceiling survives at the current zoom.
   *
   * These composites are 375 m per pixel (true colour) or coarser. Past their
   * native zoom the browser is just enlarging one sensor pixel across a whole
   * village, and the result is haze over the sharp imagery underneath plus
   * visible seams where two orbital passes met. So the layer holds full
   * strength through one zoom past native, fades over the next two, and is
   * gone after that - present where it means something, absent where it does
   * not, with no toggle for the reader to remember.
   */
  zoomFade() {
    if (!this.map) return 1;
    const native = GIBS_LAYERS[this.gibsKey].maxZoom;
    const z = this.map.getZoom();
    const full = native + 1;
    const none = native + 3;
    if (z <= full) return 1;
    if (z >= none) return 0;
    return 1 - (z - full) / (none - full);
  }

  /**
   * Reconcile the layer with the toggle and the zoom. Below the visibility
   * floor the layer is taken off the map rather than left at opacity zero,
   * so it stops requesting tiles nobody can see.
   */
  applyGibsVisibility() {
    if (!this.map || !this.layers.gibs) return;

    const fade = this.zoomFade();
    const effective = this.gibsEnabled === false ? 0 : this.gibsCeiling() * fade;
    const onMap = this.map.hasLayer(this.layers.gibs);

    if (effective < 0.02) {
      if (onMap) this.map.removeLayer(this.layers.gibs);
    } else {
      if (!onMap) this.layers.gibs.addTo(this.map);
      this.layers.gibs.setOpacity(effective);
      this.layers.gibs.bringToFront();
    }

    if (this.onGibsVisibility) {
      this.onGibsVisibility({
        enabled: this.gibsEnabled !== false,
        fadedByZoom: this.gibsEnabled !== false && fade === 0,
        effective,
        zoom: this.map.getZoom(),
        native: GIBS_LAYERS[this.gibsKey].maxZoom,
      });
    }
  }

  buildGibsLayer() {
    const L_ = GIBS_LAYERS[this.gibsKey];
    return L.tileLayer(gibsUrl(this.gibsKey, this.gibsDate), {
      maxNativeZoom: L_.maxZoom,
      maxZoom: 18,
      opacity: this.gibsCeiling() * this.zoomFade(),
      attribution: 'Imagery courtesy NASA EOSDIS GIBS',
      className: 'gibs-tiles',
      /* A missing granule for a given day returns an XML error, not a tile;
         a transparent pixel keeps the map clean instead of showing a blank
         grid of broken images. */
      errorTileUrl: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
    });
  }

  setGibs(layerKey, date) {
    if (layerKey) this.gibsKey = layerKey;
    if (date) this.gibsDate = date;
    if (!this.map) return;

    this.map.removeLayer(this.layers.gibs);
    this.layers.gibs = this.buildGibsLayer();
    this.applyGibsVisibility();
  }

  setGibsOpacity(value) {
    this.gibsOpacity = value;
    this.applyGibsVisibility();
  }

  setBase(which) {
    if (!this.map) return;
    for (const key of ['esri', 'carto']) {
      if (this.map.hasLayer(this.layers[key])) this.map.removeLayer(this.layers[key]);
    }
    this.layers[which === 'carto' ? 'carto' : 'esri'].addTo(this.map);
    if (this.map.hasLayer(this.layers.gibs)) this.layers.gibs.bringToFront();
  }

  toggleGibs(on) {
    this.gibsEnabled = on;
    this.applyGibsVisibility();
  }

  toggleGroup(name, on) {
    const g = this.groups[name];
    if (!g || !this.map) return;
    if (on) g.addTo(this.map);
    else this.map.removeLayer(g);
  }

  clear(name) {
    if (this.groups[name]) this.groups[name].clearLayers();
  }

  /* ======================= Risk surface ================================== */

  /**
   * Villages drawn as graduated circles. Radius scales with population so a
   * severe reading in Garapan reads heavier than the same number in Marpi -
   * risk without exposure is not the thing to act on.
   */
  drawRisk(riskResult) {
    this.clear('risk');
    if (!riskResult) return;

    for (const v of riskResult.villages) {
      const radius = 9 + Math.sqrt(v.pop || 1) * 0.42;

      const bandColor = token(v.band.cssVar, '#888');

      /* A calm day should look calm: the outline fades with the reading
         instead of ringing every village in a hard line. */
      const circle = L.circleMarker([v.lat, v.lon], {
        radius,
        color: bandColor,
        weight: v.confirmed ? 2.6 : 1.4,
        opacity: 0.3 + v.risk * 0.65,
        fillColor: bandColor,
        fillOpacity: 0.08 + v.risk * 0.42,
        dashArray: v.confirmed ? null : '3 3',
      });

      circle.bindPopup(`
        <h4>${escapeHtml(v.name)}</h4>
        <div style="font-size:.72rem;color:${v.band.color};margin-bottom:5px">
          ${v.band.label} &middot; ${v.risk100}/100
        </div>
        <div style="font-size:.76rem;line-height:1.5">
          Population ~${(v.pop || 0).toLocaleString('en-US')}<br>
          Elevation ${v.elev_m} m &middot; Feeder ${escapeHtml(v.feeder)}<br>
          Vulnerability index ${fmt(v.vulnerability.score, 2)}<br>
          ${v.confirmed
            ? `<strong style="color:var(--ok)">${v.confirmations} ground report${v.confirmations > 1 ? 's' : ''}</strong>`
            : '<span style="opacity:.6">Modelled, no ground reports</span>'}
        </div>`);

      if (this.onVillageClick) {
        circle.on('click', () => this.onVillageClick(v.id));
      }

      circle.addTo(this.groups.risk);
    }
  }

  /* ======================= Reports ======================================= */

  drawReports(reports, categories) {
    this.clear('reports');
    const catById = new Map((categories || []).map((c) => [c.id, c]));

    for (const r of reports) {
      if (r.lat == null || r.lon == null) continue;
      const cat = catById.get(r.category) || { color: token('--accent'), label: r.category, icon: 'info' };
      const fresh = Date.now() - new Date(r.created_at).getTime() < 6 * 3600e3;

      const marker = L.circleMarker([r.lat, r.lon], {
        radius: fresh ? 7.5 : 5.5,
        color: token('--surface', '#fff'),
        weight: 1.5,
        fillColor: cat.color,
        fillOpacity: r.sync_state === 'pending' ? 0.45 : 0.95,
      });

      marker.bindPopup(`
        <h4 style="display:flex;align-items:center;gap:6px">
          <span style="color:${cat.color}">${icon(cat.icon || 'info', 15)}</span>
          ${escapeHtml(cat.label)}
        </h4>
        <div style="font-size:.73rem;color:var(--text-2);margin-bottom:4px">
          ${escapeHtml(r.village_name || 'Unlocated')} &middot; ${ago(r.created_at)}
          ${r.sync_state === 'pending' ? ' &middot; <span style="color:var(--watch)">queued offline</span>' : ''}
        </div>
        ${r.note ? `<div style="font-size:.78rem">${escapeHtml(r.note)}</div>` : ''}
        ${r.photo ? `<img src="${r.photo}" alt="" style="margin-top:6px;width:100%;border-radius:6px">` : ''}
        <div style="font-size:.64rem;color:var(--text-3);margin-top:5px">
          severity ${r.severity || '-'}/4 &middot; ${escapeHtml(r.observer_id || '')}
        </div>`);

      marker.addTo(this.groups.reports);
    }
  }

  /* ======================= Utility status =============================== */

  drawGrid(agg, island) {
    this.clear('grid');
    if (!agg) return;

    for (const plant of island.plants) {
      L.marker([plant.lat, plant.lon], {
        icon: L.divIcon({
          className: '',
          html: `<div style="width:26px;height:26px;border-radius:7px;background:var(--surface-2);border:1.5px solid var(--ok);
                 display:grid;place-items:center;color:var(--ok);box-shadow:0 2px 10px rgba(0,0,0,.6)">
                 ${icon('bolt', 15)}</div>`,
          iconSize: [26, 26],
          iconAnchor: [13, 13],
        }),
      })
        .bindPopup(`<h4>${escapeHtml(plant.name)}</h4>
          <div style="font-size:.76rem">${escapeHtml(plant.role)}<br>
          <span style="color:var(--text-2)">${escapeHtml(plant.village)}</span></div>
          <div style="font-size:.72rem;color:var(--text-3);margin-top:5px">${escapeHtml(plant.note)}</div>`)
        .addTo(this.groups.grid);
    }

    for (const v of agg.villages) {
      const colorFor = {
        up: 'var(--ok)', reported: 'var(--watch)', degraded: 'var(--warn)', down: 'var(--crit)', unknown: 'var(--text-3)',
      };
      const pColor = colorFor[v.power.status];
      const wColor = colorFor[v.water.status];
      const live = v.power.status === 'down' || v.water.status === 'down';

      const marker = L.marker([v.lat, v.lon], {
        icon: L.divIcon({
          className: live ? 'pulse-marker' : '',
          html: `<div style="display:flex;border-radius:99px;overflow:hidden;border:1.5px solid var(--canvas);
                 box-shadow:0 2px 8px rgba(0,0,0,.6);color:${pColor}">
                 <i style="width:11px;height:16px;background:${pColor}"></i>
                 <i style="width:11px;height:16px;background:${wColor}"></i></div>`,
          iconSize: [22, 16],
          iconAnchor: [11, 8],
        }),
      });

      marker.bindPopup(`
        <h4>${escapeHtml(v.name)}</h4>
        <div style="font-size:.76rem;line-height:1.6">
          ${icon('bolt', 12)} Power: <strong style="color:${pColor}">${v.power.status}</strong>
            <span style="color:var(--text-3)">(${v.power.observers} obs, conf ${fmt(v.power.confidence, 2)})</span><br>
          ${icon('droplet', 12)} Water: <strong style="color:${wColor}">${v.water.status}</strong>
            <span style="color:var(--text-3)">(${v.water.observers} obs)</span><br>
          <span style="color:var(--text-2)">Feeder ${escapeHtml(v.feeder)} &middot; ${escapeHtml(v.water_zone)}</span>
        </div>
        ${v.power.since ? `<div style="font-size:.66rem;color:var(--watch);margin-top:5px">
          out since ${ago(v.power.since)}</div>` : ''}`);

      marker.addTo(this.groups.grid);
    }
  }

  /* ======================= Radar change ================================= */

  /**
   * Sentinel-1 surface change for Yutu, as a georeferenced image overlay.
   * Deliberately not a tile layer: it is one small pre-computed PNG covering
   * the island, so there is nothing to serve and it works offline like the
   * rest of the app.
   */
  drawSar(sar) {
    this.clear('sar');
    if (!sar || !sar.overlay) return;

    const bounds = sar.overlay.bounds;
    L.imageOverlay(sar.overlay.image, bounds, {
      opacity: 0.75,
      interactive: false,
      alt: 'Sentinel-1 backscatter change over Saipan, 16 to 28 October 2018',
    }).addTo(this.groups.sar);
  }

  /* ======================= Reef sites =================================== */

  drawReefs(sites, alertLevel) {
    this.clear('reef');
    const tone = token(['--ok', '--watch', '--warn', '--alert', '--crit'][alertLevel || 0], '#888');

    for (const s of sites) {
      L.circleMarker([s.lat, s.lon], {
        radius: 7,
        color: tone,
        weight: 2,
        fillColor: token('--surface', '#fff'),
        fillOpacity: 0.85,
      })
        .bindPopup(`
          <h4>${escapeHtml(s.name)}</h4>
          <div style="font-size:.66rem;color:var(--text-3);margin-bottom:4px">
            ${s.depth_m} m &middot; ${escapeHtml(s.habitat)}
          </div>
          <div style="font-size:.76rem">${escapeHtml(s.status_note)}</div>
          <div style="font-size:.72rem;color:var(--text-2);margin-top:5px">
            <strong>Indicator:</strong> ${escapeHtml(s.indicator_taxa)}<br>
            <strong>Pressures:</strong> ${s.pressures.map(escapeHtml).join(', ')}
          </div>`)
        .addTo(this.groups.reef);
    }
  }

  /* ======================= Helpers ====================================== */

  flyTo(lat, lon, zoom = 14) {
    if (this.map) this.map.flyTo([lat, lon], zoom, { duration: 0.8 });
  }

  resetView() {
    if (this.map) this.map.setView(ISLAND_VIEW.center, ISLAND_VIEW.zoom);
  }

  resize() {
    if (this.map) this.map.invalidateSize();
  }

  marker(lat, lon) {
    if (!this.map) return null;
    if (this._pin) this.map.removeLayer(this._pin);
    this._pin = L.circleMarker([lat, lon], {
      radius: 9, weight: 3, fillOpacity: 0.25,
      color: token('--accent', '#0f6fde'), fillColor: token('--accent', '#0f6fde'),
    }).addTo(this.map);
    return this._pin;
  }
}

/** Nearest village by great-circle distance, for auto-tagging a report. */
export function nearestVillage(lat, lon, villages) {
  let best = null;
  let bestD = Infinity;

  for (const v of villages) {
    const dLat = (v.lat - lat) * 111.32;
    const dLon = (v.lon - lon) * 111.32 * Math.cos((lat * Math.PI) / 180);
    const d = Math.hypot(dLat, dLon);
    if (d < bestD) { bestD = d; best = v; }
  }

  return best ? { village: best, distanceKm: +bestD.toFixed(2) } : null;
}
