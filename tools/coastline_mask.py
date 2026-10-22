#!/usr/bin/env python3
"""Build the island mask from the real coastline.

An earlier version derived this from the pre-event Sentinel-1 scene by
thresholding backscatter, on the reasoning that the radar product already
computed it. That was wrong, and visibly so: a single threshold is a poor
coastline extractor. Radar shadow on the steep east-facing slopes dropped
whole headlands below the threshold and bit a notch out of the southeast
coast; smooth inland ground punched a hole near Garapan; wave crests and
boats left specks stranded offshore; and the shore itself came out
stair-stepped at pixel resolution.

OpenStreetMap has the actual coastline, surveyed. Rasterising that gives one
cohesive, correctly shaped island with a clean edge, which is what the risk
surface needs to be clipped against.

    python tools/coastline_mask.py

Reads tools/.cache/coastline.json if present, otherwise fetches it from
Overpass and caches it. Writes data/saipan-land-mask.png.
"""

import json
import os
import sys
import urllib.parse
import urllib.request

from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, 'tools', '.cache')
DATA = os.path.join(ROOT, 'data')

# Must match the grid the radar products are written on, so the two overlays
# register against each other and share one set of bounds.
BBOX = (145.670, 15.080, 145.845, 15.300)   # west, south, east, north
OUT_RES_DEG = 0.00027                        # ~30 m

# Rasterise large, then scale down: that is what gives a smooth, anti-aliased
# coast instead of a staircase.
SUPERSAMPLE = 4

OVERPASS = 'https://overpass-api.de/api/interpreter'
QUERY = """
[out:json][timeout:90];
(way["natural"="coastline"](15.05,145.65,15.33,145.87););
out geom;
"""


def _stitch(ways, tol=1e-7):
    """Join coastline ways end to end into one ordered ring.

    OSM stores a coastline as many separate ways, and they come back in no
    particular order. Concatenating them as-is draws lines across the island
    and the polygon fill comes out as shattered glass. Each way has to be
    attached to whichever free end it actually touches, flipping it when it
    is stored in the opposite direction.
    """
    remaining = [list(w) for w in ways if len(w) > 1]
    if not remaining:
        return []

    remaining.sort(key=len, reverse=True)
    chain = remaining.pop(0)

    near = lambda a, b: abs(a[0] - b[0]) < tol and abs(a[1] - b[1]) < tol

    progress = True
    while remaining and progress:
        progress = False
        for i, w in enumerate(remaining):
            if near(chain[-1], w[0]):
                chain.extend(w[1:])
            elif near(chain[-1], w[-1]):
                chain.extend(list(reversed(w))[1:])
            elif near(chain[0], w[-1]):
                chain = w[:-1] + chain
            elif near(chain[0], w[0]):
                chain = list(reversed(w))[:-1] + chain
            else:
                continue
            remaining.pop(i)
            progress = True
            break

    if remaining:
        print(f'  note: {len(remaining)} coastline ways did not join the main ring')
    return chain


def load_ring():
    """The coastline as an ordered list of (lat, lon)."""
    path = os.path.join(CACHE, 'coastline-ring.json')
    if os.path.exists(path):
        with open(path, encoding='utf-8') as f:
            ring = json.load(f)
        print(f'  cached ring: {len(ring)} points')
        return [(float(a), float(b)) for a, b in ring]

    print('  fetching coastline from Overpass...')
    body = urllib.parse.urlencode({'data': QUERY}).encode()
    req = urllib.request.Request(OVERPASS, data=body,
                                 headers={'User-Agent': 'saipan-observational-network'})
    with urllib.request.urlopen(req, timeout=120) as r:
        payload = json.load(r)

    ways = [[(p['lat'], p['lon']) for p in w['geometry']]
            for w in payload.get('elements', []) if w.get('geometry')]
    if not ways:
        sys.exit('Overpass returned no coastline ways')
    print(f'  {len(ways)} ways, {sum(len(w) for w in ways)} points')

    ring = _stitch(ways)
    print(f'  stitched ring: {len(ring)} points, '
          f'{"closed" if abs(ring[0][0]-ring[-1][0]) < 1e-5 else "open"}')

    os.makedirs(CACHE, exist_ok=True)
    with open(path, 'w', encoding='utf-8') as f:
        json.dump([[a, b] for a, b in ring], f)
    return ring


def main():
    print('Saipan land mask from OpenStreetMap coastline')
    ring = load_ring()

    west, south, east, north = BBOX
    width = int(round((east - west) / OUT_RES_DEG))
    height = int(round((north - south) / OUT_RES_DEG))

    lats = [p[0] for p in ring]
    lons = [p[1] for p in ring]
    print(f'  extent  lat {min(lats):.4f}..{max(lats):.4f}  lon {min(lons):.4f}..{max(lons):.4f}')

    sw, sh = width * SUPERSAMPLE, height * SUPERSAMPLE
    img = Image.new('L', (sw, sh), 0)
    draw = ImageDraw.Draw(img)

    pts = [
        ((lon - west) / (east - west) * sw, (north - lat) / (north - south) * sh)
        for lat, lon in ring
    ]
    # A coastline way is open; closing it makes the land a filled polygon.
    draw.polygon(pts, fill=255)

    img = img.resize((width, height), Image.LANCZOS)

    rgba = Image.new('RGBA', (width, height))
    rgba.putdata([(255, 255, 255, a) for a in img.getdata()])

    os.makedirs(DATA, exist_ok=True)
    out = os.path.join(DATA, 'saipan-land-mask.png')
    rgba.save(out, optimize=True)

    import numpy as _np
    covered = float((_np.asarray(img) > 128).mean())
    km2 = covered * ((east - west) * 111.32 * 0.965) * ((north - south) * 111.32)
    print(f'  {width}x{height}  {os.path.getsize(out) / 1024:.0f} KB')
    print(f'  land {covered:.1%} of box  ~{km2:.0f} km2  (Saipan is about 115 km2)')


if __name__ == '__main__':
    main()
