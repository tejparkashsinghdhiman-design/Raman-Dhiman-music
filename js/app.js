// App bootstrap: data, live refresh, router, and the Listen / About / track-detail screens.
import { $, $$, esc, fmtTime, fmtBytes, fmtDate, timeAgo, ls, toast } from './util.js';
import { icon, hydrateIcons } from './icons.js';
import { coverFor, coverURL } from './cover.js';
import { player, toPlayable, TIERS, specText } from './player.js';
import * as offline from './offline.js';
import { mountString } from './viz.js';
import {
  sortTracks, latestTrack, bestTier, mergeItunes, fingerprint,
  appleSearchUrl, spotifySearchUrl, youtubeSearchUrl,
} from './merge.js';
import { initPlayerUI } from './playerui.js';
import { renderStats } from './stats.js';
import { renderSettings } from './settings.js';
import { mountDrafts } from './drafts.js';
import { toggleOffline, share } from './actions.js';

const state = {
  catalog: null, stats: null, artist: null, config: null,
  saved: new Set(), rawFp: '',
  ui: ls.get('listUi', { sort: 'newest', q: '', lossless: false }),
};

// ---------- data ----------
async function getJSON(name, fresh) {
  const url = `data/${name}.json`;
  try {
    const r = await fetch(fresh ? `${url}?t=${Date.now()}` : url, { cache: fresh ? 'no-store' : 'no-cache' });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

async function loadData(fresh = false) {
  const [catalog, stats, artist, config] = await Promise.all(['catalog', 'stats', 'artist', 'config'].map((n) => getJSON(n, fresh)));
  if (catalog) state.catalog = catalog;
  if (stats) state.stats = stats;
  if (artist) state.artist = artist;
  if (config) state.config = config;
  if (catalog) state.rawFp = fingerprint([catalog, stats]);
  return !!catalog;
}

const slimSong = (s) => ({
  trackName: s.trackName, collectionName: s.collectionName, trackTimeMillis: s.trackTimeMillis, releaseDate: s.releaseDate,
  previewUrl: s.previewUrl, trackViewUrl: s.trackViewUrl, artworkUrl100: s.artworkUrl100, primaryGenreName: s.primaryGenreName,
});

/** Ask Apple's public iTunes API for 30-second previews, artwork and new releases. Best-effort: failures are silent. */
async function liveEnrich() {
  if (!state.catalog) return false;
  const cfg = state.config || {};
  const cc = cfg.country || 'IN';
  const aid = (state.stats && state.stats.sources && state.stats.sources.apple && state.stats.sources.apple.artistId) || cfg.appleArtistId;
  const key = `itunes:${aid || 'name'}`;
  const cached = ls.get(key, null);
  let songs;
  if (cached && Date.now() - cached.t < 6 * 3600e3) songs = cached.songs;
  else {
    const url = aid
      ? `https://itunes.apple.com/lookup?id=${aid}&entity=song&limit=200&country=${cc}`
      : `https://itunes.apple.com/search?term=${encodeURIComponent(cfg.artistName || 'Raman Dhiman')}&entity=song&attribute=artistTerm&limit=100&country=${cc}`;
    const r = await fetch(url);
    if (!r.ok) return false;
    const j = await r.json();
    songs = (j.results || [])
      .filter((x) => x.wrapperType === 'track' && x.kind === 'song')
      .filter((x) => aid || /raman dhiman/i.test(x.artistName || ''))
      .map(slimSong);
    ls.set(key, { t: Date.now(), songs });
  }
  // New releases are only added when the Apple artist ID has been pinned and checked by the sync job,
  // so a different artist with the same name can never end up in the catalogue.
  const { changes } = mergeItunes(state.catalog, songs, { addNew: !!aid && cfg.addNewReleases !== false });
  return changes.length > 0;
}

async function refreshSaved() {
  state.saved = new Set((await offline.list()).map((i) => i.url));
}
const trackSaved = (t) => ['lossless', 'high', 'standard'].some((k) => {
  const s = t.audio && t.audio[k] && t.audio[k].src;
  return s && state.saved.has(new URL(s, location.href).href);
});

async function refreshAll({ manual = false } = {}) {
  const before = state.rawFp;
  const ok = await loadData(true);
  if (ok) { try { await liveEnrich(); } catch { /* offline or blocked: fine */ } }
  updateSyncStatus();
  const changed = ok && state.rawFp !== before;
  if (changed || manual) rerenderIfSafe();
  if (manual) toast(!ok ? 'Couldn’t reach the server. Showing what’s saved on this device.' : changed ? 'Updated with the latest data.' : 'Everything is already up to date.');
}

function updateSyncStatus() {
  const el = $('#syncStatus');
  if (!el) return;
  const at = state.stats && state.stats.updatedAt;
  const age = at ? Date.now() - Date.parse(at) : Infinity;
  const tone = age < 12 * 3600e3 ? 'ok' : age < 48 * 3600e3 ? 'warn' : 'off';
  el.innerHTML = `<i class="dot ${tone}"></i>Synced ${esc(at ? timeAgo(at) : 'never')}`;
}

// ---------- theme ----------
function applyTheme(mode) {
  ls.set('theme', mode);
  document.documentElement.dataset.theme = mode === 'dark' || mode === 'light' ? mode : 'auto';
  const dark = mode === 'dark' || (mode !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
  const meta = document.querySelector('meta[name=theme-color]');
  if (meta) meta.content = dark ? '#120C36' : '#F4F1FF';
  window.dispatchEvent(new Event('rd:theme'));
}

// ---------- helpers ----------
const findTrack = (id) => state.catalog && state.catalog.tracks.find((t) => t.id === id);
const hasAudio = (t) => Object.keys(toPlayable(t).sources).length > 0;
const countryCode = () => String((state.config && state.config.country) || 'IN').toLowerCase();

function linksFor(t) {
  const q = `${t.title} Raman Dhiman`;
  const l = t.links || {};
  return [
    { name: 'Spotify', url: l.spotify || spotifySearchUrl(q), exact: !!l.spotify },
    { name: 'Apple Music', url: l.apple || appleSearchUrl(q, countryCode()), exact: !!l.apple },
    { name: 'YouTube', url: l.youtube || youtubeSearchUrl(q), exact: !!l.youtube },
  ];
}

function chip(tier) {
  if (tier === 'lossless') return '<span class="chip q-lossless">Lossless</span>';
  if (tier === 'high') return '<span class="chip q-high">High</span>';
  if (tier === 'standard') return '<span class="chip q-standard">Data saver</span>';
  if (tier === 'preview') return '<span class="chip q-preview">30-second preview</span>';
  return '<span class="chip q-none">Streaming only</span>';
}

function metaLine(t) {
  const when = t.releaseDate ? fmtDate(t.releaseDate) : t.year || '';
  const others = (t.artists || []).filter((a) => a !== 'Raman Dhiman');
  return [t.type, when].filter(Boolean).join(', ') + (others.length ? `, with ${others.join(' and ')}` : '');
}

// ---------- playing ----------
function visibleTracks() {
  const { q, sort, lossless } = state.ui;
  let list = state.catalog.tracks;
  if (q) { const n = q.toLowerCase(); list = list.filter((t) => t.title.toLowerCase().includes(n) || (t.artists || []).join(' ').toLowerCase().includes(n)); }
  if (lossless) list = list.filter((t) => bestTier(t) === 'lossless');
  return sortTracks(list, sort);
}

function playTrack(id) {
  const t = findTrack(id);
  if (!t) return;
  if (!hasAudio(t)) { openTrack(id); toast(`“${t.title}” isn’t playable in this app yet. Choose where to listen.`); return; }
  if (player.current && player.current.item.id === id) { player.toggle(); return; }
  const list = visibleTracks().filter(hasAudio).map(toPlayable);
  if (!list.some((p) => p.id === id)) list.push(toPlayable(t));
  player.playList(list, id);
}

function queueTrack(id) {
  const t = findTrack(id);
  if (!t) return;
  if (!hasAudio(t)) { toast(`“${t.title}” has no audio in this app yet.`); return; }
  player.enqueue(toPlayable(t));
}

async function saveTrack(id, btn) {
  const t = findTrack(id);
  if (!t) return;
  if (btn) { btn.disabled = true; btn.classList.add('busy'); }
  await toggleOffline(toPlayable(t));
  if (btn && btn.isConnected) { btn.disabled = false; btn.classList.remove('busy'); }
}

// ---------- Listen ----------
let heroString = null;

function home(main) {
  if (!state.catalog) return errorView(main);
  const a = state.artist || {};
  const latest = latestTrack(state.catalog.tracks);
  main.innerHTML = `
  <section class="hero" aria-labelledby="heroName">
    <h1 id="heroName" class="hero-name">Raman<br>Dhiman</h1>
    <p class="hero-roles">${esc(a.tagline || '')}</p>
    <canvas id="heroString" class="hero-string" role="img" aria-label="A vibrating string. Move your pointer across it to pluck it."></canvas>
    ${latest ? latestPanel(latest) : ''}
  </section>
  <section class="disco" aria-labelledby="discoH">
    <div class="disco-head">
      <h2 id="discoH">Releases</h2>
      <div class="disco-tools">
        <label class="vh" for="q">Search releases</label>
        <input id="q" type="search" placeholder="Search releases" value="${esc(state.ui.q)}" autocomplete="off">
        <label class="vh" for="sort">Sort releases</label>
        <select id="sort">
          <option value="newest"${state.ui.sort === 'newest' ? ' selected' : ''}>Newest first</option>
          <option value="oldest"${state.ui.sort === 'oldest' ? ' selected' : ''}>Oldest first</option>
          <option value="title"${state.ui.sort === 'title' ? ' selected' : ''}>A to Z</option>
        </select>
        <label class="check"><input type="checkbox" id="onlyLossless"${state.ui.lossless ? ' checked' : ''}> Lossless only</label>
      </div>
    </div>
    <div id="trackList"></div>
  </section>`;
  hydrateIcons(main);
  heroString = mountString($('#heroString', main), { wave: () => player.getWave(), playing: () => !!player.current && !player.paused });

  const upd = () => { ls.set('listUi', state.ui); renderList(); };
  $('#q', main).addEventListener('input', (e) => { state.ui.q = e.target.value.trim(); upd(); });
  $('#sort', main).addEventListener('change', (e) => { state.ui.sort = e.target.value; upd(); });
  $('#onlyLossless', main).addEventListener('change', (e) => { state.ui.lossless = e.target.checked; upd(); });
  renderList();
  return () => { if (heroString) { heroString.destroy(); heroString = null; } };
}

function latestPanel(t) {
  const playable = hasAudio(t);
  return `<aside class="latest" aria-label="Newest release">
    <img class="cover" src="${esc(coverFor(t))}" alt="" width="96" height="96">
    <div class="latest-text">
      <h2>${esc(t.title)}</h2>
      <p>Newest release, ${esc(t.releaseDate ? fmtDate(t.releaseDate) : t.year)}</p>
      <div class="btnrow">
        ${playable
          ? `<button class="btn primary" type="button" data-act="play" data-id="${esc(t.id)}">${icon('play')} Play</button>`
          : `<button class="btn primary" type="button" data-act="open" data-id="${esc(t.id)}">Where to listen</button>`}
        ${chip(bestTier(t))}
      </div>
    </div>
  </aside>`;
}

function rowHTML(t) {
  const best = bestTier(t);
  const cur = player.current && player.current.item.id === t.id;
  const saved = trackSaved(t);
  const full = best && best !== 'preview';
  return `<li class="row${cur ? ' is-current' : ''}" data-id="${esc(t.id)}">
    <button class="row-art" type="button" data-act="play" data-id="${esc(t.id)}" aria-label="Play ${esc(t.title)}">
      <img src="${esc(coverFor(t))}" alt="" width="56" height="56" loading="lazy">
      <span class="row-playicon">${icon('play')}</span>
      <span class="eq" aria-hidden="true"><i></i><i></i><i></i></span>
    </button>
    <div class="row-main">
      <h4><button class="linklike" type="button" data-act="open" data-id="${esc(t.id)}">${esc(t.title)}</button></h4>
      <p>${esc(metaLine(t))}</p>
    </div>
    <div class="row-q">${chip(best)}</div>
    <span class="row-dur">${t.durationSec ? fmtTime(t.durationSec) : ''}</span>
    <div class="row-actions">
      <button class="icon-btn" type="button" data-act="queue" data-id="${esc(t.id)}" aria-label="Add ${esc(t.title)} to queue"${best ? '' : ' disabled'}>${icon('queue')}</button>
      <button class="icon-btn save${saved ? ' on' : ''}" type="button" data-act="save" data-id="${esc(t.id)}" aria-pressed="${saved}" aria-label="${saved ? 'Remove' : 'Save'} ${esc(t.title)} ${saved ? 'from' : 'for'} offline"${full ? '' : ' disabled'}>${icon(saved ? 'check' : 'down')}</button>
    </div>
  </li>`;
}

function renderList() {
  const box = $('#trackList');
  if (!box || !state.catalog) return;
  const list = visibleTracks();
  if (!list.length) {
    box.innerHTML = state.ui.lossless && !state.ui.q
      ? '<p class="empty">No releases are in lossless yet. Clear the filter to see everything.</p>'
      : `<p class="empty">No releases match “${esc(state.ui.q)}”.</p>`;
    return;
  }
  const groups = [];
  if (state.ui.sort === 'title') groups.push([null, list]);
  else {
    const m = new Map();
    for (const t of list) { const y = t.year || 'Earlier'; if (!m.has(y)) m.set(y, []); m.get(y).push(t); }
    groups.push(...m);
  }
  box.innerHTML = groups.map(([year, items]) =>
    `${year ? `<h3 class="year">${esc(year)}</h3>` : ''}<ol class="rows">${items.map(rowHTML).join('')}</ol>`).join('');
}

function markCurrent() {
  const id = player.current && player.current.item.id;
  $$('.row').forEach((li) => {
    const on = li.dataset.id === id;
    li.classList.toggle('is-current', on);
    if (on) li.setAttribute('aria-current', 'true'); else li.removeAttribute('aria-current');
  });
}

// ---------- track details ----------
let dlgTrackId = null;

function openTrack(id) {
  const t = findTrack(id);
  if (!t) return;
  dlgTrackId = id;
  paintTrackDialog();
  const dlg = $('#trackDlg');
  if (!dlg.open) dlg.showModal();
}

function paintTrackDialog() {
  const t = findTrack(dlgTrackId);
  const dlg = $('#trackDlg');
  if (!t) return;
  const p = toPlayable(t);
  const playable = Object.keys(p.sources).length > 0;
  const pick = playable ? player.resolve(p) : null;
  const canSave = !!pick && pick.tier !== 'preview';
  const saved = trackSaved(t);
  const rows = ['lossless', 'high', 'standard', 'preview'].map((k) => {
    const s = t.audio && t.audio[k];
    const ok = !!(s && s.src);
    return `<tr><th scope="row">${TIERS[k].label}</th><td>${ok ? esc(specText(k, s) || '30 seconds') : '<span class="dim">Not uploaded yet</span>'}</td><td class="r">${ok && s.bytes ? fmtBytes(s.bytes) : ''}</td></tr>`;
  }).join('');
  const links = linksFor(t).map((l) => `<li><a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">${icon('ext')} ${l.exact ? 'Open on' : 'Search on'} ${l.name}</a></li>`).join('');
  const credits = (t.credits || []).map((c) => `<li><b>${esc(c.name)}</b><small>${esc(c.role || '')}</small></li>`).join('');
  dlg.innerHTML = `<div class="td">
    <div class="td-top"><button class="icon-btn" type="button" data-act="close" aria-label="Close">${icon('x')}</button></div>
    <div class="td-head">
      <img class="cover" src="${esc(coverFor(t))}" alt="" width="120" height="120">
      <div><h2>${esc(t.title)}</h2><p>${esc(metaLine(t))}</p>${t.genre ? `<p class="dim">${esc(t.genre)}</p>` : ''}${chip(bestTier(t))}</div>
    </div>
    <div class="btnrow">
      ${playable ? `<button class="btn primary" type="button" data-act="dplay">${icon('play')} Play</button>` : ''}
      ${canSave ? `<button class="btn" type="button" data-act="dsave" aria-pressed="${saved}">${icon(saved ? 'check' : 'down')} ${saved ? 'Saved offline' : 'Save offline'}</button>` : ''}
      <button class="btn" type="button" data-act="dshare">${icon('share')} Share</button>
    </div>
    <h3>Sound quality in this app</h3>
    <table class="tbl small"><tbody>${rows}</tbody></table>
    ${playable ? '' : '<p class="hint">Full-length audio for this release hasn’t been uploaded to the app yet. You can still listen on the services below.</p>'}
    <h3>Listen elsewhere</h3>
    <ul class="links">${links}</ul>
    ${credits ? `<h3>Credits</h3><ul class="credits">${credits}</ul>` : ''}
    ${t.note ? `<h3>Good to know</h3><p>${esc(t.note)}</p>` : ''}
    ${t.lyrics ? `<h3>Lyrics</h3><pre class="lyrics">${esc(t.lyrics)}</pre>` : ''}
  </div>`;
}

function wireTrackDialog() {
  const dlg = $('#trackDlg');
  dlg.addEventListener('click', async (e) => {
    if (e.target === dlg) { dlg.close(); return; }
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const t = findTrack(dlgTrackId);
    if (b.dataset.act === 'close') dlg.close();
    else if (b.dataset.act === 'dplay' && t) { dlg.close(); playTrack(t.id); }
    else if (b.dataset.act === 'dshare' && t) share(toPlayable(t));
    else if (b.dataset.act === 'dsave' && t) { b.disabled = true; await toggleOffline(toPlayable(t)); }
  });
  dlg.addEventListener('close', () => {
    if (location.hash.startsWith('#/track/')) history.replaceState(null, '', location.pathname + location.search + '#/');
  });
}

// ---------- About ----------
function about(main) {
  const a = state.artist || {};
  const l = a.links || {};
  const tracks = (state.catalog && state.catalog.tracks) || [];
  const byYear = new Map();
  for (const t of sortTracks(tracks, 'newest')) { const y = t.year || 'Earlier'; if (!byYear.has(y)) byYear.set(y, []); byYear.get(y).push(t); }
  const find = [
    l.instagram && [`Instagram, @${a.instagramHandle || 'raman.dhiman.official'}`, l.instagram],
    l.spotify && ['Spotify', l.spotify],
    l.apple && ['Apple Music', l.apple],
    l.youtube && ['YouTube', l.youtube],
    l.facebook && ['Facebook', l.facebook],
  ].filter(Boolean).map(([n, u]) => `<li><a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${icon('ext')} ${esc(n)}</a></li>`).join('');
  main.innerHTML = `
  <header class="about-head">
    <div class="portrait" style="background-image:url('${esc(a.photo || coverURL('raman-dhiman-portrait'))}')">${a.photo ? '' : '<span>RD</span>'}</div>
    <div>
      <h1>${esc(a.name || 'Raman Dhiman')}</h1>
      <p class="roles">${esc((a.roles || []).join(', '))}</p>
    </div>
  </header>
  <section class="block prose" aria-labelledby="abBio"><h2 id="abBio">Story</h2>${(a.bio || []).map((p) => `<p>${esc(p)}</p>`).join('')}</section>
  <section class="block" aria-labelledby="abFind"><h2 id="abFind">Find Raman</h2><ul class="links">${find}</ul></section>
  <section class="block" aria-labelledby="abTime"><h2 id="abTime">Releases through the years</h2>
    <ol class="timeline">${[...byYear].map(([y, items]) => `<li><h3>${esc(y)}</h3><ul>${items.map((t) => `<li><a href="#/track/${encodeURIComponent(t.id)}">${esc(t.title)}</a></li>`).join('')}</ul></li>`).join('')}</ol>
  </section>
  ${(a.collaborators || []).length ? `<section class="block" aria-labelledby="abWith"><h2 id="abWith">Worked with</h2><ul class="credits">${a.collaborators.map((c) => `<li><b>${esc(c.name)}</b><small>on ${esc(c.on)}</small></li>`).join('')}</ul></section>` : ''}
  <section class="block"><details class="how"><summary>Where this information comes from</summary><ul class="plain">${(a.sources || []).map((s) => `<li>${esc(s)}</li>`).join('')}</ul></details></section>`;
}

function errorView(main) {
  main.innerHTML = `<div class="emptybox"><h2>Couldn’t load the releases</h2><p>Check your connection and try again.</p><button class="btn primary" type="button" data-act="retry">Try again</button></div>`;
}

// ---------- router ----------
const VIEWS = {
  home,
  stats: (m) => renderStats(m, state),
  about,
  drafts: (m) => mountDrafts(m),
  settings: (m) => renderSettings(m, state, { applyTheme, refreshAll, refreshSaved }),
  track: (m, arg) => { const c = home(m); if (arg) openTrack(decodeURIComponent(arg)); return c; },
};
let cleanup = null;
let currentView = 'home';

function route({ initial = false, keepScroll = false } = {}) {
  const [name, arg] = location.hash.replace(/^#\/?/, '').split('/');
  const key = VIEWS[name] ? name : 'home';
  const main = $('#main');
  if (cleanup) { try { cleanup(); } catch { /* ignore */ } cleanup = null; }
  currentView = key;
  main.dataset.view = key;
  main.innerHTML = '';
  cleanup = VIEWS[key](main, arg) || null;
  hydrateIcons(main);
  const navKey = key === 'track' ? 'home' : key;
  $$('.navlist a').forEach((a) => { if (a.dataset.route === navKey) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  if (!initial && !keepScroll) { window.scrollTo(0, 0); main.focus({ preventScroll: true }); }
}

function rerenderIfSafe() {
  if (['home', 'stats', 'about', 'track'].includes(currentView) && !$('#trackDlg').open) route({ keepScroll: true });
}

// ---------- wiring ----------
function wireMain() {
  $('#main').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const id = b.dataset.id;
    switch (b.dataset.act) {
      case 'play': playTrack(id); break;
      case 'open': openTrack(id); break;
      case 'queue': queueTrack(id); break;
      case 'save': saveTrack(id, b); break;
      case 'refresh': refreshAll({ manual: true }); break;
      case 'retry': loadData(true).then(() => route()); break;
      default: break;
    }
  });
  document.addEventListener('rd:track', markCurrent);
  document.addEventListener('rd:saved', async () => {
    await refreshSaved();
    if (!$('#trackDlg').open) { if (currentView === 'home') renderList(); } else paintTrackDialog();
  });
  window.addEventListener('hashchange', () => route());
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (ls.get('theme', 'auto') === 'auto') applyTheme('auto'); });
}

function registerSW() {
  const ok = 'serviceWorker' in navigator && (location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname));
  if (!ok) return;
  navigator.serviceWorker.register('sw.js').then((reg) => {
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing;
      if (nw) nw.addEventListener('statechange', () => {
        if (nw.state === 'installed' && navigator.serviceWorker.controller) {
          toast('A new version of the app is ready.', { ms: 15000, action: { label: 'Reload', run: () => location.reload() } });
        }
      });
    });
  }).catch(() => {});
}

async function boot() {
  applyTheme(ls.get('theme', 'auto'));
  hydrateIcons();
  initPlayerUI();
  wireMain();
  wireTrackDialog();
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); window.__rdInstall = e; });
  await loadData();
  await refreshSaved();
  updateSyncStatus();
  route({ initial: true });
  registerSW();
  setInterval(updateSyncStatus, 60000);
  if (state.catalog) liveEnrich().then((changed) => { if (changed) rerenderIfSafe(); }).catch(() => {});
  setInterval(() => { if (document.visibilityState === 'visible') refreshAll(); }, 10 * 60 * 1000);
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') hiddenAt = Date.now();
    else if (hiddenAt && Date.now() - hiddenAt > 5 * 60 * 1000) refreshAll();
  });
}

boot();
