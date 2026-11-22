'use strict';

const listEl = document.getElementById('pp-list');
const emptyEl = document.getElementById('pp-empty');
const statsEl = document.getElementById('pp-stats');
const newInput = document.getElementById('pp-new-name');
const newAdd = document.getElementById('pp-new-add');
const chipToggle = document.getElementById('pp-chip');
const holdToggle = document.getElementById('pp-hold');
const openBtn = document.getElementById('pp-open');

let settings = {};

async function send(msg) {
  try {
    return await chrome.runtime.sendMessage(msg);
  } catch (err) {
    return null;
  }
}

function dashboardUrl(playlistId) {
  const base = chrome.runtime.getURL('dashboard/dashboard.html');
  return playlistId ? base + '?playlist=' + encodeURIComponent(playlistId) : base;
}

function render(playlists) {
  const customs = playlists.filter(p => !p.builtin);
  const wl = playlists.find(p => p.builtin);
  const total = playlists.reduce((n, p) => n + p.videos.length, 0);
  statsEl.textContent = total + ' video' + (total === 1 ? '' : 's') + ' · ' +
    ((customs.length || 0) + 1) + ' playlist' + (customs.length ? 's' : '');

  listEl.textContent = '';
  const rows = wl ? [wl, ...customs] : customs;
  for (const p of rows) {
    const li = document.createElement('li');
    li.className = 'pp-item';
    li.style.animationDelay = (rows.indexOf(p) * 30) + 'ms';
    li.title = 'Open in dashboard';

    const dot = document.createElement('span');
    dot.className = 'pp-dot';
    dot.style.background = p.color || '#ff4d6d';

    const name = document.createElement('span');
    name.className = 'pp-name';
    name.textContent = p.name;

    const count = document.createElement('span');
    count.className = 'pp-count';
    count.textContent = p.videos.length;

    li.append(dot, name, count);
    li.addEventListener('click', () => chrome.tabs.create({ url: dashboardUrl(p.id) }));
    listEl.appendChild(li);
  }
  emptyEl.hidden = rows.length > 0;
}

async function refresh() {
  const resp = await send({ action: 'getState' });
  if (resp && resp.ok) {
    render(resp.playlists || []);
    settings = resp.settings || {};
    chipToggle.checked = !!settings.hoverChip;
    holdToggle.checked = !!settings.playerDrag;
  }
}

newAdd.addEventListener('click', async () => {
  const name = newInput.value.trim();
  if (!name) {
    newInput.focus();
    return;
  }
  const resp = await send({ action: 'createPlaylist', name });
  if (resp && resp.ok) {
    newInput.value = '';
    refresh();
  }
});

newInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') newAdd.click();
});

chipToggle.addEventListener('change', () => send({ action: 'setSetting', key: 'hoverChip', value: chipToggle.checked }));
holdToggle.addEventListener('change', () => send({ action: 'setSetting', key: 'playerDrag', value: holdToggle.checked }));

openBtn.addEventListener('click', () => chrome.tabs.create({ url: dashboardUrl() }));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.ct_playlists) refresh();
});

refresh();
