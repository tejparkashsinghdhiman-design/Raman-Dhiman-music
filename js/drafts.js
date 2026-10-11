// Drafts: unreleased songs. Everything here lives in this browser's IndexedDB.
// Nothing is ever uploaded, and nothing here is written to the GitHub repository.
import { $, esc, fmtTime, fmtBytes, timeAgo, slugify, toast, debounce } from './util.js';
import { icon, hydrateIcons } from './icons.js';
import { coverFor } from './cover.js';
import { player } from './player.js';
import * as lock from './lock.js';

const STATUSES = ['Idea', 'Writing', 'Demo', 'Recording', 'Mixing', 'Mastering', 'Ready'];
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
const shortMime = (m) => (m ? m.replace(/^audio\//, '').replace(/;.*$/, '').replace('x-', '').toUpperCase() : '');

// ---------- storage ----------
let dbp;
function db() {
  if (!dbp) {
    dbp = new Promise((res, rej) => {
      const rq = indexedDB.open('rd-drafts', 1);
      rq.onupgradeneeded = () => {
        const d = rq.result;
        if (!d.objectStoreNames.contains('drafts')) d.createObjectStore('drafts', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('blobs')) d.createObjectStore('blobs', { keyPath: 'id' });
      };
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error);
    });
  }
  return dbp;
}
const rp = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const txDone = (t) => new Promise((res, rej) => {
  t.oncomplete = () => res();
  t.onerror = () => rej(t.error);
  t.onabort = () => rej(t.error || new Error('Storage was interrupted'));
});

export async function listDrafts() { return rp((await db()).transaction('drafts').objectStore('drafts').getAll()); }
async function getDraft(id) { return rp((await db()).transaction('drafts').objectStore('drafts').get(id)); }
async function putDraft(d) {
  d.updatedAt = Date.now();
  const t = (await db()).transaction('drafts', 'readwrite');
  t.objectStore('drafts').put(d);
  await txDone(t);
}
async function putBlob(id, blob) {
  const t = (await db()).transaction('blobs', 'readwrite');
  t.objectStore('blobs').put({ id, blob });
  await txDone(t);
}
async function getBlob(id) {
  const r = await rp((await db()).transaction('blobs').objectStore('blobs').get(id));
  return r ? r.blob : null;
}
async function deleteTake(id) {
  const t = (await db()).transaction('blobs', 'readwrite');
  t.objectStore('blobs').delete(id);
  await txDone(t);
}
async function deleteDraft(d) {
  const t = (await db()).transaction(['drafts', 'blobs'], 'readwrite');
  for (const k of d.takes) t.objectStore('blobs').delete(k.id);
  t.objectStore('drafts').delete(d.id);
  await txDone(t);
}

const newDraft = (title = '') => ({
  id: uid(), title, status: 'Idea', bpm: '', key: '', tags: '', collaborators: '', lyrics: '', notes: '',
  takes: [], createdAt: Date.now(), updatedAt: Date.now(),
});
const isEmpty = (d) => !d.title.trim() && !d.takes.length && !d.lyrics.trim() && !d.notes.trim();

// ---------- audio helpers ----------
async function computePeaks(blob, n = 240) {
  const AC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!AC || blob.size > 150e6) return null;
  try {
    const ctx = new AC(1, 1, 44100);
    const ab = await ctx.decodeAudioData(await blob.arrayBuffer());
    const ch = ab.getChannelData(0);
    const step = Math.max(1, Math.floor(ch.length / n));
    const stride = Math.max(1, Math.floor(step / 48));
    const peaks = [];
    for (let i = 0; i < n; i++) {
      let m = 0;
      const end = Math.min(ch.length, (i + 1) * step);
      for (let j = i * step; j < end; j += stride) { const v = Math.abs(ch[j]); if (v > m) m = v; }
      peaks.push(Math.min(255, Math.round(m * 255)));
    }
    const top = Math.max(...peaks) || 1; // scale to this take's own loudest point so quiet recordings still show their shape
    return { peaks: peaks.map((v) => Math.round((v / top) * 255)), dur: ab.duration };
  } catch { return null; }
}
function metaDuration(blob) {
  return new Promise((res) => {
    const a = new Audio();
    const u = URL.createObjectURL(blob);
    const done = (v) => { URL.revokeObjectURL(u); res(v); };
    a.preload = 'metadata';
    a.onloadedmetadata = () => done(Number.isFinite(a.duration) ? a.duration : 0);
    a.onerror = () => done(0);
    setTimeout(() => done(0), 4000);
    a.src = u;
  });
}
function drawPeaks(cv, peaks, progress = 0) {
  const ctx = cv.getContext('2d');
  const w = cv.width, h = cv.height;
  const css = getComputedStyle(document.documentElement);
  const idle = css.getPropertyValue('--ink-3').trim() || '#8077B8';
  const done = css.getPropertyValue('--gold').trim() || '#FFB52E';
  ctx.clearRect(0, 0, w, h);
  if (!peaks) { ctx.fillStyle = idle; ctx.fillRect(0, h / 2 - 1, w, 2); return; }
  const n = peaks.length, bw = w / n;
  for (let i = 0; i < n; i++) {
    const v = Math.max(3, (peaks[i] / 255) * h);
    ctx.fillStyle = i / n < progress ? done : idle;
    ctx.fillRect(i * bw + 0.5, (h - v) / 2, Math.max(1, bw - 1.5), v);
  }
}

