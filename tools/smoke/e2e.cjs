'use strict';

// Regression suite driven over the Chrome DevTools Protocol.
//
// Requires a headless Chrome started with:
//   --remote-debugging-port=<port> --enable-unsafe-extension-debugging
//   --user-data-dir=<fresh dir>
//
// Scenarios:
//   S1  hover chip saves to Watch Later
//   S2  drag released over nothing cancels (no save, ghost gone, dock hides)
//   S3  Escape mid-drag cancels
//   S4  drag + drop on Watch Later saves
//   S5  mid-drag playlist creation via the dashed well
//   S6  duplicate drop is rejected ("Already in")
//   S7  context-menu lookup returns real metadata
//   S8  watch-page player long-press lifts and cancels cleanly
//   S9  dashboard renders the saved state
//  S10  popup stats and settings toggle persist

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
        const { resolve, reject, method, params } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) {
          reject(new Error(msg.error.message + ' (while calling ' + method + ' with ' + JSON.stringify(params).slice(0, 220) + ')'));
        } else {
          resolve(msg.result);
        }
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
      this.pending.set(id, { resolve, reject, method, params });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('timeout: ' + method));
        }
      }, 30000);
    });
  }
}

async function shot(browser, sessionId, name) {
  const { data } = await browser.send('Page.captureScreenshot', { format: 'png' }, sessionId);
  fs.writeFileSync(path.join(OUT, name), Buffer.from(data, 'base64'));
  console.log('  shot:', name);
}

async function evalJs(browser, sessionId, expression, awaitPromise = false) {
  const res = await browser.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise }, sessionId);
  if (res.exceptionDetails) {
    throw new Error('eval failed: ' + JSON.stringify(res.exceptionDetails.exception && res.exceptionDetails.exception.description || res.exceptionDetails));
  }
  return res.result.value;
}

