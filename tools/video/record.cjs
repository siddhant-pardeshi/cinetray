'use strict';

// Records the live walkthrough: real CDP screencast of the extension being
// used — drag-and-drop, dock, mid-drag playlist creation, Escape/undo,
// hover chip, player long-press, dashboard navigation, popup.
// Output: tools/video/caps/<section>/f%05d.jpg + stamps.json per section.

const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.CDP_PORT || 9320);
const ROOT = path.resolve(__dirname, '..', '..');
const CAPS = path.join(__dirname, 'caps');
const sleep = ms => new Promise(r => setTimeout(r, ms));

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    ws.addEventListener('message', ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject, method } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message + ' (' + method + ')'));
        else resolve(msg.result);
      }
    });
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('ws connect failed')), { once: true });
    });
    return new Cdp(ws);
  }
  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('timeout: ' + method)); }
      }, 30000);
    });
  }
}

const { execFileSync } = require('child_process');
const narrDur = name => parseFloat(execFileSync('ffprobe', [
  '-v', 'error', '-show_entries', 'format=duration',
  '-of', 'default=nw=1:nk=1', path.join(__dirname, 'narr', name + '.wav')
]).toString().trim());

const v = (id, title, channel, duration, addedAt) => ({
  videoId: id, title, channel, duration,
  thumb: 'https://i.ytimg.com/vi/' + id + '/mqdefault.jpg',
  url: 'https://www.youtube.com/watch?v=' + id, addedAt
});