// ---------- recording ----------
function recordIdea() {
  return new Promise((resolve) => {
    (async () => {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
        toast('Recording isn’t supported in this browser.'); resolve(null); return;
      }
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      } catch { toast('Microphone access was blocked. Allow it in your browser’s site settings, then try again.'); resolve(null); return; }
      const mime = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find((t) => MediaRecorder.isTypeSupported(t)) || '';
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      const chunks = [];
      let keep = false;
      rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      const dlg = document.createElement('dialog');
      dlg.className = 'rec';
      dlg.setAttribute('aria-label', 'Recording');
      dlg.innerHTML = `<div class="rec-in"><span class="recdot" aria-hidden="true"></span><p class="rec-time" id="recT" role="timer">0:00</p>
        <p class="hint">Voice ideas are recorded in a compressed format. Keep your real takes as WAV or FLAC.</p>
        <div class="btnrow"><button class="btn primary" type="button" id="recStop">${icon('stop')} Stop and keep</button><button class="btn" type="button" id="recCancel">Discard</button></div></div>`;
      document.body.append(dlg);
      dlg.showModal();
      const t0 = Date.now();
      const timer = setInterval(() => { const el = dlg.querySelector('#recT'); if (el) el.textContent = fmtTime((Date.now() - t0) / 1000); }, 250);
      rec.onstop = () => {
        clearInterval(timer);
        stream.getTracks().forEach((t) => t.stop());
        dlg.close(); dlg.remove();
        const type = rec.mimeType || mime || 'audio/webm';
        resolve(keep && chunks.length ? { blob: new Blob(chunks, { type }), mime: type } : null);
      };
      dlg.querySelector('#recStop').addEventListener('click', () => { keep = true; if (rec.state !== 'inactive') rec.stop(); });
      dlg.querySelector('#recCancel').addEventListener('click', () => { keep = false; if (rec.state !== 'inactive') rec.stop(); });
      dlg.addEventListener('cancel', () => { keep = false; if (rec.state !== 'inactive') rec.stop(); });
      rec.start(1000);
    })();
  });
}

// ---------- view: lock + list ----------
let listMain = null;

export function mountDrafts(main) {
  listMain = main;
  if (!lock.isUnlocked()) renderLock(main); else renderList(main);
  return () => { listMain = null; if (lock.hasPin()) lock.relock(); };
}

