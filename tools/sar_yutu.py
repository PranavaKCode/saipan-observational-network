#!/usr/bin/env python3
"""Surface change over Saipan from Sentinel-1 radar, bracketing Super Typhoon Yutu.

WHY RADAR
    Every optical source this app uses - VIIRS, MODIS, Esri - is blind during
    a typhoon, because a typhoon is made of cloud. Slide the map scrubber to
    25 October 2018 and you see Yutu's cloud tops, not what happened beneath
    them. Synthetic aperture radar does not care about cloud or darkness.

THE PAIR
    Sentinel-1 RTC (radiometrically terrain corrected gamma0), from Microsoft
    Planetary Computer's `sentinel-1-rtc` collection:

        pre   2018-10-16 20:07Z
        post  2018-10-28 20:07Z   (3 days after landfall on 24-25 Oct)

    Same relative orbit, same pass time, 12-day repeat, so geometry and
    incidence angle match and gamma0 can be differenced directly. The products
    arrive terrain corrected and geocoded, which is the whole reason for
    preferring them over raw GRD: no co-registration, no DEM work.

    Planetary Computer issues a read token anonymously, so this runs with no
    account anywhere. The same products on NASA/ASF need an Earthdata login:
    a HEAD request there returns 200 and a GET returns 401, which is an easy
    way to convince yourself the data is open when it is not.

    Assets are cloud-optimized GeoTIFFs read over HTTP range requests, so only
    the Saipan window is transferred, not the whole scene.

WHAT THIS MEASURES, AND WHAT IT DOES NOT
    It measures CHANGE IN RADAR BACKSCATTER. For a category 5 landfall that
    change is dominated by structural damage and defoliation, not standing
    water. NASA JPL's own Yutu product was named a "Damage Proxy Map" for
    exactly this reason.

    A separate open-water test is computed as well, but it is reported
    separately and never merged into the change figure, because:

      - the post-event scene is 3 days late, and Saipan's karst plateau
        drains fast; only the Susupe and Chalan Piao basins pond for days
      - radar water detection fails in dense built-up areas, where
        double-bounce off walls returns bright and hides the dark water
        signal - Chalan Kanoa's tight grid is precisely the hard case

    So the output names its fields for what they are. Calling this "flood
    extent" would be the kind of overclaim this project exists to avoid.

USAGE
    python tools/sar_yutu.py

    Needs `pip install rasterio`. Reads only the Saipan window over the
    network and writes data/sar-yutu.json and data/sar-yutu-change.png.
"""

import json
import math
import os
import sys
import urllib.request

import numpy as np

try:
    import rasterio
    from rasterio.warp import reproject, Resampling, calculate_default_transform
except ImportError:
    sys.exit('rasterio is required:  pip install rasterio')

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, 'tools', '.cache')
DATA = os.path.join(ROOT, 'data')

STAC = 'https://planetarycomputer.microsoft.com/api/stac/v1/search'
SAS = 'https://planetarycomputer.microsoft.com/api/sas/v1/token/sentinel-1-rtc'
COLLECTION = 'sentinel-1-rtc'

DATES = {
    'pre':  ('2018-10-16T00:00:00Z', '2018-10-17T00:00:00Z'),
    'post': ('2018-10-28T00:00:00Z', '2018-10-29T00:00:00Z'),
}

# Saipan, with a small margin.
BBOX = (145.670, 15.080, 145.845, 15.300)   # west, south, east, north
OUT_RES_DEG = 0.00027                        # ~30 m, matching the product

# gamma0 in dB below which a VV pixel reads as a specular surface - calm open
# water being the usual cause. Published Sentinel-1 VV water thresholds sit
# between about -15 and -20 dB; -17 is the middle of that range. Roughened
# water under wind returns brighter and is missed, so this under-counts.
WATER_DB = -17.0

# Pre-event gamma0 above this reads as land. Calm open water sits well below
# -17 dB in VV; coastal land is typically -10 dB or brighter. This matters a
# great deal: the analysis box is mostly ocean, and sea state changed
# enormously between a calm 16 October and three days after a category 5. A
# "common mode" computed over the whole box would be mostly that sea-state
# change, and subtracting it from land pixels would push nearly every village
# negative for no physical reason.
LAND_DB = -14.0

