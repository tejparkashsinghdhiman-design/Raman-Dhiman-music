// Stats screen. Every number says where it came from and how fresh it is.
import { esc, fmtNum, fmtDate, timeAgo } from './util.js';
import { icon } from './icons.js';
import { sortTracks, coverage, bestTier } from './merge.js';
import { TIERS } from './player.js';

const DAY = 86400000;
const PILL = {
  ok: ['Live', 'ok'],
  snapshot: ['Snapshot', 'warn'],
  stale: ['Out of date', 'warn'],
  not_configured: ['Not connected', 'off'],
  error: ['Failed', 'bad'],
};

function spark(values) {
  if (values.length < 2) return '';
  const w = 96, h = 28;
  const min = Math.min(...values), max = Math.max(...values), span = max - min || 1;
  const pts = values.map((v, i) => `${((i / (values.length - 1)) * w).toFixed(1)},${(h - 3 - ((v - min) / span) * (h - 6)).toFixed(1)}`).join(' ');
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" role="img" aria-label="Trend over the last ${values.length} checks"><polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

const row = (label, value, hint = '', extra = '') =>
  `<div class="lrow"><dt>${label}${hint ? `<small>${hint}</small>` : ''}</dt><dd><span class="num${value === '—' ? ' na' : ''}">${value}</span>${extra}</dd></div>`;

const pill = (status, text) => {
  const [label, tone] = PILL[status] || ['Unknown', 'off'];
  return `<span class="pill ${tone}">${esc(text || label)}</span>`;
};

export function renderStats(main, state) {
  const stats = state.stats || {};
  const src = stats.sources || {};
  const sp = src.spotify || {};
  const lis = sp.listeners || {};
  const api = sp.api || {};
  const yt = src.youtube || {};
  const tracks = (state.catalog && state.catalog.tracks) || [];
  const cov = coverage(tracks);
  const history = (stats.history || []).map((h) => h.monthlyListeners).filter((n) => Number.isFinite(n));

  const asOfMs = lis.asOf ? Date.parse(lis.asOf) : NaN;
  const lisStale = Number.isFinite(asOfMs) && Date.now() - asOfMs > 3 * DAY;
  const years = tracks.map((t) => t.year).filter(Boolean);
  const range = years.length ? `${Math.min(...years)} to ${Math.max(...years)}` : '';

  const rows = [
    row(
      'Spotify monthly listeners',
      fmtNum(lis.value),
      lis.asOf ? `From the public artist page, ${esc(fmtDate(lis.asOf))}${lisStale ? '. This may be out of date.' : ''}` : 'Not available yet',
      spark(history)
    ),
    row('Spotify followers', fmtNum(api.followers), api.status === 'ok' ? 'From the Spotify API' : 'Not available yet'),
    row('Spotify popularity', api.popularity == null ? '—' : `${api.popularity}<span class="unit"> / 100</span>`, 'Spotify’s own score, based mostly on recent plays'),
    yt.status === 'ok' ? row('YouTube subscribers', fmtNum(yt.subscribers), `${fmtNum(yt.videos)} videos`) : '',
    yt.status === 'ok' ? row('YouTube views', fmtNum(yt.views), 'All videos on the channel') : '',
  ].join('');

  const catalogRows = [
    row('Releases', fmtNum(cov.total), range),
    row('In lossless', `${cov.lossless}<span class="unit"> of ${cov.total}</span>`, cov.lossless === cov.total ? 'Every release has a lossless master' : 'The rest play in lower quality or are streaming-only'),
    row('Playable here', `${cov.lossless + cov.high + cov.standard + cov.previewOnly}<span class="unit"> of ${cov.total}</span>`, cov.previewOnly ? `${cov.previewOnly} as 30-second previews` : ''),
  ].join('');

  const table = sortTracks(tracks, 'newest').map((t) => {
    const best = bestTier(t);
    const views = stats.tracks && stats.tracks[t.id] && stats.tracks[t.id].youtubeViews;
    return `<tr>
      <th scope="row"><a href="#/track/${encodeURIComponent(t.id)}">${esc(t.title)}</a></th>
      <td>${esc(t.releaseDate ? fmtDate(t.releaseDate) : t.year || '')}</td>
      <td>${best ? esc(TIERS[best].label) : 'Streaming only'}</td>
      <td class="r">${views == null ? '—' : fmtNum(views)}</td>
    </tr>`;
  }).join('');

  const health = [
    ['Spotify monthly listeners', lis.status, lis.reason || 'Read from the public Spotify artist page', sp.checkedAt],
    ['Spotify followers and popularity', api.status, api.reason || 'Spotify Web API', sp.checkedAt],
    ['Apple Music releases', (src.apple || {}).status, (src.apple || {}).reason || `${fmtNum((src.apple || {}).songsFound)} songs matched`, (src.apple || {}).checkedAt],
    ['YouTube', yt.status, yt.reason || 'YouTube Data API', yt.checkedAt],
  ].map(([name, status, detail, at]) =>
    `<li>${pill(lisStale && name.includes('monthly') ? 'stale' : status)}<div><b>${esc(name)}</b><small>${esc(detail)}${at ? `. Checked ${esc(timeAgo(at))}` : ''}</small></div></li>`
  ).join('');

  main.innerHTML = `
  <header class="page-head">
    <h1>Stats</h1>
    <p>Last synced ${esc(stats.updatedAt ? timeAgo(stats.updatedAt) : 'never')}. The numbers refresh by themselves every few hours.</p>
    <div class="btnrow"><button class="btn" type="button" data-act="refresh">${icon('refresh')} Refresh now</button></div>
  </header>
  <section class="block" aria-labelledby="sAud"><h2 id="sAud">Audience</h2><dl class="ledger">${rows}</dl></section>
  <section class="block" aria-labelledby="sCat"><h2 id="sCat">Catalogue</h2><dl class="ledger">${catalogRows}</dl></section>
  <section class="block" aria-labelledby="sRel"><h2 id="sRel">Release by release</h2>
    <div class="tblwrap"><table class="tbl"><thead><tr><th scope="col">Release</th><th scope="col">Released</th><th scope="col">In this app</th><th scope="col" class="r">YouTube views</th></tr></thead><tbody>${table}</tbody></table></div>
  </section>
  <section class="block"><details class="how"><summary>How these numbers stay current</summary>
    <ul class="health">${health}</ul>
    <p class="hint">Spotify doesn’t publish monthly listeners through its API, so that number is read from the public artist page and rounded by Spotify. Release lists come from Apple Music and Spotify.</p>
  </details></section>`;
}
