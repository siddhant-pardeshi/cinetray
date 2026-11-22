'use strict';

const els = {
  nav: document.getElementById('db-nav'),
  stats: document.getElementById('db-stats'),
  search: document.getElementById('db-search'),
  newBtn: document.getElementById('db-new'),
  exportBtn: document.getElementById('db-export'),
  importBtn: document.getElementById('db-import'),
  fileInput: document.getElementById('db-file'),
  settingsBtn: document.getElementById('db-settings-btn'),
  views: {
    welcome: document.getElementById('view-welcome'),
    playlist: document.getElementById('view-playlist'),
    search: document.getElementById('view-search'),
    settings: document.getElementById('view-settings')
  },
  welcomeNew: document.getElementById('db-welcome-new'),
  plColor: document.getElementById('db-pl-color'),
  plName: document.getElementById('db-pl-name'),
  plCount: document.getElementById('db-pl-count'),
  openAll: document.getElementById('db-open-all'),
  deleteBtn: document.getElementById('db-delete'),
  rows: document.getElementById('db-rows'),
  rowsEmpty: document.getElementById('db-rows-empty'),
  searchTitle: document.getElementById('db-search-title'),
  searchCount: document.getElementById('db-search-count'),
  searchRows: document.getElementById('db-search-rows'),
  searchEmpty: document.getElementById('db-search-empty'),
  setChip: document.getElementById('db-set-chip'),
  setHold: document.getElementById('db-set-hold'),
  setUndo: document.getElementById('db-set-undo'),
  setSide: document.getElementById('db-set-side'),
  setAnim: document.getElementById('db-set-anim'),
  resetBtn: document.getElementById('db-reset')
};

let playlists = [];
let settings = {};
let current = { type: 'welcome' };

/* ------------------------------------------------------------ plumbing */

