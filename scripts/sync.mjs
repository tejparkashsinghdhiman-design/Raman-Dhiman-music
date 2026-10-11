#!/usr/bin/env node
// Keeps data/catalog.json and data/stats.json current. Runs on a schedule in GitHub Actions.
//
//   Apple Music (no key needed)   release list, 30-second previews, artwork, dates
//   Spotify page (no key needed)  monthly listeners, read from the public artist page
//   Spotify API (optional)        followers, popularity, release links. Secrets: SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET
//   YouTube API (optional)        subscribers, views. Secret: YOUTUBE_API_KEY, plus youtubeChannelId in data/config.json
//
// Every source runs on its own: one failing never blocks the others, and a failure never wipes the last good number.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeItunes, mergeSpotifyAlbums, parseCount, norm, fingerprint, youtubeId } from '../js/merge.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UA = 'Mozilla/5.0 (compatible; RamanDhimanApp/1.0; +https://github.com)';
const enc = encodeURIComponent;
const today = (d) => d.toISOString().slice(0, 10);

async function getJSON(fetchFn, url, init) {
  const r = await fetchFn(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, ...init });
  if (!r.ok) throw new Error(`${new URL(url).hostname} answered ${r.status}`);
  return r.json();
}

// ---------- Apple Music via the public iTunes Search API ----------
export async function syncApple({ cfg, catalog, prev, fetchFn, now }) {
  const cc = cfg.country || 'IN';
  const known = new Set(catalog.tracks.map((t) => norm(t.title)));
  let aid = cfg.appleArtistId || (prev && prev.artistId) || null;
  let songs = [];
  if (!aid) {
    const j = await getJSON(fetchFn, `https://itunes.apple.com/search?term=${enc(cfg.artistName)}&entity=song&attribute=artistTerm&limit=200&country=${cc}`);
    const groups = new Map();
    for (const s of (j.results || []).filter((x) => x.wrapperType === 'track' && x.kind === 'song')) {
      if (!norm(s.artistName).includes(norm(cfg.artistName))) continue;
      const g = groups.get(s.artistId) || { id: s.artistId, score: 0 };
      if (known.has(norm(s.trackName))) g.score++;
      groups.set(s.artistId, g);
    }
    // Pin the artist whose songs match our known catalogue. Same-name artists are ignored.
    const best = [...groups.values()].sort((a, b) => b.score - a.score)[0];
    if (!best || best.score < 2) return { status: 'error', reason: 'Could not confidently identify the Apple Music artist yet', checkedAt: now.toISOString(), artistId: null, changes: [] };
    aid = best.id;
  }
  const j = await getJSON(fetchFn, `https://itunes.apple.com/lookup?id=${aid}&entity=song&limit=200&country=${cc}`);
  songs = (j.results || []).filter((x) => x.wrapperType === 'track' && x.kind === 'song');
  const { changes } = mergeItunes(catalog, songs, { addNew: cfg.addNewReleases !== false });
  return { status: 'ok', artistId: aid, songsFound: songs.length, checkedAt: now.toISOString(), changes };
}

// ---------- Spotify ----------
export async function scrapeListeners({ artistId, fetchFn, now }) {
  const r = await fetchFn(`https://open.spotify.com/artist/${artistId}`, { headers: { 'User-Agent': UA, 'Accept-Language': 'en' } });
  if (!r.ok) throw new Error(`open.spotify.com answered ${r.status}`);
  const n = parseCount((await r.text()).replace(/&nbsp;|\u00a0/g, ' '));
  if (n == null) throw new Error('Monthly listeners were not found on the artist page');
  return { status: 'ok', value: n, asOf: today(now) };
}

export async function spotifyApi({ cfg, catalog, env, fetchFn }) {
  const id = env.SPOTIFY_CLIENT_ID, secret = env.SPOTIFY_CLIENT_SECRET;
  if (!id || !secret) return { status: 'not_configured', followers: null, popularity: null };
  const tok = await getJSON(fetchFn, 'https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
    body: 'grant_type=client_credentials',
  });
  const auth = { headers: { Authorization: `Bearer ${tok.access_token}`, 'User-Agent': UA } };
  const artist = await getJSON(fetchFn, `https://api.spotify.com/v1/artists/${cfg.spotifyArtistId}`, auth);
  const albums = [];
  let url = `https://api.spotify.com/v1/artists/${cfg.spotifyArtistId}/albums?include_groups=single,album,appears_on&market=${cfg.country || 'IN'}&limit=50`;
  for (let i = 0; i < 6 && url; i++) { const p = await getJSON(fetchFn, url, auth); albums.push(...(p.items || [])); url = p.next; }
  const { changes } = mergeSpotifyAlbums(catalog, albums, { artistId: cfg.spotifyArtistId, addNew: cfg.addNewReleases !== false });
  return {
    status: 'ok',
    followers: artist.followers && artist.followers.total != null ? artist.followers.total : null,
    popularity: artist.popularity != null ? artist.popularity : null,
    changes,
  };
}