# A backscatter change this large is not speckle. Sentinel-1 VV speckle on
# 30 m multi-looked data sits well under 1 dB, so 3 dB is a conservative bar.
CHANGE_DB = 3.0

# How far around a village anchor to pool pixels. Matches the 500 m used by
# refresh_terrain.py so the two measurements describe the same footprint.
VILLAGE_RADIUS_M = 500


def _post_json(url, payload):
    body = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=body, headers={
        'Content-Type': 'application/json',
        'User-Agent': 'saipan-observational-network',
    })
    with urllib.request.urlopen(req, timeout=90) as r:
        return json.load(r)


def _get_json(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'saipan-observational-network'})
    with urllib.request.urlopen(req, timeout=90) as r:
        return json.load(r)


def sas_token():
    """Planetary Computer issues this anonymously; it lasts about an hour."""
    return _get_json(SAS)['token']


def asset_url(name, token, polarization='vv'):
    """STAC search for the scene on `name`'s date, returning a signed asset URL."""
    start, end = DATES[name]
    found = _post_json(STAC, {
        'collections': [COLLECTION],
        'intersects': {'type': 'Point', 'coordinates': [145.75, 15.19]},
        'datetime': f'{start}/{end}',
        'limit': 1,
    })
    feats = found.get('features') or []
    if not feats:
        sys.exit(f'No {COLLECTION} scene found for {name} ({start[:10]})')

    item = feats[0]
    href = item['assets'][polarization]['href']
    print(f'  {name:4s} {item["properties"]["datetime"][:16]}  {item["id"][:46]}')
    return f'{href}?{token}'


def read_to_wgs84(path):
    """`path` may be a local file or an https URL to a cloud-optimized GeoTIFF."""
    """Read a band and warp it onto a fixed WGS84 grid over Saipan."""
    west, south, east, north = BBOX
    width = int(round((east - west) / OUT_RES_DEG))
    height = int(round((north - south) / OUT_RES_DEG))
    dst_transform = rasterio.transform.from_bounds(west, south, east, north, width, height)

    dst = np.full((height, width), np.nan, dtype='float32')
    src_path = f'/vsicurl/{path}' if str(path).startswith('http') else path
    with rasterio.open(src_path) as src:
        reproject(
            source=rasterio.band(src, 1),
            destination=dst,
            src_transform=src.transform,
            src_crs=src.crs,
            dst_transform=dst_transform,
            dst_crs='EPSG:4326',
            dst_nodata=np.nan,
            resampling=Resampling.bilinear,
        )
    return dst, dst_transform, (width, height)


def to_db(gamma0):
    """Linear gamma0 power to decibels, with non-positive values masked out."""
    with np.errstate(divide='ignore', invalid='ignore'):
        db = 10.0 * np.log10(np.where(gamma0 > 0, gamma0, np.nan))
    return db


def village_stats(island, change_db, post_db, pre_db, transform, shape):
    width, height = shape
    west, south, east, north = BBOX
    out = []

    for v in island['villages']:
        lat, lon = v['lat'], v['lon']
        # Degrees covering VILLAGE_RADIUS_M at this latitude.
        dlat = VILLAGE_RADIUS_M / 111_320.0
        dlon = VILLAGE_RADIUS_M / (111_320.0 * max(0.1, math.cos(math.radians(lat))))

        c0 = int((lon - dlon - west) / OUT_RES_DEG)
        c1 = int((lon + dlon - west) / OUT_RES_DEG)
        r0 = int((north - (lat + dlat)) / OUT_RES_DEG)
        r1 = int((north - (lat - dlat)) / OUT_RES_DEG)
        c0, c1 = max(0, c0), min(width, c1)
        r0, r1 = max(0, r0), min(height, r1)

        if c1 <= c0 or r1 <= r0:
            out.append({'id': v['id'], 'covered': False})
            continue

        win_change = change_db[r0:r1, c0:c1]
        win_post = post_db[r0:r1, c0:c1]
        win_pre = pre_db[r0:r1, c0:c1]
        valid = np.isfinite(win_change)
        n = int(valid.sum())

        if n < 20:
            out.append({'id': v['id'], 'covered': False, 'pixels': n})
            continue

        changed = np.abs(win_change[valid]) >= CHANGE_DB
        new_water = (
            np.isfinite(win_post) & np.isfinite(win_pre)
            & (win_post < WATER_DB) & (win_pre >= WATER_DB)
        )

        out.append({
            'id': v['id'],
            'name': v['name'],
            'covered': True,
            'pixels': n,
            'mean_change_db': round(float(np.nanmean(win_change[valid])), 2),
            'mean_abs_change_db': round(float(np.nanmean(np.abs(win_change[valid]))), 2),
            'changed_fraction': round(float(changed.mean()), 4),
            'new_water_fraction': round(float(new_water.sum() / max(1, n)), 4),
        })

    return out


