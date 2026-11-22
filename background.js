'use strict';

// Single writer for storage: content scripts, popup and dashboard all go
// through messages so there is exactly one code path mutating data.

const WL_ID = 'WL';
const PALETTE = ['#ff4d6d', '#ffb02e', '#2ec27e', '#3aa0ff', '#9b5cff', '#ff7ac3'];

const DEFAULT_SETTINGS = {
  hoverChip: true,
  playerDrag: true,
  dockSide: 'right',
  animations: 'full',
  toastUndo: true
};

chrome.runtime.onInstalled.addListener(async () => {
  await seedData();
  rebuildContextMenus();
  refreshBadge();
});

chrome.runtime.onStartup.addListener(async () => {
  await seedData();
  rebuildContextMenus();
  refreshBadge();
});

/* ---------------------------------------------------------------- data */

function newPlaylist(name, index) {
  return {
    id: 'p' + crypto.randomUUID().slice(0, 10),
    name,
    color: PALETTE[index % PALETTE.length],
    createdAt: Date.now(),
    lastUpdated: Date.now(),
    videos: []
  };
}

async function seedData() {
  const existing = await chrome.storage.local.get(['ct_playlists', 'ct_settings']);
  if (!existing.ct_playlists) {
    const wl = newPlaylist('Watch Later', 0);
    wl.id = WL_ID;
    wl.builtin = true;
    await chrome.storage.local.set({ ct_playlists: [wl] });
  }
  if (!existing.ct_settings) {
    await chrome.storage.local.set({ ct_settings: { ...DEFAULT_SETTINGS } });
  }
}

async function loadPlaylists() {
  const { ct_playlists } = await chrome.storage.local.get('ct_playlists');
  return ct_playlists || [];
}

async function savePlaylists(list) {
  await chrome.storage.local.set({ ct_playlists: list });
}

async function loadSettings() {
  const { ct_settings } = await chrome.storage.local.get('ct_settings');
  return { ...DEFAULT_SETTINGS, ...(ct_settings || {}) };
}

/* ----------------------------------------------------------------- ops */

async function opSave(video, playlistId) {
  if (!video || !video.videoId) return { ok: false, error: 'bad video' };
  const list = await loadPlaylists();
  let pl = list.find(p => p.id === playlistId) || list.find(p => p.id === WL_ID);
  if (!pl) {
    pl = newPlaylist('Watch Later', 0);
    pl.id = WL_ID;
    pl.builtin = true;
    list.push(pl);
  }
  const existed = pl.videos.some(v => v.videoId === video.videoId);
  if (!existed) {
    pl.videos.unshift({ ...video, addedAt: Date.now() });
    pl.lastUpdated = Date.now();
    await savePlaylists(list);
  }
  return { ok: true, existed, playlistId: pl.id, playlistName: pl.name };
}

async function opCreatePlaylist(name) {
  name = String(name || '').trim().slice(0, 60);
  if (!name) return { ok: false, error: 'empty name' };
  const list = await loadPlaylists();
  const existing = list.find(p => p.name.toLowerCase() === name.toLowerCase());
  if (existing) return { ok: true, playlistId: existing.id, playlistName: existing.name, existed: true };
  const pl = newPlaylist(name, Math.max(0, list.length - 1));
  list.push(pl);
  await savePlaylists(list);
  return { ok: true, playlistId: pl.id, playlistName: pl.name };
}

async function opRemoveVideo(playlistId, videoId) {
  const list = await loadPlaylists();
  const pl = list.find(p => p.id === playlistId);
  if (!pl) return { ok: false, error: 'no such playlist' };
  const before = pl.videos.length;
  pl.videos = pl.videos.filter(v => v.videoId !== videoId);
  if (pl.videos.length === before) return { ok: false, error: 'video not in playlist' };
  pl.lastUpdated = Date.now();
  await savePlaylists(list);
  return { ok: true };
}

async function opDeletePlaylist(id) {
  const list = await loadPlaylists();
  const pl = list.find(p => p.id === id);
  if (!pl) return { ok: false, error: 'no such playlist' };
  if (pl.builtin) return { ok: false, error: 'Watch Later is built in' };
  await savePlaylists(list.filter(p => p.id !== id));
  return { ok: true };
}

async function opRenamePlaylist(id, name) {
  name = String(name || '').trim().slice(0, 60);
  const list = await loadPlaylists();
  const pl = list.find(p => p.id === id);
  if (!pl) return { ok: false, error: 'no such playlist' };
  if (pl.builtin) return { ok: false, error: 'Watch Later is built in' };
  if (!name) return { ok: false, error: 'empty name' };
  pl.name = name;
  await savePlaylists(list);
  return { ok: true };
}

async function opReorderVideo(playlistId, from, to) {
  const list = await loadPlaylists();
  const pl = list.find(p => p.id === playlistId);
  if (!pl) return { ok: false, error: 'no such playlist' };
  const max = pl.videos.length - 1;
  from = Math.max(0, Math.min(max, from));
  to = Math.max(0, Math.min(max, to));
  if (from === to) return { ok: true };
  const [moved] = pl.videos.splice(from, 1);
  pl.videos.splice(to, 0, moved);
  await savePlaylists(list);
  return { ok: true };
}

async function opSetSetting(key, value) {
  if (!(key in DEFAULT_SETTINGS)) return { ok: false, error: 'unknown setting' };
  const settings = await loadSettings();
  settings[key] = value;
  await chrome.storage.local.set({ ct_settings: settings });
  return { ok: true, settings };
}

