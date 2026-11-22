'use strict';

// End-to-end smoke test driven over the Chrome DevTools Protocol.
// Expects Chrome started with --remote-debugging-port=9222 and the
// extension loaded. Screenshots land in tools/smoke/out/.

const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.CDP_PORT || 9222);
const OUT = path.join(__dirname, 'out');

const sleep = ms => new Promise(r => setTimeout(r, ms));

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    ws.addEventListener('message', ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
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
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('timeout: ' + method));
        }
      }, 25000);
    });
  }
}

async function browserCdp() {
  const ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  return Cdp.connect(ver.webSocketDebuggerUrl);
}

async function shot(cdp, sessionId, name) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
  fs.writeFileSync(path.join(OUT, name), Buffer.from(data, 'base64'));
  console.log('shot:', name);
}

async function evalJs(cdp, sessionId, expression, awaitPromise = false) {
  const res = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise }, sessionId);
  if (res.exceptionDetails) {
    throw new Error('eval failed: ' + JSON.stringify(res.exceptionDetails.exception && res.exceptionDetails.exception.description || res.exceptionDetails));
  }
  return res.result.value;
}

async function mouse(cdp, sessionId, type, x, y, opts = {}) {
  await cdp.send('Input.dispatchMouseEvent', {
    type,
    x: Math.round(x),
    y: Math.round(y),
    button: opts.button || 'none',
    buttons: opts.buttons || 0,
    clickCount: opts.clickCount || 0,
    pointerType: 'mouse'
  }, sessionId);
}

