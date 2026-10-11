// Audio engine: queue, quality tiers, honest fallbacks, Media Session, sleep timer, analyser.
import { ls, toast, isIOS, clamp } from './util.js';
import { coverFor } from './cover.js';

export const TIERS = {
  lossless: { label: 'Lossless', blurb: 'Original quality, nothing discarded' },
  high: { label: 'High', blurb: 'Near-transparent, about a third of the data' },
  standard: { label: 'Data saver', blurb: 'Smallest files, for slow connections' },
  preview: { label: 'Preview', blurb: '30-second clip from Apple Music' },
  original: { label: 'Original file', blurb: 'Played exactly as saved' },
};
const FULL = ['lossless', 'high', 'standard'];

/** "FLAC · 16-bit · 44.1 kHz" or "MP3 · 320 kbps". Only states what the file metadata says. */
export function specText(tier, spec) {
  if (!spec) return '';
  const parts = [];
  if (spec.format) parts.push(spec.format);
  if (tier === 'lossless') {
    if (spec.bitDepth) parts.push(`${spec.bitDepth}-bit`);
    if (spec.sampleRate) parts.push(`${+(spec.sampleRate / 1000).toFixed(1)} kHz`);
  } else if (spec.bitrateKbps) parts.push(`${spec.bitrateKbps} kbps`);
  return parts.join(' · ');
}

/** Catalog track -> something the player can queue. */
export function toPlayable(track) {
  const sources = {};
  for (const k of [...FULL, 'preview']) if (track.audio && track.audio[k] && track.audio[k].src) sources[k] = track.audio[k];
  return {
    id: track.id,
    kind: 'release',
    title: track.title,
    artists: track.artists && track.artists.length ? track.artists : ['Raman Dhiman'],
    cover: coverFor(track),
    year: track.year,
    durationSec: track.durationSec || 0,
    lyrics: track.lyrics || null,
    sources,
  };
}

const isLocalSrc = (src) => src.startsWith('blob:') || new URL(src, location.href).origin === location.origin;

