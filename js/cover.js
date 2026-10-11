// Generative cover art: one distinct, deterministic abstract piece per track.
// Real artwork (track.cover) always wins when it exists.
const PALETTES = [
  ['#FFB52E', '#FF4F8B', '#2A1B6E'],
  ['#2ED3B7', '#5B7CFF', '#140F3F'],
  ['#FF4F8B', '#8B5CFF', '#1B1450'],
  ['#FFD36B', '#FF7A45', '#2B1458'],
  ['#7CF0D8', '#FFB52E', '#1B1450'],
  ['#B79CFF', '#FF4F8B', '#0F0B2E'],
];

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function rng(seed) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const cache = new Map();
export function coverURL(seedStr) {
  const key = String(seedStr || 'rd');
  if (cache.has(key)) return cache.get(key);
  const seed = hash(key);
  const r = rng(seed);
  const p = PALETTES[seed % PALETTES.length];
  const cx = 90 + r() * 220, cy = 90 + r() * 220, rad = 80 + r() * 90;
  const amp = 16 + r() * 36, freq = 1.2 + r() * 2.4, phase = r() * 6.283, ly = 170 + r() * 150;
  let d = '';
  for (let x = 0; x <= 400; x += 8) {
    const y = ly + Math.sin((x / 400) * freq * 6.283 + phase) * amp * Math.sin((x / 400) * Math.PI);
    d += `${x ? 'L' : 'M'}${x} ${y.toFixed(1)} `;
  }
  const ring = rad + 26 + r() * 30;
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 400 400'>` +
    `<defs><linearGradient id='b' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='${p[2]}'/><stop offset='1' stop-color='#0a0720'/></linearGradient>` +
    `<linearGradient id='c' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='${p[0]}'/><stop offset='1' stop-color='${p[1]}'/></linearGradient></defs>` +
    `<rect width='400' height='400' fill='url(#b)'/>` +
    `<circle cx='${cx.toFixed(0)}' cy='${cy.toFixed(0)}' r='${ring.toFixed(0)}' fill='none' stroke='${p[0]}' stroke-opacity='.28' stroke-width='3'/>` +
    `<circle cx='${cx.toFixed(0)}' cy='${cy.toFixed(0)}' r='${rad.toFixed(0)}' fill='url(#c)'/>` +
    `<path d='${d}' fill='none' stroke='#fff' stroke-width='6' stroke-linecap='round' stroke-linejoin='round' stroke-opacity='.92'/>` +
    `<circle cx='14' cy='${ly.toFixed(0)}' r='7' fill='#fff'/><circle cx='386' cy='${ly.toFixed(0)}' r='7' fill='#fff'/></svg>`;
  // encodeURIComponent leaves ' untouched, which would end a CSS url('...') early (the About portrait). Encode it too.
  const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg).replace(/'/g, '%27');
  cache.set(key, url);
  return url;
}

export const coverFor = (item) => (item && item.cover) || coverURL(item && (item.id || item.title));
