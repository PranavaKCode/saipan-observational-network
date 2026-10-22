#!/usr/bin/env python3
"""Cut the captured frames into a short walkthrough.

Simple functional editing, deliberately: a title card, each captured screen
held with a slow push, a caption naming what is on screen, crossfades between,
and an end card. No motion-graphics flourish - the app is the subject and
anything else competes with it.

Typography and captions are composited with PIL, because that gives exact
control over type; ffmpeg does the motion, the dissolves and the encode.

    python tools/build_demo_video.py [capDir] [outFile]
"""

import json
import os
import subprocess
import sys

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CAP = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, '..', '_cap'))
OUT = os.path.abspath(sys.argv[2] if len(sys.argv) > 2 else os.path.join(ROOT, '..', 'saipan-observational-network-demo.mp4'))
WORK = os.path.join(CAP, 'comp')

W, H = 1920, 1080
FPS = 30
HOLD = 3.6          # seconds each screen is on frame
FADE = 0.55         # crossfade length
TITLE_HOLD = 3.4
END_HOLD = 4.2

INK = (238, 243, 248)
MUTED = (162, 178, 196)
ACCENT = (77, 155, 255)
CANVAS = (11, 15, 20)

FONTS = 'C:/Windows/Fonts'


def font(name, size):
    for candidate in (name, 'segoeui.ttf', 'arial.ttf'):
        path = os.path.join(FONTS, candidate)
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    return ImageFont.load_default()


F_TITLE = font('seguisb.ttf', 76)
F_SUB = font('segoeui.ttf', 31)
F_CAP = font('seguisb.ttf', 40)
F_CAPSUB = font('segoeui.ttf', 26)
F_SMALL = font('segoeui.ttf', 22)
F_MONO = font('consola.ttf', 25)

# id -> (heading, supporting line)
CAPTIONS = {
    '01-pulse': ('Island pulse',
                 'One weighted index over live weather, reef heat stress, utilities and alerts'),
    '02-reef': ('Coral heat stress, computed live',
                '6.4 \u00b0C-weeks accumulated \u2014 NOAA Alert Level 1, from Open-Meteo sea surface temperature'),
    '03-map': ('Satellite and field map',
               'NASA daily imagery over modelled village risk and citizen reports'),
    '04-map-sar': ('Radar sees what cloud hides',
                   'Sentinel-1 change, 16 to 28 Oct 2018, bracketing Super Typhoon Yutu'),
    '05-map-yutu': ('400-day imagery scrubber',
                    'Jump to any date \u2014 and watch optical imagery go blind during the storm'),
    '06-report': ('Field reporting',
                  'Eleven categories, written to the device before any network attempt'),
    '07-report-list': ('Corroboration, not volume',
                       'Two independent observers within 1.5 km and 6 h before a claim is upgraded'),
    '08-composer': ('Built for one hand in the rain',
                    'Category-specific questions, on-device photo downscaling, GPS or a map pin'),
    '09-model': ('A model trained in the browser',
                 'Logistic regression over 4,300 days of ERA5 reanalysis, retrained on device'),
    '10-model-dials': ('Dial a storm',
                       'Move a slider and all 31 villages re-score on every animation frame'),
    '11-villages': ('Hazard \u00d7 vulnerability, stated openly',
                    'Elevation measured from SRTM for 26 of 31 villages, the rest labelled estimates'),
    '12-grid': ('Grid and water status',
                'Resident reports rolled up to CUC feeders, with confidence shown'),
    '13-grid-reliability': ('The accountability half',
                            'Outage counts, median restore time and observed uptime per village'),
}

ORDER = ['01-pulse', '02-reef', '03-map', '04-map-sar', '05-map-yutu', '06-report',
         '07-report-list', '08-composer', '09-model', '10-model-dials', '11-villages',
         '12-grid', '13-grid-reliability']


