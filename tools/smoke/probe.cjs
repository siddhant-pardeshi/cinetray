'use strict';

// One-off diagnostic probe for the hover-chip save path.
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PORT = Number(process.env.CDP_PORT || 9227);

(async () => {
  const ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r));
  let id = 0;
  const pend = new Map();
  const events = [];
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') {
      events.push('EXC: ' + (m.params.exceptionDetails.exception && m.params.exceptionDetails.exception.description || m.params.exceptionDetails.text));
    }
    if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) {
      events.push(m.params.type + ': ' + m.params.args.map(a => a.value || a.description).join(' ').slice(0, 200));
    }
  });
  const send = (method, params = {}, sessionId) => {
    const i = ++id;
    return new Promise(res => { pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) })); });
  };

  const extPath = require('path').resolve(__dirname, '..', '..');
  await send('Extensions.loadUnpacked', { path: extPath });
  await sleep(800);

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Runtime.enable', {}, sessionId);
  await send('Page.enable', {}, sessionId);
  await send('Page.navigate', { url: 'https://www.youtube.com/results?search_query=lofi+hip+hop' }, sessionId);
  await sleep(6000);

  const mouse = async (type, x, y, o = {}) =>
    send('Input.dispatchMouseEvent', {
      type, x: Math.round(x), y: Math.round(y),
      button: o.button || 'none', buttons: o.buttons || 0,
      clickCount: o.clickCount || 0, pointerType: 'mouse'
    }, sessionId);
  const ev = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception && r.exceptionDetails.exception.description);
    return r.result.value;
  };

  const card = await ev(`(() => {
    const cards = [...document.querySelectorAll('ytd-video-renderer, yt-lockup-view-model')]
      .filter(c => c.querySelector('a[href*="/watch?v="]'));
    const c = cards[1] || cards[0];
    const r = c.getBoundingClientRect();
    return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
  })()`);
  console.log('card:', JSON.stringify(card));

  await mouse('mouseMoved', card.cx, card.cy);
  await sleep(420);

  const chip = await ev(`(() => {
    const chip = document.querySelector('.ct-chip--show');
    if (!chip) return null;
    const r = chip.getBoundingClientRect();
    const cs = getComputedStyle(chip);
    return {
      rect: { left: r.left, top: r.top, w: r.width, h: r.height },
      x: r.left + r.width / 2, y: r.top + r.height / 2,
      pe: cs.pointerEvents, z: cs.zIndex, display: cs.display,
      hostPos: getComputedStyle(chip.parentElement).position,
      anchor: (() => {
        const a = chip.parentElement.querySelector('a[href*="/watch?v="]');
        if (!a) return null;
        const acs = getComputedStyle(a);
        return { pos: acs.position, z: acs.zIndex };
      })()
    };
  })()`);
  console.log('chip:', JSON.stringify(chip));

  const hit = await ev(`(() => {
    const el = document.elementFromPoint(${Math.round(chip.x)}, ${Math.round(chip.y)});
    return el ? el.tagName + '.' + String(el.className).slice(0, 60) : 'none';
  })()`);
  console.log('elementFromPoint at chip center:', hit);

  await mouse('mousePressed', chip.x, chip.y, { button: 'left', buttons: 1, clickCount: 1 });
  await mouse('mouseReleased', chip.x, chip.y, { button: 'left', clickCount: 1 });
  await sleep(1200);

  console.log('toast:', await ev(`(document.querySelector('.ct-toast__text') || {}).textContent || null`));
  console.log('chip-done:', await ev(`!!document.querySelector('.ct-chip--done')`));
  console.log('click handler reached? instrument not present; events:', events.length ? events.join(' | ') : 'none');
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
