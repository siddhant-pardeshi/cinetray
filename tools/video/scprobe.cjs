'use strict';

// Diagnostic: does Page.screencastFrame stream continuously in this Chrome?
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PORT = Number(process.env.CDP_PORT || 9321);

(async () => {
  const ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r));
  let id = 0;
  const pend = new Map();
  let frameCount = 0;
  let ackErrors = [];
  const frameTimes = [];
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); }
    if (m.method === 'Page.screencastFrame') {
      frameCount++;
      frameTimes.push(Math.round(m.params.metadata && m.params.metadata.timestamp ? m.params.metadata.timestamp * 1000 % 100000 : 0));
      const ackId = ++id;
      ws.send(JSON.stringify({ id: ackId, method: 'Page.screencastFrameAck', params: { frameNumber: m.params.frameNumber }, sessionId: m.sessionId }));
      pend.set(ackId, res => { if (res && res.error) ackErrors.push(JSON.stringify(res.error)); });
    }
  });
  const send = (method, params = {}, sessionId) => {
    const i = ++id;
    return new Promise(res => { pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) })); });
  };

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId);
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false }, sessionId);
  await send('Page.navigate', { url: 'https://example.com' }, sessionId);
  await sleep(1500);

  await send('Page.startScreencast', { format: 'jpeg', quality: 70, maxWidth: 640, maxHeight: 360, everyFrameAck: true }, sessionId);
  // wiggle the page so it repaints
  for (let i = 0; i < 30; i++) {
    await send('Runtime.evaluate', { expression: `document.body.style.transform = 'translateY(${i % 2 ? 3 : 0}px)'` }, sessionId);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 100 + i * 10, y: 200, pointerType: 'mouse' }, sessionId);
    await sleep(50);
  }
  await sleep(1000);
  await send('Page.stopScreencast', {}, sessionId);
  console.log('frames received:', frameCount);
  console.log('ack errors:', ackErrors.length ? ackErrors.slice(0, 3) : 'none');
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