function renderLock(main) {
  main.innerHTML = `<div class="lockscreen">
    <div class="lockicon">${icon('lock')}</div>
    <h1>Drafts are locked</h1>
    <form id="unlock" class="stack" autocomplete="off">
      <label class="field"><span>PIN</span><input id="pinIn" type="password" inputmode="numeric" maxlength="8" autocomplete="current-password" required></label>
      <button class="btn primary" type="submit">Unlock</button>
      <p class="hint" id="pinMsg" role="alert"></p>
    </form></div>`;
  const form = main.querySelector('#unlock');
  main.querySelector('#pinIn').focus();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const ok = await lock.verifyPin(main.querySelector('#pinIn').value);
    if (ok) { renderList(main); return; }
    main.querySelector('#pinMsg').textContent = 'That PIN isn’t right. Try again.';
    main.querySelector('#pinIn').select();
  });
}

function renderList(main) {
  main.innerHTML = `
  <header class="page-head">
    <h1>Drafts</h1>
    <p>Unreleased songs live here, on this device only. They are never uploaded or published.</p>
    <div class="btnrow">
      <button class="btn primary" type="button" data-d="new">${icon('plus')} New draft</button>
      <button class="btn" type="button" data-d="record">${icon('mic')} Record an idea</button>
      <button class="btn ghost" type="button" data-d="export">${icon('down')} Export backup</button>
      <button class="btn ghost" type="button" data-d="import">${icon('upload')} Import backup</button>
      <input type="file" id="importFile" accept="application/json,.json" hidden>
    </div>
  </header>
  <div id="draftList"><p class="empty">Loading…</p></div>`;
  main.querySelector('.page-head').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-d]');
    if (!b) return;
    if (b.dataset.d === 'new') { const d = newDraft(); await putDraft(d); openEditor(d.id); }
    else if (b.dataset.d === 'record') quickRecord();
    else if (b.dataset.d === 'export') exportAll();
    else if (b.dataset.d === 'import') main.querySelector('#importFile').click();
  });
  main.querySelector('#importFile').addEventListener('change', (e) => { if (e.target.files[0]) importBackup(e.target.files[0]); e.target.value = ''; });
  main.querySelector('#draftList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-open]');
    if (b) openEditor(b.dataset.open);
  });
  paintList();
}

async function paintList() {
  const box = listMain && listMain.querySelector('#draftList');
  if (!box) return;
  let list;
  try { list = await listDrafts(); } catch {
    box.innerHTML = '<p class="empty">This browser isn’t letting the app store drafts. Private browsing often blocks it. Open the app in a normal window.</p>';
    return;
  }
  list.sort((a, b) => b.updatedAt - a.updatedAt);
  if (!list.length) {
    box.innerHTML = `<div class="emptybox"><h2>No drafts yet</h2><p>Start with a title, a line of lyrics, or a quick voice idea. Everything saves as you go.</p></div>`;
    return;
  }
  box.innerHTML = `<ul class="dlist">${list.map((d) => `<li><button class="draft" type="button" data-open="${esc(d.id)}">
    <img class="cover" src="${esc(coverFor({ id: d.id }))}" alt="" width="56" height="56">
    <span class="draft-text"><b>${esc(d.title || 'Untitled')}</b><small>${d.takes.length} ${d.takes.length === 1 ? 'take' : 'takes'}${d.tags ? `, ${esc(d.tags)}` : ''}. Edited ${esc(timeAgo(d.updatedAt))}</small></span>
    <span class="chip st-${esc(d.status)}">${esc(d.status)}</span></button></li>`).join('')}</ul>`;
}

async function quickRecord() {
  const r = await recordIdea();
  if (!r) return;
  const d = newDraft(`Voice idea ${new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}`);
  await putDraft(d);
  await openEditor(d.id, async () => { await addTake(r.blob, 'Voice idea (compressed)', r.mime); });
}

// ---------- editor ----------
let cur = null;
let dlgEl = null;
const urls = new Map();
let saveFn = null;

