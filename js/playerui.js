// Everything you see and touch for playback: bar, now-playing sheet, quality menu, queue, shortcuts.
import { $, esc, fmtTime, fmtBytes, toast } from './util.js';
import { icon, hydrateIcons } from './icons.js';
import { player, TIERS, specText } from './player.js';
import { mountString } from './viz.js';
import { toggleOffline, share, isItemSaved, offlinePick } from './actions.js';

const BASE_TITLE = document.title;
const QUALITY_KEYS = ['auto', 'lossless', 'high', 'standard'];

export function initPlayerUI() {
  hydrateIcons();
  const bar = $('#pb');
  const now = $('#now');
  const qmenu = $('#qmenu');
  const el = {
    pbSeek: $('#pbSeek'), pbCur: $('#pbCur'), pbDur: $('#pbDur'),
    nowSeek: $('#nowSeek'), nowCur: $('#nowCur'), nowDur: $('#nowDur'),
    vol: $('#pbVol'), qchip: $('#pbQuality'), qlabel: $('#pbQLabel'),
  };
  let dragging = false;
  let rafId = 0;
  let nowStr = null;

  const tierName = (c) => (c.tier === 'original' ? 'Draft' : TIERS[c.tier].label);

  // ---------- text helpers ----------
  function streamText(c) {
    if (!c) return '';
    if (c.tier === 'original') return `Your original file${c.spec.format ? `, ${c.spec.format}` : ''}. It plays exactly as saved.`;
    if (c.tier === 'preview') return '30-second preview from Apple Music. Full-length audio for this track isn’t uploaded yet.';
    const spec = specText(c.tier, c.spec);
    let s = `${TIERS[c.tier].label}${spec ? `: ${spec}` : ''}.`;
    if (c.fellBack) s += ` ${TIERS[c.requested] ? TIERS[c.requested].label : 'That quality'} isn’t available for this track yet.`;
    else if (player.quality === 'auto') s += ' Chosen automatically for your connection.';
    return s;
  }

  function optionsHTML(role) {
    const c = player.current;
    const src = c ? c.item.sources : null;
    return QUALITY_KEYS.map((k) => {
      let label = k === 'auto' ? 'Auto' : TIERS[k].label;
      let hint;
      if (k === 'auto') hint = `Right now: ${TIERS[player.autoTier()].label}. Saves data on slow connections.`;
      else if (!src || src.original) hint = TIERS[k].blurb;
      else if (src[k] && src[k].src) hint = [specText(k, src[k]), src[k].bytes ? fmtBytes(src[k].bytes) : ''].filter(Boolean).join(' · ') || TIERS[k].blurb;
      else hint = 'Not uploaded for this track yet';
      const on = player.quality === k;
      return `<button type="button" class="qopt${on ? ' on' : ''}" role="${role}" aria-checked="${on}" data-q="${k}">
        <span class="qopt-main"><b>${label}</b><small>${esc(hint)}</small></span>${on ? icon('check') : ''}</button>`;
    }).join('');
  }

  function renderQuality() {
    $('#nowQuality').innerHTML =
      optionsHTML('radio') +
      '<p class="hint">Lossless files are delivered untouched. Your device or browser may still resample the sound on its way to the speakers.</p>';
    if (!qmenu.hidden) qmenu.innerHTML = optionsHTML('menuitemradio');
  }

  function paintChip() {
    const c = player.current;
    let name, cls = '', tip = 'Choose sound quality';
    if (!c) name = player.quality === 'auto' ? 'Auto' : TIERS[player.quality].label;
    else {
      name = tierName(c);
      cls = ` q-${c.tier}`;
      if (c.fellBack && c.tier !== 'original') tip = `${TIERS[c.requested] ? TIERS[c.requested].label : 'Your chosen quality'} isn’t available for this track, so it’s playing in ${name}.`;
      if (player.quality === 'auto' && c.tier !== 'original') name = `Auto · ${name}`;
    }
    el.qlabel.textContent = name;
    el.qchip.className = `qchip${cls}`;
    el.qchip.title = tip;
  }

  // ---------- painting ----------
  function paintTrack() {
    const c = player.current;
    bar.hidden = !c;
    document.body.classList.toggle('has-player', !!c);
    paintChip();
    renderQuality();
    if (!c) { document.title = BASE_TITLE; return; }
    const it = c.item;
    const artists = it.artists.join(', ');
    $('#pbCover').src = it.cover;
    $('#pbTitle').textContent = it.title;
    $('#pbSub').textContent = artists;
    $('#nowCover').src = it.cover;
    $('#nowTitle').textContent = it.title;
    $('#nowSub').textContent = artists + (it.year ? `, ${it.year}` : '');
    $('#nowStream').textContent = streamText(c);
    $('#nowKind').textContent = it.kind === 'draft' ? 'Draft, only on this device' : 'Now playing';
    $('#nowLyricsWrap').hidden = !it.lyrics;
    $('#nowLyrics').textContent = it.lyrics || '';
    document.title = `${it.title} · Raman Dhiman`;
    renderQueue();
    paintSave();
    paintState();
    paintTime();
    document.dispatchEvent(new CustomEvent('rd:track'));
  }

  async function paintSave() {
    const b = $('#nowSave');
    const it = player.current && player.current.item;
    $('#nowShare').innerHTML = `${icon('share')} Share`;
    $('#nowShare').hidden = !it || it.kind !== 'release';
    if (!it || it.kind !== 'release') { b.hidden = true; return; }
    b.hidden = false;
    const saved = await isItemSaved(it);
    b.disabled = !saved && !offlinePick(it);
    b.setAttribute('aria-pressed', String(saved));
    b.innerHTML = saved ? `${icon('check')} Saved offline` : `${icon('down')} Save offline`;
  }

  function paintState() {
    const playing = !!player.current && !player.paused;
    for (const id of ['#pbPlay', '#nowPlay']) {
      const b = $(id);
      b.innerHTML = icon(playing ? 'pause' : 'play');
      b.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    }
    document.body.dataset.playing = playing ? '1' : '0';
    if (playing) startLoop(); else { stopLoop(); paintTime(); }
    const sh = $('#nowShuffle');
    sh.setAttribute('aria-pressed', String(player.shuffle));
    sh.classList.toggle('on', player.shuffle);
    const rp = $('#nowRepeat');
    rp.classList.toggle('on', player.repeat !== 'off');
    rp.setAttribute('aria-label', `Repeat: ${player.repeat}`);
    rp.dataset.mode = player.repeat;
  }

  function paintTime() {
    if (dragging) return;
    const d = player.duration;
    const t = player.currentTime;
    const v = d > 0 ? Math.min(1000, Math.round((t / d) * 1000)) : 0;
    for (const [seek, cur, dur] of [[el.pbSeek, el.pbCur, el.pbDur], [el.nowSeek, el.nowCur, el.nowDur]]) {
      seek.value = v;
      seek.style.setProperty('--p', `${v / 10}%`);
      cur.textContent = fmtTime(t);
      dur.textContent = d ? fmtTime(d) : '';
    }
  }
  function startLoop() {
    if (rafId) return;
    const tick = () => { paintTime(); rafId = requestAnimationFrame(tick); };
    rafId = requestAnimationFrame(tick);
  }
  function stopLoop() { cancelAnimationFrame(rafId); rafId = 0; }

  function renderQueue() {
    const ol = $('#nowQueue');
    const q = player.queue;
    if (!q.length) { ol.innerHTML = '<li class="empty">Nothing queued yet.</li>'; return; }
    ol.innerHTML = q.map((p, i) => `<li><button type="button" class="qrow${i === player.idx ? ' is-current' : ''}" data-i="${i}"${i === player.idx ? ' aria-current="true"' : ''}>
      <img src="${esc(p.cover)}" alt="" width="40" height="40"><span><b>${esc(p.title)}</b><small>${esc(p.artists.join(', '))}</small></span></button></li>`).join('');
  }

  function paintVolume() {
    el.vol.value = Math.round(player.volume * 100);
    el.vol.style.setProperty('--p', `${el.vol.value}%`);
    $('#pbMute').innerHTML = icon(player.muted || player.volume === 0 ? 'mute' : 'volume');
    $('#pbMute').setAttribute('aria-label', player.muted ? 'Unmute' : 'Mute');
  }

  // ---------- quality menu ----------
  function openMenu() {
    qmenu.innerHTML = optionsHTML('menuitemradio');
    qmenu.hidden = false;
    el.qchip.setAttribute('aria-expanded', 'true');
    const first = qmenu.querySelector('.qopt.on') || qmenu.querySelector('.qopt');
    if (first) first.focus();
  }
  function closeMenu(refocus) {
    if (qmenu.hidden) return;
    qmenu.hidden = true;
    el.qchip.setAttribute('aria-expanded', 'false');
    if (refocus) el.qchip.focus();
  }
  function pickQuality(q) {
    player.setQuality(q);
    const c = player.current;
    if (!c || c.tier === 'original') toast(`Default sound quality: ${q === 'auto' ? 'Auto' : TIERS[q].label}`);
    else if (q === 'auto') toast(`Auto quality is on. Playing ${tierName(c)}.`);
    else if (c.tier === q) toast(`Switched to ${TIERS[q].label}`);
    else toast(`${TIERS[q].label} isn’t available for this track yet. Playing ${tierName(c)}.`);
    renderQuality();
  }
  el.qchip.addEventListener('click', () => (qmenu.hidden ? openMenu() : closeMenu()));
  for (const host of [qmenu, $('#nowQuality')]) {
    host.addEventListener('click', (e) => {
      const b = e.target.closest('[data-q]');
      if (!b) return;
      pickQuality(b.dataset.q);
      if (host === qmenu) closeMenu(true);
    });
  }
  qmenu.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); closeMenu(true); return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = [...qmenu.querySelectorAll('.qopt')];
    const i = items.indexOf(document.activeElement);
    items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
  });
  document.addEventListener('click', (e) => { if (!qmenu.hidden && !e.target.closest('#qmenu, #pbQuality')) closeMenu(); });

  // ---------- transport wiring ----------
  const on = (sel, ev, fn) => $(sel).addEventListener(ev, fn);
  on('#pbPlay', 'click', () => player.toggle());
  on('#nowPlay', 'click', () => player.toggle());
  on('#pbPrev', 'click', () => player.prev());
  on('#nowPrev', 'click', () => player.prev());
  on('#pbNext', 'click', () => player.next());
  on('#nowNext', 'click', () => player.next());
  on('#nowShuffle', 'click', () => player.toggleShuffle());
  on('#nowRepeat', 'click', () => player.cycleRepeat());
  on('#pbMute', 'click', () => player.toggleMute());
  el.vol.addEventListener('input', () => player.setVolume(el.vol.value / 100));

  for (const [seek, cur] of [[el.pbSeek, el.pbCur], [el.nowSeek, el.nowCur]]) {
    seek.addEventListener('input', () => {
      dragging = true;
      seek.style.setProperty('--p', `${seek.value / 10}%`);
      cur.textContent = fmtTime((seek.value / 1000) * player.duration);
    });
    seek.addEventListener('change', () => {
      player.seek((seek.value / 1000) * player.duration);
      dragging = false;
      paintTime();
    });
  }

  $('#nowQueue').addEventListener('click', (e) => {
    const b = e.target.closest('[data-i]');
    if (b) player.jump(Number(b.dataset.i));
  });
  $('#nowSleep').addEventListener('change', (e) => {
    const v = e.target.value;
    player.setSleep(v === 'end' ? 'end' : Number(v));
    toast(v === '0' ? 'Sleep timer off' : v === 'end' ? 'Music will stop after this track' : `Music will fade out in ${v} minutes`);
  });
  $('#nowSave').addEventListener('click', async (e) => {
    const it = player.current && player.current.item;
    if (!it) return;
    const b = e.currentTarget;
    b.disabled = true;
    await toggleOffline(it, (p) => { b.textContent = `Saving ${Math.round(p * 100)}%`; });
    paintSave();
  });
  $('#nowShare').addEventListener('click', () => { if (player.current) share(player.current.item); });

  // ---------- now-playing sheet ----------
  function openNow() {
    if (!player.current || now.open) return;
    now.showModal();
    nowStr = mountString($('#nowString'), { wave: () => player.getWave(), playing: () => !player.paused }, { thickness: 2.6, amp: 0.36 });
  }
  on('#pbOpen', 'click', openNow);
  on('#nowClose', 'click', () => now.close());
  now.addEventListener('click', (e) => { if (e.target === now) now.close(); });
  now.addEventListener('close', () => { if (nowStr) { nowStr.destroy(); nowStr = null; } });

  // ---------- keyboard ----------
  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || !player.current) return;
    const t = e.target;
    const typing = t.closest && t.closest('input:not([type=range]), textarea, select, [contenteditable=true]');
    if (typing) return;
    const onControl = t.closest && t.closest('button, a, summary, [role=menuitemradio], [role=radio]');
    if (e.key === ' ' && !onControl && !(t.type === 'range')) { e.preventDefault(); player.toggle(); }
    else if (e.key === 'ArrowRight' && t.type !== 'range') { player.seek(player.currentTime + 5); }
    else if (e.key === 'ArrowLeft' && t.type !== 'range') { player.seek(player.currentTime - 5); }
    else if (e.key === 'n' || e.key === 'N') player.next();
    else if (e.key === 'p' || e.key === 'P') player.prev();
    else if (e.key === 'm' || e.key === 'M') player.toggleMute();
  });

  // ---------- player events ----------
  player.on('track', paintTrack);
  player.on('state', paintState);
  player.on('time', () => { if (player.paused) paintTime(); });
  player.on('buffering', (b) => document.body.classList.toggle('buffering', !!b));
  player.on('quality', () => { paintChip(); renderQuality(); });
  player.on('queue', renderQueue);
  player.on('modes', paintState);
  player.on('volume', paintVolume);
  player.on('sleep', (s) => { if (!s) $('#nowSleep').value = '0'; });
  player.on('nosource', (it) => toast(`“${it.title}” has no audio in this app yet. Listen on Spotify or Apple Music instead.`));
  document.addEventListener('rd:saved', paintSave);

  paintVolume();
  paintChip();
  paintState();
}
