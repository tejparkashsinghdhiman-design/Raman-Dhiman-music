// Settings: sound quality, appearance, offline library, drafts lock, install.
import { esc, fmtBytes, ls, toast, timeAgo, isIOS } from './util.js';
import { icon } from './icons.js';
import { player } from './player.js';
import * as offline from './offline.js';
import * as lock from './lock.js';

export const APP_VERSION = '1.0.0';

const radio = (name, items, current) =>
  items.map(([v, label, hint]) =>
    `<label class="opt"><input type="radio" name="${name}" value="${v}"${current === v ? ' checked' : ''}><span><b>${label}</b><small>${hint}</small></span></label>`
  ).join('');

export function renderSettings(main, state, api) {
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const canInstall = !!window.__rdInstall && !standalone;
  const iosHint = isIOS() && !standalone;
  const theme = ls.get('theme', 'auto');

  main.innerHTML = `
  <div id="setRoot">
  <header class="page-head"><h1>Settings</h1><p>Saved on this device.</p></header>

  <section class="block" aria-labelledby="setQ">
    <h2 id="setQ">Sound quality</h2>
    <div class="opts" role="radiogroup" aria-labelledby="setQ">${radio('quality', [
      ['auto', 'Auto', 'Lossless on a good connection, lower quality on slow networks or in your phone’s data saver mode.'],
      ['lossless', 'Lossless', 'Original quality. Roughly 25 to 40 MB per song.'],
      ['high', 'High', 'MP3 at 320 kbps. Roughly 8 to 10 MB per song.'],
      ['standard', 'Data saver', 'MP3 at 128 kbps. Roughly 3 to 4 MB per song.'],
    ], player.quality)}</div>
    <label class="switch"><input type="checkbox" id="vizToggle"${player.vizOn ? ' checked' : ''}><span><b>Sound-reactive string</b><small>Moves with the music. Turn off to save battery. Takes effect next time you press play.</small></span></label>
  </section>

  <section class="block" aria-labelledby="setT">
    <h2 id="setT">Appearance</h2>
    <div class="opts row" role="radiogroup" aria-labelledby="setT">${radio('theme', [
      ['auto', 'Match my device', ''], ['dark', 'Dark', ''], ['light', 'Light', ''],
    ], theme)}</div>
  </section>

  <section class="block" aria-labelledby="setO">
    <h2 id="setO">Offline</h2>
    <p class="hint" id="storageLine">Checking storage…</p>
    <ul class="offlist" id="offList"><li class="empty">Loading…</li></ul>
    <div class="btnrow"><button class="btn" type="button" id="persistBtn" hidden>Keep my saved files from being cleared</button></div>
  </section>

  <section class="block" aria-labelledby="setL">
    <h2 id="setL">Drafts privacy</h2>
    ${lock.hasPin()
      ? `<p>A screen lock is on for Drafts.${lock.isUnlocked() ? '' : ' Open Drafts and enter your PIN before changing it.'}</p>
         <div class="btnrow"><button class="btn" type="button" id="pinOff"${lock.isUnlocked() ? '' : ' disabled'}>${icon('lock')} Turn off screen lock</button></div>`
      : `<p>Drafts never leave this device. Add a PIN if other people use it.</p>
         <form id="pinForm" class="stack" autocomplete="off">
           <label class="field"><span>New PIN, 4 to 8 digits</span><input id="pin1" type="password" inputmode="numeric" pattern="[0-9]{4,8}" minlength="4" maxlength="8" autocomplete="new-password" required></label>
           <label class="field"><span>Repeat PIN</span><input id="pin2" type="password" inputmode="numeric" pattern="[0-9]{4,8}" minlength="4" maxlength="8" autocomplete="new-password" required></label>
           <div class="btnrow"><button class="btn" type="submit">${icon('lock')} Turn on screen lock</button></div>
         </form>`}
    <p class="hint">This is a screen lock, not encryption. It keeps casual eyes out. To protect drafts from someone with full access to the device, use the device’s own lock and encryption.</p>
  </section>

  <section class="block" aria-labelledby="setA">
    <h2 id="setA">App</h2>
    <div class="btnrow">
      ${canInstall ? `<button class="btn primary" type="button" id="installBtn">${icon('down')} Install the app</button>` : ''}
      <button class="btn" type="button" id="syncBtn">${icon('refresh')} Check for new data</button>
    </div>
    ${iosHint ? '<p class="hint">On iPhone or iPad, tap Share, then Add to Home Screen to install.</p>' : ''}
    <p class="hint">Version ${APP_VERSION}. Data last synced ${esc(state.stats && state.stats.updatedAt ? timeAgo(state.stats.updatedAt) : 'never')}.</p>
  </section>
  </div>`;

  const root = main.querySelector('#setRoot');

  root.addEventListener('change', (e) => {
    const t = e.target;
    if (t.name === 'quality') { player.setQuality(t.value); toast(`Default sound quality: ${t.value === 'auto' ? 'Auto' : t.parentElement.querySelector('b').textContent}`); }
    else if (t.name === 'theme') api.applyTheme(t.value);
    else if (t.id === 'vizToggle') { player.vizOn = t.checked; ls.set('viz', t.checked); }
  });

  root.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.id === 'installBtn' && window.__rdInstall) {
      window.__rdInstall.prompt();
      await window.__rdInstall.userChoice.catch(() => {});
      window.__rdInstall = null;
      b.remove();
    } else if (b.id === 'syncBtn') api.refreshAll({ manual: true });
    else if (b.id === 'pinOff') {
      if (confirm('Turn off the Drafts screen lock?')) { lock.removePin(); toast('Screen lock is off'); renderSettings(main, state, api); }
    } else if (b.id === 'persistBtn') {
      const ok = navigator.storage && (await navigator.storage.persist());
      toast(ok ? 'Done. Your browser will keep your saved files and drafts.' : 'Your browser declined. It may ask again when you install the app.');
      paintStorage();
    } else if (b.dataset.rm) {
      await offline.remove(b.dataset.rm);
      document.dispatchEvent(new CustomEvent('rd:saved'));
      paintOffline();
    }
  });

  const pinForm = root.querySelector('#pinForm');
  if (pinForm) {
    pinForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const a = root.querySelector('#pin1').value;
      const c = root.querySelector('#pin2').value;
      if (!/^\d{4,8}$/.test(a)) { toast('Use 4 to 8 digits.'); return; }
      if (a !== c) { toast('The two PINs don’t match.'); return; }
      await lock.setPin(a);
      toast('Screen lock is on for Drafts');
      renderSettings(main, state, api);
    });
  }

  async function paintStorage() {
    const line = root.querySelector('#storageLine');
    const btn = root.querySelector('#persistBtn');
    if (!line) return;
    try {
      const est = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null;
      const persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : false;
      line.textContent = est
        ? `This app is using ${fmtBytes(est.usage)} of the ${fmtBytes(est.quota)} your browser allows. ${persisted ? 'Your browser will keep it.' : 'Your browser may clear it if the device runs low on space.'}`
        : 'Storage details aren’t available in this browser.';
      if (btn) btn.hidden = persisted || !(navigator.storage && navigator.storage.persist);
    } catch { line.textContent = ''; }
  }

  async function paintOffline() {
    const box = root.querySelector('#offList');
    if (!box) return;
    const items = await offline.list();
    if (!root.isConnected) return;
    const byUrl = new Map();
    for (const t of (state.catalog && state.catalog.tracks) || []) {
      for (const k of ['lossless', 'high', 'standard']) {
        const s = t.audio && t.audio[k] && t.audio[k].src;
        if (s) byUrl.set(new URL(s, location.href).href, { t, k });
      }
    }
    box.innerHTML = items.length
      ? items.map((i) => {
          const m = byUrl.get(i.url);
          return `<li><span><b>${esc(m ? m.t.title : i.url.split('/').pop())}</b><small>${m ? esc(m.k) : ''} ${i.bytes ? '· ' + fmtBytes(i.bytes) : ''}</small></span><button class="icon-btn" type="button" data-rm="${esc(i.url)}" aria-label="Remove ${esc(m ? m.t.title : 'file')} from offline storage">${icon('trash')}</button></li>`;
        }).join('')
      : '<li class="empty">Nothing saved yet. Use the download button next to a song.</li>';
  }

  paintStorage();
  paintOffline();
  const onSaved = () => root.isConnected && paintOffline();
  document.addEventListener('rd:saved', onSaved);
  return () => document.removeEventListener('rd:saved', onSaved);
}