function setSaved(text, bad = false) {
  const el = dlgEl && dlgEl.querySelector('#edSaved');
  if (el) { el.textContent = text; el.classList.toggle('bad', bad); }
}
function touch() { setSaved('Saving…'); if (saveFn) saveFn(); }

function editorHTML(d) {
  return `<div class="ed">
    <div class="ed-top">
      <button class="icon-btn" type="button" data-e="close" aria-label="Close editor">${icon('chevron')}</button>
      <span class="saved" id="edSaved" role="status">Saved on this device</span>
      <button class="btn" type="button" data-e="release">Prepare for release</button>
    </div>
    <label class="vh" for="edTitle">Song title</label>
    <input class="ed-title" id="edTitle" placeholder="Untitled song" value="${esc(d.title)}" autocomplete="off">
    <div class="ed-grid">
      <label class="field"><span>Stage</span><select id="edStatus">${STATUSES.map((s) => `<option${s === d.status ? ' selected' : ''}>${s}</option>`).join('')}</select></label>
      <label class="field"><span>Tempo (BPM)</span><input id="edBpm" type="number" min="30" max="300" inputmode="numeric" value="${esc(d.bpm)}"></label>
      <label class="field"><span>Key</span><input id="edKey" placeholder="For example, A minor" value="${esc(d.key)}"></label>
      <label class="field"><span>Tags</span><input id="edTags" placeholder="Mood, style, idea" value="${esc(d.tags)}"></label>
    </div>
    <section class="panel">
      <div class="panel-head"><h3>Audio takes</h3>
        <div class="btnrow"><button class="btn" type="button" data-e="addfile">${icon('upload')} Add audio</button><button class="btn" type="button" data-e="rec">${icon('mic')} Record</button></div>
        <input type="file" id="edFile" accept="audio/*,.wav,.flac,.mp3,.m4a,.aac,.ogg,.opus,.aif,.aiff" multiple hidden>
      </div>
      <ul id="edTakes" class="takes"></ul>
    </section>
    <section class="panel"><label class="h3" for="edLyrics">Lyrics</label><textarea id="edLyrics" rows="10" placeholder="Write lyrics here">${esc(d.lyrics)}</textarea></section>
    <section class="panel"><label class="h3" for="edNotes">Notes</label><textarea id="edNotes" rows="4" placeholder="References, ideas, things to fix in the mix">${esc(d.notes)}</textarea></section>
    <label class="field"><span>Collaborators</span><input id="edCollab" placeholder="Who is working on this song?" value="${esc(d.collaborators)}"></label>
    <div class="ed-foot"><button class="btn danger" type="button" data-e="delete">${icon('trash')} Delete draft</button></div>
  </div>`;
}

function renderTakes() {
  const ul = dlgEl.querySelector('#edTakes');
  if (!cur.takes.length) { ul.innerHTML = '<li class="empty">No audio yet. Add a file or record an idea.</li>'; return; }
  ul.innerHTML = cur.takes.map((tk) => `<li class="take" data-take="${esc(tk.id)}">
    <button class="icon-btn play" type="button" data-t="play" aria-label="Play ${esc(tk.label)}">${icon('play')}</button>
    <div class="take-main">
      <input class="take-label" data-t="label" value="${esc(tk.label)}" aria-label="Take name">
      <canvas class="wave" width="480" height="48" data-t="wave" aria-label="Waveform. Click to play from that point."></canvas>
      <small>${tk.dur ? fmtTime(tk.dur) + ', ' : ''}${fmtBytes(tk.size)}${tk.mime ? ', ' + esc(shortMime(tk.mime)) : ''}</small>
    </div>
    <button class="icon-btn" type="button" data-t="del" aria-label="Delete ${esc(tk.label)}">${icon('trash')}</button></li>`).join('');
  cur.takes.forEach((tk) => drawPeaks(ul.querySelector(`[data-take="${CSS.escape(tk.id)}"] canvas`), tk.peaks, 0));
  paintProgress();
}