def run(args):
    r = subprocess.run(args, capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit(f'ffmpeg failed:\n{" ".join(args[:6])}...\n{r.stderr[-1800:]}')


INSET = 0.955   # screenshot is inset so the push never crops the chrome


def stage(src):
    """Place the screenshot on the canvas, slightly inset.

    The push below zooms up to ~1.045. Applied to a full-bleed screenshot that
    clips the sidebar icons and the top bar, which looks careless. Insetting
    the capture by the same amount means the zoom travels into the margin
    instead of into the interface.
    """
    shot = Image.open(src).convert('RGB')
    w, h = int(W * INSET), int(H * INSET)
    shot = shot.resize((w, h), Image.LANCZOS)

    canvas = Image.new('RGB', (W, H), (7, 10, 14))
    canvas.paste(shot, ((W - w) // 2, (H - h) // 2))
    return canvas


def scrim(img, height=300):
    """Darken the bottom so caption text always has contrast under it."""
    base = img.convert('RGBA')
    grad = Image.new('RGBA', (1, height))
    for y in range(height):
        a = int(252 * (y / height) ** 1.15)
        grad.putpixel((0, y), (5, 8, 12, a))
    base.alpha_composite(grad.resize((W, height)), (0, H - height))
    return base


def caption_frame(src, heading, sub, index, total):
    img = scrim(stage(src))
    d = ImageDraw.Draw(img)

    x, y = 96, H - 176
    d.line([(x, y + 6), (x, y + 86)], fill=ACCENT, width=4)
    d.text((x + 26, y), heading, font=F_CAP, fill=INK)
    d.text((x + 26, y + 54), sub, font=F_CAPSUB, fill=MUTED)

    step = f'{index:02d} / {total:02d}'
    tw = d.textlength(step, font=F_MONO)
    d.text((W - 96 - tw, y + 16), step, font=F_MONO, fill=(110, 128, 149))

    out = os.path.join(WORK, f'cap-{index:02d}.png')
    img.convert('RGB').save(out, quality=96)
    return out


def card(path, title, sub, lines=()):
    img = Image.new('RGB', (W, H), CANVAS)
    d = ImageDraw.Draw(img)

    # A restrained accent wash, nothing more.
    for i in range(420):
        a = int(26 * (1 - i / 420))
        d.line([(0, i), (W, i)], fill=(11 + a // 4, 15 + a // 3, 20 + a))

    d.line([(96, 404), (96 + 92, 404)], fill=ACCENT, width=5)
    d.text((96, 436), title, font=F_TITLE, fill=INK)
    d.text((96, 546), sub, font=F_SUB, fill=MUTED)

    y = 630
    for ln in lines:
        d.text((96, y), ln, font=F_SMALL, fill=(132, 150, 170))
        y += 36

    img.save(path, quality=96)
    return path


def clip(src, dst, seconds, push=True):
    """One still becomes a clip with a slow push, so the frame is never dead."""
    frames = int(seconds * FPS)
    if push:
        # zoompan on an upscaled source keeps the push from softening the image.
        vf = (f"scale={W*2}:{H*2}:flags=lanczos,"
              f"zoompan=z='min(1.0+0.00030*on,1.045)':d={frames}:"
              f"x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s={W}x{H}:fps={FPS},"
              f"format=yuv420p")
    else:
        vf = f"scale={W}:{H},loop=-1:1,fps={FPS},format=yuv420p"

    run(['ffmpeg', '-y', '-loop', '1', '-i', src, '-t', f'{seconds}',
         '-vf', vf, '-c:v', 'libx264', '-preset', 'medium', '-crf', '17',
         '-pix_fmt', 'yuv420p', '-r', str(FPS), dst])


def main():
    os.makedirs(WORK, exist_ok=True)
    manifest = {m['id'] for m in json.load(open(os.path.join(CAP, 'manifest.json')))}
    ids = [i for i in ORDER if i in manifest]
    if not ids:
        sys.exit('no captured frames found; run tools/capture_demo.mjs first')
    print(f'{len(ids)} screens')

    segments = []

    title = card(os.path.join(WORK, 'title.png'),
                 'Saipan Observational Network',
                 'Citizen science and utility accountability for Saipan, CNMI',
                 ['Offline-first \u00b7 no build step \u00b7 no backend',
                  'Live NOAA, NASA, Open-Meteo and Sentinel-1 data'])
    seg = os.path.join(WORK, 'seg-title.mp4')
    clip(title, seg, TITLE_HOLD)
    segments.append((seg, TITLE_HOLD))

    for n, fid in enumerate(ids, start=1):
        head, sub = CAPTIONS.get(fid, (fid, ''))
        framed = caption_frame(os.path.join(CAP, f'{fid}.png'), head, sub, n, len(ids))
        seg = os.path.join(WORK, f'seg-{n:02d}.mp4')
        clip(framed, seg, HOLD)
        segments.append((seg, HOLD))
        print(f'  {n:02d} {head}')

    end = card(os.path.join(WORK, 'end.png'),
               'son-five-xi.vercel.app',
               'github.com/PranavaKCode/saipan-observational-network',
               ['Conditions, satellite imagery, the radar layer and the trained model are real.',
                'Citizen reports shown are a labelled demo scenario, tagged in the app.'])
    seg = os.path.join(WORK, 'seg-end.mp4')
    clip(end, seg, END_HOLD, push=False)
    segments.append((seg, END_HOLD))

    # Chain the segments with crossfades.
    inputs = []
    for path, _ in segments:
        inputs += ['-i', path]

    filt = []
    prev = '0:v'
    offset = 0.0
    for i in range(1, len(segments)):
        offset += segments[i - 1][1] - FADE
        label = f'x{i}'
        filt.append(f'[{prev}][{i}:v]xfade=transition=fade:duration={FADE}:offset={offset:.3f}[{label}]')
        prev = label

    print('\nencoding...')
    run(['ffmpeg', '-y', *inputs,
         '-filter_complex', ';'.join(filt),
         '-map', f'[{prev}]',
         '-c:v', 'libx264', '-preset', 'slow', '-crf', '19',
         '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-r', str(FPS), OUT])

    total = sum(s for _, s in segments) - FADE * (len(segments) - 1)
    size = os.path.getsize(OUT) / 1e6
    print(f'\n{OUT}\n{total:.1f}s  {size:.1f} MB  {W}x{H}  {FPS}fps')


if __name__ == '__main__':
    main()
