'use strict';

// Captures 720p frames of every CineTray feature for the walkthrough video.
// Requires Chrome started with --remote-debugging-port and
// --enable-unsafe-extension-debugging. Output: tools/video/frames/*.png

const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.CDP_PORT || 9300);
const OUT = path.join(__dirname, 'frames');
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
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('timeout: ' + method));
        }
      }, 30000);
    });
  }
}

function v(id, title, channel, duration, addedAt) {
  return {
    videoId: id, title, channel, duration,
    thumb: 'https://i.ytimg.com/vi/' + id + '/mqdefault.jpg',
    url: 'https://www.youtube.com/watch?v=' + id, addedAt
  };
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
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

  // A believable starting collection so wells show cover art.
  // First inject a small helper into the worker, then seed.
  await browser.send('Runtime.evaluate', {
    expression: `self.v = function(id, title, channel, duration, addedAt) {
      return { videoId: id, title: title, channel: channel, duration: duration,
        thumb: 'https://i.ytimg.com/vi/' + id + '/mqdefault.jpg',
        url: 'https://www.youtube.com/watch?v=' + id, addedAt: addedAt };
    };`,
    awaitPromise: false, returnByValue: true
  }, SW);
  await browser.send('Runtime.evaluate', {
    expression: `chrome.storage.local.set({ ct_playlists: [
      { id: 'WL', name: 'Watch Later', builtin: true, color: '#ff4d6d', createdAt: 1700000000000, lastUpdated: 1730000000000, videos: [
        v('jNQXAC9IVRw', 'Me at the zoo', 'jawed', '0:19', 1729000000000)
      ] },
      { id: 'p1', name: 'Deep dives', color: '#3aa0ff', createdAt: 1700000100000, lastUpdated: 1730000100000, videos: [
        v('aqz-KE-bpKQ', 'Big Buck Bunny 60fps 4K', 'Blender', '10:34', 1729000100000),
        v('jfKfPfyJRdk', 'lofi hip hop radio, beats to relax and study to', 'Lofi Girl', '', 1729000200000)
      ] },
      { id: 'p2', name: 'Party', color: '#ffb02e', createdAt: 1700000200000, lastUpdated: 1730000200000, videos: [
        v('9bZkp7q19f0', 'PSY - GANGNAM STYLE M/V', 'officialpsy', '4:13', 1729000300000)
      ] }
    ], ct_settings: { hoverChip: true, playerDrag: true, dockSide: 'right', animations: 'full', toastUndo: true } })`,
    awaitPromise: true, returnByValue: true
  }, SW);
  console.log('storage seeded');

  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId: S } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  await browser.send('Page.enable', {}, S);
  await browser.send('Runtime.enable', {}, S);
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1.25, mobile: false }, S);

  const shot = async name => {
    const { data } = await browser.send('Page.captureScreenshot', { format: 'png' }, S);
    fs.writeFileSync(path.join(OUT, name), Buffer.from(data, 'base64'));
    console.log('frame:', name);
  };
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
  const glide = async (from, to, steps = 10) => {
    for (let i = 1; i <= steps; i++) {
      await mouse('mouseMoved', from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps, { buttons: 1 });
      await sleep(26);
    }
  };
  const DOCK = { x: 1144, y: 360 };

  // results baseline
  await browser.send('Page.navigate', { url: 'https://www.youtube.com/results?search_query=lofi+hip+hop' }, S);
  await sleep(6500);
  await shot('01-results.png');

  // chrome://extensions (install story)
  await browser.send('Page.navigate', { url: 'chrome://extensions/' }, S);
  await sleep(2500);
  await shot('02-extensions.png');
  await browser.send('Page.navigate', { url: 'https://www.youtube.com/results?search_query=lofi+hip+hop' }, S);
  await sleep(6000);

  const pick = await ev(`(() => {
    const cards = [...document.querySelectorAll('ytd-video-renderer, yt-lockup-view-model, ytd-rich-grid-media')]
      .filter(c => c.querySelector('a[href*="/watch?v="]'))
      .map(c => { const r = c.getBoundingClientRect(); return { c, r, inView: r.top > 110 && r.bottom < 700 }; })
      .filter(v => v.inView);
    const first = cards.find(v => v.c.querySelector('a[href^="/@"]')) || cards[0];
    const other = cards.find(v => v !== first);
    const g = v => { const a = v.c.querySelector('a[href*="/watch?v="]'); const r = a.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: Math.max(140, r.top + r.height / 2) }; };
    return { a: g(first), b: g(other) };
  })()`);
  if (!pick || !pick.a) throw new Error('no visible cards found');
  console.log('cards picked');

  // hover chip (with YouTube's preview player fighting back — the chip wins)
  await mouse('mouseMoved', pick.a.x, pick.a.y);
  await sleep(500);
  await shot('03-chip.png');

  // drag: lift + dock open. Press pick.b directly — pick.a is under YouTube's
  // hover-preview player after the dwell, and its overlay swallows presses.
  await mouse('mousePressed', pick.b.x, pick.b.y, { button: 'left', buttons: 1, clickCount: 1 });
  await glide(pick.b, DOCK);
  await sleep(650);
  await shot('04-drag.png');

  // hover the bottom well (its glow stays visible beside the leaning ghost)
  const party = await ev(`(() => {
    const w = document.querySelector('.ct-well[data-playlist="p2"]');
    const r = w.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  await glide(DOCK, party, 6);
  await sleep(320);
  await shot('05-drag-hover.png');

  // drop on Watch Later → toast + sparkle burst
  const wl = await ev(`(() => {
    const w = document.querySelector('.ct-well[data-playlist="WL"]');
    const r = w.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  await glide(party, wl, 5);
  await sleep(200);
  await mouse('mouseReleased', wl.x, wl.y, { button: 'left', clickCount: 1 });
  await sleep(430);
  await shot('06-toast.png');
  await sleep(1200);

  // new-playlist well with text typed (press pick.b again — it was never
  // hovered long enough to spawn a preview)
  await mouse('mousePressed', pick.b.x, pick.b.y, { button: 'left', buttons: 1, clickCount: 1 });
  await glide(pick.b, DOCK);
  await sleep(600);
  const nw = await ev(`(() => {
    const w = document.querySelector('.ct-well--new');
    const r = w.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  await glide(DOCK, nw, 6);
  await sleep(350);
  await browser.send('Input.insertText', { text: 'Road trips' }, S);
  await sleep(250);
  await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }, S);
  await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }, S);
  // shoot after the commit: the new well is in the dock with its count and
  // the card has just flown in — better storytelling than the hidden input
  await sleep(520);
  await shot('07-newwell.png');
  await mouse('mouseReleased', nw.x, nw.y, { button: 'left', clickCount: 1 });
  await sleep(1100);

  // watch page long-press
  await browser.send('Page.navigate', { url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw' }, S);
  await sleep(5000);
  const player = await ev(`(() => {
    const p = document.querySelector('#movie_player');
    const r = p.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  await mouse('mousePressed', player.x, player.y, { button: 'left', buttons: 1, clickCount: 1 });
  await sleep(720);
  await shot('08-player.png');
  await mouse('mouseReleased', player.x, player.y, { button: 'left', clickCount: 1 });
  await sleep(900);

  // dashboard views
  await browser.send('Page.navigate', { url: 'chrome-extension://' + extId + '/dashboard/dashboard.html?playlist=WL' }, S);
  await sleep(1800);
  await shot('09-dashboard.png');
  await browser.send('Page.navigate', { url: 'chrome-extension://' + extId + '/dashboard/dashboard.html?view=settings' }, S);
  await sleep(1400);
  await shot('10-settings.png');

  // popup
  await browser.send('Page.navigate', { url: 'chrome-extension://' + extId + '/popup/popup.html' }, S);
  await sleep(1300);
  await shot('11-popup.png');

  await browser.send('Browser.close');
  console.log('FRAMES CAPTURED');
}

main().catch(err => {
  console.error('CAPTURE FAILED:', err.message);
  process.exit(1);
});
