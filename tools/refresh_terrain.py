"""Measure the village terrain fields in data/island.json from open data.

Writes, per village:

  elev_m        median SRTM 30 m elevation of the village's built-up ground
  slope_pct     median local hillslope over that same ground
  drainage      0-1 score derived from slope_pct, consumed by the risk model
  coast_dist_m  distance from the measurement point to the mapped coastline
  terrain_src   "measured" or "estimate" - never guessed at

Sources
  SRTM 30 m (NASA/USGS, 1-arcsecond) via Open-Topo-Data, api.opentopodata.org
  OpenStreetMap building footprints, place nodes and natural=coastline,
  via Overpass

Why this is not just "sample the DEM at the village coordinate"
  The coordinates in island.json are hand-placed and several are off by one to
  two kilometres. Saipan's west side is a scarp - the ground climbs 40 m in the
  500 m behind Garapan - so one DEM pixel at a hand-placed point reads the
  hillside for a village that sits on the beach flat. Garapan measures 39 m
  that way against a true 4-5 m.

  So each village is first anchored to the ground its houses actually stand on,
  then measured over a 500 m radius of that anchor. The anchor is the recorded
  coordinate unless OpenStreetMap has a place node of the same name within
  2.5 km that has strictly more buildings around it, in which case the village
  was pinned in the bush and the OSM node is the village. Every move is printed
  and recorded in coord_src, and the original file is copied to tools/.cache
  first, so this is auditable and revertible.

  Villages with almost no mapped buildings near either candidate cannot be
  measured this way. Their terrain is left exactly as it was and marked
  "estimate". They are listed at the end of the run.

What this script never touches
  flood_history. There is no open per-village flood record for Saipan, so it
  stays a hand estimate and stays labelled as one.
  coastal. Whether a village takes surge depends on reef, cliff and aspect, not
  only on distance, so the measured coast_dist_m is recorded alongside the
  author's flag rather than overwriting it. Disagreements are printed.

Usage
  python tools/refresh_terrain.py              # measure and write island.json
  python tools/refresh_terrain.py --dry-run    # measure and print, write nothing
  python tools/refresh_terrain.py --no-cache   # refetch instead of reusing tools/.cache

Needs network. Stdlib only. About 35 Open-Topo-Data calls, throttled to the
public 1/s limit, so a cold run takes roughly a minute.
"""

import argparse, json, math, os, re, shutil, time, urllib.parse, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
ISLAND = os.path.join(ROOT, "data", "island.json")
CACHE = os.path.join(HERE, ".cache")

BBOX = (15.08, 145.66, 15.32, 145.85)   # south, west, north, east
LATTICE = 0.0015                        # ~165 m, the DEM sampling step
SAMPLE_R = 500                          # measure over buildings within this of the anchor
ANCHOR_R = 400                          # building count used to choose between anchors
MAX_MOVE = 2500                         # an OSM node further than this is a different place
SAME_PLACE_M = 25                       # ...and nearer than this is the same place, already anchored
MIN_BUILDINGS = 8                       # fewer than this near the anchor: do not claim a measurement
POP_PER_BUILDING = 40                   # ...nor if the anchor holds fewer houses than the village needs
SLOPE_FLAT, SLOPE_FREE = 1.0, 12.0      # drainage scale, in percent rise

UA = {"User-Agent": "saipan-observational-network/1.0 (prototype data refresh)"}
OVERPASS = [
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]

M_PER_DEG_LAT = 110950.0
def m_per_deg_lon(lat): return 111320.0 * math.cos(math.radians(lat))
def metres(alat, alon, blat, blon):
    return math.hypot((alat - blat) * M_PER_DEG_LAT, (alon - blon) * m_per_deg_lon(alat))


# --------------------------------------------------------------------------
# fetching

def cached(name, build, use_cache=True):
    path = os.path.join(CACHE, name)
    if use_cache and os.path.exists(path):
        print(f"  cache hit {name}")
        return json.load(open(path, encoding="utf-8"))
    data = build()
    os.makedirs(CACHE, exist_ok=True)
    json.dump(data, open(path, "w", encoding="utf-8"))
    return data


def overpass(query):
    body = urllib.parse.urlencode({"data": query}).encode()
    for endpoint in OVERPASS:
        try:
            return json.load(urllib.request.urlopen(
                urllib.request.Request(endpoint, data=body, headers=UA), timeout=300))
        except Exception as exc:
            print(f"  {endpoint.split('/')[2]} failed: {exc!r:.60}")
            time.sleep(3)
    raise SystemExit("every Overpass mirror failed")