def write_overlay(change_db, shape):
    """A transparent PNG of change magnitude, for the map overlay."""
    from PIL import Image

    width, height = shape
    mag = np.abs(change_db)
    alpha = np.clip((mag - CHANGE_DB) / 9.0, 0, 1)
    alpha[~np.isfinite(mag)] = 0

    # Amber through red, matching the app's warn/crit tokens.
    t = np.clip((mag - CHANGE_DB) / 9.0, 0, 1)
    t[~np.isfinite(t)] = 0
    r = (212 + (180 - 212) * t)
    g = (106 + (33 - 106) * t)
    b = (31 + (63 - 31) * t)

    rgba = np.zeros((height, width, 4), dtype='uint8')
    rgba[..., 0] = r.astype('uint8')
    rgba[..., 1] = g.astype('uint8')
    rgba[..., 2] = b.astype('uint8')
    rgba[..., 3] = (alpha * 235).astype('uint8')

    img = Image.fromarray(rgba, 'RGBA')

    # Half resolution and quantised. The overlay is read at island zoom where
    # 60 m is plenty, and a committed asset should not be most of the repo.
    img = img.resize((width // 2, height // 2), Image.LANCZOS)
    img = img.quantize(colors=64, method=Image.FASTOCTREE).convert('RGBA')

    path = os.path.join(DATA, 'sar-yutu-change.png')
    img.save(path, optimize=True)
    return path, os.path.getsize(path)


def main():
    print('Sentinel-1 surface change over Saipan, Yutu 2018')
    print('OPERA L2 RTC-S1 burst T031-065424-IW2\n')

    print('  resolving scenes via Planetary Computer (anonymous token)')
    token = sas_token()
    paths = {k: asset_url(k, token) for k in DATES}

    print('\nwarping both scenes onto a common WGS84 grid over Saipan')
    pre, transform, shape = read_to_wgs84(paths['pre'])
    post, _, _ = read_to_wgs84(paths['post'])
    width, height = shape
    print(f'  grid {width} x {height} at ~30 m')

    pre_db, post_db = to_db(pre), to_db(post)
    raw_change = post_db - pre_db

    valid = np.isfinite(raw_change)
    coverage = float(valid.sum()) / (width * height)
    print(f'  valid pixels: {valid.sum():,} ({coverage:.0%} of the box)')
    if valid.sum() == 0:
        sys.exit('No overlap between the scenes and the Saipan box.')

    # Remove the island-wide common mode before calling anything "change".
    #
    # The raw median across Saipan is strongly positive, and that is not
    # damage: three days after a typhoon the whole island is saturated, and
    # wet soil has a higher dielectric constant, so backscatter rises
    # everywhere at once. A scene-wide radiometric offset between the two
    # products would look the same. Either way it is common mode, and leaving
    # it in marks almost half the island as "changed".
    #
    # Subtracting the median leaves the spatial anomaly - the places that
    # changed differently from everywhere else - which is the part that can
    # plausibly be attributed to the storm.
    # Land only, taken from the calm pre-event scene.
    land = np.isfinite(pre_db) & (pre_db > LAND_DB)
    land_valid = land & valid
    land_fraction = float(land_valid.sum()) / max(1, valid.sum())
    print(f'  land mask: {land_valid.sum():,} px ({land_fraction:.0%} of the box)')

    common_mode = float(np.nanmedian(raw_change[land_valid]))
    change_db = raw_change - common_mode
    change_db[~land] = np.nan          # the sea is not the subject
    valid = np.isfinite(change_db)
    print(f'  land common mode: {common_mode:+.2f} dB (removed)')

    changed = np.abs(change_db[valid]) >= CHANGE_DB
    new_water = (
        np.isfinite(post_db) & np.isfinite(pre_db)
        & (post_db < WATER_DB) & (pre_db >= WATER_DB)
    )

    print(f'  anomaly median     {np.nanmedian(change_db[valid]):+.2f} dB (0 by construction)')
    print(f'  |anomaly| >= {CHANGE_DB} dB  {changed.mean():.1%} of valid pixels')
    print(f'  new low-backscatter (water-like)  {new_water.sum() / max(1, valid.sum()):.2%}')

    with open(os.path.join(DATA, 'island.json'), encoding='utf-8') as f:
        island = json.load(f)
    stats = village_stats(island, change_db, post_db, pre_db, transform, shape)

    png_path, png_size = write_overlay(change_db, shape)
    print(f'\n  overlay {os.path.basename(png_path)}  {png_size / 1024:.0f} KB')

    payload = {
        'event': 'Super Typhoon Yutu',
        'landfall': '2018-10-24/2018-10-25',
        'measures': 'change in Sentinel-1 VV gamma0 backscatter between the two dates',
        'is_not': ('a flood map. For a category 5 landfall this signal is dominated by structural '
                   'damage and defoliation. The open-water test is reported separately as '
                   'new_water_fraction and is known to under-count: the post-event scene is 3 days '
                   'late, and radar water detection fails in dense built-up areas.'),
        'source': {
            'product': 'Sentinel-1 RTC (radiometrically terrain corrected gamma0)',
            'provider': 'Microsoft Planetary Computer, sentinel-1-rtc collection',
            'pre': '2018-10-16T20:07Z',
            'post': '2018-10-28T20:07Z',
            'polarization': 'VV',
            'resolution_m': 30,
        },
        'thresholds': {
            'change_db': CHANGE_DB,
            'water_db': WATER_DB,
            'land_db': LAND_DB,
            'village_radius_m': VILLAGE_RADIUS_M,
        },
        'overlay': {
            'image': 'data/sar-yutu-change.png',
            'bounds': [[BBOX[1], BBOX[0]], [BBOX[3], BBOX[2]]],
        },
        'island_wide': {
            'box_pixel_fraction': round(coverage, 3),
            'land_fraction_of_box': round(land_fraction, 3),
            'raw_median_change_db': round(common_mode, 2),
            'common_mode_removed_db': round(common_mode, 2),
            'changed_fraction': round(float(changed.mean()), 4),
            'new_water_fraction': round(float(new_water.sum() / max(1, valid.sum())), 4),
        },
        'method_note': (
            'Village figures are anomalies: the island-wide median change of '
            f'{common_mode:+.2f} dB is subtracted first. That common mode is most likely '
            'saturated ground three days after landfall raising backscatter everywhere, '
            'possibly with a radiometric offset between the two products on top. Either way '
            'it is not localised storm damage. The median is taken over land only (pre-event '
            f'gamma0 above {LAND_DB} dB): the analysis box is mostly ocean, sea state changed '
            'enormously between a calm pre-event scene and three days after a category 5, and '
            'mixing that into the baseline would push every village negative for no physical '
            'reason. Sea pixels are excluded from the output entirely.'
        ),
        'villages': stats,
        'generated': '2026-10-22',
    }

    out = os.path.join(DATA, 'sar-yutu.json')
    with open(out, 'w', encoding='utf-8') as f:
        json.dump(payload, f, indent=2)
    print(f'  wrote {os.path.basename(out)}')

    covered = [s for s in stats if s.get('covered')]
    print(f'\n  villages covered: {len(covered)} of {len(stats)}')
    for s in sorted(covered, key=lambda x: -x['changed_fraction'])[:8]:
        print(f"    {s['name'][:22]:24s} changed {s['changed_fraction']:6.1%}"
              f"   water-like {s['new_water_fraction']:6.2%}"
              f"   mean {s['mean_change_db']:+.2f} dB")


if __name__ == '__main__':
    main()