// ---------- YouTube ----------
export async function syncYouTube({ cfg, catalog, env, fetchFn }) {
  const key = env.YOUTUBE_API_KEY;
  if (!key || !cfg.youtubeChannelId) return { status: 'not_configured' };
  const ch = await getJSON(fetchFn, `https://www.googleapis.com/youtube/v3/channels?part=statistics&id=${enc(cfg.youtubeChannelId)}&key=${enc(key)}`);
  const st = ch.items && ch.items[0] && ch.items[0].statistics;
  if (!st) throw new Error('YouTube channel not found. Check youtubeChannelId in data/config.json');
  const idToTrack = new Map();
  for (const t of catalog.tracks) { const v = youtubeId(t.links && t.links.youtube); if (v) idToTrack.set(v, t.id); }
  const perTrack = {};
  const ids = [...idToTrack.keys()];
  for (let i = 0; i < ids.length; i += 50) {
    const v = await getJSON(fetchFn, `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${ids.slice(i, i + 50).join(',')}&key=${enc(key)}`);
    for (const it of v.items || []) perTrack[idToTrack.get(it.id)] = { youtubeViews: Number(it.statistics.viewCount) };
  }
  return {
    status: 'ok',
    subscribers: st.hiddenSubscriberCount ? null : Number(st.subscriberCount),
    views: Number(st.viewCount), videos: Number(st.videoCount), perTrack,
  };
}

// ---------- orchestration ----------
async function guarded(name, fn, log) {
  try { return await fn(); } catch (e) {
    log(`::warning::${name}: ${e.message}`);
    return { status: 'error', reason: e.message };
  }
}

export async function syncAll({ root = path.resolve(HERE, '..'), fetchFn = fetch, env = process.env, now = new Date(), log = console.log } = {}) {
  const read = async (n) => JSON.parse(await readFile(path.join(root, 'data', `${n}.json`), 'utf8'));
  const write = (n, o) => writeFile(path.join(root, 'data', `${n}.json`), JSON.stringify(o, null, 2) + '\n');
  const [cfg, catalog, stats] = await Promise.all([read('config'), read('catalog'), read('stats')]);
  const before = fingerprint(catalog);
  const src = stats.sources || {};
  const iso = now.toISOString();
  const out = { sources: { ...src } };

  // Apple
  const apple = await guarded('Apple Music', () => syncApple({ cfg, catalog, prev: src.apple, fetchFn, now }), log);
  out.sources.apple = apple.status === 'ok' ? { status: 'ok', artistId: apple.artistId, songsFound: apple.songsFound, checkedAt: iso }
    : { ...(src.apple || {}), status: 'error', reason: apple.reason, checkedAt: iso };
  if (apple.changes && apple.changes.length) log(`Apple Music: ${apple.changes.length} update(s)`);

  // Spotify listeners (page) and API
  const prevSp = src.spotify || {};
  const listeners = await guarded('Spotify listeners', () => scrapeListeners({ artistId: cfg.spotifyArtistId, fetchFn, now }), log);
  const api = await guarded('Spotify API', () => spotifyApi({ cfg, catalog, env, fetchFn }), log);
  if (api.changes && api.changes.length) log(`Spotify: ${api.changes.length} update(s)`);
  out.sources.spotify = {
    artistId: cfg.spotifyArtistId,
    listeners: listeners.status === 'ok'
      ? listeners
      : { ...(prevSp.listeners || {}), status: prevSp.listeners && prevSp.listeners.value != null ? 'stale' : 'error', reason: listeners.reason },
    api: api.status === 'ok'
      ? { status: 'ok', followers: api.followers, popularity: api.popularity }
      : { ...(prevSp.api || {}), status: api.status, ...(api.reason ? { reason: api.reason } : {}) },
    checkedAt: iso,
  };

  // YouTube
  const yt = await guarded('YouTube', () => syncYouTube({ cfg, catalog, env, fetchFn }), log);
  out.sources.youtube = yt.status === 'ok'
    ? { status: 'ok', channelId: cfg.youtubeChannelId, subscribers: yt.subscribers, views: yt.views, videos: yt.videos, checkedAt: iso }
    : { ...(src.youtube || {}), status: yt.status, ...(yt.reason ? { reason: yt.reason } : {}), checkedAt: iso };

  // History (one row per day, newest values win)
  const day = today(now);
  const sp = out.sources.spotify;
  const row = { date: day };
  if (sp.listeners && sp.listeners.value != null) row.monthlyListeners = sp.listeners.value;
  if (sp.api && sp.api.followers != null) row.followers = sp.api.followers;
  if (out.sources.youtube.views != null) row.youtubeViews = out.sources.youtube.views;
  const history = (stats.history || []).filter((h) => h.date !== day);
  history.push(row);
  history.sort((a, b) => a.date.localeCompare(b.date));

  const next = {
    schemaVersion: 1, updatedAt: iso, sources: out.sources, history: history.slice(-180),
    tracks: yt.status === 'ok' ? yt.perTrack : stats.tracks || {},
  };

  if (fingerprint(catalog) !== before) { catalog.generatedAt = iso; await write('catalog', catalog); log('catalog.json updated'); }
  await write('stats', next);
  log(`stats.json written (${iso})`);
  return { stats: next, catalog };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  syncAll().catch((e) => { console.error(e); process.exit(1); });
}