function paintProgress() {
  if (!dlgEl || !cur) return;
  const c = player.current;
  cur.takes.forEach((tk) => {
    const cv = dlgEl.querySelector(`[data-take="${CSS.escape(tk.id)}"] canvas`);
    if (!cv) return;
    const mine = c && c.item.id === `draft:${tk.id}`;
    const d = player.duration;
    drawPeaks(cv, tk.peaks, mine && d ? player.currentTime / d : 0);
    const btn = cv.closest('.take').querySelector('[data-t="play"]');
    const playing = mine && !player.paused;
    btn.innerHTML = icon(playing ? 'pause' : 'play');
    btn.setAttribute('aria-label', `${playing ? 'Pause' : 'Play'} ${tk.label}`);
  });
}

function draftPlayable(d, tk, url) {
  return {
    id: `draft:${tk.id}`, kind: 'draft',
    title: `${d.title || 'Untitled'}${d.takes.length > 1 ? `, ${tk.label}` : ''}`,
    artists: ['Draft'], cover: coverFor({ id: d.id }), durationSec: tk.dur || 0, lyrics: d.lyrics || null,
    sources: { original: { src: url, format: shortMime(tk.mime) } },
  };
}

function playTake(tk, seekPct) {
  const id = `draft:${tk.id}`;
  if (player.current && player.current.item.id === id) {
    if (seekPct != null) { player.seek(seekPct * player.duration); if (player.paused) player.play(); } else player.toggle();
    return;
  }
  const items = cur.takes.filter((t) => urls.has(t.id)).map((t) => draftPlayable(cur, t, urls.get(t.id)));
  player.playList(items, id);
  if (seekPct != null && tk.dur) player.el.addEventListener('loadedmetadata', () => player.seek(seekPct * player.duration), { once: true });
}

async function addTake(blob, label, mime) {
  const tk = { id: uid(), label, mime: mime || blob.type || '', size: blob.size, dur: 0, peaks: null, addedAt: Date.now() };
  try { await putBlob(tk.id, blob); } catch {
    toast('Not enough storage to keep that file. Free some space or export a backup first.');
    return null;
  }
  const pk = await computePeaks(blob);
  if (pk) { tk.peaks = pk.peaks; tk.dur = pk.dur; } else tk.dur = await metaDuration(blob);
  urls.set(tk.id, URL.createObjectURL(blob));
  cur.takes.push(tk);
  if (!cur.title.trim()) {
    cur.title = label.replace(/\s*\(compressed\)$/, '');
    dlgEl.querySelector('#edTitle').value = cur.title;
  }
  touch();
  renderTakes();
  return tk;
}

async function openEditor(id, after) {
  const d = await getDraft(id);
  if (!d) return;
  cur = d;
  dlgEl = $('#draftDlg');
  if (!dlgEl.dataset.bound) {
    dlgEl.addEventListener('click', (e) => { if (e.target === dlgEl) dlgEl.close(); });
    dlgEl.dataset.bound = '1';
  }
  dlgEl.innerHTML = editorHTML(d);
  hydrateIcons(dlgEl);
  for (const tk of d.takes) {
    if (!urls.has(tk.id)) { const b = await getBlob(tk.id); if (b) urls.set(tk.id, URL.createObjectURL(b)); }
  }
  saveFn = debounce(async () => {
    if (!cur) return;
    try { await putDraft(cur); setSaved('Saved on this device'); } catch { setSaved('Couldn’t save. Storage may be full.', true); }
  }, 500);
  renderTakes();
  wireEditor();
  const onTime = () => paintProgress();
  player.addEventListener('time', onTime);
  player.addEventListener('track', onTime);
  player.addEventListener('state', onTime);
  dlgEl.addEventListener('close', async () => {
    player.removeEventListener('time', onTime);
    player.removeEventListener('track', onTime);
    player.removeEventListener('state', onTime);
    const done = cur;
    cur = null;
    if (done) {
      try { if (isEmpty(done)) await deleteDraft(done); else await putDraft(done); } catch { /* storage unavailable */ }
    }
    paintList();
  }, { once: true });
  dlgEl.showModal();
  if (after) await after();
}