async function main() {
  fs.mkdirSync(CAPS, { recursive: true });
  const ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  const browser = await Cdp.connect(ver.webSocketDebuggerUrl);

  const extPath = path.resolve(__dirname, '..', '..');
  const loaded = await browser.send('Extensions.loadUnpacked', { path: extPath });
  const extId = loaded.id;
  console.log('extension:', extId);

  let sw = null;
  for (let i = 0; i < 10 && !sw; i++) {
    const { targetInfos } = await browser.send('Target.getTargets');
    sw = targetInfos.find(t => t.type === 'service_worker' && t.url.startsWith('chrome-extension://' + extId + '/'));
    if (!sw) await sleep(500);
  }
  if (!sw) throw new Error('service worker not found');
  const { sessionId: SW } = await browser.send('Target.attachToTarget', { targetId: sw.targetId, flatten: true });

  const storage = expr => browser.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, SW);
  await storage(`self.v = ${v.toString()}`);
  await storage(`chrome.storage.local.set({ ct_playlists: [
    { id: 'WL', name: 'Watch Later', builtin: true, color: '#ff4d6d', createdAt: 1700000000000, lastUpdated: 1730000000000, videos: [
      v('jNQXAC9IVRw', 'Me at the zoo', 'jawed', '0:19', 1729000000000) ] },
    { id: 'p1', name: 'Deep dives', color: '#3aa0ff', createdAt: 1700000100000, lastUpdated: 1730000100000, videos: [
      v('aqz-KE-bpKQ', 'Big Buck Bunny 60fps 4K', 'Blender', '10:34', 1729000100000),
      v('jfKfPfyJRdk', 'lofi hip hop radio, beats to relax and study to', 'Lofi Girl', '', 1729000200000) ] },
    { id: 'p2', name: 'Party', color: '#ffb02e', createdAt: 1700000200000, lastUpdated: 1730000200000, videos: [
      v('9bZkp7q19f0', 'PSY - GANGNAM STYLE M/V', 'officialpsy', '4:13', 1729000300000) ] }
  ], ct_settings: { hoverChip: true, playerDrag: true, dockSide: 'right', animations: 'full', toastUndo: true } })`);
  console.log('seeded');

  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId: S } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  await browser.send('Page.enable', {}, S);
  await browser.send('Runtime.enable', {}, S);
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false }, S);

  // ---------------------------------------------------------- frame loop
  // Headless screencast only pushes compositor frames (3 total per section),
  // so capture deterministically by polling captureScreenshot instead.
  let frames = [];
  let t0 = 0;
  let recording = false;

  async function captureLoop() {
    while (recording) {
      try {
        const r = await browser.send('Page.captureScreenshot', { format: 'jpeg', quality: 78 }, S);
        frames.push({ data: r.data, ts: (performance.now() - t0) / 1000 });
      } catch (err) { /* navigation mid-capture; keep going */ }
      await sleep(30);
    }
  }

  async function record(name, fn, narr = null) {
    const dir = path.join(CAPS, name);
    fs.mkdirSync(dir, { recursive: true });
    frames = [];
    recording = true;
    t0 = performance.now();
    const loop = captureLoop();
    await sleep(250);
    await fn();
    const minDur = narr ? narrDur(narr) + 1.2 : 0;
    const need = minDur - (performance.now() - t0) / 1000;
    if (need > 0) await sleep(need * 1000);
    await sleep(350);
    recording = false;
    await loop;
    frames.forEach((f, i) => fs.writeFileSync(path.join(dir, 'f' + String(i).padStart(5, '0') + '.jpg'), Buffer.from(f.data, 'base64')));
    fs.writeFileSync(path.join(dir, 'stamps.json'), JSON.stringify({ dur: (performance.now() - t0) / 1000, count: frames.length, ts: frames.map(f => +f.ts.toFixed(3)) }));
    console.log(`section ${name}: ${frames.length} frames, ${(performance.now() - t0) / 1000 | 0}s`);
    frames = [];
  }

  const ev = async expr => {
    const r = await browser.send('Runtime.evaluate', { expression: expr, returnByValue: true }, S);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception && r.exceptionDetails.exception.description || 'eval failed');
    return r.result.value;
  };
  const mouse = (type, x, y, o = {}) => browser.send('Input.dispatchMouseEvent', {
    type, x: Math.round(x), y: Math.round(y),
    button: o.button || 'none', buttons: o.buttons || 0,
    clickCount: o.clickCount || 0, pointerType: 'mouse'
  }, S);
  const glide = async (from, to, ms = 900, steps = Math.max(8, Math.round(ms / 26))) => {
    for (let i = 1; i <= steps; i++) {
      await mouse('mouseMoved', from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps, { buttons: 1 });
      await sleep(ms / steps);
    }
  };
  const press = (x, y) => mouse('mousePressed', x, y, { button: 'left', buttons: 1, clickCount: 1 });
  const release = (x, y) => mouse('mouseReleased', x, y, { button: 'left', clickCount: 1 });
  const hover = (x, y) => mouse('mouseMoved', x, y);
  const key = async (k, code, vk) => {
    await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }, S);
    await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }, S);
  };
  const type = async text => { await browser.send('Input.insertText', { text }, S); await sleep(150); };
  const wheel = async (x, y, dy, times = 1) => {
    for (let i = 0; i < times; i++) {
      await browser.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel', x: Math.round(x), y: Math.round(y),
        deltaX: 0, deltaY: dy, pointerType: 'mouse'
      }, S);
      await sleep(220);
    }
  };
  const nav = async url => { await browser.send('Page.navigate', { url }, S); await sleep(2500); };
  const well = sel => ev(`(() => { const w = document.querySelector('${sel}'); if (!w) return null; const r = w.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()`);
  const cardAt = async () => {
    for (let attempt = 0; attempt < 4; attempt++) {
      const found = await ev(`(() => {
        const cards = [...document.querySelectorAll('ytd-video-renderer, yt-lockup-view-model, ytd-rich-grid-media')]
          .filter(c => c.querySelector('a[href*="/watch?v="]'))
          .map(c => { const r = c.getBoundingClientRect(); return { c, r, inView: r.top > 110 && r.bottom < 700 }; })
          .filter(vv => vv.inView);
        const first = cards.find(vv => vv.c.querySelector('a[href^="/@"]')) || cards[0];
        const other = cards.find(vv => vv !== first) || first;
        const g = vv => { const a = vv.c.querySelector('a[href*="/watch?v="]'); const r = a.getBoundingClientRect();
          return { x: r.left + r.width/2, y: Math.max(140, r.top + r.height/2) }; };
        return first ? { a: g(first), b: g(other) } : null;
      })()`);
      if (found) return found;
      await sleep(1200);
    }
    throw new Error('no visible cards after retries');
  };
  const DOCK = { x: 1144, y: 360 };

  // ---------------------------------------------- 01: install page (live)
  await record('01-install', async () => {
    await browser.send('Page.navigate', { url: 'chrome://extensions/' }, S);
    await sleep(2200);
    // try to flip the Developer mode toggle for real (WebUI, shadow DOM)
    const toggle = await ev(`(() => {
      try {
        const t = document.querySelector('extensions-manager').shadowRoot
          .querySelector('extensions-toolbar').shadowRoot.querySelector('cr-toggle#devMode');
        const r = t.getBoundingClientRect();
        return { x: r.left + r.width/2, y: r.top + r.height/2, on: t.checked };
      } catch (e) { return null; }
    })()`);
    if (toggle && !toggle.on) {
      await hover(toggle.x, toggle.y);
      await sleep(350);
      await press(toggle.x, toggle.y);
      await release(toggle.x, toggle.y);
      await sleep(1100);
    }
    await sleep(700);
    await wheel(640, 400, 160, 4);
    await sleep(500);
    await wheel(640, 400, -160, 3);
    await sleep(800);
  }, '03-install');

  // ---------------------------------------------- 02: results + hover chip
  await browser.send('Page.navigate', { url: 'https://www.youtube.com/results?search_query=lofi+hip+hop' }, S);
  await sleep(6500);
  const pick = await cardAt();
  if (!pick || !pick.a) throw new Error('no cards');

  await record('02-chip', async () => {
    await glide({ x: 640, y: 400 }, pick.a, 700, 16);
    await sleep(260);
    await glide(pick.a, { x: pick.a.x + 60, y: pick.a.y + 20 }, 500, 12);
    await sleep(700);
    const chip = await ev(`(() => { const c = document.querySelector('.ct-chip--show'); if (!c) return null; const r = c.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()`);
    if (chip) {
      await hover(chip.x, chip.y);
      await sleep(250);
      await press(chip.x, chip.y);
      await release(chip.x, chip.y);
      await sleep(1400);
    }
  }, '08-chip');

  // ---------------------------------------------- 03: the drag (Watch Later)
  await record('03-drag', async () => {
    await press(pick.b.x, pick.b.y);
    await sleep(220);
    await glide(pick.b, DOCK, 1500, 34);
    await sleep(500);
    const wl = await well('.ct-well[data-playlist="WL"]');
    if (wl) await glide(DOCK, wl, 900, 20);
    await sleep(450);
    if (wl) await release(wl.x, wl.y);
    await sleep(1500);
  }, '04-first-drag');

  // ---------------------------------------------- 04: tour the wells
  await record('04-dock', async () => {
    const tour = await cardAt();
    await press(tour.a.x, tour.a.y);
    await sleep(220);
    await glide(tour.a, DOCK, 1300, 26);
    await sleep(500);
    for (const sel of ['.ct-well[data-playlist="WL"]', '.ct-well[data-playlist="p1"]', '.ct-well[data-playlist="p2"]', '.ct-well--new']) {
      const w = await well(sel);
      if (w) await glide(DOCK, w, 900, 18);
      await sleep(1300);
    }
    if (await ev(`!!document.querySelector('.ct-ghost')`)) await key('Escape', 'Escape', 27);
    await sleep(1100);
  }, '05-dock');

  // ---------------------------------------------- 05: mid-drag playlist create
  await record('05-middrag', async () => {
    const again = await cardAt();
    await press(again.a.x, again.a.y);
    await sleep(220);
    await glide(again.a, DOCK, 1400, 30);
    await sleep(450);
    const nw = await well('.ct-well--new');
    if (nw) await glide(DOCK, nw, 800, 18);
    await sleep(500);
    await type('Road trips');
    await sleep(250);
    await key('Enter', 'Enter', 13);
    await sleep(1600);
    if (nw) await release(nw.x, nw.y);
    await sleep(900);
  }, '06-middrag');

  // ---------------------------------------------- 05: escape + undo
  await record('06-escape', async () => {
    const again = await cardAt();
    await press(again.a.x, again.a.y);
    await sleep(220);
    await glide(again.a, DOCK, 1200, 26);
    await sleep(450);
    await key('Escape', 'Escape', 27);
    await sleep(1300);
    // undo the last save via the toast button
    const undo = await ev(`(() => { const b = document.querySelector('.ct-toast .ct-toast__undo'); if (!b || b.hidden) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()`);
    if (undo) {
      const ag = await cardAt();
      await press(ag.a.x, ag.a.y);
      await sleep(200);
      await glide(ag.a, DOCK, 1000, 22);
      const w2 = await well('.ct-well[data-playlist="WL"]');
      if (w2) await glide(DOCK, w2, 700, 14);
      await sleep(300);
      if (w2) await release(w2.x, w2.y);
      await sleep(700);
      const undo2 = await ev(`(() => { const b = document.querySelector('.ct-toast .ct-toast__undo'); if (!b || b.hidden) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()`);
      if (undo2) {
        await hover(undo2.x, undo2.y);
        await sleep(200);
        await press(undo2.x, undo2.y);
        await release(undo2.x, undo2.y);
        await sleep(1200);
      }
    }
  }, '07-cancel');

  // ---------------------------------------------- 07: player long-press
  await nav('https://www.youtube.com/watch?v=jNQXAC9IVRw');
  await sleep(2500);
  await record('07-player', async () => {
    const player = await ev(`(() => { const p = document.querySelector('#movie_player'); const r = p.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()`);
    await glide({ x: player.x - 220, y: player.y }, player, 600, 14);
    await press(player.x, player.y);
    await sleep(850);
    if (await ev(`!!document.querySelector('.ct-ghost')`)) {
      const wl = await well('.ct-well[data-playlist="WL"]');
      if (wl) await glide(player, wl, 900, 20);
      await sleep(400);
      if (wl) await release(wl.x, wl.y);
    } else {
      await release(player.x, player.y);
    }
    await sleep(1300);
  }, '10-player');

  // ---------------------------------------------- 08: dashboard tour
  await nav('chrome-extension://' + extId + '/dashboard/dashboard.html');
  await sleep(1800);
  await record('08-dashboard', async () => {
    // open Watch Later
    const wlItem = await ev(`(() => { const it = [...document.querySelectorAll('.db-nav-item')].find(n => n.textContent.includes('Watch Later')); const r = it.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()`);
    await hover(wlItem.x, wlItem.y);
    await sleep(200);
    await press(wlItem.x, wlItem.y);
    await release(wlItem.x, wlItem.y);
    await sleep(900);
    // hover a row (lift effect)
    const row = await ev(`(() => { const r = document.querySelector('.db-row'); if (!r) return null; const b = r.getBoundingClientRect(); return { x: b.left + b.width/2, y: b.top + b.height/2 }; })()`);
    if (row) await glide({ x: 640, y: 400 }, row, 600, 12);
    await sleep(600);
    await wheel(640, 400, 120, 2);
    await sleep(700);
    // settings: flip dock side to Left for real
    await nav('chrome-extension://' + extId + '/dashboard/dashboard.html?view=settings');
    await sleep(1400);
    const segBtn = await ev(`(() => { const b = [...document.querySelectorAll('#db-set-side button')].find(x => x.dataset.v === 'left'); const r = b.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()`);
    await glide({ x: 640, y: 300 }, segBtn, 700, 14);
    await sleep(200);
    await press(segBtn.x, segBtn.y);
    await release(segBtn.x, segBtn.y);
    await sleep(900);
    const backBtn = await ev(`(() => { const b = [...document.querySelectorAll('#db-set-side button')].find(x => x.dataset.v === 'right'); const r = b.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()`);
    await press(backBtn.x, backBtn.y);
    await release(backBtn.x, backBtn.y);
    await sleep(700);
  }, '11-dashboard');

  // ---------------------------------------------- 09: popup live
  await nav('chrome-extension://' + extId + '/popup/popup.html');
  await sleep(1500);
  await record('09-popup', async () => {
    const input = await ev(`(() => { const i = document.getElementById('pp-new-name'); const r = i.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()`);
    await hover(input.x, input.y);
    await press(input.x, input.y);
    await release(input.x, input.y);
    await sleep(200);
    await type('Weekend watch');
    const add = await ev(`(() => { const b = document.getElementById('pp-new-add'); const r = b.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()`);
    await press(add.x, add.y);
    await release(add.x, add.y);
    await sleep(1100);
    const chipT = await ev(`(() => { const c = document.getElementById('pp-chip'); const r = c.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()`);
    await hover(chipT.x, chipT.y);
    await sleep(250);
    await press(chipT.x, chipT.y);
    await release(chipT.x, chipT.y);
    await sleep(700);
    await press(chipT.x, chipT.y);
    await release(chipT.x, chipT.y);
    await sleep(800);
  }, '12-popup');

  console.log('ALL SECTIONS RECORDED');
  await browser.send('Browser.close');
}

main().catch(err => {
  console.error('RECORD FAILED:', err.message);
  process.exit(1);
});