class Player extends EventTarget {
  constructor() {
    super();
    this.base = [];
    this.queue = [];
    this.idx = -1;
    this.shuffle = ls.get('shuffle', false);
    this.repeat = ls.get('repeat', 'off');
    this.quality = ls.get('quality', 'auto');
    this.volume = ls.get('volume', 0.9);
    this.muted = false;
    this.vizOn = ls.get('viz', true);
    this.current = null; // { item, tier, requested, src, spec, fellBack, remote }
    this.ctx = null;
    this.analyser = null;
    this.sleep = null;
    this._retried = false;
    this._lastPos = 0;
    // Two elements on purpose: Web Audio would silence a cross-origin stream (the Apple previews),
    // so only same-origin audio goes through the analyser element.
    this.local = this._makeEl();
    this.remote = this._makeEl();
    this.el = this.local;
    this._bindMediaSession();
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  on(type, fn) { this.addEventListener(type, (e) => fn(e.detail)); }

  _makeEl() {
    const a = new Audio();
    a.preload = 'metadata';
    a.volume = this.volume;
    const mine = (fn) => () => { if (a === this.el) fn(); };
    a.addEventListener('play', mine(() => this.emit('state')));
    a.addEventListener('pause', mine(() => this.emit('state')));
    a.addEventListener('playing', mine(() => { this._retried = false; this.emit('buffering', false); }));
    a.addEventListener('waiting', mine(() => this.emit('buffering', true)));
    a.addEventListener('timeupdate', mine(() => this.emit('time')));
    a.addEventListener('durationchange', mine(() => this.emit('time')));
    a.addEventListener('ended', mine(() => this._ended()));
    a.addEventListener('error', mine(() => this._error()));
    return a;
  }

  get paused() { return this.el.paused; }
  get currentTime() { return this.el.currentTime || 0; }
  get duration() {
    const d = this.el.duration;
    if (Number.isFinite(d) && d > 0) return d;
    return (this.current && this.current.item.durationSec) || 0;
  }

  // ---------- quality ----------
  autoTier() {
    const c = navigator.connection;
    if (c && c.saveData) return 'standard';
    if (c && /^(slow-2g|2g)$/.test(c.effectiveType || '')) return 'standard';
    if (c && c.effectiveType === '3g') return 'high';
    return 'lossless';
  }

  /** Pick the best available source for a preference. Never mislabels: the returned tier is what will actually play. */
  resolve(item, pref = this.quality) {
    const s = item.sources || {};
    if (s.original) return { tier: 'original', requested: 'original', src: s.original.src, spec: s.original, fellBack: false, remote: false };
    const want = pref === 'auto' ? this.autoTier() : pref;
    const wi = Math.max(0, FULL.indexOf(want));
    const order = [];
    for (let i = wi; i < FULL.length; i++) order.push(FULL[i]); // requested, then lower
    for (let i = wi - 1; i >= 0; i--) order.push(FULL[i]); // then higher
    order.push('preview');
    const tier = order.find((k) => s[k] && s[k].src);
    if (!tier) return null;
    return { tier, requested: want, src: s[tier].src, spec: s[tier], fellBack: tier !== want, remote: !isLocalSrc(s[tier].src) };
  }

  setQuality(q) {
    this.quality = q;
    ls.set('quality', q);
    this.emit('quality', q);
    const c = this.current;
    if (!c || c.tier === 'original') return;
    const pick = this.resolve(c.item);
    if (!pick) return;
    if (pick.src === c.src) {
      this.current = { item: c.item, ...pick };
      this.emit('track', this.current);
      return;
    }
    const t = this.el.currentTime;
    const was = !this.el.paused;
    this._load(was, t);
  }

  // ---------- queue ----------
  _shuffled(list, firstId) {
    const rest = list.filter((p) => p.id !== firstId);
    for (let i = rest.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [rest[i], rest[j]] = [rest[j], rest[i]];
    }
    const first = list.find((p) => p.id === firstId);
    return first ? [first, ...rest] : rest;
  }

  playList(list, id, { autoplay = true } = {}) {
    this.base = list.slice();
    this.queue = this.shuffle ? this._shuffled(list, id) : list.slice();
    this.idx = Math.max(0, this.queue.findIndex((p) => p.id === id));
    this.emit('queue');
    return this._load(autoplay, 0);
  }

  jump(i) {
    if (i < 0 || i >= this.queue.length) return;
    this.idx = i;
    return this._load(true, 0);
  }

  enqueue(item, { next = false } = {}) {
    if (!this.queue.length) { this.playList([item], item.id); return; }
    if (this.queue.some((p) => p.id === item.id)) { toast(`“${item.title}” is already in the queue`); return; }
    if (next) this.queue.splice(this.idx + 1, 0, item); else this.queue.push(item);
    this.base.push(item);
    this.emit('queue');
    toast(next ? `“${item.title}” plays next` : `Added “${item.title}” to the queue`);
  }

  toggleShuffle() {
    this.shuffle = !this.shuffle;
    ls.set('shuffle', this.shuffle);
    const cur = this.current && this.current.item;
    if (cur) {
      this.queue = this.shuffle ? this._shuffled(this.base, cur.id) : this.base.slice();
      this.idx = Math.max(0, this.queue.findIndex((p) => p.id === cur.id));
    }
    this.emit('queue');
    this.emit('modes');
  }

  cycleRepeat() {
    this.repeat = { off: 'all', all: 'one', one: 'off' }[this.repeat] || 'off';
    ls.set('repeat', this.repeat);
    this.emit('modes');
  }

  // ---------- loading & transport ----------
  _ensureGraph() {
    if (!this.vizOn || isIOS() || this.ctx) return; // iOS can drop background audio when routed through Web Audio
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      const src = this.ctx.createMediaElementSource(this.local);
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 1024;
      this.analyser.smoothingTimeConstant = 0.8;
      src.connect(this.analyser);
      this.analyser.connect(this.ctx.destination);
    } catch {
      this.ctx = null;
      this.analyser = null;
    }
  }
  _resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {}); }

  getWave() {
    if (!this.vizOn || !this.analyser || this.el !== this.local || this.el.paused) return null;
    if (!this._wb || this._wb.length !== this.analyser.fftSize) this._wb = new Uint8Array(this.analyser.fftSize);
    this.analyser.getByteTimeDomainData(this._wb);
    return this._wb;
  }

  async _load(autoplay = true, startAt = 0, forceTier = null) {
    const item = this.queue[this.idx];
    if (!item) return false;
    let pick = this.resolve(item);
    if (forceTier && item.sources[forceTier]) {
      const s = item.sources[forceTier];
      pick = { tier: forceTier, requested: this.quality, src: s.src, spec: s, fellBack: true, remote: !isLocalSrc(s.src) };
    }
    if (!pick) { this.emit('nosource', item); return false; }
    this.current = { item, ...pick };
    const el = pick.remote ? this.remote : this.local;
    if (el !== this.el) { this.el.pause(); this.el = el; }
    el.volume = this.volume;
    el.muted = this.muted;
    if (!pick.remote) this._ensureGraph();
    el.src = pick.src;
    if (startAt > 0) {
      // Setting currentTime before metadata arrives records a default start position, so a seek the listener makes
      // later can't override one the listener made earlier. The metadata listener is only a fallback for browsers
      // that ignore the early assignment, and it never fights a seek the person has already made.
      try { el.currentTime = startAt; } catch { /* not seekable yet */ }
      el.addEventListener('loadedmetadata', () => { if (el.currentTime < 0.5) { try { el.currentTime = startAt; } catch { /* ignore */ } } }, { once: true });
    }
    this.emit('track', this.current);
    if (autoplay) {
      this._resume();
      try { await el.play(); } catch (e) { if (e && e.name !== 'AbortError') this.emit('state'); }
    } else this.emit('state');
    this._updateSession();
    return true;
  }

  async play() { this._resume(); try { await this.el.play(); } catch { /* blocked or interrupted */ } }
  pause() { this.el.pause(); }
  async toggle() { if (!this.current) return; if (this.el.paused) await this.play(); else this.pause(); }
  seek(t) { if (!this.current) return; const d = this.duration || t; this.el.currentTime = clamp(t, 0, d); this.emit('time'); }

  async next({ auto = false } = {}) {
    const len = this.queue.length;
    if (!len) return;
    for (let step = 1; step <= len; step++) {
      let n = this.idx + step;
      if (n >= len) {
        if (auto && this.repeat !== 'all') break; // natural end of queue
        n %= len;
      }
      if (this.resolve(this.queue[n])) { this.idx = n; return this._load(true, 0); }
    }
    if (auto) { this.el.pause(); try { this.el.currentTime = 0; } catch { /* ignore */ } this.emit('state'); }
  }

  async prev() {
    if (!this.current) return;
    if (this.el.currentTime > 3) { this.seek(0); return; }
    const len = this.queue.length;
    for (let step = 1; step <= len; step++) {
      const n = (((this.idx - step) % len) + len) % len;
      if (this.resolve(this.queue[n])) { this.idx = n; return this._load(true, 0); }
    }
  }

  _ended() {
    if (this.sleep && this.sleep.end) { this._sleepNow(); return; }
    if (this.repeat === 'one') { this.seek(0); this.play(); return; }
    this.next({ auto: true });
  }

  _error() {
    const c = this.current;
    if (!c) return;
    if (c.tier === 'original') { toast("Couldn't play that file. It may be in a format this browser doesn't support."); return; }
    const order = ['lossless', 'high', 'standard', 'preview'];
    const lower = order.slice(order.indexOf(c.tier) + 1).find((k) => c.item.sources[k] && c.item.sources[k].src);
    if (lower && !this._retried) {
      this._retried = true;
      toast(`Couldn't load the ${c.tier} file. Playing ${lower} instead.`);
      this._load(true, this.el.currentTime || 0, lower);
    } else {
      toast(`Couldn't load “${c.item.title}”. Check your connection and try again.`);
      this.emit('state');
    }
  }

  // ---------- volume ----------
  setVolume(v) {
    this.volume = clamp(v, 0, 1);
    ls.set('volume', this.volume);
    this.local.volume = this.volume;
    this.remote.volume = this.volume;
    if (this.volume > 0 && this.muted) this.toggleMute(false);
    this.emit('volume');
  }
  toggleMute(force) {
    this.muted = force === undefined ? !this.muted : force;
    this.local.muted = this.muted;
    this.remote.muted = this.muted;
    this.emit('volume');
  }

  // ---------- sleep timer ----------
  setSleep(spec) {
    clearTimeout(this._sleepT);
    if (!spec) { this.sleep = null; this.emit('sleep', null); return; }
    if (spec === 'end') this.sleep = { end: true };
    else {
      this.sleep = { until: Date.now() + spec * 60000 };
      this._sleepT = setTimeout(() => this._sleepNow(), spec * 60000);
    }
    this.emit('sleep', this.sleep);
  }
  _sleepNow() {
    this.sleep = null;
    this.emit('sleep', null);
    const el = this.el;
    const v0 = this.volume;
    let i = 0;
    const t = setInterval(() => {
      i++;
      el.volume = Math.max(0, v0 * (1 - i / 20));
      if (i >= 20) { clearInterval(t); el.pause(); el.volume = v0; toast('Sleep timer finished. Goodnight.'); }
    }, 200);
  }

  // ---------- Media Session (lock screen, headphones, keyboard media keys) ----------
  _bindMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    const set = (a, f) => { try { ms.setActionHandler(a, f); } catch { /* unsupported action */ } };
    set('play', () => this.play());
    set('pause', () => this.pause());
    set('previoustrack', () => this.prev());
    set('nexttrack', () => this.next());
    set('seekto', (d) => { if (d.seekTime != null) this.seek(d.seekTime); });
    set('seekbackward', (d) => this.seek(this.currentTime - (d.seekOffset || 10)));
    set('seekforward', (d) => this.seek(this.currentTime + (d.seekOffset || 10)));
    this.on('state', () => { ms.playbackState = this.el.paused ? 'paused' : 'playing'; });
    this.on('time', () => {
      const now = Date.now();
      if (now - this._lastPos < 1000) return;
      this._lastPos = now;
      const d = this.duration;
      if (d > 0 && ms.setPositionState) {
        try { ms.setPositionState({ duration: d, position: clamp(this.currentTime, 0, d), playbackRate: 1 }); } catch { /* ignore */ }
      }
    });
  }
  _updateSession() {
    if (!('mediaSession' in navigator) || !this.current) return;
    const it = this.current.item;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: it.title,
        artist: it.artists.join(', '),
        album: it.kind === 'draft' ? 'Drafts' : 'Raman Dhiman',
        artwork: [{ src: new URL(it.cover, location.href).href, sizes: '512x512' }],
      });
    } catch { /* ignore */ }
  }
}

export const player = new Player();