function wireEditor() {
  const dlg = dlgEl;
  const root = dlg.querySelector('.ed'); // replaced on every open, so its listeners never pile up
  const bind = (sel, key) => dlg.querySelector(sel).addEventListener('input', (e) => { cur[key] = e.target.value; touch(); });
  bind('#edTitle', 'title'); bind('#edStatus', 'status'); bind('#edBpm', 'bpm'); bind('#edKey', 'key');
  bind('#edTags', 'tags'); bind('#edLyrics', 'lyrics'); bind('#edNotes', 'notes'); bind('#edCollab', 'collaborators');
  dlg.querySelector('#edStatus').addEventListener('change', (e) => { cur.status = e.target.value; touch(); });

  dlg.querySelector('#edFile').addEventListener('change', async (e) => {
    for (const f of e.target.files) {
      if (!f.type.startsWith('audio/') && !/\.(wav|flac|mp3|m4a|aac|ogg|opus|aif|aiff|webm)$/i.test(f.name)) { toast(`${f.name} doesn’t look like an audio file.`); continue; }
      await addTake(f, f.name.replace(/\.[^.]+$/, ''), f.type);
    }
    e.target.value = '';
  });

  root.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-e]');
    if (b) {
      const a = b.dataset.e;
      if (a === 'close') dlg.close();
      else if (a === 'addfile') dlg.querySelector('#edFile').click();
      else if (a === 'rec') { const r = await recordIdea(); if (r) await addTake(r.blob, 'Voice idea (compressed)', r.mime); }
      else if (a === 'release') releaseDialog(cur);
      else if (a === 'delete') {
        if (confirm(`Delete “${cur.title || 'Untitled'}” and its audio from this device? This can’t be undone.`)) {
          const d = cur; cur = null;
          for (const tk of d.takes) { const u = urls.get(tk.id); if (u) { URL.revokeObjectURL(u); urls.delete(tk.id); } }
          try { await deleteDraft(d); } catch { toast('Couldn’t delete the draft. Try again.'); }
          dlg.close();
        }
      }
      return;
    }
    const t = e.target.closest('[data-t]');
    if (!t) return;
    const li = t.closest('.take');
    const tk = li && cur.takes.find((x) => x.id === li.dataset.take);
    if (!tk) return;
    if (t.dataset.t === 'play') playTake(tk);
    else if (t.dataset.t === 'wave') { const r = t.getBoundingClientRect(); playTake(tk, Math.min(1, Math.max(0, (e.clientX - r.left) / r.width))); }
    else if (t.dataset.t === 'del') {
      if (!confirm(`Delete the take “${tk.label}”?`)) return;
      cur.takes = cur.takes.filter((x) => x.id !== tk.id);
      const u = urls.get(tk.id); if (u) { URL.revokeObjectURL(u); urls.delete(tk.id); }
      try { await deleteTake(tk.id); } catch { /* ignore */ }
      touch(); renderTakes();
    }
  });
  root.addEventListener('input', (e) => {
    const t = e.target.closest('[data-t="label"]');
    if (!t) return;
    const tk = cur.takes.find((x) => x.id === t.closest('.take').dataset.take);
    if (tk) { tk.label = t.value; touch(); }
  });
}