def fetch_buildings():
    print("  Overpass: building footprints")
    s, w, n, e = BBOX
    d = overpass(f'[out:json][timeout:300];way["building"]({s},{w},{n},{e});out center;')
    pts = [[el["center"]["lat"], el["center"]["lon"]] for el in d["elements"] if "center" in el]
    print(f"  {len(pts)} buildings")
    return pts


def fetch_places():
    print("  Overpass: place nodes")
    s, w, n, e = BBOX
    d = overpass(f'[out:json][timeout:120];node["place"]({s},{w},{n},{e});out tags center;')
    pts = [{"name": el["tags"]["name"], "lat": el["lat"], "lon": el["lon"],
            "place": el["tags"].get("place")}
           for el in d["elements"] if el.get("tags", {}).get("name")]
    print(f"  {len(pts)} named places")
    return pts


def fetch_coastline():
    print("  Overpass: coastline")
    s, w, n, e = BBOX
    d = overpass(f'[out:json][timeout:300];way["natural"="coastline"]({s},{w},{n},{e});out geom;')
    pts = [[g["lat"], g["lon"]] for el in d["elements"] for g in el.get("geometry", [])]
    print(f"  {len(pts)} coastline nodes")
    return pts


def fetch_elevations(cells):
    cells = sorted(cells)
    print(f"  Open-Topo-Data: {len(cells)} lattice cells in {-(-len(cells) // 100)} calls")
    out = {}
    for start in range(0, len(cells), 100):
        chunk = cells[start:start + 100]
        url = "https://api.opentopodata.org/v1/srtm30m?locations=" + \
              "|".join(f"{i * LATTICE:.5f},{j * LATTICE:.5f}" for i, j in chunk)
        for attempt in range(5):
            try:
                res = json.load(urllib.request.urlopen(
                    urllib.request.Request(url, headers=UA), timeout=90))["results"]
                break
            except Exception as exc:
                print(f"  retry ({exc!r:.50})")
                time.sleep(4)
        else:
            raise SystemExit("Open-Topo-Data did not answer")
        for cell, r in zip(chunk, res):
            out[f"{cell[0]},{cell[1]}"] = r["elevation"]
        time.sleep(1.05)                 # public limit is 1 call/s
    return out


# --------------------------------------------------------------------------
# measuring

def median(xs):
    xs = sorted(xs)
    if not xs: return None
    mid = len(xs) // 2
    return xs[mid] if len(xs) % 2 else (xs[mid - 1] + xs[mid]) / 2


def cell_of(lat, lon): return (round(lat / LATTICE), round(lon / LATTICE))


def slope_pct(i, j, dem):
    """Local slope by central differences on the lattice, in percent rise.

    The baseline is two cells, about 330 m, so this is a smoothed hillslope
    rather than a pixel-to-pixel gradient - which is what we want, because a
    village drains down a hillside, not down one 30 m DEM cell.
    """
    def z(a, b): return dem.get(f"{a},{b}")
    n, s, e, w = z(i + 1, j), z(i - 1, j), z(i, j + 1), z(i, j - 1)
    if None in (n, s, e, w): return None
    dy = (n - s) / (2 * LATTICE * M_PER_DEG_LAT)
    dx = (e - w) / (2 * LATTICE * m_per_deg_lon(i * LATTICE))
    return 100.0 * math.hypot(dx, dy)


def drainage_from_slope(pct):
    """Map hillslope to the 0-1 drainage score the vulnerability index wants.

    1.0 is ground that sheds water, 0.0 is ground that holds it. Flat coastal
    fill below ~1% ponds; past ~12% one village sheds about as fast as the
    next, so the scale saturates there. Linear in between - this is a proxy
    for drainage, not a measurement of it, and giving it more shape than a
    straight line would be pretending to knowledge we do not have.
    """
    return round(min(1.0, max(0.0, (pct - SLOPE_FLAT) / (SLOPE_FREE - SLOPE_FLAT))), 2)


def normalise(name): return re.sub(r"[^a-z]", "", (name or "").lower())


