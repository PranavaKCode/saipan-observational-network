# Demo script — 3:00

344 spoken words over 180 seconds is about **115 words per minute**. Normal
presenting pace is 130–150, so this is deliberately slack: every beat has room
to breathe, and you can pause on a number without going over. If a take runs
long, the three lines marked *(cuttable)* come out and nothing breaks.

Numbers are written the way they are said, not the way they are printed, so you
are never converting while the camera rolls.

---

## 0:00 – 0:24 · On camera only, no graphics

> Saipan sits in the most active typhoon basin on Earth.
>
> When Super Typhoon Yutu hit in 2018, some villages lost power for months.
>
> And when your water goes out there, you have no way to know if it's just
> your house, your village, or the whole island.
>
> So I built this.

*Hold the last line. The first screenshot comes up on "this", not before it.*

---

## 0:24 – 0:48 · `_cap-mobile/01-pulse.png`

> This is the island pulse. Every feed on it is live — NOAA, the Weather
> Service, NASA, Open-Meteo.
>
> Right now the island condition index reads twenty-four out of a hundred.
> Emergency.
>
> Flood hazard, reef heat stress and utility service, weighted into one number
> you can read in a second.

---

## 0:48 – 1:04 · `_cap-mobile/02-reef.png` — punch in on the Coral heat stress card

> The coral side is computed, not copied. Degree heating weeks, straight from
> sea surface temperature, on NOAA's Coral Reef Watch thresholds.
>
> Six point two. Alert Level One — bleaching likely.

---

## 1:04 – 1:26 · `_cap-mobile/03-map.png`

> On the map, risk isn't dots on villages. Village scores get interpolated into
> a continuous surface and clipped to the real surveyed coastline —
>
> so you see where the water goes, not which pin happens to be nearest.

---

## 1:26 – 1:48 · `_cap-mobile/04-map-sar.png`

> This layer is radar. Sentinel-1 bounces microwaves off the ground, so it sees
> straight through storm cloud.
>
> I pulled the scenes from before and after Yutu — October sixteenth and
> twenty-eighth — and differenced them. The bright areas are surface change.

---

## 1:48 – 2:08 · `_cap-mobile/06-report.png`

> Residents report what they see. Eleven categories — and every one writes to
> the device before it ever tries the network.
>
> Because the moment you actually need this, the towers are down. *(cuttable)*
>
> It syncs when signal comes back.

---

## 2:08 – 2:20 · `_cap-mobile/07-report-list.png`

> And it doesn't trust one report. Two independent observers, within a
> kilometre and a half and six hours, before anything gets upgraded.

---

## 2:20 – 2:42 · `_cap-mobile/09-model.png`, then `_cap-mobile/10-model-dials.png`

> The model trains in your browser. Three thousand four hundred days of
> reanalysis, with eight hundred sixty-two held back, strictly later in
> time. Held-out AUC, nine eight five. *(cuttable: the day counts, keep the AUC)*
>
> Dial a storm, and all thirty-one villages re-score as you drag.

*Swap to the dials screenshot on "Dial a storm."*

---

## 2:42 – 3:00 · `_cap-mobile/12-grid.png`, then end card

> Which closes the loop. Resident reports roll up into a public grid map —
> seventeen thousand people without power, by feeder, on the record.
>
> No backend, no build step, works offline. *(cuttable)*
>
> That's the Saipan Observational Network.

---

## Notes

**Every number here is on screen behind you** — twenty-four, six point two,
nine eight five, thirty-one villages, seventeen thousand — so nothing you say
contradicts what the viewer is reading.

**But the figures are live, and they move.** The model retrains on each load
against a record that grows by a day, every day, and the reef number tracks
sea surface temperature. Between the desktop pass and the mobile one the AUC
went .982 → .985, the held-out window 861 → 862 days, and heat stress 6.4 →
6.2. So if you recapture before recording, read the new numbers off the
screenshots and correct these three lines. `_cap-mobile/facts.json` has them
extracted for you.

**Captures are `_cap-mobile/`**, 1179×2556 — an iPhone 15 Pro viewport at 3×,
sized for a portrait device mockup. `_cap/` holds the 1920×1080 desktop set if
you ever want a browser frame instead.

Regenerate either with the dev server running:

```bash
node tools/capture_demo.mjs --mobile
```

**`saipan-observational-network.mp4`** is the 54-second cut of the same beats
with motion. Useful as b-roll under the middle section if a static screenshot
sits too long.