async function send(msg) {
  try {
    return await chrome.runtime.sendMessage(msg);
  } catch (err) {
    return null;
  }
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function formatDate(ts) {
  try {
    return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  } catch (err) {
    return '';
  }
}

function armConfirm(button, armedLabel, action) {
  if (button.dataset.armed) {
    delete button.dataset.armed;
    button.textContent = button.dataset.label;
    action();
    return;
  }
  button.dataset.label = button.textContent;
  button.dataset.armed = '1';
  button.textContent = armedLabel;
  setTimeout(() => {
    if (button.dataset.armed) {
      delete button.dataset.armed;
      button.textContent = button.dataset.label;
    }
  }, 2600);
}

function showView(type) {
  current.type = type;
  for (const key of Object.keys(els.views)) {
    els.views[key].hidden = key !== type;
  }
  for (const item of els.nav.children) {
    const id = item.dataset.id;
    item.classList.toggle('is-active', type === 'playlist' && id === current.playlistId);
  }
}

function openPlaylist(id) {
  const pl = playlists.find(p => p.id === id);
  if (!pl) return showView('welcome');
  current.playlistId = id;
  history.replaceState(null, '', '?playlist=' + encodeURIComponent(id));
  renderPlaylist(pl);
  showView('playlist');
}

function openSettings() {
  history.replaceState(null, '', '?view=settings');
  syncSettingsUi();
  showView('settings');
}

function openWelcome() {
  history.replaceState(null, '', location.pathname);
  showView('welcome');
}

/* --------------------------------------------------------------- stats */

async function renderStats() {
  const total = playlists.reduce((n, p) => n + p.videos.length, 0);
  let bytes = '';
  try {
    const b = await chrome.storage.local.getBytesInUse(null);
    bytes = b > 10240 ? Math.round(b / 1024) + ' KB' : b + ' B';
  } catch (err) { /* optional */ }
  els.stats.innerHTML =
    '<div class="db-stat"><b>' + total + '</b><span>videos</span></div>' +
    '<div class="db-stat"><b>' + playlists.length + '</b><span>playlists</span></div>' +
    '<div class="db-stat"><b>' + escapeHtml(bytes || '–') + '</b><span>stored</span></div>';
}

/* ----------------------------------------------------------------- nav */

function renderNav() {
  els.nav.textContent = '';
  playlists.forEach((p, i) => {
    const item = document.createElement('div');
    item.className = 'db-nav-item';
    item.dataset.id = p.id;
    item.style.animationDelay = (i * 26) + 'ms';
    item.style.setProperty('--nav-color', p.color || '#ff4d6d');

    const dot = document.createElement('span');
    dot.className = 'db-nav-dot';
    dot.style.background = p.color || '#ff4d6d';

    const name = document.createElement('span');
    name.className = 'db-nav-name';
    name.textContent = p.name;

    const count = document.createElement('span');
    count.className = 'db-nav-count';
    count.textContent = p.videos.length;

    item.append(dot, name, count);
    item.addEventListener('click', () => openPlaylist(p.id));
    els.nav.appendChild(item);
  });
}

function renderAll() {
  renderNav();
  renderStats();
  if (current.type === 'playlist') {
    const pl = playlists.find(p => p.id === current.playlistId);
    if (pl) renderPlaylist(pl);
    else openWelcome();
  } else if (current.type === 'search') {
    runSearch(els.search.value);
  } else if (current.type === 'settings') {
    syncSettingsUi();
  }
}

/* ------------------------------------------------------------ playlist */

function renderPlaylist(pl) {
  els.plColor.style.background = pl.color || '#ff4d6d';
  els.plName.textContent = pl.name;
  els.plName.contentEditable = pl.builtin ? 'false' : 'true';
  const n = pl.videos.length;
  els.plCount.textContent = n + ' video' + (n === 1 ? '' : 's');
  els.deleteBtn.hidden = !!pl.builtin;

  els.rows.textContent = '';
  els.rowsEmpty.hidden = n > 0;

  pl.videos.forEach((v, i) => {
    els.rows.appendChild(buildRow(v, {
      index: i,
      playlistId: pl.id,
      delay: Math.min(i, 14) * 24,
      tag: null
    }));
  });
}

function buildRow(video, opts) {
  const li = document.createElement('li');
  li.className = 'db-row';
  li.style.animationDelay = (opts.delay || 0) + 'ms';
  li.title = 'Open on YouTube';
  if (opts.draggable !== false) li.draggable = true;
  li.dataset.index = opts.index;

  const thumb = document.createElement('div');
  thumb.className = 'db-row-thumb';
  const img = document.createElement('img');
  img.src = video.thumb || '';
  img.alt = '';
  img.loading = 'lazy';
  if (video.duration) {
    const d = document.createElement('span');
    d.textContent = video.duration;
    thumb.append(img, d);
  } else {
    thumb.append(img);
  }

  const text = document.createElement('div');
  text.className = 'db-row-text';
  const title = document.createElement('span');
  title.className = 'db-row-title';
  title.textContent = video.title || 'Untitled video';
  const meta = document.createElement('span');
  meta.className = 'db-row-meta';
  meta.textContent = [video.channel, formatDate(video.addedAt)].filter(Boolean).join(' · ');
  text.append(title, meta);

  if (opts.tag) {
    const tag = document.createElement('span');
    tag.className = 'db-tag';
    tag.textContent = opts.tag;
    tag.style.marginRight = '6px';
    meta.prepend(tag);
  }

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'db-row-remove';
  remove.textContent = '×';
  remove.title = 'Remove from playlist';
  remove.setAttribute('aria-label', 'Remove ' + (video.title || 'video'));

  li.append(thumb, text, remove);

  li.addEventListener('click', e => {
    if (e.target.closest('.db-row-remove')) return;
    chrome.tabs.create({ url: video.url || ('https://www.youtube.com/watch?v=' + video.videoId) });
  });

  remove.addEventListener('click', async e => {
    e.stopPropagation();
    await send({ action: 'removeVideo', playlistId: opts.playlistId, videoId: video.videoId });
    refresh();
  });

  attachReorder(li, opts.playlistId);
  return li;
}

function attachReorder(row, playlistId) {
  row.addEventListener('dragstart', e => {
    row.classList.add('is-dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(row.dataset.index));
  });
  row.addEventListener('dragend', () => row.classList.remove('is-dragging'));
  row.addEventListener('dragover', e => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    row.classList.add('is-drop-target');
  });
  row.addEventListener('dragleave', () => row.classList.remove('is-drop-target'));
  row.addEventListener('drop', async e => {
    e.preventDefault();
    row.classList.remove('is-drop-target');
    const from = parseInt(e.dataTransfer.getData('text/plain'), 10);
    const hovered = parseInt(row.dataset.index, 10);
    if (Number.isNaN(from) || Number.isNaN(hovered) || from === hovered) return;

    // Drop above or below the hovered row, then compensate for the item
    // that leaves its old slot as the list shifts.
    const after = (e.clientY - row.getBoundingClientRect().top) > row.getBoundingClientRect().height / 2;
    const slot = hovered + (after ? 1 : 0);
    const to = from < slot ? slot - 1 : slot;
    if (to === from) return;
    const resp = await send({ action: 'reorderVideo', playlistId, from, to });
    if (resp && resp.ok) refresh();
  });
}

els.plName.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    e.preventDefault();
    els.plName.blur();
  }
  if (e.key === 'Escape') {
    const pl = playlists.find(p => p.id === current.playlistId);
    els.plName.textContent = pl ? pl.name : '';
    els.plName.blur();
  }
});

