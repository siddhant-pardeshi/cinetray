(() => {
  'use strict';

  // ---------------------------------------------------------------- config

  const CARD_SELECTORS = [
    'ytd-rich-grid-media',
    'ytd-video-renderer',
    'ytd-grid-video-renderer',
    'ytd-compact-video-renderer',
    'ytd-playlist-video-renderer',
    'ytd-playlist-panel-video-renderer',
    'yt-lockup-view-model'
  ].join(', ');

  // Widgets inside a card that must keep their own click behaviour.
  const BLOCKING_SELECTORS = [
    'button',
    'tp-yt-paper-icon-button',
    'yt-icon-button',
    'ytd-menu-renderer',
    '[role="button"]',
    'input',
    'textarea',
    'select',
    '.ytp-chrome-bottom',
    '.ytp-progress-bar-container'
  ].join(', ');

  const DRAG_START_PX = 6;
  const HOLD_MS = 380;
  const PLAYER_HOLD_MS = 520;

  const state = {
    settings: { hoverChip: true, playerDrag: true, dockSide: 'right', animations: 'full', toastUndo: true },
    lastSave: null
  };

  let session = null;   // active drag
  let suppressNextClick = false;
  let holdTimer = 0;
  let dockHideTimer = 0;
  let chipTimer = 0;
  let chipCard = null;

  /* ------------------------------------------------------------ helpers */

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  async function send(msg) {
    try {
      return await chrome.runtime.sendMessage(msg);
    } catch (err) {
      return null;
    }
  }

  /* ---------------------------------------------------------- extraction */

  function parseVideoId(url) {
    if (!url) return null;
    let m = url.match(/[?&]v=([\w-]{11})/);
    if (m) return m[1];
    m = url.match(/youtu\.be\/([\w-]{11})/);
    if (m) return m[1];
    m = url.match(/\/shorts\/([\w-]{11})/);
    return m ? m[1] : null;
  }

  function firstText(el) {
    return el ? (el.textContent || '').trim() : '';
  }

  function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function extractVideo(card) {
    if (!card) return null;
    const link = card.querySelector('a[href*="/watch?v="], a[href*="youtu.be/"]');
    const id = parseVideoId(link && link.getAttribute('href'));
    if (!id) return null;

    const channelEl = card.querySelector(
      'ytd-channel-name a, #channel-name a, ' +
      '.yt-lockup-metadata-view-model-wiz__metadata a, .yt-lockup-metadata-view-model__metadata a, ' +
      'a[href^="/@"], a[href^="/channel/"]');
    const channel = firstText(channelEl).slice(0, 80);

    // Older markup uses #video-title; newer lockups use a metadata title or
    // a heading, and the anchor's aria-label reads "<title> by <channel>".
    const titleEl = card.querySelector('#video-title, .yt-lockup-metadata-view-model__title, h3');
    let title = firstText(titleEl) || (link && link.getAttribute('title')) || '';
    if (!title && link && link.getAttribute('aria-label')) {
      const label = link.getAttribute('aria-label').trim();
      title = channel ? label.replace(new RegExp('\\s+by\\s+' + escapeRegExp(channel) + '\\s*$', 'i'), '') : label;
    }

    const durEl = card.querySelector(
      'ytd-thumbnail block, ytd-thumbnail-overlay-time-status-renderer span, ' +
      '.badge-shape-wiz__text, .yt-badge-shape__text, .yt-badge-shape-wiz__text');

    return {
      videoId: id,
      title: title.slice(0, 180) || 'Untitled video',
      channel,
      duration: firstText(durEl).slice(0, 12),
      thumb: thumbFor(id),
      url: 'https://www.youtube.com/watch?v=' + id,
      addedAt: Date.now()
    };
  }

  function thumbFor(id) {
    return 'https://i.ytimg.com/vi/' + id + '/mqdefault.jpg';
  }

  function currentWatchVideo() {
    const id = parseVideoId(location.href);
    if (!id) return null;
    const titleEl = document.querySelector('h1.ytd-watch-metadata yt-formatted-string, h1.title yt-formatted-string');
    const title = firstText(titleEl) || document.title.replace(/ - YouTube$/, '');
    const channelEl = document.querySelector('ytd-channel-name a, #owner #channel-name a');
    return {
      videoId: id,
      title: title.slice(0, 180) || 'Untitled video',
      channel: firstText(channelEl).slice(0, 80),
      duration: '',
      thumb: thumbFor(id),
      url: location.origin + '/watch?v=' + id,
      addedAt: Date.now()
    };
  }

  /* ------------------------------------------------------- dock and wells */

  const ui = { dock: null, wells: null, toast: null, toastTimer: 0 };
  let playlistsCache = [];

  function ensureDock() {
    if (ui.dock) return ui.dock;
    const dock = document.createElement('div');
    dock.className = 'ct-dock ct-' + (state.settings.dockSide === 'left' ? 'left' : 'right');
    dock.innerHTML =
      '<div class="ct-dock__head"><span class="ct-dock__title">Drop to save</span></div>' +
      '<div class="ct-dock__wells"></div>';
    document.documentElement.appendChild(dock);
    ui.dock = dock;
    ui.wells = dock.querySelector('.ct-dock__wells');

    ui.wells.addEventListener('keydown', e => {
      const input = e.target.closest('.ct-well__input');
      if (input && e.key === 'Enter') commitNewPlaylist(input);
      if (input && e.key === 'Escape') {
        input.value = '';
        input.blur();
        closeNewWell();
      }
    });

    ui.wells.addEventListener('click', e => {
      const well = e.target.closest('.ct-well[data-playlist]');
      if (well && session && session.lifted && !session.dropDone) {
        // Some pointers (touch) never fire a clean pointerup over the well;
        // the click after lift counts as the drop.
        dropIntoPlaylist(well);
      }
    });
    return dock;
  }

  function wellStackHtml(videos) {
    const thumbs = videos.slice(0, 3).map((v, i) =>
      '<span class="ct-well__thumb" style="--stack:' + i + '">' +
      '<img src="' + escapeHtml(v.thumb) + '" alt="" loading="lazy">' +
      '</span>').join('');
    return thumbs || '<span class="ct-well__thumb ct-well__thumb--empty"></span>';
  }

  function renderWells() {
    if (!ui.wells) return;
    const customs = playlistsCache
      .filter(p => !p.builtin)
      .sort((a, b) => b.lastUpdated - a.lastUpdated)
      .slice(0, 12);

    let html = '';
    const wl = playlistsCache.find(p => p.id === 'WL');
    if (wl) html += wellHtml(wl, 0);
    customs.forEach((p, i) => { html += wellHtml(p, i + 1); });
    html +=
      '<div class="ct-well ct-well--new" data-new="1">' +
      '<span class="ct-well__newlabel">+ New playlist</span>' +
      '<input class="ct-well__input" maxlength="60" placeholder="Name it and press Enter" aria-label="New playlist name">' +
      '</div>';

    const prevHover = session && session.hoverWell ? session.hoverWell.dataset.playlist : null;
    ui.wells.innerHTML = html;
    if (prevHover) {
      const again = ui.wells.querySelector('[data-playlist="' + prevHover + '"]');
      if (again) setHoverWell(again);
    }
  }

  function wellHtml(p, index) {
    return (
      '<div class="ct-well' + (p.builtin ? ' ct-well--primary' : '') + '" data-playlist="' + p.id + '" ' +
      'style="--i:' + index + '; --accent:' + escapeHtml(p.color || '#ff4d6d') + '">' +
      '<span class="ct-well__stack">' + wellStackHtml(p.videos || []) + '</span>' +
      '<span class="ct-well__meta">' +
      '<span class="ct-well__name">' + escapeHtml(p.name) + '</span>' +
      '<span class="ct-well__count">' + (p.videos || []).length + '</span>' +
      '</span>' +
      '</div>'
    );
  }

  function openDock() {
    const dock = ensureDock();
    clearTimeout(dockHideTimer);
    renderWells();
    document.documentElement.style.setProperty('--ct-dock-x', state.settings.dockSide === 'left' ? '14%' : '86%');
    requestAnimationFrame(() => dock.classList.add('ct-show'));

    send({ action: 'getState' }).then(resp => {
      if (resp && resp.ok) {
        playlistsCache = resp.playlists;
        Object.assign(state.settings, resp.settings || {});
        if (ui.dock) {
          ui.dock.classList.toggle('ct-right', state.settings.dockSide !== 'left');
          ui.dock.classList.toggle('ct-left', state.settings.dockSide === 'left');
        }
        renderWells();
      }
    });
  }

  function closeDockSoon() {
    if (!ui.dock) return;
    clearTimeout(dockHideTimer);
    dockHideTimer = setTimeout(() => {
      if (session) return; // another drag picked up mid-exit
      ui.dock.classList.remove('ct-show');
      setHoverWell(null);
    }, 900);
  }

  function closeNewWell() {
    const well = ui.wells && ui.wells.querySelector('.ct-well--new');
    if (well) well.classList.remove('ct-new-open');
  }

  function setHoverWell(well) {
    const s = session;
    const prev = s ? s.hoverWell : null;
    if (prev === well) return;
    if (prev) prev.classList.remove('ct-hover');
    if (well) well.classList.add('ct-hover');
    if (s) s.hoverWell = well;
    if (well && well.dataset.new) {
      well.classList.add('ct-new-open');
      const input = well.querySelector('.ct-well__input');
      if (input && document.activeElement !== input) input.focus();
    } else {
      closeNewWell();
    }
  }

  async function commitNewPlaylist(input) {
    const name = (input.value || '').trim();
    if (!name) {
      closeNewWell();
      return;
    }
    const resp = await send({ action: 'createPlaylist', name });
    if (!resp || !resp.ok) return;
    if (!playlistsCache.some(p => p.id === resp.playlistId)) {
      playlistsCache.unshift({
        id: resp.playlistId, name: resp.playlistName, color: '#9b5cff',
        createdAt: Date.now(), lastUpdated: Date.now(), videos: []
      });
    }
    renderWells();
    input.value = '';
    input.blur();
    closeNewWell();

    const s = session;
    if (s && s.lifted && !s.dropDone) {
      const well = ui.wells.querySelector('[data-playlist="' + resp.playlistId + '"]');
      if (well) dropIntoPlaylist(well);
      else dropToId(resp.playlistId);
    }
  }

  /* ---------------------------------------------------------- ghost card */

  function buildGhost(video, width) {
    const g = document.createElement('div');
    g.className = 'ct-ghost';
    g.style.width = width + 'px';
    g.innerHTML =
      '<div class="ct-ghost__thumb">' +
      '<img src="' + escapeHtml(video.thumb) + '" alt="">' +
      (video.duration ? '<span class="ct-ghost__duration">' + escapeHtml(video.duration) + '</span>' : '') +
      '</div>' +
      '<div class="ct-ghost__meta">' +
      '<span class="ct-ghost__title">' + escapeHtml(video.title) + '</span>' +
      (video.channel ? '<span class="ct-ghost__title ct-ghost__title--channel">' + escapeHtml(video.channel) + '</span>' : '') +
      '</div>';
    document.documentElement.appendChild(g);
    return g;
  }

  function transformAt(x, y, scale, rotate) {
    return 'translate3d(' + x + 'px,' + y + 'px,0) rotate(' + rotate + 'deg) scale(' + scale + ')';
  }

  function flyGhostTo(x, y, scale, onDone) {
    const s = session;
    if (!s || !s.ghost) { if (onDone) onDone(); return; }
    cancelAnimationFrame(s.raf);
    const g = s.ghost;
    const w = g.offsetWidth || 240;
    const h = g.offsetHeight || 150;
    const from = { x: s.gx, y: s.gy };
    const to = { x: x - w * scale / 2, y: y - h * scale / 2 };
    if (state.settings.animations === 'off') {
      g.remove();
      s.ghost = null;
      if (onDone) onDone();
      return;
    }
    const mid = {
      x: (from.x + to.x) / 2 + (to.y - from.y) * 0.16,
      y: (from.y + to.y) / 2 - Math.abs(to.x - from.x) * 0.10
    };
    const anim = g.animate(
      [
        { transform: transformAt(from.x, from.y, 1.02, 0), offset: 0 },
        { transform: transformAt(mid.x, mid.y, 0.78, clamp((to.x - from.x) * 0.03, -10, 10)), offset: 0.55 },
        { transform: transformAt(to.x, to.y, scale, 0), offset: 1 }
      ],
      { duration: 380, easing: 'cubic-bezier(.4,0,.2,1)', fill: 'forwards' }
    );
    anim.onfinish = () => {
      g.remove();
      s.ghost = null;
      if (onDone) onDone();
    };
  }

  function burst(x, y, accent) {
    const host = document.createElement('div');
    host.className = 'ct-burst';
    host.style.left = x + 'px';
    host.style.top = y + 'px';
    host.style.setProperty('--accent', accent || '#ff4d6d');
    for (let i = 0; i < 12; i++) {
      const spark = document.createElement('i');
      const ang = (Math.PI * 2 * i) / 12 + Math.random() * 0.5;
      const dist = 26 + Math.random() * 36;
      spark.style.setProperty('--dx', (Math.cos(ang) * dist).toFixed(1) + 'px');
      spark.style.setProperty('--dy', (Math.sin(ang) * dist).toFixed(1) + 'px');
      spark.style.setProperty('--d', Math.round(480 + Math.random() * 260) + 'ms');
      spark.style.setProperty('--sz', (3 + Math.random() * 4).toFixed(1) + 'px');
      host.appendChild(spark);
    }
    document.documentElement.appendChild(host);
    setTimeout(() => host.remove(), 900);
  }

  /* --------------------------------------------------------------- toast */

  function ensureToast() {
    if (ui.toast) return ui.toast;
    const t = document.createElement('div');
    t.className = 'ct-toast';
    t.innerHTML =
      '<svg class="ct-toast__check" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">' +
      '<path d="M5 12.5l4.2 4.2L19 7.5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" pathLength="1"/>' +
      '</svg>' +
      '<span class="ct-toast__text"></span>' +
      '<button class="ct-toast__undo" type="button">Undo</button>';
    document.documentElement.appendChild(t);
    ui.toast = t;
    t.querySelector('.ct-toast__undo').addEventListener('click', async () => {
      const last = state.lastSave;
      if (last) {
        await send({ action: 'removeVideo', playlistId: last.playlistId, videoId: last.videoId });
        state.lastSave = null;
        toast('Removed', {});
      }
      t.classList.remove('ct-show');
    });
    return t;
  }

  function toast(text, opts) {
    opts = opts || {};
    const t = ensureToast();
    t.querySelector('.ct-toast__text').textContent = text;
    t.classList.toggle('ct-toast--error', !!opts.error);
    t.querySelector('.ct-toast__undo').hidden = !opts.undo;
    t.classList.add('ct-show');
    clearTimeout(ui.toastTimer);
    ui.toastTimer = setTimeout(() => t.classList.remove('ct-show'), opts.error ? 3400 : 2600);
  }

  /* --------------------------------------------------------- drag engine */

  function armDrag(e, card, video, holdMs) {
    session = {
      pointerId: e.pointerId,
      pointerType: e.pointerType,
      card,
      video,
      originRect: card ? card.getBoundingClientRect() : null,
      startX: e.clientX,
      startY: e.clientY,
      x: e.clientX,
      y: e.clientY,
      px: e.clientX,
      py: e.clientY,
      gx: 0,
      gy: 0,
      ghostW: 240,
      ghostH: 150,
      vx: 0,
      lifted: false,
      dropDone: false,
      fromPlayer: !card,
      hoverWell: null,
      raf: 0,
      ghost: null
    };
    clearTimeout(holdTimer);
    holdTimer = setTimeout(() => {
      if (session && !session.lifted && !movedFar()) lift();
    }, holdMs);

    window.addEventListener('pointermove', onPointerMove, true);
    window.addEventListener('pointerup', onPointerUp, true);
    window.addEventListener('pointercancel', onPointerCancel, true);
  }

  function movedFar() {
    const s = session;
    return Math.hypot(s.x - s.startX, s.y - s.startY) >= DRAG_START_PX;
  }

  function lift() {
    const s = session;
    if (!s || s.lifted) return;
    clearTimeout(holdTimer);
    s.lifted = true;
    suppressNextClick = true;

    const w = clamp(s.originRect ? s.originRect.width : 240, 200, 264);
    s.ghostW = w;
    s.ghost = buildGhost(s.video, w);
    s.ghostH = s.ghost.offsetHeight || 150;

    if (s.fromPlayer) {
      s.gx = s.x - w / 2;
      s.gy = s.y - s.ghostH / 2;
    } else {
      s.gx = s.originRect.left;
      s.gy = s.originRect.top;
    }

    if (s.card) s.card.classList.add('ct-source-lifted');
    document.documentElement.classList.add('ct-drag-active');
    muteIframes(true);

    openDock();
    if (state.settings.animations !== 'off') {
      s.ghost.classList.add('ct-ghost--in');
      s.raf = requestAnimationFrame(stepGhost);
    } else {
      positionGhost();
    }
  }

  function positionGhost() {
    const s = session;
    if (!s || !s.ghost) return;
    s.gx = s.x - s.ghostW / 2;
    s.gy = s.y - s.ghostH / 2;
    s.ghost.style.transform = transformAt(s.gx, s.gy, 1.04, 0);
    hitTest();
  }

  function stepGhost() {
    const s = session;
    if (!s || !s.lifted || !s.ghost || s.dropDone) return;
    const k = 0.28;
    const prevX = s.gx;
    const prevY = s.gy;
    // Lean the card up-left while it hovers a well so the target stays visible.
    const lean = s.hoverWell ? 44 : 0;
    s.gx += (s.x - s.ghostW / 2 - lean - s.gx) * k;
    s.gy += (s.y - s.ghostH / 2 - lean * 0.7 - s.gy) * k;
    const tilt = clamp((s.gx - prevX) * 0.55, -9, 9);
    s.ghost.style.transform = transformAt(s.gx, s.gy, s.hoverWell ? 0.94 : 1.04, tilt);
    hitTest();
    s.raf = requestAnimationFrame(stepGhost);
  }

  function hitTest() {
    const s = session;
    const el = document.elementFromPoint(s.x, s.y);
    const well = el && el.closest ? el.closest('.ct-well[data-playlist], .ct-well[data-new]') : null;
    setHoverWell(well);
  }

  function hitTestAt(x, y) {
    const el = document.elementFromPoint(x, y);
    return el && el.closest ? el.closest('.ct-well[data-playlist], .ct-well[data-new]') : null;
  }

  function onPointerMove(e) {
    const s = session;
    if (!s || e.pointerId !== s.pointerId) return;
    s.x = e.clientX;
    s.y = e.clientY;
    if (!s.lifted) {
      if (s.pointerType === 'touch' && Math.hypot(s.x - s.startX, s.y - s.startY) > 4) {
        // Touch users probably meant to scroll, not drag.
        disarm();
        return;
      }
      if (s.pointerType !== 'touch' && movedFar()) lift();
    } else if (state.settings.animations === 'off') {
      positionGhost();
    }
  }

  function onPointerUp(e) {
    const s = session;
    if (!s || e.pointerId !== s.pointerId) return;
    clearTimeout(holdTimer);
    if (!s.lifted) {
      finishSession();
      return;
    }
    suppressNextClick = true;
    const well = hitTestAt(e.clientX, e.clientY) || s.hoverWell;
    if (well && well.dataset.playlist && !s.dropDone) {
      dropIntoPlaylist(well);
    } else if (well && well.dataset.new) {
      const input = well.querySelector('.ct-well__input');
      if (input && input.value.trim()) commitNewPlaylist(input);
      else flyBack();
    } else {
      flyBack();
    }
  }

  function onPointerCancel() {
    const s = session;
    if (!s) return;
    clearTimeout(holdTimer);
    if (s.lifted) flyBack();
    else finishSession();
  }

  function disarm() {
    const s = session;
    if (!s) return;
    clearTimeout(holdTimer);
    window.removeEventListener('pointermove', onPointerMove, true);
    window.removeEventListener('pointerup', onPointerUp, true);
    window.removeEventListener('pointercancel', onPointerCancel, true);
    session = null;
  }

  function finishSession() {
    disarm();
    if (ui.dock) ui.dock.classList.remove('ct-show');
  }

  function dropIntoPlaylist(well) {
    const s = session;
    if (!s || s.dropDone) return;
    s.dropDone = true;
    const rect = well.getBoundingClientRect();
    const accent = well.style.getPropertyValue('--accent') || '#ff4d6d';

    flyGhostTo(rect.left + rect.width / 2, rect.top + rect.height / 2, 0.28);

    send({ action: 'save', video: s.video, playlistId: well.dataset.playlist }).then(resp => {
      if (!resp || !resp.ok) {
        toast('Could not save — try again', { error: true });
        return;
      }
      if (resp.existed) {
        well.classList.add('ct-well--dupe');
        setTimeout(() => well.classList.remove('ct-well--dupe'), 520);
        toast('Already in ' + resp.playlistName, {});
        return;
      }
      burst(rect.left + rect.width / 2, rect.top + rect.height / 2, accent);
      well.classList.add('ct-well--pulse');
      setTimeout(() => well.classList.remove('ct-well--pulse'), 720);
      bumpWellCount(well, +1);
      state.lastSave = { playlistId: resp.playlistId, videoId: s.video.videoId };
      toast('Saved to ' + resp.playlistName, { undo: !!state.settings.toastUndo });
    });

    endDragVisuals();
  }

  function dropToId(playlistId) {
    const s = session;
    if (!s || s.dropDone) return;
    s.dropDone = true;
    send({ action: 'save', video: s.video, playlistId }).then(resp => {
      if (resp && resp.ok && !resp.existed) {
        state.lastSave = { playlistId, videoId: s.video.videoId };
        toast('Saved to ' + (resp.playlistName || 'playlist'), { undo: !!state.settings.toastUndo });
      }
    });
    endDragVisuals();
  }

  function bumpWellCount(well, delta) {
    const count = well.querySelector('.ct-well__count');
    if (!count) return;
    count.textContent = Math.max(0, (parseInt(count.textContent, 10) || 0) + delta);
    count.classList.remove('ct-pop');
    void count.offsetWidth; // restart the animation
    count.classList.add('ct-pop');
  }

  function flyBack() {
    const s = session;
    if (!s) return;
    s.dropDone = true;
    const target = s.originRect
      ? { x: s.originRect.left + s.originRect.width / 2, y: s.originRect.top + s.originRect.height / 2 }
      : { x: s.x, y: s.y };
    flyGhostTo(target.x, target.y, 0.85, () => {
      if (s.ghost) s.ghost.remove();
    });
    endDragVisuals();
  }

  function endDragVisuals() {
    const s = session;
    if (!s) return;
    if (s.card) s.card.classList.remove('ct-source-lifted');
    document.documentElement.classList.remove('ct-drag-active');
    muteIframes(false);
    closeDockSoon();
    disarm();
  }

  function muteIframes(mute) {
    for (const frame of document.querySelectorAll('iframe')) {
      if (mute) {
        if (!frame.dataset.ctPe) frame.dataset.ctPe = frame.style.pointerEvents || 'reset';
        frame.style.pointerEvents = 'none';
      } else {
        frame.style.pointerEvents = frame.dataset.ctPe === 'reset' ? '' : (frame.dataset.ctPe || '');
        delete frame.dataset.ctPe;
      }
    }
  }

  /* ------------------------------------------------------ input plumbing */

  document.addEventListener('click', e => {
    if (suppressNextClick) {
      e.preventDefault();
      e.stopPropagation();
      suppressNextClick = false;
    }
  }, true);

  // Native link dragging would swallow our pointer stream, so it is cancelled
  // for as long as a press is pending on a card.
  document.addEventListener('dragstart', e => {
    if (session && !session.fromPlayer) e.preventDefault();
  }, true);

  window.addEventListener('pointerdown', onPointerDown, true);

  function onPointerDown(e) {
    if (e.button !== 0 || session) return;
    if (e.target.closest && e.target.closest('.ct-dock, .ct-ghost, .ct-toast, .ct-chip, .ct-burst')) return;

    const blocker = e.target.closest && e.target.closest(BLOCKING_SELECTORS);
    const card = e.target.closest && e.target.closest(CARD_SELECTORS);

    if (!card && state.settings.playerDrag) {
      const player = e.target.closest && e.target.closest('#movie_player, ytd-player');
      if (player && !blocker) {
        const video = currentWatchVideo();
        if (video) armDrag(e, null, video, PLAYER_HOLD_MS);
      }
      return;
    }
    if (!card || blocker) return;
    const video = extractVideo(card);
    if (!video) return;
    armDrag(e, card, video, HOLD_MS);
  }

  /* ------------------------------------------------------------ the chip */

  document.addEventListener('mouseover', e => {
    const card = e.target.closest && e.target.closest(CARD_SELECTORS);
    if (card !== chipCard) {
      clearChip();
      if (card && state.settings.hoverChip) {
        chipCard = card;
        chipTimer = setTimeout(showChip, 240);
      }
    }
  });

  document.addEventListener('mouseout', e => {
    const card = e.target.closest && e.target.closest(CARD_SELECTORS);
    if (chipCard && (!card || card !== chipCard)) clearChip();
  });

  function showChip() {
    if (!chipCard || !document.contains(chipCard)) return;
    let chip = chipCard.querySelector('.ct-chip');
    if (!chip) {
      chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'ct-chip';
      chip.title = 'Save to Watch Later';
      chip.setAttribute('aria-label', 'Save to Watch Later');
      chipCard.appendChild(chip);
    }
    chipCard.classList.add('ct-chip-host');
    chip.classList.add('ct-chip--show');
  }

  function clearChip() {
    clearTimeout(chipTimer);
    if (chipCard) {
      const chip = chipCard.querySelector('.ct-chip');
      if (chip) chip.classList.remove('ct-chip--show');
      chipCard = null;
    }
  }

  document.addEventListener('click', e => {
    const chip = e.target.closest && e.target.closest('.ct-chip');
    if (!chip) return;
    e.preventDefault();
    e.stopPropagation();
    const card = chip.closest(CARD_SELECTORS);
    const video = extractVideo(card);
    if (!video) return;
    saveInstant(video, chip);
  }, true);

  async function saveInstant(video, chip) {
    const resp = await send({ action: 'save', video, playlistId: 'WL' });
    if (!resp || !resp.ok) {
      toast('Could not save — try again', { error: true });
      return;
    }
    if (resp.existed) {
      toast('Already in ' + resp.playlistName, {});
      return;
    }
    const rect = chip.getBoundingClientRect();
    burst(rect.left + rect.width / 2, rect.top + rect.height / 2, '#ff4d6d');
    state.lastSave = { playlistId: 'WL', videoId: video.videoId };
    toast('Saved to ' + resp.playlistName, { undo: !!state.settings.toastUndo });
    chip.classList.add('ct-chip--done');
    setTimeout(() => chip.classList.remove('ct-chip--done'), 900);
  }

  /* --------------------------------------------- context-menu handoff */

  chrome.runtime.onMessage.addListener((msg, sender, respond) => {
    if (msg.action === 'lookup') {
      const anchor = document.querySelector('a[href*="v=' + (msg.videoId || '') + '"]');
      const video = extractVideo(anchor && anchor.closest(CARD_SELECTORS)) ||
        (currentWatchVideo() || {});
      const ok = video && video.videoId === msg.videoId;
      respond({
        ok: true,
        video: ok ? video : {
          videoId: msg.videoId,
          title: 'YouTube video',
          channel: '',
          duration: '',
          thumb: thumbFor(msg.videoId),
          url: 'https://www.youtube.com/watch?v=' + msg.videoId,
          addedAt: Date.now()
        }
      });
      return false;
    }
    return undefined;
  });

  /* ------------------------------------------------------------ settings */

  function applyAnimPreference() {
    const off = state.settings.animations === 'off' ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    document.documentElement.classList.toggle('ct-anim-off', !!off);
  }

  send({ action: 'getState' }).then(resp => {
    if (resp && resp.ok) {
      Object.assign(state.settings, resp.settings || {});
      playlistsCache = resp.playlists || [];
      applyAnimPreference();
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.ct_settings) {
      Object.assign(state.settings, changes.ct_settings.newValue || {});
      applyAnimPreference();
    }
    if (changes.ct_playlists) {
      send({ action: 'getState' }).then(resp => {
        if (resp && resp.ok) playlistsCache = resp.playlists || [];
      });
    }
  });
})();