async function drag(cdp, sessionId, from, to, steps = 10) {
  await mouse(cdp, sessionId, 'mousePressed', from.x, from.y, { button: 'left', buttons: 1, clickCount: 1 });
  for (let i = 1; i <= steps; i++) {
    const x = from.x + ((to.x - from.x) * i) / steps;
    const y = from.y + ((to.y - from.y) * i) / steps;
    await mouse(cdp, sessionId, 'mouseMoved', x, y, { buttons: 1 });
    await sleep(28);
  }
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await browserCdp();

  // Chrome 137+ dropped --load-extension on branded builds; load the
  // unpacked extension over CDP instead.
  const extPath = path.resolve(__dirname, '..', '..');
  const loaded = await browser.send('Extensions.loadUnpacked', { path: extPath });
  const extId = loaded.id;
  console.log('loaded extension id:', extId);
  await sleep(800);

  const { targetInfos } = await browser.send('Target.getTargets');
  const sw = targetInfos.find(t => t.type === 'service_worker' && t.url.startsWith('chrome-extension://' + extId + '/'));
  if (!sw) {
    throw new Error('service worker for ' + extId + ' not running; sw targets: ' +
      JSON.stringify(targetInfos.filter(t => t.type === 'service_worker').map(t => t.url)));
  }
  console.log('service worker up:', sw.url);

  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  const cdp = browser;
  const S = sessionId;

  await cdp.send('Page.enable', {}, S);
  await cdp.send('Runtime.enable', {}, S);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false }, S);

  // 1. YouTube search results (always renders cards without sign-in) -----
  await cdp.send('Page.navigate', { url: 'https://www.youtube.com/results?search_query=lofi+hip+hop' }, S);
  await sleep(7000);

  const consent = await evalJs(cdp, S, `!!document.querySelector('form[action*="consent"]')`);
  if (consent) {
    console.log('consent wall detected');
    await shot(cdp, S, '01-consent.png');
  }

  const cards = await evalJs(cdp, S, `document.querySelectorAll('ytd-video-renderer a[href*="/watch?v="], ytd-rich-grid-media a[href*="/watch?v="], yt-lockup-view-model a[href*="/watch?v="]').length`);
  console.log('video cards found:', cards);
  if (!cards) {
    await shot(cdp, S, '01-no-cards.png');
    throw new Error('no cards found on the results page');
  }
  await shot(cdp, S, '01-results.png');

  // 2. drag a real video card (prefer one with a channel byline) ---------
  const cardCenter = await evalJs(cdp, S, `(() => {
    const cards = [...document.querySelectorAll('ytd-video-renderer, ytd-rich-grid-media, yt-lockup-view-model')]
      .filter(c => c.querySelector('a[href*="/watch?v="]'))
      .map(c => {
        const a = c.querySelector('a[href*="/watch?v="]');
        const r = a.getBoundingClientRect();
        return { card: c, r, inView: r.top > 110 && r.bottom < 850 };
      })
      .filter(v => v.inView);
    const pick = cards.find(v => v.card.querySelector('a[href^="/@"]')) || cards[0];
    if (!pick) return null;
    return {
      x: pick.r.left + pick.r.width / 2,
      y: Math.max(160, pick.r.top + pick.r.height / 2),
      withChannel: !!pick.card.querySelector('a[href^="/@"]')
    };
  })()`);
  if (!cardCenter) throw new Error('no visible card to drag');
  console.log('card center:', cardCenter);
  console.log('card center:', cardCenter);

  await drag(cdp, S, cardCenter, { x: 1264, y: 450 });
  await sleep(700);

  const dockUp = await evalJs(cdp, S, `!!document.querySelector('.ct-dock.ct-show')`);
  const wellNames = await evalJs(cdp, S, `[...document.querySelectorAll('.ct-well[data-playlist]')].map(w => w.querySelector('.ct-well__name').textContent)`);
  console.log('dock visible:', dockUp, 'wells:', JSON.stringify(wellNames));
  await shot(cdp, S, '02-dock.png');
  if (!dockUp) throw new Error('dock did not appear during drag');

  // 3. drop on Watch Later ----------------------------------------------
  const wlWell = await evalJs(cdp, S, `(() => {
    const w = document.querySelector('.ct-well[data-playlist="WL"]');
    if (!w) return null;
    const r = w.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  if (!wlWell) throw new Error('Watch Later well missing');
  console.log('watch later well:', wlWell);

  await drag(cdp, S, { x: 1264, y: 450 }, wlWell, 6);
  await mouse(cdp, S, 'mouseReleased', wlWell.x, wlWell.y, { button: 'left', clickCount: 1 });
  await sleep(1400);

  const toast = await evalJs(cdp, S, `document.querySelector('.ct-toast') ? document.querySelector('.ct-toast__text').textContent : null`);
  console.log('toast:', JSON.stringify(toast));
  await shot(cdp, S, '03-after-drop.png');

  // 4. verify storage through the service worker ------------------------
  const { sessionId: swSession } = await browser.send('Target.attachToTarget', { targetId: sw.targetId, flatten: true });
  const stored = await evalJs(cdp, swSession, `chrome.storage.local.get('ct_playlists').then(d => JSON.stringify({
    lists: d.ct_playlists.map(p => ({ id: p.id, name: p.name, n: p.videos.length })),
    first: d.ct_playlists[0].videos[0] && { title: d.ct_playlists[0].videos[0].title, channel: d.ct_playlists[0].videos[0].channel, hasThumb: !!d.ct_playlists[0].videos[0].thumb }
  }))`, true);
  console.log('storage:', stored);
  const parsed = JSON.parse(stored);
  if (!parsed.lists.some(p => p.id === 'WL' && p.n > 0)) throw new Error('video was not written to storage');
  if (!parsed.first || parsed.first.title.length < 4 || !parsed.first.hasThumb) {
    throw new Error('saved video metadata incomplete: ' + JSON.stringify(parsed.first));
  }
  if (cardCenter.withChannel && !parsed.first.channel) {
    throw new Error('channel not extracted: ' + JSON.stringify(parsed.first));
  }
  console.log('SAVE VERIFIED with title:', JSON.stringify(parsed.first.title));

  // 5. dashboard ----------------------------------------------------------
  await cdp.send('Page.navigate', { url: 'chrome-extension://' + extId + '/dashboard/dashboard.html' }, S);
  await sleep(1800);
  const welcomeShown = await evalJs(cdp, S, `!document.getElementById('view-welcome').hidden`);
  console.log('welcome view visible on plain load:', welcomeShown);
  await shot(cdp, S, '04-dashboard.png');

  await cdp.send('Page.navigate', { url: 'chrome-extension://' + extId + '/dashboard/dashboard.html?playlist=WL' }, S);
  await sleep(1800);
  const dashState = await evalJs(cdp, S, `JSON.stringify({
    nav: [...document.querySelectorAll('.db-nav-name')].map(e => e.textContent),
    rows: document.querySelectorAll('.db-row').length,
    firstRow: document.querySelector('.db-row-title') ? document.querySelector('.db-row-title').textContent : null,
    name: document.getElementById('db-pl-name').textContent
  })`);
  console.log('dashboard playlist view:', dashState);
  await shot(cdp, S, '04b-dashboard-playlist.png');

  // 6. popup --------------------------------------------------------------
  await cdp.send('Page.navigate', { url: 'chrome-extension://' + extId + '/popup/popup.html' }, S);
  await sleep(1200);
  const pop = await evalJs(cdp, S, `JSON.stringify({
    stats: document.getElementById('pp-stats').textContent,
    items: [...document.querySelectorAll('.pp-name')].map(e => e.textContent)
  })`);
  console.log('popup:', pop);
  await shot(cdp, S, '05-popup.png');

  await cdp.send('Browser.close');
  console.log('SMOKE TEST PASSED');
}

main().catch(err => {
  console.error('SMOKE TEST FAILED:', err.message);
  process.exit(1);
});