function assert(cond, message) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + message);
  console.log('  ok:', message);
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  const browser = await Cdp.connect(ver.webSocketDebuggerUrl);

  const extPath = path.resolve(__dirname, '..', '..');
  const loaded = await browser.send('Extensions.loadUnpacked', { path: extPath });
  const extId = loaded.id;
  console.log('extension loaded:', extId);
  await sleep(800);

  let sw = null;
  for (let i = 0; i < 10 && !sw; i++) {
    const { targetInfos } = await browser.send('Target.getTargets');
    sw = targetInfos.find(t => t.type === 'service_worker' && t.url.startsWith('chrome-extension://' + extId + '/'));
    if (!sw) await sleep(500);
  }
  assert(sw, 'service worker is running');

  const { sessionId: SW } = await browser.send('Target.attachToTarget', { targetId: sw.targetId, flatten: true });
  const storage = expr => evalJs(browser, SW, expr, true);

  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId: S } = await browser.send('Target.attachToTarget', { targetId, flatten: true });

  await browser.send('Page.enable', {}, S);
  await browser.send('Runtime.enable', {}, S);
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false }, S);

  // --- input primitives: one clean gesture per scenario, always released ---
  const press = (x, y) => browser.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: Math.round(x), y: Math.round(y),
    button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse'
  }, S);
  const release = (x, y) => browser.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: Math.round(x), y: Math.round(y),
    button: 'left', clickCount: 1, pointerType: 'mouse'
  }, S);
  const glide = async (from, to, steps = 8) => {
    for (let i = 1; i <= steps; i++) {
      await browser.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: Math.round(from.x + ((to.x - from.x) * i) / steps),
        y: Math.round(from.y + ((to.y - from.y) * i) / steps),
        button: 'none',
        buttons: 1,
        pointerType: 'mouse'
      }, S);
      await sleep(26);
    }
  };
  const keyEvent = async (key, code, vk) => {
    await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }, S);
    await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }, S);
  };
  const hoverMove = (x, y) => browser.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved', x: Math.round(x), y: Math.round(y), button: 'none', pointerType: 'mouse'
  }, S);

  // ---------------------------------------------------------- setup
  await storage(`chrome.storage.local.set({
    ct_playlists: [{ id: 'WL', name: 'Watch Later', builtin: true, color: '#ff4d6d', createdAt: 0, lastUpdated: 0, videos: [] }],
    ct_settings: { hoverChip: true, playerDrag: true, dockSide: 'right', animations: 'full', toastUndo: true }
  })`);

  await browser.send('Page.navigate', { url: 'https://www.youtube.com/results?search_query=lofi+hip+hop' }, S);
  await sleep(7000);

  const pickCards = await evalJs(browser, S, `(() => {
    const cards = [...document.querySelectorAll('ytd-video-renderer, ytd-rich-grid-media, yt-lockup-view-model')]
      .filter(c => c.querySelector('a[href*="/watch?v="]'))
      .map(c => {
        const r = c.getBoundingClientRect();
        return { c, r, inView: r.top > 110 && r.bottom < 850 };
      })
      .filter(v => v.inView);
    const pick = cards.find(v => v.c.querySelector('a[href^="/@"]')) || cards[0];
    const other = cards.find(v => v !== pick);
    const grab = v => {
      if (!v) return null;
      const a = v.c.querySelector('a[href*="/watch?v="]');
      return {
        videoId: (a.href.match(/[?&]v=([\\w-]{11})/) || [])[1] || null,
        x: v.r.left + v.r.width / 2,
        y: Math.max(160, v.r.top + v.r.height / 2)
      };
    };
    return { chip: grab(pick), drop: grab(other) };
  })()`);
  assert(pickCards.chip && pickCards.chip.videoId, 'a visible video card was located: ' + JSON.stringify(pickCards.chip && pickCards.chip.videoId));
  assert(pickCards.drop && pickCards.drop.videoId && pickCards.drop.videoId !== pickCards.chip.videoId,
    'a second distinct card is available for the drop scenarios');
  const chipCardPos = pickCards.chip;
  const dropCardPos = pickCards.drop;

  const wlCount = async () => JSON.parse(await storage(
    `chrome.storage.local.get('ct_playlists').then(d => JSON.stringify(d.ct_playlists.find(p => p.id === 'WL').videos.length))`));

  const wellCenter = name => evalJs(browser, S, `(() => {
    const w = document.querySelector('${name}');
    if (!w) return null;
    const r = w.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);

  const DOCK_MID = { x: 1264, y: 450 };
  const EMPTY = { x: 700, y: 620 };

  // ---------------------------------------------------------- S1: hover chip
  console.log('S1: hover chip save');
  await hoverMove(chipCardPos.x, chipCardPos.y);
  await sleep(420);
  const chipPos = await evalJs(browser, S, `(() => {
    const chip = document.querySelector('.ct-chip--show');
    if (!chip) return null;
    const r = chip.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  assert(chipPos, 'hover chip appeared after resting on the card');
  await press(chipPos.x, chipPos.y);
  await release(chipPos.x, chipPos.y);
  await sleep(900);
  assert(await wlCount() === 1, 'chip click saved the video to Watch Later');
  await shot(browser, S, 's1-chip.png');

  // ---------------------------------------------------------- S2: cancel by releasing elsewhere
  console.log('S2: release over nothing cancels');
  await press(chipCardPos.x, chipCardPos.y);
  await glide(chipCardPos, EMPTY);
  await release(EMPTY.x, EMPTY.y);
  await sleep(850);
  assert(await evalJs(browser, S, `document.querySelectorAll('.ct-ghost').length`) === 0,
    'ghost card flew home and was removed');
  await sleep(450);
  assert(!await evalJs(browser, S, `!!document.querySelector('.ct-dock.ct-show')`),
    'dock slid away after the cancel');
  assert(await wlCount() === 1, 'nothing was saved by the cancelled drag');
  await shot(browser, S, 's2-cancel.png');

  // ---------------------------------------------------------- S3: Escape cancels
  console.log('S3: Escape mid-drag cancels');
  await press(chipCardPos.x, chipCardPos.y);
  await glide(chipCardPos, { x: 760, y: 480 });
  await keyEvent('Escape', 'Escape', 27);
  await sleep(850);
  assert(await evalJs(browser, S, `document.querySelectorAll('.ct-ghost').length`) === 0,
    'ghost card removed after Escape');
  assert(await wlCount() === 1, 'Escape did not save anything');

  // ---------------------------------------------------------- S4: drop on Watch Later
  console.log('S4: drop on Watch Later');
  await press(dropCardPos.x, dropCardPos.y);
  await glide(dropCardPos, DOCK_MID);
  await sleep(600);
  assert(await evalJs(browser, S, `!!document.querySelector('.ct-dock.ct-show')`), 'dock visible mid-drag');
  const wlWell = await wellCenter('.ct-well[data-playlist="WL"]');
  assert(wlWell, 'Watch Later well present');
  await glide(DOCK_MID, wlWell, 6);
  await release(wlWell.x, wlWell.y);
  await sleep(1200);
  assert(await wlCount() === 2, 'drag-and-drop saved to Watch Later');
  await shot(browser, S, 's4-drop.png');

  // ---------------------------------------------------------- S5: create a playlist mid-drag
  console.log('S5: create playlist from the dashed well mid-drag');
  await press(chipCardPos.x, chipCardPos.y);
  await glide(chipCardPos, DOCK_MID);
  await sleep(600);
  const newWell = await wellCenter('.ct-well--new');
  assert(newWell, 'new-playlist well present');
  await glide(DOCK_MID, newWell, 6);
  await sleep(250);
  assert(await evalJs(browser, S, `!!document.querySelector('.ct-well--new.ct-new-open .ct-well__input')`),
    'new-playlist well opened its input on hover');
  await browser.send('Input.insertText', { text: 'Road trips' }, S);
  await sleep(120);
  await keyEvent('Enter', 'Enter', 13);
  await sleep(1400);
  const lists5 = JSON.parse(await storage(
    `chrome.storage.local.get('ct_playlists').then(d => JSON.stringify(d.ct_playlists.map(p => ({ id: p.id, name: p.name, n: p.videos.length }))))`));
  const roadTrips = lists5.find(p => p.name === 'Road trips');
  assert(!!roadTrips, 'playlist "Road trips" was created mid-drag');
  assert(roadTrips.n === 1, 'the dragged video was filed into it');
  await release(newWell.x, newWell.y);
  await sleep(300);
  await shot(browser, S, 's5-new-playlist.png');

  // ---------------------------------------------------------- S6: duplicate drop
  console.log('S6: duplicate drop is rejected');
  await press(chipCardPos.x, chipCardPos.y);
  await glide(chipCardPos, DOCK_MID);
  await sleep(600);
  const wlWell6 = await wellCenter('.ct-well[data-playlist="WL"]');
  await glide(DOCK_MID, wlWell6, 6);
  await release(wlWell6.x, wlWell6.y);
  await sleep(1200);
  const toast6 = await evalJs(browser, S, `(document.querySelector('.ct-toast__text') || {}).textContent || null`);
  assert(toast6 && toast6.startsWith('Already in'), 'duplicate rejected with toast: ' + JSON.stringify(toast6));
  assert(await wlCount() === 2, 'Watch Later count unchanged after duplicate');

  // ---------------------------------------------------------- S7: context-menu lookup path
  console.log('S7: context-menu lookup returns real metadata');
  const lookup = JSON.parse(await storage(`chrome.tabs.query({ active: true }).then(tabs =>
    chrome.tabs.sendMessage(tabs[0].id, { action: 'lookup', videoId: '${chipCardPos.videoId}' })
  ).then(r => JSON.stringify(r))`, true));
  assert(lookup.ok && lookup.video && lookup.video.title.length > 3 && lookup.video.title !== 'YouTube video',
    'lookup returned a real title: ' + JSON.stringify(lookup.video && lookup.video.title));

  // ---------------------------------------------------------- S8: player long-press on watch page
  console.log('S8: watch-page long-press lift and cancel');
  await browser.send('Page.navigate', { url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw' }, S);
  await sleep(5000);
  const player = await evalJs(browser, S, `(() => {
    const p = document.querySelector('#movie_player');
    const r = p.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  await press(player.x, player.y);
  await sleep(750);
  const liftedState = JSON.parse(await evalJs(browser, S, `JSON.stringify({
    ghost: document.querySelectorAll('.ct-ghost').length,
    dock: !!document.querySelector('.ct-dock.ct-show')
  })`));
  assert(liftedState.ghost >= 1 && liftedState.dock, 'long-press lifted the current video with the dock up');
  await shot(browser, S, 's8-player.png');
  await release(player.x, player.y);
  await sleep(1100);
  const afterState = JSON.parse(await evalJs(browser, S, `JSON.stringify({
    ghosts: document.querySelectorAll('.ct-ghost').length,
    url: location.href.includes('watch?v=jNQXAC9IVRw')
  })`));
  assert(afterState.ghosts === 0, 'ghost cleaned up after release');
  assert(afterState.url, 'long-press release did not navigate the page');
  assert(await wlCount() === 2, 'long-press cancel saved nothing');

  // ---------------------------------------------------------- S9: dashboard
  console.log('S9: dashboard renders the saved state');
  await browser.send('Page.navigate', { url: 'chrome-extension://' + extId + '/dashboard/dashboard.html?playlist=WL' }, S);
  await sleep(1800);
  const dash = JSON.parse(await evalJs(browser, S, `JSON.stringify({
    rows: document.querySelectorAll('.db-row').length,
    nav: [...document.querySelectorAll('.db-nav-name')].map(e => e.textContent),
    welcomeHidden: document.getElementById('view-welcome').hidden
  })`));
  assert(dash.rows === 2, 'dashboard shows 2 rows in Watch Later');
  assert(dash.nav.length === 2 && dash.nav.includes('Road trips'), 'dashboard nav lists both playlists');
  assert(dash.welcomeHidden, 'welcome view is not shown for a playlist deep link');
  await shot(browser, S, 's9-dashboard.png');

  // ---------------------------------------------------------- S10: popup + settings toggle
  console.log('S10: popup stats and settings toggle');
  await browser.send('Page.navigate', { url: 'chrome-extension://' + extId + '/popup/popup.html' }, S);
  await sleep(1200);
  const pop = JSON.parse(await evalJs(browser, S, `JSON.stringify({
    stats: document.getElementById('pp-stats').textContent,
    items: [...document.querySelectorAll('.pp-name')].map(e => e.textContent)
  })`));
  assert(pop.stats.startsWith('3 videos'), 'popup stats count all saved videos: ' + JSON.stringify(pop.stats));
  assert(pop.items.includes('Road trips'), 'popup lists the new playlist');
  await evalJs(browser, S, `document.getElementById('pp-chip').click()`);
  await sleep(500);
  const hoverChip = JSON.parse(await storage(`chrome.storage.local.get('ct_settings').then(d => JSON.stringify(d.ct_settings.hoverChip))`));
  assert(hoverChip === false, 'popup toggle persisted hoverChip=false');
  await shot(browser, S, 's10-popup.png');

  await browser.send('Browser.close');
  console.log('ALL REGRESSION SCENARIOS PASSED');
}

main().catch(err => {
  console.error('REGRESSION FAILED:', err.message);
  process.exit(1);
});
