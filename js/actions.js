// Actions shared by several screens: save-offline toggle and sharing.
import { toast, fmtBytes } from './util.js';
import { player, TIERS } from './player.js';
import * as offline from './offline.js';

/** The file that would be saved for this item under the current quality setting. */
export function offlinePick(item) {
  if (!item || item.kind !== 'release') return null;
  const pick = player.resolve(item);
  return pick && pick.tier !== 'preview' ? pick : null;
}

export async function isItemSaved(item) {
  if (!item || !item.sources) return false;
  for (const k of ['lossless', 'high', 'standard']) {
    const s = item.sources[k];
    if (s && s.src && (await offline.isSaved(s.src))) return true;
  }
  return false;
}

export async function toggleOffline(item, onProgress) {
  if (!offline.supported) { toast('Offline saving is not supported in this browser.'); return false; }
  if (await isItemSaved(item)) {
    for (const k of ['lossless', 'high', 'standard']) {
      const s = item.sources[k];
      if (s && s.src) await offline.remove(s.src);
    }
    toast(`Removed “${item.title}” from offline storage`);
    document.dispatchEvent(new CustomEvent('rd:saved'));
    return false;
  }
  const pick = offlinePick(item);
  if (!pick) { toast('Only full-length tracks can be saved. Previews and drafts are not saved offline.'); return false; }
  try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch { /* optional */ }
  toast(`Saving “${item.title}” as ${TIERS[pick.tier].label}${pick.spec.bytes ? ` (${fmtBytes(pick.spec.bytes)})` : ''}…`);
  try {
    await offline.save(pick.src, onProgress);
    toast(`“${item.title}” is ready offline`);
    document.dispatchEvent(new CustomEvent('rd:saved'));
    return true;
  } catch (e) {
    toast(`Couldn't save “${item.title}”. ${e && e.message ? e.message : ''}`.trim());
    return false;
  }
}

export async function share(item) {
  const url = new URL(`#/track/${encodeURIComponent(item.id)}`, location.href.split('#')[0]).href;
  const data = { title: `${item.title} by Raman Dhiman`, text: `Listen to ${item.title} by Raman Dhiman`, url };
  try {
    if (navigator.share) { await navigator.share(data); return; }
    await navigator.clipboard.writeText(url);
    toast('Link copied');
  } catch (e) {
    if (e && e.name === 'AbortError') return;
    toast('Couldn’t share. Copy the address from your browser instead.');
  }
}
