'use strict';

// Renders the 14 walkthrough slides (1280x720, 2x DPR) as PNGs.
// Frame slides embed the captured screenshots; others are designed cards.

const fs = require('fs');
const path = require('path');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PORT = Number(process.env.CDP_PORT || 9310);

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(__dirname, 'slides');
const FRAMES = path.join(__dirname, 'frames');

const SLIDES = [
  { id: '01', part: 'MEET CINETRAY', caption: 'Collect YouTube videos with a single drag', designed: 'title' },
  { id: '02', part: 'WHY IT EXISTS', caption: 'Three clicks become one gesture', designed: 'problem' },
  { id: '03', part: 'INSTALL', caption: 'chrome://extensions - Developer mode - Load unpacked', frame: '02-extensions.png' },
  { id: '04', part: 'THE GESTURE', caption: 'Press and move: the video lifts, the dock slides in', frame: '04-drag.png' },
  { id: '05', part: 'THE DOCK', caption: 'A well for Watch Later and every playlist', frame: '05-drag-hover.png' },
  { id: '06', part: 'CREATE MID-DRAG', caption: 'Type a name in the dashed well, press Enter, done', frame: '07-newwell.png' },
  { id: '07', part: 'CANCEL & UNDO', caption: 'Release elsewhere to cancel, Escape works, Undo in the toast', frame: '06-toast.png' },
  { id: '08', part: 'HOVER CHIP', caption: 'One click on the card saves to Watch Later', frame: '03-chip.png' },
  { id: '09', part: 'RIGHT-CLICK', caption: 'Right-click any video, choose CineTray, save anywhere', designed: 'menu', frame: '01-results.png' },
  { id: '10', part: 'PLAYER LONG-PRESS', caption: 'Hold inside the player to lift the current video', frame: '08-player.png' },
  { id: '11', part: 'THE DASHBOARD', caption: 'Browse, rename, reorder, search, open all, export', frame: '09-dashboard.png' },
  { id: '12', part: 'POPUP & BADGE', caption: 'Your collection at a glance', frame: '11-popup.png' },
  { id: '13', part: 'PRIVACY', caption: '100% local: chrome.storage, no accounts, no servers', designed: 'privacy' },
  { id: '14', part: 'THAT IS CINETRAY', caption: 'github.com/siddhant-pardeshi/cinetray', designed: 'outro' }
];

const LOGO = `<svg viewBox="0 0 24 24" width="34" height="34" style="display:block">
  <rect x="1.5" y="3" width="21" height="15" rx="3.5" fill="#ff4d6d"/>
  <path d="M10 7.2v6.6l5.6-3.3z" fill="#fff"/>
  <rect x="4" y="19.6" width="16" height="2.6" rx="1.3" fill="#ff4d6d" opacity="0.55"/>
</svg>`;