def choose_anchor(v, places, buildings):
    """Put the village where its houses are, or leave it where it was.

    Candidates are the recorded coordinate and any same-named OSM place node
    within MAX_MOVE. Whichever has more mapped buildings within ANCHOR_R wins;
    ties go to the recorded coordinate, so nothing moves without evidence.
    """
    def count(lat, lon):
        return sum(1 for b in buildings if metres(lat, lon, b[0], b[1]) <= ANCHOR_R)

    name, vid = normalise(v["name"]), normalise(v["id"])
    here = count(v["lat"], v["lon"])
    best, best_n = None, here
    for p in places:
        pn = normalise(p["name"])
        if not pn or not (pn == name or pn == vid or name.startswith(pn) or pn.startswith(vid)):
            continue
        away = metres(v["lat"], v["lon"], p["lat"], p["lon"])
        if away > MAX_MOVE:
            continue                     # same name, different place
        if away <= SAME_PLACE_M:
            # Already standing on this node - almost certainly a previous run
            # of this script. Keep the credit, do not report a move.
            return v["lat"], v["lon"], "osm-place-node", here, 0
        n = count(p["lat"], p["lon"])
        if n > best_n:
            best, best_n = p, n
    if best is None:
        return v["lat"], v["lon"], "prototype-estimate", here, 0
    return (best["lat"], best["lon"], "osm-place-node", best_n,
            metres(v["lat"], v["lon"], best["lat"], best["lon"]))