els.plName.addEventListener('blur', async () => {
  const pl = playlists.find(p => p.id === current.playlistId);
  if (!pl) return;
  const name = els.plName.textContent.replace(/\s+/g, ' ').trim().slice(0, 60);
  if (!name || name === pl.name) {
    els.plName.textContent = pl.name;
    return;
  }
  const resp = await send({ action: 'renamePlaylist', id: pl.id, name });
  if (resp && resp.ok) refresh();
  else els.plName.textContent = pl.name;
});

els.openAll.addEventListener('click', () => {
  armConfirm(els.openAll, 'Open them all?', () => {
    const pl = playlists.find(p => p.id === current.playlistId);
    if (!pl) return;
    pl.videos.slice(0, 12).forEach((v, i) => {
      setTimeout(() => chrome.tabs.create({ url: v.url }), i * 220);
    });
  });
});

els.deleteBtn.addEventListener('click', () => {
  const pl = playlists.find(p => p.id === current.playlistId);
  if (!pl || pl.builtin) return;
  armConfirm(els.deleteBtn, 'Delete "' + pl.name + '"?', async () => {
    await send({ action: 'deletePlaylist', id: pl.id });
    openWelcome();
    refresh();
  });
});

/* -------------------------------------------------------------- search */

els.search.addEventListener('input', () => {
  const q = els.search.value.trim();
  if (!q) {
    if (current.type === 'search') openWelcome();
    return;
  }
  runSearch(q);
});

function runSearch(q) {
  const needle = q.toLowerCase();
  const matches = [];
  for (const p of playlists) {
    for (const v of p.videos) {
      if ((v.title || '').toLowerCase().includes(needle) ||
          (v.channel || '').toLowerCase().includes(needle)) {
        matches.push({ video: v, playlist: p });
      }
    }
  }
  if (current.type !== 'search') {
    history.replaceState(null, '', '?view=search');
  }
  els.searchTitle.textContent = 'Results for "' + q + '"';
  els.searchCount.textContent = matches.length + ' match' + (matches.length === 1 ? '' : 'es');
  els.searchRows.textContent = '';
  els.searchEmpty.hidden = matches.length > 0;
  matches.slice(0, 60).forEach((m, i) => {
    els.searchRows.appendChild(buildRow(m.video, {
      index: i,
      playlistId: m.playlist.id,
      delay: Math.min(i, 14) * 24,
      tag: m.playlist.name,
      draggable: false
    }));
  });
  showView('search');
}