function pageInner(s, index) {
  const total = SLIDES.length;
  const progress = ((index + 1) / total) * 100;
  const kicker = `CINETRAY WALKTHROUGH &nbsp;&middot;&nbsp; ${s.part} &nbsp;&middot;&nbsp; ${index + 1} / ${total}`;

  let body = '';
  if (s.designed === 'menu') {
    const url = 'file:///' + path.join(FRAMES, s.frame).replace(/\\/g, '/');
    body = `<div class="shot" style="background-image:url('${url}');filter:saturate(0.85) brightness(0.9)"></div>
            <div class="shade"></div>
            <div class="ctxmenu">
              <div class="ctx-head">${LOGO}<span>CineTray</span></div>
              <div class="ctx-item hot">Save to Watch Later</div>
              <div class="ctx-item">Save to Watch Later (Deep dives)</div>
              <div class="ctx-item">Save to Watch Later (Road trips)</div>
              <div class="ctx-item">Save to Watch Later (Party)</div>
              <div class="ctx-sep"></div>
              <div class="ctx-item dim">Open dashboard</div>
            </div>`;
  } else if (s.frame) {
    const url = 'file:///' + path.join(FRAMES, s.frame).replace(/\\/g, '/');
    body = `<div class="shot" style="background-image:url('${url}')"></div>
            <div class="shade"></div>`;
  } else if (s.designed === 'title') {
    body = `
      <div class="designed">
        <div class="stars">${dots()}</div>
        ${LOGO.replace('width="34" height="34"', 'width="88" height="88"')}
        <h1>CineTray</h1>
        <div class="rule"></div>
        <p class="big">Press a video. Drop it in a well. Filed.</p>
        <p class="dim">Watch Later &amp; playlists &middot; one gesture &middot; runs entirely in your browser</p>
      </div>`;
  } else if (s.designed === 'problem') {
    body = `
      <div class="designed row">
        <div class="pane">
          <div class="tag dimtag">BEFORE</div>
          <div class="fake-menu">
            <div class="fm-row">&bull;&nbsp; Open the three-dot menu</div>
            <div class="fm-row">&bull;&nbsp; "Save to Watch Later"</div>
            <div class="fm-row">&bull;&nbsp; Pick a playlist</div>
          </div>
          <p class="dim">three clicks, zero delight</p>
        </div>
        <div class="arrow">&rarr;</div>
        <div class="pane glow">
          <div class="tag">WITH CINETRAY</div>
          <div class="mini">
            <div class="mini-card"><span class="play"></span></div>
            <div class="mini-arrow"></div>
            <div class="mini-well"><span class="check">&#10003;</span></div>
          </div>
          <p class="accent-text">one drag, and it is filed</p>
        </div>
      </div>`;
  } else if (s.designed === 'privacy') {
    body = `
      <div class="designed">
        <svg viewBox="0 0 64 64" width="76" height="76">
          <path d="M32 6 L54 14 v16 c0 14 -9 22 -22 28 C19 52 10 44 10 30 V14 Z"
                fill="rgba(255,77,109,0.14)" stroke="#ff4d6d" stroke-width="2.5"/>
          <rect x="24" y="28" width="16" height="13" rx="3" fill="#ff4d6d"/>
          <path d="M27 28 v-4 a5 5 0 0 1 10 0 v4" fill="none" stroke="#ff8fa3" stroke-width="2.5"/>
        </svg>
        <h1>Yours, and only yours</h1>
        <p class="big">chrome.storage.local &mdash; nothing leaves the browser</p>
        <div class="chips">
          <span class="chip">No accounts</span>
          <span class="chip">No servers</span>
          <span class="chip">Export anytime</span>
        </div>
      </div>`;
  } else if (s.designed === 'outro') {
    body = `
      <div class="designed">
        ${LOGO.replace('width="34" height="34"', 'width="72" height="72"')}
        <h1>Press. Drag. Drop.</h1>
        <p class="big">Happy collecting!</p>
        <p class="repo">github.com/siddhant-pardeshi/cinetray</p>
      </div>`;
  }

  return `<!doctype html><html><head><meta charset="utf-8"><style>
    * { margin:0; padding:0; box-sizing:border-box; }
    html,body { width:1280px; height:720px; overflow:hidden; background:#0a0a10;
      font-family:'Segoe UI', Arial, sans-serif; color:#f0f0f4; }
    .shot { position:absolute; inset:0; background-size:cover; background-position:center; }
    .shade { position:absolute; inset:0;
      background:linear-gradient(180deg, rgba(6,7,12,0.42) 0%, rgba(6,7,12,0) 30%, rgba(6,7,12,0) 55%, rgba(6,7,12,0.82) 100%); }
    .chrome { position:absolute; inset:0; display:flex; flex-direction:column; justify-content:space-between;
      padding:26px 34px 30px; }
    .kicker { font-size:13px; font-weight:600; letter-spacing:2.5px; color:rgba(240,240,244,0.85);
      text-shadow:0 2px 10px rgba(0,0,0,0.8); display:flex; align-items:center; gap:10px; }
    .kicker .mark { filter:drop-shadow(0 2px 6px rgba(0,0,0,0.6)); }
    .caption { max-width:900px; font-size:31px; font-weight:600; line-height:1.25;
      text-shadow:0 2px 14px rgba(0,0,0,0.85); }
    .caption .bar { display:block; width:76px; height:5px; border-radius:3px; margin-bottom:14px;
      background:linear-gradient(90deg,#ff4d6d,#9b5cff); }
    .progress { position:absolute; left:0; bottom:0; height:5px;
      background:linear-gradient(90deg,#ff4d6d,#9b5cff); }
    /* designed cards */
    .designed { position:absolute; inset:0; display:flex; flex-direction:column; align-items:center;
      justify-content:center; gap:18px; text-align:center;
      background:radial-gradient(900px 500px at 80% -10%, rgba(155,92,255,0.16), transparent 60%),
                 radial-gradient(700px 420px at 12% 110%, rgba(255,77,109,0.14), transparent 60%), #0a0a10; }
    .designed h1 { font-size:76px; font-weight:600; letter-spacing:0.5px; }
    .designed .big { font-size:26px; color:#c9ccd8; }
    .designed .dim { font-size:16px; color:#8f95ab; }
    .rule { width:130px; height:5px; border-radius:3px; background:linear-gradient(90deg,#ff4d6d,#9b5cff); }
    .repo { font-size:20px; color:#7fb4ff; letter-spacing:0.5px; }
    .row { flex-direction:row; gap:34px; }
    .pane { width:400px; padding:30px 28px; border-radius:20px; background:#12131b;
      border:1px solid rgba(255,255,255,0.09); display:flex; flex-direction:column; gap:14px; align-items:center; }
    .pane.glow { border-color:rgba(255,77,109,0.55);
      box-shadow:0 0 40px rgba(255,77,109,0.18) inset, 0 12px 40px rgba(255,77,109,0.12); }
    .tag { font-size:13px; font-weight:700; letter-spacing:3px; color:#ff8fa3; }
    .dimtag { color:#8f95ab; }
    .fake-menu { text-align:left; }
    .fm-row { font-size:19px; color:#c9ccd8; padding:7px 0; }
    .accent-text { color:#ff8fa3; font-size:19px; }
    .arrow { font-size:44px; color:#6d7386; }
    .mini { display:flex; align-items:center; gap:16px; }
    .mini-card { width:96px; height:58px; border-radius:9px; background:linear-gradient(135deg,#ff4d6d,#9b5cff);
      position:relative; box-shadow:0 10px 26px rgba(0,0,0,0.5); }
    .play { position:absolute; left:50%; top:50%; transform:translate(-42%,-50%);
      border-left:16px solid #fff; border-top:10px solid transparent; border-bottom:10px solid transparent; }
    .mini-arrow { width:44px; height:0; border-top:2.5px dashed rgba(255,255,255,0.35); position:relative; }
    .mini-arrow::after { content:''; position:absolute; right:-2px; top:-5.5px;
      border-left:9px solid rgba(255,255,255,0.5); border-top:4.5px solid transparent; border-bottom:4.5px solid transparent; }
    .mini-well { width:58px; height:44px; border-radius:9px; background:rgba(255,77,109,0.16);
      border:1.5px solid rgba(255,77,109,0.6); display:flex; align-items:center; justify-content:center; }
    .check { color:#ff8fa3; font-size:20px; font-weight:700; }
    .chips { display:flex; gap:14px; }
    .chip { padding:10px 20px; border-radius:999px; background:rgba(255,255,255,0.07);
      border:1px solid rgba(255,255,255,0.14); font-size:16px; color:#c9ccd8; }
    .ctxmenu { position:absolute; right:210px; top:200px; width:300px; background:#15161f;
      border:1px solid rgba(255,255,255,0.14); border-radius:14px; overflow:hidden;
      box-shadow:0 24px 70px rgba(0,0,0,0.65); }
    .ctx-head { display:flex; align-items:center; gap:9px; padding:12px 16px; font-weight:600; font-size:15px;
      border-bottom:1px solid rgba(255,255,255,0.09); }
    .ctx-item { padding:11px 16px; font-size:14.5px; color:#c9ccd8; }
    .ctx-item.hot { background:rgba(255,77,109,0.22); color:#fff; font-weight:600;
      border-left:3px solid #ff4d6d; }
    .ctx-item.dim { color:#8f95ab; }
    .ctx-sep { height:1px; background:rgba(255,255,255,0.09); margin:4px 0; }
    .stars { position:absolute; inset:0; opacity:0.5; }
  </style></head><body>
    ${body}
    <div class="chrome">
      <div class="kicker"><span class="mark">${LOGO}</span>${kicker}</div>
      <div class="caption"><span class="bar"></span>${s.caption}</div>
    </div>
    <div class="progress" style="width:${progress}%"></div>
  </body></html>`;
}