async function opImport(data) {
  if (!data || !Array.isArray(data.playlists)) return { ok: false, error: 'malformed file' };
  const list = await loadPlaylists();
  const now = Date.now();
  for (const incoming of data.playlists) {
    if (!incoming || typeof incoming.name !== 'string' || !Array.isArray(incoming.videos)) continue;
    const isWl = incoming.id === WL_ID || /watch later/i.test(incoming.name);
    const target = isWl ? list.find(p => p.id === WL_ID) : list.find(p => p.name.toLowerCase() === incoming.name.toLowerCase());
    if (target) {
      const seen = new Set(target.videos.map(v => v.videoId));
      for (const v of incoming.videos) {
        if (v && v.videoId && !seen.has(v.videoId)) {
          target.videos.push({ ...v, addedAt: v.addedAt || now });
          seen.add(v.videoId);
        }
      }
    } else {
      const pl = newPlaylist(incoming.name.slice(0, 60), list.length);
      pl.videos = incoming.videos
        .filter(v => v && v.videoId)
        .map(v => ({ ...v, addedAt: v.addedAt || now }));
      list.push(pl);
    }
  }
  await savePlaylists(list);
  return { ok: true };
}

async function opReset() {
  const wl = newPlaylist('Watch Later', 0);
  wl.id = WL_ID;
  wl.builtin = true;
  await chrome.storage.local.set({ ct_playlists: [wl], ct_settings: { ...DEFAULT_SETTINGS } });
  return { ok: true };
}

/* ------------------------------------------------------------- messages */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.action) {
        case 'getState':
          return sendResponse({ ok: true, playlists: await loadPlaylists(), settings: await loadSettings() });
        case 'save':
          return sendResponse(await opSave(msg.video, msg.playlistId));
        case 'createPlaylist':
          return sendResponse(await opCreatePlaylist(msg.name));
        case 'removeVideo':
          return sendResponse(await opRemoveVideo(msg.playlistId, msg.videoId));
        case 'deletePlaylist':
          return sendResponse(await opDeletePlaylist(msg.id));
        case 'renamePlaylist':
          return sendResponse(await opRenamePlaylist(msg.id, msg.name));
        case 'reorderVideo':
          return sendResponse(await opReorderVideo(msg.playlistId, msg.from, msg.to));
        case 'setSetting':
          return sendResponse(await opSetSetting(msg.key, msg.value));
        case 'import':
          return sendResponse(await opImport(msg.data));
        case 'reset':
          return sendResponse(await opReset());
        default:
          return sendResponse({ ok: false, error: 'unknown action' });
      }
    } catch (err) {
      return sendResponse({ ok: false, error: String(err && err.message || err) });
    }
  })();
  return true;
});

/* -------------------------------------------------------- context menus */

const MENU_CONTEXTS = ['link', 'image', 'video'];

function truncate(text, n) {
  return text.length > n ? text.slice(0, n - 1) + '…' : text;
}

async function rebuildContextMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'ct-root', title: 'CineTray', contexts: MENU_CONTEXTS });
    chrome.contextMenus.create({ id: 'ct-wl', parentId: 'ct-root', title: 'Save to Watch Later', contexts: MENU_CONTEXTS });
    loadPlaylists().then(list => {
      const customs = list.filter(p => !p.builtin).slice(0, 8);
      if (customs.length) {
        chrome.contextMenus.create({ id: 'ct-sep', parentId: 'ct-root', type: 'separator', contexts: MENU_CONTEXTS });
      }
      for (const p of customs) {
        chrome.contextMenus.create({ id: 'pl:' + p.id, parentId: 'ct-root', title: 'Save to ' + truncate(p.name, 24), contexts: MENU_CONTEXTS });
      }
    });
  });
}

function parseWatchId(raw) {
  if (!raw) return null;
  let m = raw.match(/[?&]v=([\w-]{11})/);
  if (m) return m[1];
  m = raw.match(/youtu\.be\/([\w-]{11})/);
  if (m) return m[1];
  m = raw.match(/\/shorts\/([\w-]{11})/);
  return m ? m[1] : null;
}

function thumbUrl(id) {
  return 'https://i.ytimg.com/vi/' + id + '/mqdefault.jpg';
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const playlistId = info.menuItemId === 'ct-wl' ? WL_ID : String(info.menuItemId).slice(3);
  const raw = info.linkUrl || info.srcUrl || info.pageUrl || '';
  const videoId = parseWatchId(raw) || parseWatchId(info.pageUrl);
  if (!videoId) return;

  // Prefer the data the page already knows (real title, channel).
  let video = null;
  if (tab && tab.id >= 0) {
    try {
      const resp = await chrome.tabs.sendMessage(tab.id, { action: 'lookup', videoId });
      if (resp && resp.ok && resp.video) video = resp.video;
    } catch (err) { /* no content script on this tab */ }
  }
  if (!video) {
    video = {
      videoId,
      title: 'YouTube video',
      channel: '',
      duration: '',
      thumb: thumbUrl(videoId),
      url: 'https://www.youtube.com/watch?v=' + videoId,
      addedAt: Date.now()
    };
  }
  await opSave(video, playlistId);
});

/* ---------------------------------------------------------- badge, sync */

let menuTimer = 0;

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.ct_playlists) {
    refreshBadge();
    clearTimeout(menuTimer);
    menuTimer = setTimeout(rebuildContextMenus, 800);
  }
});

async function refreshBadge() {
  const list = await loadPlaylists();
  const total = list.reduce((n, p) => n + p.videos.length, 0);
  await chrome.action.setBadgeBackgroundColor({ color: '#ff4d6d' });
  await chrome.action.setBadgeText({ text: total > 0 ? String(total) : '' });
}