/* ------------------------------------------------------------ settings */

function syncSettingsUi() {
  els.setChip.checked = !!settings.hoverChip;
  els.setHold.checked = !!settings.playerDrag;
  els.setUndo.checked = !!settings.toastUndo;
  markSeg(els.setSide, settings.dockSide || 'right');
  markSeg(els.setAnim, settings.animations || 'full');
}

function markSeg(seg, value) {
  for (const b of seg.querySelectorAll('button')) {
    b.classList.toggle('is-on', b.dataset.v === value);
  }
}

async function setSetting(key, value) {
  const resp = await send({ action: 'setSetting', key, value });
  if (resp && resp.ok) settings = resp.settings;
}

els.setChip.addEventListener('change', () => setSetting('hoverChip', els.setChip.checked));
els.setHold.addEventListener('change', () => setSetting('playerDrag', els.setHold.checked));
els.setUndo.addEventListener('change', () => setSetting('toastUndo', els.setUndo.checked));

els.setSide.addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  setSetting('dockSide', b.dataset.v);
  settings.dockSide = b.dataset.v;
  markSeg(els.setSide, b.dataset.v);
});

els.setAnim.addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  setSetting('animations', b.dataset.v);
  settings.animations = b.dataset.v;
  markSeg(els.setAnim, b.dataset.v);
});

els.resetBtn.addEventListener('click', () => {
  armConfirm(els.resetBtn, 'Really delete everything?', async () => {
    await send({ action: 'reset' });
    await refresh();
    openWelcome();
  });
});

/* ------------------------------------------------------ create, io, nav */

els.newBtn.addEventListener('click', createFromPrompt);
els.welcomeNew.addEventListener('click', createFromPrompt);

async function createFromPrompt() {
  const name = prompt('Name the new playlist');
  if (!name) return;
  const resp = await send({ action: 'createPlaylist', name });
  if (resp && resp.ok) {
    await refresh();
    openPlaylist(resp.playlistId);
  }
}

els.exportBtn.addEventListener('click', () => {
  const blob = new Blob([JSON.stringify({ app: 'cinetray', version: 1, exportedAt: new Date().toISOString(), playlists }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'cinetray-export.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
});

els.importBtn.addEventListener('click', () => els.fileInput.click());

els.fileInput.addEventListener('change', async () => {
  const file = els.fileInput.files && els.fileInput.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const resp = await send({ action: 'import', data });
    if (resp && resp.ok) refresh();
    else alert('That file did not look like a CineTray export.');
  } catch (err) {
    alert('Could not read that file.');
  }
  els.fileInput.value = '';
});

els.settingsBtn.addEventListener('click', openSettings);

/* -------------------------------------------------------------- boot */

async function refresh() {
  const resp = await send({ action: 'getState' });
  if (resp && resp.ok) {
    playlists = resp.playlists || [];
    settings = resp.settings || {};
    renderAll();
  }
}

const params = new URLSearchParams(location.search);
if (params.get('view') === 'settings') {
  openSettings();
} else if (params.get('playlist')) {
  // resolved after data loads below
  current.pendingPlaylist = params.get('playlist');
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.ct_playlists || changes.ct_settings)) refresh();
});

document.addEventListener('keydown', e => {
  if (e.key === '/' && document.activeElement !== els.search) {
    e.preventDefault();
    els.search.focus();
  }
});

refresh().then(() => {
  if (current.pendingPlaylist) {
    const pl = playlists.find(p => p.id === current.pendingPlaylist);
    current.pendingPlaylist = null;
    if (pl) {
      openPlaylist(pl.id);
      return;
    }
  }
  if (current.type === 'welcome') openWelcome();
});