function dots() {
  let out = '';
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 60; i++) {
    const x = Math.round(rnd() * 1280);
    const y = Math.round(rnd() * 720);
    const r = 1 + Math.round(rnd() * 2);
    const o = (0.04 + rnd() * 0.1).toFixed(2);
    out += `<circle cx="${x}" cy="${y}" r="${r}" fill="#ffffff" opacity="${o}"/>`;
  }
  return `<svg width="1280" height="720" style="position:absolute;inset:0">${out}</svg>`;
}

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

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const htmlDir = path.join(__dirname, 'html');
  fs.mkdirSync(htmlDir, { recursive: true });

  SLIDES.forEach((s, i) => {
    fs.writeFileSync(path.join(htmlDir, `slide-${s.id}.html`), pageInner(s, i));
  });

  const ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  const browser = await Cdp.connect(ver.webSocketDebuggerUrl);
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId: S } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  await browser.send('Page.enable', {}, S);
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 2, mobile: false }, S);

  for (const s of SLIDES) {
    await browser.send('Page.navigate', { url: 'file:///' + path.join(htmlDir, `slide-${s.id}.html`).replace(/\\/g, '/') }, S);
    await sleep(700);
    const { data } = await browser.send('Page.captureScreenshot', { format: 'png' }, S);
    fs.writeFileSync(path.join(OUT, `slide-${s.id}.png`), Buffer.from(data, 'base64'));
    console.log('slide:', s.id);
  }
  await browser.send('Target.closeTarget', { targetId });
  console.log('SLIDES RENDERED');
}

main().catch(err => {
  console.error('SLIDES FAILED:', err.message);
  process.exit(1);
});
