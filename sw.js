// Service worker: offline app shell, fresh data, and range-aware playback of saved songs.
const VERSION = 'v1.0.0';
const SHELL = `rd-shell-${VERSION}`;
const DATA = `rd-data-${VERSION}`;
const AUDIO = 'rd-audio-v1'; // owned by js/offline.js, never deleted here
const FONTS = 'rd-fonts-v1';

const SHELL_FILES = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css', 'assets/icon.svg',
  'js/app.js', 'js/util.js', 'js/icons.js', 'js/cover.js', 'js/merge.js', 'js/player.js', 'js/playerui.js',
  'js/offline.js', 'js/actions.js', 'js/viz.js', 'js/stats.js', 'js/settings.js', 'js/drafts.js', 'js/lock.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keep = new Set([SHELL, DATA, AUDIO, FONTS]);
    for (const k of await caches.keys()) if (!keep.has(k)) await caches.delete(k);
    await self.clients.claim();
  })());
});

// Serve a cached audio file with proper HTTP Range support so seeking works offline.
async function rangeFromCache(req, res) {
  const range = req.headers.get('range');
  const blob = await res.blob();
  const type = res.headers.get('content-type') || 'audio/mpeg';
  if (!range) return new Response(blob, { status: 200, headers: { 'Content-Type': type, 'Content-Length': String(blob.size), 'Accept-Ranges': 'bytes' } });
  const m = /bytes=(\d*)-(\d*)/.exec(range);
  let start = m && m[1] ? parseInt(m[1], 10) : 0;
  let end = m && m[2] ? parseInt(m[2], 10) : blob.size - 1;
  if (m && !m[1] && m[2]) { start = Math.max(0, blob.size - parseInt(m[2], 10)); end = blob.size - 1; }
  end = Math.min(end, blob.size - 1);
  if (start > end || start >= blob.size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${blob.size}` } });
  const part = blob.slice(start, end + 1, type);
  return new Response(part, {
    status: 206,
    headers: { 'Content-Type': type, 'Content-Length': String(part.size), 'Content-Range': `bytes ${start}-${end}/${blob.size}`, 'Accept-Ranges': 'bytes' },
  });
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === location.origin && /\/audio\//.test(url.pathname)) {
    e.respondWith((async () => {
      const hit = await (await caches.open(AUDIO)).match(url.href);
      if (hit) return rangeFromCache(req, hit);
      return fetch(req); // not saved: normal network playback
    })());
    return;
  }

  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith((async () => {
      const c = await caches.open(FONTS);
      const hit = await c.match(req);
      if (hit) return hit;
      try { const res = await fetch(req); if (res.ok || res.type === 'opaque') c.put(req, res.clone()); return res; } catch { return hit || Response.error(); }
    })());
    return;
  }

  if (url.origin !== location.origin) return; // previews, artwork, APIs: leave to the network

  if (url.pathname.includes('/data/')) { // network first so stats stay fresh, cache as the offline fallback
    e.respondWith((async () => {
      const c = await caches.open(DATA);
      try {
        const res = await fetch(req);
        if (res.ok) c.put(url.pathname, res.clone());
        return res;
      } catch {
        return (await c.match(url.pathname)) || Response.error();
      }
    })());
    return;
  }

  // App shell: stale-while-revalidate
  e.respondWith((async () => {
    const c = await caches.open(SHELL);
    const hit = await c.match(req, { ignoreSearch: true });
    const net = fetch(req).then((res) => { if (res.ok) c.put(req, res.clone()); return res; }).catch(() => null);
    if (hit) { net.catch(() => {}); return hit; }
    return (await net) || (req.mode === 'navigate' ? await c.match('index.html') : Response.error());
  })());
});
