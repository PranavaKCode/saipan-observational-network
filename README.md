# Saipan Observational Network

A citizen-science and utility-accountability app for Saipan, CNMI. It pairs live
satellite and weather data with a flood model that trains in the browser, and an
offline-first reporting tool that turns residents into the sensor network the
island does not otherwise have.

Built as a single-page web app with no build step and no backend. Open
`index.html` from any static server and it runs.

---

## The problem it addresses

Saipan carries four pressures at once, and they compound:

| Pressure | What is documented |
|---|---|
| **Flooding** | The southwest coastal plain (Susupe, Chalan Kanoa, Oleai, Garapan) sits 2–5 m above sea level on poorly drained fill beside the Lake Susupe wetland. Heavy rain ponds for days. |
| **Reef collapse** | Long-term monitoring recorded losses of **more than 85% of staghorn *Acropora*** at Saipan lagoon sites across the 2013 and 2014 bleaching events. 2017 was the most severe regional bleaching on record, affecting nearly all coral taxa down to at least 20 m. |
| **Utility instability** | Island-wide outages have been traced publicly to engine trips at Power Plant 1 and a high-voltage cable failure at Power Plant 4. Water follows power: CUC has described water systems needing roughly 2–3 hours to re-pressurise after island-wide loss. |
| **Storm exposure** | Typhoon Soudelor struck directly in August 2015; Super Typhoon Yutu, a category 5, hit Tinian and southern Saipan in October 2018. |

What is missing is not concern — it is **a shared record**. Residents cannot tell
a blown breaker from a feeder trip, nobody can say how widespread an outage is
while it is happening, and afterwards there is no data to point at.

---

## What the app does

### 1. Island pulse
A single composite **Island Condition Index** over five weighted components
(flood hazard 30%, reef heat stress 25%, utility service 25%, weather alerts 10%,
sea state 10%), each shown separately so the number can be argued with. Live
rainfall, wind, pressure, sea surface temperature, swell and the NWS forecast
for Saipan sit underneath it.

### 2. Satellite and field map
NASA GIBS daily composites with a **400-day date scrubber** and one-tap jumps to
Soudelor, Yutu and Mawar — slide back and watch the storm sit on the island.
Esri high-resolution imagery underneath, with an opacity control to compare.

The GIBS layer fades itself out past its native resolution (full strength to one
zoom past native, gone two zooms later) and leaves the map entirely rather than
sitting at zero opacity, so it stops requesting tiles nobody can see. True colour
is 375 m per pixel and its daily composite is stitched from separate orbital
passes, so close in it is haze plus visible swath seams; this keeps it where it
is informative and out of the way where it is not, and says so in the scrubber
rather than leaving the toggle looking broken.
Village flood risk, citizen reports, utility status and reef sites overlay it.

### 3. Field reporting
Eleven categories across hazards (flooding, downed lines, blocked roads),
utilities (power, water) and science (bleaching, invasive species, erosion,
turbidity, debris, fish kills). Category-specific follow-up questions, on-device
photo downscaling, GPS or map-pin location, and an **anonymous device-local
observer id** — no account, because an app that demands a login before letting
someone flag a live wire is a broken app.

Everything is written to IndexedDB **before** any network attempt.

