import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { norm, parseCount, sortTracks, latestTrack, coverage, bestTier, mergeItunes, mergeSpotifyAlbums, youtubeId } from '../js/merge.js';
import { syncAll } from '../scripts/sync.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const catalog = () => JSON.parse(JSON.stringify(JSON.parse(require_sync('data/catalog.json'))));
import { readFileSync } from 'node:fs';
function require_sync(p) { return readFileSync(path.join(ROOT, p), 'utf8'); }

test('norm ignores case, punctuation and feature credits', () => {
  assert.equal(norm('Shokeen Kudte Pajame De (feat. Navdeep Bhatti)'), 'shokeen kudte pajame de');
  assert.equal(norm('  PANJAB! '), 'panjab');
});

test('parseCount handles plain, K, M and comma forms', () => {
  assert.equal(parseCount('Artist · 203 monthly listeners.'), 203);
  assert.equal(parseCount('6.3K monthly listeners'), 6300);
  assert.equal(parseCount('1.2M monthly listeners'), 1200000);
  assert.equal(parseCount('1,204,331 monthly listeners'), 1204331);
  assert.equal(parseCount('nothing here'), null);
});

test('youtubeId extracts ids from common url shapes', () => {
  assert.equal(youtubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(youtubeId('https://youtu.be/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(youtubeId(null), null);
});

test('seed catalogue: 8 releases, newest is Panjab, nothing playable yet', () => {
  const c = catalog();
  assert.equal(c.tracks.length, 8);
  assert.equal(latestTrack(c.tracks).id, 'panjab');
  assert.deepEqual(sortTracks(c.tracks, 'oldest').slice(0, 2).map((t) => t.id), ['dunali', 'jhooth']);
  const cov = coverage(c.tracks);
  assert.equal(cov.lossless, 0);
  assert.equal(cov.none, 8);
  assert.equal(bestTier(c.tracks[0]), null);
});

test('mergeItunes fills gaps but never overwrites hand-written data', () => {
  const c = catalog();
  const { changes } = mergeItunes(c, [
    { trackName: 'Patloo', releaseDate: '2023-03-05T07:00:00Z', trackTimeMillis: 999000, previewUrl: 'https://a/p.m4a', trackViewUrl: 'https://music.apple.com/x', artworkUrl100: 'https://is1/100x100bb.jpg', primaryGenreName: 'Punjabi' },
    { trackName: 'Panjab', releaseDate: '2025-06-20T07:00:00Z', trackTimeMillis: 180000, previewUrl: 'https://a/q.m4a' },
  ]);
  const patloo = c.tracks.find((t) => t.id === 'patloo');
  assert.equal(patloo.releaseDate, '2023-03-03', 'kept the verified date');
  assert.equal(patloo.durationSec, 214, 'kept the verified duration');
  assert.equal(patloo.audio.preview.src, 'https://a/p.m4a');
  assert.equal(patloo.cover, 'https://is1/600x600bb.jpg');
  const panjab = c.tracks.find((t) => t.id === 'panjab');
  assert.equal(panjab.releaseDate, '2025-06-20');
  assert.equal(panjab.durationSec, 180);
  assert.ok(changes.length > 0);
});

test('mergeItunes adds unknown releases only when asked', () => {
  const song = { trackName: 'Brand New', releaseDate: '2026-09-01T00:00:00Z', collectionName: 'Brand New - Single' };
  const a = catalog(); mergeItunes(a, [song], { addNew: false });
  assert.equal(a.tracks.length, 8);
  const b = catalog(); mergeItunes(b, [song], { addNew: true });
  assert.equal(b.tracks.length, 9);
  assert.equal(latestTrack(b.tracks).id, 'brand-new');
});

test('mergeSpotifyAlbums attaches links and ignores other artists', () => {
  const c = catalog();
  mergeSpotifyAlbums(c, [
    { name: 'Fame', album_type: 'single', release_date: '2024-05-10', external_urls: { spotify: 'https://open.spotify.com/album/abc' }, images: [{ url: 'https://i/x.jpg' }], artists: [{ id: 'ME' }] },
    { name: 'Someone Else', album_type: 'single', release_date: '2024-01-01', artists: [{ id: 'OTHER' }] },
  ], { artistId: 'ME', addNew: true });
  assert.equal(c.tracks.find((t) => t.id === 'fame').links.spotify, 'https://open.spotify.com/album/abc');
  assert.equal(c.tracks.find((t) => t.id === 'fame').releaseDate, '2024-05-10');
  assert.equal(c.tracks.length, 8, 'a different artist is never added');
});

// ---------- sync with a mocked network ----------
async function tmpRoot() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rd-'));
  await cp(path.join(ROOT, 'data'), path.join(dir, 'data'), { recursive: true });
  return dir;
}
const json = (o, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => o, text: async () => JSON.stringify(o) });
const titles = ['Panjab', 'Fame', 'Akdan', 'Patloo', 'Debat'];
function mockFetch(opts = {}) {
  const calls = [];
  const f = async (url, init) => {
    calls.push(url);
    if (url.includes('itunes.apple.com/search')) {
      return json({ results: [
        ...titles.map((t) => ({ wrapperType: 'track', kind: 'song', artistId: 111, artistName: 'Raman Dhiman', trackName: t })),
        { wrapperType: 'track', kind: 'song', artistId: 999, artistName: 'Raman Dhiman', trackName: 'Unrelated Song' },
      ] });
    }
    if (url.includes('itunes.apple.com/lookup')) {
      return json({ results: [
        { wrapperType: 'artist' },
        { wrapperType: 'track', kind: 'song', artistId: 111, artistName: 'Raman Dhiman', trackName: 'Panjab', releaseDate: '2025-06-20T00:00:00Z', previewUrl: 'https://p/panjab.m4a', trackTimeMillis: 181000 },
        { wrapperType: 'track', kind: 'song', artistId: 111, artistName: 'Raman Dhiman', trackName: 'Newest Thing', releaseDate: '2026-09-30T00:00:00Z', collectionName: 'Newest Thing - Single', previewUrl: 'https://p/new.m4a' },
      ] });
    }
    if (url.includes('open.spotify.com/artist')) {
      if (opts.spotifyDown) return { ok: false, status: 503, text: async () => '' };
      return { ok: true, status: 200, text: async () => '<meta property="og:description" content="Artist · 6.3K monthly listeners. Popular">' };
    }
    throw new Error('unexpected url ' + url);
  };
  f.calls = calls;
  return f;
}

test('sync: discovers the right Apple artist, adds a new release, reads listeners', async () => {
  const root = await tmpRoot();
  const fetchFn = mockFetch();
  const { stats, catalog: cat } = await syncAll({ root, fetchFn, env: {}, now: new Date('2026-10-11T06:00:00Z'), log: () => {} });
  assert.equal(stats.sources.apple.artistId, 111, 'chose the artist matching our catalogue, not 999');
  assert.equal(cat.tracks.length, 9);
  assert.equal(cat.tracks.find((t) => t.id === 'panjab').audio.preview.src, 'https://p/panjab.m4a');
  assert.equal(stats.sources.spotify.listeners.value, 6300);
  assert.equal(stats.sources.spotify.listeners.asOf, '2026-10-11');
  assert.equal(stats.sources.spotify.api.status, 'not_configured');
  assert.equal(stats.sources.youtube.status, 'not_configured');
  assert.equal(stats.history.at(-1).monthlyListeners, 6300);
  assert.equal(stats.history.length, 2, 'seed day plus today');
  const onDisk = JSON.parse(await readFile(path.join(root, 'data/stats.json'), 'utf8'));
  assert.equal(onDisk.updatedAt, '2026-10-11T06:00:00.000Z');
});

test('sync: a failing source keeps the last good number and says so', async () => {
  const root = await tmpRoot();
  const { stats } = await syncAll({ root, fetchFn: mockFetch({ spotifyDown: true }), env: {}, now: new Date('2026-10-11T06:00:00Z'), log: () => {} });
  assert.equal(stats.sources.spotify.listeners.value, 203, 'old value kept');
  assert.equal(stats.sources.spotify.listeners.status, 'stale');
  assert.match(stats.sources.spotify.listeners.reason, /503/);
  assert.equal(stats.sources.apple.status, 'ok', 'other sources unaffected');
});

test('sync: running twice on the same day replaces rather than duplicates history', async () => {
  const root = await tmpRoot();
  const now = new Date('2026-10-11T06:00:00Z');
  await syncAll({ root, fetchFn: mockFetch(), env: {}, now, log: () => {} });
  const { stats } = await syncAll({ root, fetchFn: mockFetch(), env: {}, now: new Date('2026-10-11T12:00:00Z'), log: () => {} });
  assert.equal(stats.history.filter((h) => h.date === '2026-10-11').length, 1);
});