// ---------- release checklist ----------
function releaseDialog(d) {
  const slug = slugify(d.title || 'untitled');
  const entry = {
    id: slug, title: d.title || 'Untitled', artists: ['Raman Dhiman'], type: 'Single',
    year: new Date().getFullYear(), releaseDate: new Date().toISOString().slice(0, 10), durationSec: null,
    credits: [], lyrics: d.lyrics || null, links: { spotify: null, apple: null, youtube: null }, audio: {},
  };
  const json = JSON.stringify(entry, null, 2);
  const dlg = document.createElement('dialog');
  dlg.className = 'sheet narrow';
  dlg.setAttribute('aria-label', 'Prepare for release');
  dlg.innerHTML = `<div class="ed">
    <div class="ed-top"><button class="icon-btn" type="button" data-r="close" aria-label="Close">${icon('x')}</button><h2 class="grow">Prepare “${esc(entry.title)}” for release</h2></div>
    <ol class="steps">
      <li>Export the final mix from your music software as <b>FLAC</b> (or WAV) and name it <code>${esc(slug)}.flac</code>.</li>
      <li>On GitHub, open the <code>audio/lossless</code> folder, choose Add file, then Upload files. The website accepts files up to 25 MB. For larger files, use GitHub Desktop or git.</li>
      <li>Open <code>data/catalog.json</code>, add the entry below to the <code>tracks</code> list, and commit.</li>
      <li>Within a few minutes the app builds the High and Data saver versions and fills in the sound details by itself.</li>
    </ol>
    <label class="field"><span>Catalog entry</span><textarea readonly rows="14" id="relJson">${esc(json)}</textarea></label>
    <div class="btnrow"><button class="btn primary" type="button" data-r="copy">Copy entry</button><button class="btn" type="button" data-r="ready">Mark draft as Ready</button></div>
  </div>`;
  document.body.append(dlg);
  hydrateIcons(dlg);
  dlg.showModal();
  dlg.addEventListener('close', () => dlg.remove());
  dlg.addEventListener('click', async (e) => {
    if (e.target === dlg) { dlg.close(); return; }
    const b = e.target.closest('[data-r]');
    if (!b) return;
    if (b.dataset.r === 'close') dlg.close();
    else if (b.dataset.r === 'copy') {
      try { await navigator.clipboard.writeText(json); toast('Entry copied'); } catch { dlg.querySelector('#relJson').select(); toast('Press Ctrl+C or Cmd+C to copy.'); }
    } else if (b.dataset.r === 'ready') {
      cur.status = 'Ready';
      const sel = dlgEl.querySelector('#edStatus');
      if (sel) sel.value = 'Ready';
      touch();
      toast('Marked as Ready');
    }
  });
}

// ---------- backup ----------
const toDataURL = (blob) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(blob); });
function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

async function exportAll() {
  const drafts = await listDrafts();
  if (!drafts.length) { toast('There are no drafts to export yet.'); return; }
  toast('Preparing your backup. Large audio files can take a moment.');
  const parts = [`{"app":"raman-dhiman-drafts","version":1,"exportedAt":${JSON.stringify(new Date().toISOString())},"drafts":[`];
  for (let i = 0; i < drafts.length; i++) {
    const takes = [];
    for (const tk of drafts[i].takes) { const b = await getBlob(tk.id); takes.push({ ...tk, data: b ? await toDataURL(b) : null }); }
    parts.push((i ? ',' : '') + JSON.stringify({ ...drafts[i], takes }));
  }
  parts.push(']}');
  download(new Blob(parts, { type: 'application/json' }), `raman-drafts-${new Date().toISOString().slice(0, 10)}.json`);
  toast('Backup saved to your downloads. Keep it somewhere private.');
}

async function importBackup(file) {
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'raman-dhiman-drafts' || !Array.isArray(data.drafts)) throw new Error('not a drafts backup');
    const existing = new Set((await listDrafts()).map((d) => d.id));
    let n = 0;
    for (const d of data.drafts) {
      const takes = [];
      for (const tk of d.takes || []) {
        const { data: url, ...meta } = tk;
        if (url) await putBlob(meta.id, await (await fetch(url)).blob());
        takes.push(meta);
      }
      const copy = { ...newDraft(), ...d, takes };
      if (existing.has(copy.id)) { copy.id = uid(); copy.title = `${copy.title || 'Untitled'} (imported)`; }
      await putDraft(copy);
      n++;
    }
    toast(`Imported ${n} ${n === 1 ? 'draft' : 'drafts'}`);
    paintList();
  } catch {
    toast('That file isn’t a Drafts backup from this app.');
  }
}