### 4. Flood impact model
See [the model section](#the-model) below. Logistic regression, trained in your
browser on ~4,300 days of ERA5 reanalysis, downscaled to villages by an explicit
hazard × vulnerability formula, with scenario projection up to a Yutu-scale
category 5.

### 5. Crisis mode
A switch for the situation the app exists for: the network is throttled, the
battery is finite, and only three things matter. It turns off satellite
imagery, trims the feeds to current conditions and official alerts, and slows
updates from ten minutes to hourly. Measured effect on the weather request:
the hourly block is dropped and the windows shrink from 7 days forward to 1;
the marine request loses its 92-day history entirely. Filing and storing
reports is untouched. It does not claim a megabytes-saved figure, because that
number would be invented.

Reef heat stress needs 12 weeks of sea surface temperature, so in crisis mode
it reports itself paused rather than computing a figure from a truncated
window.

### 6. Verification tiers
Every report carries what the network could actually establish about it:
**Single report**, **Corroborated** (two or more independent observers, same
category, within 1.5 km and 6 hours), or **Resolved**. There is deliberately no
"cross-validated by satellite or sensor" tier, because this build has neither —
a badge implying a confirmation nobody performed is worse than no badge.

### 7. Export
A **situation report** that prints to one page, and **CSV** or **JSON** of the
reports. All three lead with the same disclaimer: community-generated, not a
product of CUC, BECQ, DCRM, NWS, FEMA or any emergency service. A document that
looks official and is not is dangerous during an emergency.

### 8. Grid and water status
Crowd reports aggregated into village and feeder status, with **corroboration
required**: two independent observers before a village is called out, one report
reads as "single report". When half the villages on a feeder report loss at once
the app infers a feeder-level fault rather than thirty coincidences. Builds a
reliability record — outage counts, median restore time per feeder, observed
uptime — which is the accountability half of the idea.

---

## The model

### Architecture
Logistic regression over eight daily weather features, full-batch gradient
descent with L2, trained client-side in ~1 second. Chosen over anything deeper
because it trains instantly on a phone, runs offline, and its weights are
readable — a manager can check that antecedent rain outweighs wind and disagree
if experience says otherwise.

**Features:** rain today · rain prior 3 days · rain prior 7 days · wet hours ·
max wind · pressure deficit · pressure trend · wet-season flag.

### Two heads, deliberately separated

Measured on the held-out block (861 days, strictly later in time than the 3,441
training days; 139 positives in the full record):

| Head | Question | Leakage | AUC | Recall | Precision | Brier skill vs climatology |
|---|---|---|---|---|---|---|
| **Nowcast** | Is today behaving like a high-impact rainfall day? | Yes — uses today's rain, which is part of the label | 0.993 | 0.93 | 0.60 | +0.70 |
| **Outlook** | Will tomorrow be one? | None — today and earlier only | 0.891 | 0.77 | 0.26 | +0.27 |

The nowcast's near-perfect AUC is **flattered and should not be quoted as
forecasting skill**. Judge the forecasting claim on the outlook head, which is
honestly weaker — a precision of 0.26 means roughly three false alarms for every
hit at the 0.5 threshold — and still beats a climatology baseline by 27% on
Brier score. For a rare, high-cost event, recall of 0.77 at that precision is
the right trade, but it is a trade and it is stated rather than buried.

These figures reproduce exactly between the in-browser trainer and an
independent Python implementation of the same math.

### Honest limitations
- **The labels are a proxy.** No open per-village flood record exists for
  Saipan, so a day counts as high-impact when its rainfall lands in the top 3%
  of the 2015–present record (≈26 mm/day), or the two-day total clears 75 mm.
  The model learns *"extreme rainfall day"* — a strong but imperfect stand-in
  for *"flooding happened"*.
- **The fix is the app itself.** Every flood report a resident files becomes a
  real observed label for that date, overriding the proxy on retrain. The
  training set gets less synthetic with use. The Model view shows the observed
  label count.
- **Probabilities are prior-corrected.** Positives are ~3% of days, so training
  weights them up or the model predicts "no flood" forever and scores 97%
  accuracy. That inflates raw outputs, so inference subtracts `ln(wPos/wNeg)`
  from the logit. Ranking comes from the weighted fit; displayed probabilities
  come after the correction.
- **No leakage in the split.** Chronological 80/20 — the test block is strictly
  later in time. Standardisation is fitted on the training split only.

### Village downscaling

```
vulnerability = 0.44·flood_history + 0.24·(1/(1 + elev/15)) + 0.21·(1 − drainage) + 0.11·coastal
risk          = hazard × (0.35 + 1.25 × vulnerability) + surge
```

The elevation term was a linear ramp to 120 m while elevations were estimates.
Measured against SRTM they run 6 m to 213 m, and a ramp handles that badly at
both ends: it flattens the bottom of the range, where the decision actually
lives — 7 m Chalan Kanoa and 13 m Tanapag are not the same village in a flood
— and it saturates the top, collapsing Marpi, Navy Hill and Capitol Hill to
exactly zero. `1/(1 + h/15)` halves exposure by 15 m and keeps falling after,
never quite reaching zero. The 15 is a judgement; it is one number, in one
place, and moving it moves the whole curve.

`surge` applies only to low-lying coastal villages when swell exceeds 2.5 m.
Two or more ground reports within 24 h floor a village at High **regardless of
the model** — an observation on the ground outranks a prediction.

On a settled day every absolute score sits near zero. That is the correct
answer, not a broken gauge; switch scenario to see the model respond.

---

## Interface

The design follows Apple's interface and motion guidance, adapted for the web.

**One calm canvas, one translucent layer.** The top bar, tab bar, map panels
and toasts are `backdrop-filter` materials with content scrolling underneath;
nothing translucent is ever stacked on something else translucent. Hierarchy
comes from type, weight and space rather than from nesting cards inside cards.

**Colour is spent on data, not chrome.** The interface is near-monochrome with
a single accent, so a red reading means something. Semantic state (ok, watch,
warn, alert, critical) is a separate scale from the accent, and the coefficient
chart uses a diverging amber/blue pair because a model weight is not an error.

**Light and dark, both designed.** Every colour is a token defined on `:root`,
redefined under `prefers-color-scheme: dark` and again under `[data-theme]` so
the in-app toggle wins in both directions. The app follows the system until the
reader chooses, and remembers the choice. Charts read their colours from the
same tokens, so there is no second code path for dark mode.

**Two shapes, not one stretched.** Below 1024px the navigation is a thumb-reachable
tab bar and modals are bottom sheets. At desktop width the navigation becomes a
labelled sidebar rail and sheets become centred dialogs.

**Motion is physical and interruptible.** Feedback fires on pointer-down, not on
release. Transitions use critically damped spring curves at a 0.3–0.4s response,
with no overshoot on anything the user did not throw. The bottom sheet can be
dragged away: it tracks the pointer 1:1, rubber-bands when pulled past its top
edge, and on release projects where the throw was heading
(`current + (v/1000)·d/(1−d)`, `d = 0.998`) to decide between dismissing and
settling back — so the gesture and the animation are one continuous motion.

**Accessibility preferences are honoured as design states**, not afterthoughts:
`prefers-reduced-motion` swaps slides for cross-fades, `prefers-reduced-transparency`
makes every material solid, and `prefers-contrast: more` strengthens every border.

Typography is the platform system face. A web font would be a liability in an
app whose premise is working offline, and the system face already ships the
optical sizing and tracking tables this kind of dense, numeric UI needs.

## Data sources

All feeds are open, keyless and CORS-enabled — no API key to expire when a
grant ends.

| Source | Used for | Endpoint |
|---|---|---|
| Open-Meteo Forecast | Current conditions, 7-day rain/wind | `api.open-meteo.com` |
| Open-Meteo Marine | Waves, sea surface temperature, 92-day SST history | `marine-api.open-meteo.com` |
| Open-Meteo Archive | ERA5 reanalysis, 2015–present — the training set | `archive-api.open-meteo.com` |
| NOAA / NWS | Forecast and alerts, office `GUM` grid `87,123`, zone `MPZ003` | `api.weather.gov` |
| USGS | Mariana seismicity, M4+ within 500 km | `earthquake.usgs.gov` |
| NASA EOSDIS GIBS | Daily VIIRS true colour, MUR SST anomaly, MODIS SST | `gibs.earthdata.nasa.gov` |
| Esri | High-resolution reference imagery | `services.arcgisonline.com` |
| Open-Topo-Data (SRTM 30 m) | Village elevation and slope, refreshed offline | `api.opentopodata.org` |
| OpenStreetMap / Overpass | Building footprints, place nodes and coastline, refreshed offline | `overpass-api.de` |

The last two are build-time, not runtime: `tools/refresh_terrain.py` calls them
and writes the result into `data/island.json`, so the app itself ships the
measured values and never needs them at load.

**Coral bleaching alert levels** follow the NOAA Coral Reef Watch definition
(DHW = Σ max(0, SST − MMM) over 12 weeks ÷ 7) computed here from Open-Meteo
marine SST against a 29.3 °C monthly maximum. **This is not an official NOAA
product.**

### Data provenance — what is real and what is a placeholder

This matters more than any feature, so it is also stated inside the app under
Settings → Data provenance.

**Real and live:** every feed in the table above.

**Measured, for 26 of the 31 villages** — `elev_m`, `slope_pct` and the
`drainage` score derived from it in `data/island.json`:

| Field | Source |
|---|---|
| `elev_m` | **SRTM 30 m** (NASA/USGS 1-arcsecond) via `api.opentopodata.org` — median over the village's built-up ground |
| `slope_pct` | the same DEM, central differences on a 165 m lattice |
| `drainage` | derived from `slope_pct`: `(slope − 1%) / 11%`, clamped to 0–1 |
| `coast_dist_m` | distance to **OpenStreetMap** `natural=coastline` |

Not "the DEM pixel under the village coordinate" — the coordinates in this file
were hand-placed and several were off by one to two kilometres, which on
Saipan's west scarp is a 40 m elevation error. Each village is first anchored
to the ground its houses actually stand on, using **OpenStreetMap building
footprints**, then measured over a 500 m radius of that anchor. Where an OSM
place node of the same name within 2.5 km had more buildings around it than the
recorded coordinate did, the village was re-anchored there and `coord_src` says
so; 16 villages moved. Re-run with `python tools/refresh_terrain.py`, which
prints every move and backs the file up first.

Useful side effect: measured elevation and drainage correlate at 0.67, against
0.86 for the hand estimates they replace — the two terms of the index are less
redundant than they were.

**Still prototype estimates, and labelled as such in the data:**
- `flood_history` for every village — the single largest soft spot in the
  model, since it carries 0.44 of the vulnerability index. There is no open
  per-village flood record for Saipan.
  → Replace with **CNMI BECQ / FEMA** flood-zone mapping or CUC/EOC incident logs.
- `elev_m`, `slope_pct` and `drainage` for the five villages with too few
  mapped buildings to measure honestly — **Talafofo, Chalan Laulau, As Perdido,
  Laolao, Obyan** (`terrain_src: "estimate"`). Their recorded coordinates sit
  away from any mapped settlement; As Perdido's has no buildings within 800 m
  at all and is probably off the island.
  → Fix those five coordinates, then re-run the refresh script.
- The `coastal` flag everywhere. Whether a village takes surge depends on reef,
  cliff and aspect, not distance alone, so the measured `coast_dist_m` is
  recorded beside the flag rather than replacing it. Seven villages disagree
  with a naive 800 m rule; the script lists them.
- Village populations — loosely based on 2020 census groupings.
  → Replace with **CNMI Central Statistics Division** census data.
- CUC feeder membership, power plant roles and water zones.
  → Replace with **CUC's** actual switching diagram and distribution map.
- The 29.3 °C bleaching baseline.
  → Replace with the official **NOAA Coral Reef Watch** MMM for the Saipan pixel.
- Reef site status notes summarise published BECQ/DCRM findings; site
  coordinates are approximate.
  → Verify against **BECQ / DCRM** monitoring stations.

**Crowd-derived, never authoritative:** every outage and hazard status comes
from residents, with observer counts and confidence shown. This app is not CUC,
BECQ, DCRM, NWS or any emergency service. In a real emergency, call the
authorities.

---

## Offline design

Offline is the premise, not a feature. A report filed in a flooded village on a
dead cell site has to survive a dead battery and a browser restart.

| Resource | Strategy | Why |
|---|---|---|
| App shell | Cache-first, precached on install | Must open with no network at all |
| Map tiles | Cache-first, capped at 1200 entries | Island tiles never change; the map keeps working in the field |
| Live feeds | Network-first, fall back to last good response | A stale reading is useful, a blank dashboard is not — and the UI **labels** anything served from cache as stale |

Reports queue in IndexedDB with a visible on-device count. There is no server in
this build: rather than fake a successful upload, the queue stays honest and the
UI says the report is stored on the device. Set an HTTPS endpoint in Settings
and the same queue drains to it.

*Verified:* with the dev server stopped entirely, the app still boots, renders
cached conditions, and keeps all stored reports and the trained model.

---

## Running it

```bash
git clone https://github.com/PranavaKCode/saipan-observational-network.git
cd saipan-observational-network
python tools/devserver.py
```

Then open `http://localhost:8777`. Use `tools/devserver.py` rather than
`python -m http.server`: the latter sends no cache headers, so browsers apply
heuristic caching, and with ES modules on unversioned filenames that produces a
genuinely confusing failure — you edit a module, reload, and the browser keeps
the old copy, reporting an import error for an export that is plainly in the
file. The dev server disables caching and pins the MIME types. Production
caching is a separate policy and lives in `vercel.json`.

There is nothing to install. The one optional step is a map key: copy
`js/carto-key.example.js` to `js/carto-key.js` and paste in a free
[CARTO](https://carto.com/basemaps/) key, then restrict it to your own domain
in their dashboard. Without it the app still runs — CARTO's raster endpoint
serves unkeyed requests, and the default Esri imagery base needs no key at
all. The key is deliberately not in this repository: the browser has to send
it with every tile request, so it cannot be hidden from a determined reader,
but it also should not be sitting in a public history for bots to harvest. Any static server works. A service worker
needs `http://` or `https://` — opening `index.html` as a `file://` URL works
but without offline caching.

Installable as a PWA, with home-screen shortcuts straight to a flood report, a
power report, or the grid view.

### Deployed

**https://son-five-xi.vercel.app**

Hosted on Vercel as a static site — no build step, no server. `vercel.json`
carries the header rules, which exist for specific reasons:

| Path | Cache-Control | Why |
|---|---|---|
| `/sw.js` | `max-age=0, must-revalidate` | The service worker decides what every returning visitor sees. If a cache pins an old copy, people keep running a stale app with no way out. Also sets `Service-Worker-Allowed: /`. |
| `/css/*` | `immutable`, 1 year | The stylesheet is requested with an explicit `?v=` that is bumped on every change, so a new version is a different URL. Safe to cache hard. |
| `/js/*`, `/data/*`, `/` | `max-age=0, must-revalidate` | These carry no version in their filename. The service worker already serves them instantly from its own cache, so this only governs how fast a deploy reaches people. |

Plus `X-Content-Type-Options`, `X-Frame-Options: SAMEORIGIN`, a strict
`Referrer-Policy`, and a `Permissions-Policy` that allows geolocation and
camera only to the app's own origin — the reports and photos live on the
device, and those headers are what stop an embedded or spoofed copy reaching
them.

`.vercelignore` keeps the terrain tooling's scratch cache out of the bundle.

Redeploy with:

```bash
npx vercel@latest deploy --prod --yes
```

Any other static host works the same way — GitHub Pages, Netlify, Cloudflare
Pages. The one thing that does not work is a sandboxed embed that blocks
cross-origin stylesheets, images or `fetch`: that strips the live feeds and the
map tiles. The app needs ordinary static hosting, not an iframe.

### Verifying the model independently

```bash
python tools/validate_nowcast.py   # diagnostic head
python tools/validate_outlook.py   # leakage-free forecast head
```

Each script pulls the same ERA5 series and reimplements the training, splitting
and metrics from scratch in Python. They reproduce the in-browser numbers to
three decimal places, which is the check that the JavaScript trainer is doing
what it claims.

### Project layout

```
index.html            app shell and bottom navigation
app.webmanifest       PWA manifest with shortcuts
sw.js                 service worker: shell, tile and feed caching
css/son.css           design system
js/
  main.js             boot, state, the five views
  export.js           CSV, JSON and the printable situation report
  feeds.js            open data feeds, DHW and bleaching alerts
  model.js            dataset build, training, evaluation, downscaling
  grid.js             outage aggregation, corroboration, reliability record
  map.js              Leaflet, GIBS layers, overlays
  reports.js          report composer, photo handling, sync queue
  store.js            IndexedDB with in-memory fallback
  ui.js               icons, toasts, sheets, SVG charts
data/
  island.json         villages, feeders, plants, water zones
  science.json        reef sites, invasive watchlist, categories, timeline
```

Dependencies: Leaflet 1.9.4 from cdnjs with SRI hashes. Everything else is
hand-written — the charts are inline SVG so nothing extra has to be cached.

---

## What I would build next

1. **Replace the proxy labels.** A season of real flood reports makes the
   outlook head genuinely trustworthy.
2. **Official geodata.** A real DEM and CUC's feeder map would sharpen village
   risk more than any modelling change.
3. **Photo-based bleaching estimates.** Percent-bleached from a tagged-colony
   photo is a well-posed vision problem and the reports already carry the
   images.
4. **A real sync backend** with moderation, so corroborated reports can reach
   BECQ, DCRM and CUC rather than only the device that filed them.
5. **Chamorro and Carolinian localisation.** An island app that only speaks
   English is only half an island app.
