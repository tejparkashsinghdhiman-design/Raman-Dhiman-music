// Save tracks for offline listening. Files live in the Cache API; the service worker serves them
// back with proper Range support so seeking works offline.
export const CACHE = 'rd-audio-v1';
export const supported = typeof caches !== 'undefined';

const abs = (src) => new URL(src, location.href).href;

export async function isSaved(src) {
  if (!supported || !src) return false;
  try { return !!(await (await caches.open(CACHE)).match(abs(src))); } catch { return false; }
}

export async function save(src, onProgress) {
  if (!supported) throw new Error('Offline storage is not available in this browser.');
  const url = abs(src);
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const cache = await caches.open(CACHE);
  const len = Number(res.headers.get('content-length')) || 0;
  const type = res.headers.get('content-type') || 'audio/mpeg';
  if (res.body && onProgress && len) {
    const reader = res.body.getReader();
    const chunks = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      onProgress(Math.min(1, got / len));
    }
    const blob = new Blob(chunks, { type });
    await cache.put(url, new Response(blob, { headers: { 'Content-Type': type, 'Content-Length': String(blob.size) } }));
  } else {
    await cache.put(url, res);
  }
}

export async function remove(src) {
  if (!supported) return;
  try { await (await caches.open(CACHE)).delete(abs(src)); } catch { /* ignore */ }
}

export async function list() {
  if (!supported) return [];
  try {
    const cache = await caches.open(CACHE);
    const keys = await cache.keys();
    const out = [];
    for (const k of keys) {
      const r = await cache.match(k);
      out.push({ url: k.url, bytes: Number(r && r.headers.get('content-length')) || 0 });
    }
    return out;
  } catch { return []; }
}