def measure(villages, places, buildings, coastline, dem):
    out = {}
    for v in villages:
        lat, lon, src, near_n, moved = choose_anchor(v, places, buildings)
        pts = [b for b in buildings if metres(lat, lon, b[0], b[1]) <= SAMPLE_R]

        cells = {}
        for blat, blon in pts:
            cells[cell_of(blat, blon)] = cells.get(cell_of(blat, blon), 0) + 1

        # Weight each cell by the buildings standing on it, so the median is
        # the elevation of the median house, not of the median patch of land.
        elevs, slopes = [], []
        for (i, j), count in cells.items():
            z = dem.get(f"{i},{j}")
            if z is not None: elevs += [z] * count
            s = slope_pct(i, j, dem)
            if s is not None: slopes += [s] * count

        rec = {
            "lat": round(lat, 5), "lon": round(lon, 5), "coord_src": src,
            "moved_m": round(moved), "n_buildings": len(pts),
            "coast_dist_m": round(min(metres(lat, lon, a, b) for a, b in coastline)),
            # Only claim a measurement when the anchor really is in the
            # village's settlement. A village of 1600 people with 19 mapped
            # buildings within 500 m is pinned somewhere its people are not,
            # and measuring that ground would be measuring the wrong hill.
            "measured": (len(pts) >= MIN_BUILDINGS
                         and len(pts) >= v["pop"] / POP_PER_BUILDING
                         and bool(elevs) and bool(slopes)),
        }
        if rec["measured"]:
            rec["elev_m"] = round(median(elevs))
            rec["elev_p10"] = round(sorted(elevs)[len(elevs) // 10])
            rec["elev_p90"] = round(sorted(elevs)[len(elevs) * 9 // 10])
            rec["slope_pct"] = round(median(slopes), 1)
            rec["drainage"] = drainage_from_slope(rec["slope_pct"])
        out[v["id"]] = rec
    return out


# --------------------------------------------------------------------------
# writing

def set_field(text, vid, field, value):
    """Replace or insert one field of one village, leaving the file's hand
    formatting - one village to a line - exactly as it is."""
    m = re.search(r'^.*"id": "' + re.escape(vid) + r'".*$', text, re.M)
    if not m: raise SystemExit(f"no line for village {vid}")
    old = m.group(0)
    new, n = re.subn(r'("' + field + r'": )(?:"[^"]*"|[^,}]+)',
                     lambda g: g.group(1) + json.dumps(value), old, count=1)
    if n == 0:                           # new field, place it after elev_m
        new = re.sub(r'("elev_m": [^,]+,)',
                     lambda g: g.group(1) + f' "{field}": {json.dumps(value)},', old, count=1)
    return text.replace(old, new, 1)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--dry-run", action="store_true", help="measure and print, write nothing")
    ap.add_argument("--no-cache", action="store_true", help="refetch instead of reusing tools/.cache")
    args = ap.parse_args()
    use_cache = not args.no_cache

    text = open(ISLAND, encoding="utf-8").read()
    island = json.loads(text)
    villages = island["villages"]
    print(f"{len(villages)} villages in {os.path.relpath(ISLAND, ROOT)}")

    buildings = cached("buildings.json", fetch_buildings, use_cache)
    places = cached("places.json", fetch_places, use_cache)
    coastline = cached("coastline.json", fetch_coastline, use_cache)

    # The DEM lattice covers every built-up cell plus a one-cell halo, because
    # the slope of an edge cell needs its four neighbours.
    built = {cell_of(lat, lon) for lat, lon in buildings}
    lattice = {(i + di, j + dj) for i, j in built
               for di, dj in ((0, 0), (1, 0), (-1, 0), (0, 1), (0, -1))}
    dem = cached("dem.json", lambda: fetch_elevations(lattice), use_cache)

    stats = measure(villages, places, buildings, coastline, dem)

    print(f"\n{'village':16s} {'anchor':>6s} {'move':>5s} {'bld':>4s} "
          f"{'elev was':>8s} {'now':>4s} {'p10':>4s} {'p90':>4s} "
          f"{'slope':>6s} {'drain was':>9s} {'now':>4s} {'coast_m':>7s}")
    skipped, moves, coast_clash = [], [], []
    for v in villages:
        s = stats[v["id"]]
        tag = "OSM" if s["coord_src"] == "osm-place-node" else "-"
        if not s["measured"]:
            skipped.append(v["id"])
            print(f"{v['id']:16s} {tag:>6s} {s['moved_m']:5d} {s['n_buildings']:4d} "
                  f"{v['elev_m']:8d}   -- too few mapped buildings, left as an estimate")
            continue
        if s["moved_m"]: moves.append((v["id"], v["lat"], v["lon"], s["lat"], s["lon"], s["moved_m"]))
        if v["coastal"] != (s["coast_dist_m"] <= 800): coast_clash.append((v["id"], v["coastal"], s["coast_dist_m"]))
        print(f"{v['id']:16s} {tag:>6s} {s['moved_m']:5d} {s['n_buildings']:4d} "
              f"{v['elev_m']:8d} {s['elev_m']:4d} {s['elev_p10']:4d} {s['elev_p90']:4d} "
              f"{s['slope_pct']:6.1f} {v['drainage']:9.2f} {s['drainage']:4.2f} {s['coast_dist_m']:7d}")

    if moves:
        print(f"\n{len(moves)} villages re-anchored to their OSM place node:")
        for vid, ola, olo, nla, nlo, d in sorted(moves, key=lambda m: -m[5]):
            print(f"  {vid:16s} {ola:.4f},{olo:.4f} -> {nla:.4f},{nlo:.4f}  ({d} m)")
    if skipped:
        print(f"\nleft as estimates ({len(skipped)}): {', '.join(skipped)}")
        print("  too few mapped buildings near the coordinate to measure honestly")
    if coast_clash:
        print("\ncoastal flag vs measured distance to the coastline (flag not changed):")
        for vid, flag, d in coast_clash:
            print(f"  {vid:16s} coastal={str(flag):5s} but {d} m from the sea")

    if args.dry_run:
        print("\n--dry-run, island.json not written")
        return

    # Back up the hand-written original once and never again: a second run
    # would otherwise overwrite it with its own output and lose the only copy
    # of the values this script replaced.
    os.makedirs(CACHE, exist_ok=True)
    backup = os.path.join(CACHE, "island.before-first-refresh.json")
    if not os.path.exists(backup):
        shutil.copy(ISLAND, backup)

    for v in villages:
        s = stats[v["id"]]
        text = set_field(text, v["id"], "coast_dist_m", s["coast_dist_m"])
        if not s["measured"]:
            text = set_field(text, v["id"], "terrain_src", "estimate")
            continue
        if s["moved_m"]:
            text = set_field(text, v["id"], "lat", s["lat"])
            text = set_field(text, v["id"], "lon", s["lon"])
        text = set_field(text, v["id"], "coord_src", s["coord_src"])
        text = set_field(text, v["id"], "elev_m", s["elev_m"])
        text = set_field(text, v["id"], "slope_pct", s["slope_pct"])
        text = set_field(text, v["id"], "drainage", s["drainage"])
        text = set_field(text, v["id"], "terrain_src", "measured")

    text = re.sub(r'("terrain_measured": ")[^"]*(")', r"\g<1>" + time.strftime("%Y-%m-%d") + r"\2", text)
    json.loads(text)                     # fail before writing if the rewrite broke the file
    open(ISLAND, "w", encoding="utf-8").write(text)
    print(f"\nwrote {os.path.relpath(ISLAND, ROOT)}; "
          f"hand-written original kept at {os.path.relpath(backup, ROOT)}")
    print("flood_history and the coastal flag untouched - still hand estimates, by design")


if __name__ == "__main__":
    main()
