/**
 * capture_demo.mjs - screenshot the running app, at full resolution.
 *
 * Chrome's `--screenshot` flag fires as soon as the document is ready, which
 * for this app is long before anything is on screen: the feeds are still in
 * flight and the flood model has not trained. The result is a picture of a
 * loading skeleton.
 *
 * So this drives headless Chrome over the DevTools Protocol instead, which
 * lets each frame wait for a condition that proves the view is actually
 * populated before the shutter opens. No Puppeteer: Node 24 ships a global
 * WebSocket, and CDP is a JSON protocol over one socket.
 *
 *   node tools/capture_demo.mjs [baseUrl] [outDir]
 */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const BASE = process.argv[2] || 'http://localhost:8781';
const OUT = resolve(process.argv[3] || '../_cap');
const PORT = 9222;
const W = 1920;
const H = 1080;

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe`,
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------------------------------------------------------- CDP --- */

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} timed out`));
      }, 60000);
    });
  }

  /** Evaluate in the page and return the value. */
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression: `(async () => { ${expression} })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
  }

  /** Poll until `expression` is truthy, or give up. */
  async waitFor(expression, { timeout = 45000, label = expression } = {}) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      try {
        if (await this.evaluate(`return !!(${expression});`)) return true;
      } catch { /* page mid-navigation */ }
      await sleep(400);
    }
    throw new Error(`timed out waiting for ${label}`);
  }

  async shot(path) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(path, Buffer.from(data, 'base64'));
  }
}

/* ------------------------------------------------------------ frames --- */

/**
 * Each frame: where to go, what proves it is ready, and an optional action to
 * perform before the shutter. `settle` covers animation after the action.
 */
const FRAMES = [
  {
    id: '01-pulse',
    url: '/?demo=1',
    ready: "document.querySelector('.ici-score') && document.querySelector('.metric-value')",
    settle: 2500,
  },
  {
    id: '02-reef',
    ready: "document.querySelector('.dhw-strip')",
    action: "document.querySelector('.dhw-strip').scrollIntoView({block:'center'});",
    settle: 1200,
  },
  {
    id: '03-map',
    action: "document.querySelector('.tabbar [data-view=\"map\"]').click();",
    ready: "document.querySelectorAll('.leaflet-tile-loaded').length > 4",
    settle: 3500,
  },
  {
    id: '04-map-sar',
    /* Clear the stage: the radar beat is about the radar, so the model circles
       and report pins come off and the plain basemap goes under it. */
    action: `for (const k of ['risk','reports']) { const c=document.querySelector('[data-overlay="'+k+'"]'); if (c && c.classList.contains('active')) c.click(); }
             const s=document.querySelector('[data-overlay="sar"]'); if (s && !s.classList.contains('active')) s.click();
             const img=document.querySelector('[data-base="esri"]'); if (img) img.click();
             const nasa=document.querySelector('[data-gibs-toggle]'); if (nasa && nasa.classList.contains('active')) nasa.click();`,
    ready: "document.querySelector('img.leaflet-image-layer')",
    settle: 4000,
  },
  {
    id: '05-map-yutu',
    action: `const s=document.querySelector('[data-overlay="sar"]'); if(s&&s.classList.contains('active')) s.click();
             for (const k of ['risk','reports']) { const c=document.querySelector('[data-overlay="'+k+'"]'); if (c && !c.classList.contains('active')) c.click(); }
             const img=document.querySelector('[data-base="esri"]'); if (img) img.click();
             const j=[...document.querySelectorAll('[data-jump]')].find(b=>/Yutu/i.test(b.textContent)); if(j) j.click();`,
    ready: "document.getElementById('scrub-date')",
    settle: 5000,
  },
  {
    id: '06-report',
    action: "document.querySelector('.tabbar [data-view=\"field\"]').click();",
    ready: "document.querySelectorAll('.cat-tile').length > 6",
    settle: 1500,
  },
  {
    id: '07-report-list',
    action: "const l=document.querySelector('#view-field .list-item[data-report]'); if(l) l.scrollIntoView({block:'center'});",
    ready: "document.querySelector('#view-field .list-item[data-report]')",
    settle: 1200,
  },
  {
    id: '08-composer',
    action: "window.scrollTo(0,0); document.querySelector('[data-newcat=\"flood\"]').click();",
    ready: "document.querySelector('.sheet.open')",
    settle: 1800,
  },
  {
    id: '09-model',
    action: `const c=document.querySelector('.sheet [data-close]'); if(c) c.click();
             await new Promise(r=>setTimeout(r,600));
             document.querySelector('.tabbar [data-view="model"]').click();`,
    ready: "document.querySelector('.loss-chart')",
    settle: 2000,
  },
  {
    id: '10-model-dials',
    action: `const p=document.querySelector('[data-scenario="custom"]'); if(p) p.click();
             await new Promise(r=>setTimeout(r,500));
             const set=(k,v)=>{const el=document.getElementById('dial-'+k); if(el){el.value=v; el.dispatchEvent(new Event('input',{bubbles:true}));}};
             set('rain1',150); await new Promise(r=>setTimeout(r,250));
             set('windMax',110); await new Promise(r=>setTimeout(r,250));
             set('presAnom',30);
             await new Promise(r=>setTimeout(r,600));
             document.querySelector('#dials').scrollIntoView({block:'center'});`,
    ready: "document.getElementById('sc-exposed')",
    settle: 1800,
  },
  {
    id: '11-villages',
    action: "const t=document.querySelector('#risk-rows'); if(t) t.scrollIntoView({block:'center'});",
    ready: "document.querySelectorAll('#risk-rows tr').length > 10",
    settle: 1200,
  },
  {
    id: '12-grid',
    action: "window.scrollTo(0,0); document.querySelector('.tabbar [data-view=\"grid\"]').click();",
    ready: "document.querySelector('#view-grid .metric-value')",
    settle: 1800,
  },
  {
    id: '13-grid-reliability',
    action: `const tables=[...document.querySelectorAll('#view-grid .vtable')];
             const last=tables[tables.length-1]; if(last) last.scrollIntoView({block:'center'});`,
    ready: "document.querySelectorAll('#view-grid .vtable').length > 0",
    settle: 1500,
  },
];

/* -------------------------------------------------------------- main --- */

async function main() {
  const chrome = CHROME_CANDIDATES.find((p) => existsSync(p));
  if (!chrome) throw new Error('Chrome not found');
  mkdirSync(OUT, { recursive: true });

  console.log(`capturing ${BASE} at ${W}x${H}`);
  const proc = spawn(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    '--force-color-profile=srgb',
    `--window-size=${W},${H}`,
    `--remote-debugging-port=${PORT}`,
    '--user-data-dir=' + resolve(OUT, '.chrome-profile'),
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ], { stdio: 'ignore' });

  // Wait for the debugging endpoint.
  let target = null;
  for (let i = 0; i < 40 && !target; i++) {
    await sleep(500);
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json`).then((r) => r.json());
      target = list.find((t) => t.type === 'page');
    } catch { /* not up yet */ }
  }
  if (!target) { proc.kill(); throw new Error('Chrome debugging endpoint never came up'); }

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

  const manifest = [];
  for (const f of FRAMES) {
    process.stdout.write(`  ${f.id} ... `);
    try {
      if (f.url) {
        await cdp.send('Page.navigate', { url: BASE + f.url });
        await sleep(1500);
      }
      if (f.action) { await cdp.evaluate(f.action); }
      if (f.ready) { await cdp.waitFor(f.ready, { label: f.id }); }
      await sleep(f.settle ?? 1200);
      /* Transient toasts are not part of the interface being shown. */
      await cdp.evaluate("const t=document.getElementById('toasts'); if(t) t.innerHTML=''; return 1;");
      await sleep(250);

      const path = resolve(OUT, `${f.id}.png`);
      await cdp.shot(path);
      manifest.push({ id: f.id, file: `${f.id}.png` });
      console.log('ok');
    } catch (err) {
      console.log('FAILED: ' + err.message);
    }
  }

  /* Pull the headline figures straight out of the running app, so anything
     the film prints beside a screenshot is the number that screenshot shows.
     Hardcoding these let the film claim an AUC the panel behind it
     contradicted. */
  const facts = await cdp.evaluate(`
    const txt = (sel) => { const e = document.querySelector(sel); return e ? e.textContent.trim() : null; };
    const num = (s) => { if (!s) return null; const m = s.replace(/,/g,'').match(/-?\d+(\.\d+)?/); return m ? Number(m[0]) : null; };
    document.querySelector('.tabbar [data-view="pulse"]').click();
    await new Promise(r => setTimeout(r, 900));
    const ici = num(txt('.ici-score'));
    const state = txt('.ici-state');
    const dhw = num([...document.querySelectorAll('.metric-value')].map(e=>e.textContent).find(t=>/C-weeks/.test(t)) || '');
    document.querySelector('.tabbar [data-view="grid"]').click();
    await new Promise(r => setTimeout(r, 900));
    const noPower = num(txt('#view-grid .metric-value'));
    document.querySelector('.tabbar [data-view="model"]').click();
    await new Promise(r => setTimeout(r, 1200));
    const metrics = [...document.querySelectorAll('#view-model .metric-value')].map(e=>e.textContent.trim());
    const auc = num(metrics[0]);
    return { ici, state, dhw, noPower, auc };
  `).catch(() => ({}));

  writeFileSync(resolve(OUT, 'facts.json'), JSON.stringify(facts, null, 2));
  console.log('  facts:', JSON.stringify(facts));

  writeFileSync(resolve(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`\n${manifest.length}/${FRAMES.length} frames in ${OUT}`);

  ws.close();
  proc.kill();
}

main().catch((e) => { console.error(e); process.exit(1); });
