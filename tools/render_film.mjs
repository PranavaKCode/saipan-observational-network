/**
 * render_film.mjs - render the composition frame by frame, then encode.
 *
 * The composition exposes `seek(frame)` and never reads a clock, so this can
 * take as long as it needs per frame and the motion still comes out at an
 * exact 30fps. That is the whole reason the earlier screencast and
 * virtual-time attempts failed and this one does not: we are not racing the
 * browser's paint loop or trying to pause it, we are telling it precisely
 * what to draw.
 *
 *   node tools/render_film.mjs [outFile]
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FILM = join(HERE, 'film', 'film.html');
const WORK = resolve(HERE, '..', '..', '_film');
const OUT = resolve(process.argv[2] || join(HERE, '..', '..', 'saipan-observational-network.mp4'));

const PORT = 9355;
const W = 1920, H = 1080, FPS = 30;

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe`,
].find((p) => existsSync(p));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      const p = this.pending.get(m.id);
      if (p) {
        this.pending.delete(m.id);
        m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej });
      setTimeout(() => { if (this.pending.delete(id)) rej(new Error(method + ' timeout')); }, 45000);
    });
  }
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
  }
}

async function main() {
  if (!CHROME) throw new Error('Chrome not found');
  if (!existsSync(FILM)) throw new Error('missing ' + FILM);
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });

  const proc = spawn(CHROME, [
    '--headless=new', '--hide-scrollbars', '--disable-gpu',
    '--force-device-scale-factor=1', '--force-color-profile=srgb',
    '--allow-file-access-from-files', '--disable-web-security',
    `--window-size=${W},${H}`, `--remote-debugging-port=${PORT}`,
    '--user-data-dir=' + join(WORK, '.profile'),
    '--no-first-run', '--no-default-browser-check',
    'about:blank',
  ], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 40 && !target; i++) {
    await sleep(500);
    try {
      target = (await fetch(`http://127.0.0.1:${PORT}/json`).then((r) => r.json()))
        .find((t) => t.type === 'page');
    } catch {}
  }
  if (!target) { proc.kill(); throw new Error('no debugging endpoint'); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });

  const cdp = new CDP(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: W, height: H, deviceScaleFactor: 1, mobile: false,
  });

  await cdp.send('Page.navigate', { url: pathToFileURL(FILM).href });

  // Wait for the composition and every screenshot it references.
  for (let i = 0; i < 80; i++) {
    await sleep(300);
    const ready = await cdp.evaluate('!!window.__filmReady').catch(() => false);
    if (ready) break;
  }
  await cdp.evaluate(`
    (async () => {
      const imgs = [...document.images];
      await Promise.all(imgs.map(i => i.complete ? null : new Promise(r => {
        i.onload = r; i.onerror = r;
      })));
      return true;
    })()
  `);
  await sleep(900);

  const total = await cdp.evaluate('window.TOTAL_FRAMES');
  if (!total) throw new Error('composition did not report TOTAL_FRAMES');
  console.log(`rendering ${total} frames (${(total / FPS).toFixed(1)}s)`);

  const t0 = Date.now();
  for (let f = 0; f < total; f++) {
    await cdp.evaluate(`window.seek(${f})`);
    const { data } = await cdp.send('Page.captureScreenshot', {
      format: 'jpeg', quality: 94, captureBeyondViewport: false,
    });
    writeFileSync(join(WORK, `f${String(f).padStart(5, '0')}.jpg`), Buffer.from(data, 'base64'));

    if (f % 60 === 0 || f === total - 1) {
      const pct = ((f + 1) / total * 100).toFixed(0);
      const rate = (f + 1) / ((Date.now() - t0) / 1000);
      const eta = (total - f - 1) / Math.max(rate, 0.01);
      process.stdout.write(`\r  ${pct}%  ${rate.toFixed(1)} fps  eta ${eta.toFixed(0)}s   `);
    }
  }
  console.log('\nencoding...');

  ws.close();
  proc.kill();

  const enc = spawnSync('ffmpeg', [
    '-y', '-framerate', String(FPS),
    '-i', join(WORK, 'f%05d.jpg'),
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '18',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    '-r', String(FPS), OUT,
  ], { encoding: 'utf8' });
  if (enc.status !== 0) {
    console.error(enc.stderr.slice(-2000));
    throw new Error('ffmpeg failed');
  }

  const { statSync } = await import('node:fs');
  console.log(`\n${OUT}`);
  console.log(`${(total / FPS).toFixed(1)}s  ${(statSync(OUT).size / 1e6).toFixed(1)} MB  ${W}x${H}  ${FPS}fps`);
}

main().catch((e) => { console.error(e); process.exit(1); });
