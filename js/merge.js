// Pure logic shared by the browser app and the Node sync scripts.
// No DOM, no fetch, no storage. That keeps it testable and keeps both sides consistent.

export const TIER_ORDER = ['lossless', 'high', 'standard', 'preview'];

/** Normalise a title so "Panjab", "PANJAB" and "Panjab (feat. X)" all match. */
export const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

const slug = (s) =>
  String(s || '').toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-') || 'untitled';

/** Sort key: exact date when known, otherwise mid-year so year-only tracks slot in sensibly. */
export const dateKey = (t) => t.releaseDate || `${t.year || 1970}-07-01`;

export function sortTracks(tracks, how = 'newest') {
  const a = tracks.slice();
  const byTitle = (x, y) => x.title.localeCompare(y.title);
  if (how === 'title') return a.sort(byTitle);
  if (how === 'oldest') return a.sort((x, y) => dateKey(x).localeCompare(dateKey(y)) || byTitle(x, y));
  return a.sort((x, y) => dateKey(y).localeCompare(dateKey(x)) || byTitle(x, y));
}

export const latestTrack = (tracks) => sortTracks(tracks, 'newest')[0] || null;

/** Best audio tier a track has, or null. */
export function bestTier(t) {
  for (const k of TIER_ORDER) if (t.audio && t.audio[k] && t.audio[k].src) return k;
  return null;
}
export const hasLossless = (t) => !!(t.audio && t.audio.lossless && t.audio.lossless.src);

export function coverage(tracks) {
  const out = { total: tracks.length, lossless: 0, high: 0, standard: 0, previewOnly: 0, none: 0, seconds: 0 };
  for (const t of tracks) {
    const b = bestTier(t);
    if (b === 'lossless') out.lossless++;
    else if (b === 'high') out.high++;
    else if (b === 'standard') out.standard++;
    else if (b === 'preview') out.previewOnly++;
    else out.none++;
    out.seconds += t.durationSec || 0;
  }
  return out;
}

/** "203 monthly listeners", "6.3K monthly listeners", "1,204,331 monthly listeners" -> number. */
export function parseCount(text) {
  const m = String(text || '').match(/(\d[\d.,]*)\s*([KMB])?\s+monthly listeners/i);
  if (!m) return null;
  const n = parseFloat(m[1].replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  const mult = { K: 1e3, M: 1e6, B: 1e9 }[(m[2] || '').toUpperCase()] || 1;
  return Math.round(n * mult);
}

export const spotifySearchUrl = (q) => `https://open.spotify.com/search/${encodeURIComponent(q)}`;
export const appleSearchUrl = (q, cc = 'in') => `https://music.apple.com/${cc}/search?term=${encodeURIComponent(q)}`;
export const youtubeSearchUrl = (q) => `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`;
export function youtubeId(url) {
  const m = String(url || '').match(/(?:v=|youtu\.be\/|shorts\/|embed\/)([\w-]{11})/);
  return m ? m[1] : null;
}

export function ensureTrack(t) {
  t.audio = t.audio || {};
  t.links = t.links || {};
  t.credits = t.credits || [];
  t.artists = t.artists && t.artists.length ? t.artists : ['Raman Dhiman'];
  return t;
}

const art600 = (u) => (u ? u.replace(/\/\d+x\d+(bb|cc)?\.(jpg|png)/, '/600x600bb.$2') : null);

/**
 * Fill gaps in `catalog` from iTunes/Apple Music song results.
 * Only fills fields that are empty, so hand-written data (dates, credits, notes) is never overwritten.
 * Mutates and returns { catalog, changes }.
 */
export function mergeItunes(catalog, songs, { addNew = false } = {}) {
  const changes = [];
  const idx = new Map(catalog.tracks.map((t) => [norm(t.title), t]));
  for (const s of songs || []) {
    if (!s || !s.trackName) continue;
    const key = norm(s.trackName);
    let t = idx.get(key);
    if (!t) {
      if (!addNew) continue;
      t = ensureTrack({
        id: slug(s.trackName),
        title: s.trackName,
        type: /single$/i.test(s.collectionName || '') ? 'Single' : 'Release',
        year: s.releaseDate ? Number(s.releaseDate.slice(0, 4)) : null,
        releaseDate: null,
        durationSec: null,
        source: 'Apple Music (auto-added)',
      });
      catalog.tracks.push(t);
      idx.set(key, t);
      changes.push(`added "${t.title}"`);
    }
    ensureTrack(t);
    const fill = (obj, k, v, label = k) => {
      if (v !== undefined && v !== null && v !== '' && !obj[k]) { obj[k] = v; changes.push(`${t.title}: ${label}`); }
    };
    const day = s.releaseDate ? s.releaseDate.slice(0, 10) : null;
    fill(t, 'releaseDate', day);
    fill(t, 'year', day ? Number(day.slice(0, 4)) : null);
    fill(t, 'durationSec', s.trackTimeMillis ? Math.round(s.trackTimeMillis / 1000) : null);
    fill(t, 'cover', art600(s.artworkUrl100), 'cover');
    fill(t, 'genre', s.primaryGenreName);
    fill(t.links, 'apple', s.trackViewUrl, 'apple link');
    if (s.previewUrl && (!t.audio.preview || t.audio.preview.src !== s.previewUrl)) {
      t.audio.preview = { src: s.previewUrl, format: 'AAC', seconds: 30, source: 'Apple Music preview' };
      changes.push(`${t.title}: preview`);
    }
  }
  return { catalog, changes };
}

/** Same idea for Spotify's /artists/{id}/albums items. */
export function mergeSpotifyAlbums(catalog, albums, { artistId, addNew = false } = {}) {
  const changes = [];
  const idx = new Map(catalog.tracks.map((t) => [norm(t.title), t]));
  for (const a of albums || []) {
    if (!a || !a.name) continue;
    const key = norm(a.name);
    let t = idx.get(key);
    const ours = !artistId || (a.artists || []).some((x) => x.id === artistId);
    if (!t) {
      if (!addNew || !ours || !['single', 'album'].includes(a.album_type)) continue;
      t = ensureTrack({
        id: slug(a.name),
        title: a.name,
        type: a.album_type === 'single' ? 'Single' : 'Album',
        year: a.release_date ? Number(a.release_date.slice(0, 4)) : null,
        releaseDate: a.release_date && a.release_date.length === 10 ? a.release_date : null,
        durationSec: null,
        source: 'Spotify (auto-added)',
      });
      catalog.tracks.push(t);
      idx.set(key, t);
      changes.push(`added "${t.title}"`);
    }
    ensureTrack(t);
    if (!t.links.spotify && a.external_urls && a.external_urls.spotify) { t.links.spotify = a.external_urls.spotify; changes.push(`${t.title}: spotify link`); }
    if (!t.releaseDate && a.release_date && a.release_date.length === 10) { t.releaseDate = a.release_date; changes.push(`${t.title}: releaseDate`); }
    if (!t.cover && a.images && a.images[0]) { t.cover = a.images[0].url; changes.push(`${t.title}: cover`); }
  }
  return { catalog, changes };
}

/** Stable fingerprint that ignores timestamps, for "did anything really change?" checks. */
export function fingerprint(obj) {
  return JSON.stringify(obj, (k, v) => (k === 'generatedAt' || k === 'updatedAt' ? undefined : v));
}
