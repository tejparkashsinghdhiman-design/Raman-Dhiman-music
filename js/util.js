// Small shared helpers. No dependencies.
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
export const clamp = (n, a, b) => Math.min(b, Math.max(a, n));

export function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function fmtBytes(n) {
  if (!n) return '—';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${u[i]}`;
}

// en-IN grouping (12,34,567) suits the audience.
export const fmtNum = (n) => (n == null || Number.isNaN(n) ? '—' : new Intl.NumberFormat('en-IN').format(n));

export function fmtDate(iso, withDay = true) {
  if (!iso) return '';
  const d = new Date(iso.length === 10 ? iso + 'T00:00:00' : iso);
  if (Number.isNaN(+d)) return '';
  return d.toLocaleDateString('en-IN', withDay ? { day: 'numeric', month: 'short', year: 'numeric' } : { month: 'short', year: 'numeric' });
}

export function timeAgo(iso) {
  const t = typeof iso === 'number' ? iso : Date.parse(iso);
  if (!Number.isFinite(t)) return 'never';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  const d = Math.round(s / 86400);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

export const slugify = (s) =>
  String(s || '').toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-') || 'untitled';

export const ls = {
  get(k, d) { try { const v = localStorage.getItem('rd:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('rd:' + k, JSON.stringify(v)); } catch { /* storage full or blocked */ } },
  del(k) { try { localStorage.removeItem('rd:' + k); } catch { /* ignore */ } },
};

export function debounce(fn, ms) {
  let t;
  const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  d.flush = (...a) => { clearTimeout(t); fn(...a); };
  return d;
}

export function toast(msg, { ms = 3800, action } = {}) {
  const host = document.getElementById('toasts');
  if (!host) return;
  const el = document.createElement('div');
  el.className = 'toast';
  const span = document.createElement('span');
  span.textContent = msg;
  el.append(span);
  const drop = () => {
    el.remove();
    if (!host.children.length && host.hidePopover) { try { host.hidePopover(); } catch { /* already hidden */ } }
  };
  if (action) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = action.label;
    b.addEventListener('click', () => { action.run(); drop(); });
    el.append(b);
  }
  host.append(el);
  while (host.children.length > 3) host.firstChild.remove();
  // The host is a manual popover so it lives in the top layer. Re-showing it moves it above any open dialog.
  if (host.showPopover) {
    try { if (host.matches(':popover-open')) host.hidePopover(); host.showPopover(); } catch { /* unsupported */ }
  }
  setTimeout(drop, ms);
}

export const isIOS = () =>
  /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
