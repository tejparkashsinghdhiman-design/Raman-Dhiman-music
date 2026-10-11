// A single vibrating string, like a tumbi's. Pluck it with the pointer; it follows the real audio when music plays.
import { clamp } from './util.js';

export function mountString(canvas, hooks = {}, { thickness = 3.2, amp: ampScale = 0.38 } = {}) {
  const ctx = canvas.getContext('2d');
  const N = 140;
  const padX = 10;
  const pos = new Float32Array(N);
  const vel = new Float32Array(N);
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  let W = 0, H = 0, raf = 0, last = 0, time = 0, visible = true, alive = true;
  let cA = '#FFB52E', cB = '#FF4F8B';

  const readColors = () => {
    const s = getComputedStyle(document.documentElement);
    cA = s.getPropertyValue('--string-a').trim() || cA;
    cB = s.getPropertyValue('--string-b').trim() || cB;
  };
  readColors();
  window.addEventListener('rd:theme', readColors);

  function resize() {
    const r = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = r.width; H = r.height;
    canvas.width = Math.max(1, Math.round(W * dpr));
    canvas.height = Math.max(1, Math.round(H * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  const xAt = (i) => padX + (i / (N - 1)) * (W - 2 * padX);
  function trace(yf) {
    ctx.beginPath();
    ctx.moveTo(xAt(0), yf(0));
    for (let i = 1; i < N - 1; i++) {
      ctx.quadraticCurveTo(xAt(i), yf(i), (xAt(i) + xAt(i + 1)) / 2, (yf(i) + yf(i + 1)) / 2);
    }
    ctx.lineTo(xAt(N - 1), yf(N - 1));
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);
    const mid = H / 2;
    const amp = H * ampScale;
    const g = ctx.createLinearGradient(0, 0, W, 0);
    g.addColorStop(0, cA);
    g.addColorStop(1, cB);
    // faint echo line gives the string some depth
    trace((i) => mid - pos[i] * amp * 0.45);
    ctx.globalAlpha = 0.3; ctx.lineWidth = 1.5; ctx.strokeStyle = cB; ctx.stroke();
    ctx.globalAlpha = 1;
    trace((i) => mid + pos[i] * amp);
    ctx.lineWidth = thickness; ctx.strokeStyle = g; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.shadowColor = cA; ctx.shadowBlur = 12; ctx.stroke(); ctx.shadowBlur = 0;
    ctx.fillStyle = cA; ctx.beginPath(); ctx.arc(xAt(0), mid, 5, 0, 6.283); ctx.fill();
    ctx.fillStyle = cB; ctx.beginPath(); ctx.arc(xAt(N - 1), mid, 5, 0, 6.283); ctx.fill();
  }

  function step(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    time += dt;
    const wave = hooks.wave ? hooks.wave() : null;
    const playing = hooks.playing ? hooks.playing() : false;
    for (let s = 0; s < 2; s++) {
      for (let i = 1; i < N - 1; i++) vel[i] += 0.22 * (pos[i - 1] + pos[i + 1] - 2 * pos[i]) - 0.03 * vel[i];
      for (let i = 1; i < N - 1; i++) pos[i] += vel[i];
    }
    for (let i = 1; i < N - 1; i++) {
      const env = Math.sin((Math.PI * i) / (N - 1));
      let target, c;
      if (wave) {
        target = ((wave[Math.floor((i / N) * wave.length)] - 128) / 128) * 1.7 * env;
        c = 0.12;
      } else if (playing) {
        target = (Math.sin(i * 0.28 + time * 5.2) * 0.45 + Math.sin(i * 0.71 - time * 7.3) * 0.25) * env * (0.55 + 0.35 * Math.sin(time * 2.4));
        c = 0.06;
      } else {
        target = (Math.sin(i * 0.085 + time * 0.9) * 0.14 + Math.sin(i * 0.21 - time * 0.55) * 0.06) * env;
        c = 0.035;
      }
      vel[i] += (target - pos[i]) * c;
    }
  }

  const running = () => alive && visible && !document.hidden && !reduce.matches;
  function frame(now) {
    raf = 0;
    if (!running()) return;
    step(now);
    draw();
    raf = requestAnimationFrame(frame);
  }
  function kick() {
    if (reduce.matches) {
      for (let i = 0; i < N; i++) pos[i] = Math.sin((Math.PI * i) / (N - 1)) * 0.07;
      draw();
      return;
    }
    if (!raf && running()) { last = performance.now(); raf = requestAnimationFrame(frame); }
  }

  function pluck(x, y, strength = 0.35) {
    if (reduce.matches) return;
    const i = Math.round(((x - padX) / Math.max(1, W - 2 * padX)) * (N - 1));
    const target = clamp((y - H / 2) / (H * ampScale), -1.5, 1.5);
    for (let k = -7; k <= 7; k++) {
      const j = i + k;
      if (j > 0 && j < N - 1) pos[j] += (target * Math.exp(-(k * k) / 20) - pos[j]) * strength;
    }
    kick();
  }

  const onMove = (e) => { const r = canvas.getBoundingClientRect(); pluck(e.clientX - r.left, e.clientY - r.top); };
  const onDown = (e) => { const r = canvas.getBoundingClientRect(); pluck(e.clientX - r.left, e.clientY - r.top, 0.7); };
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerdown', onDown);

  const ro = new ResizeObserver(() => { resize(); if (reduce.matches) draw(); });
  ro.observe(canvas);
  const io = new IntersectionObserver(([e]) => { visible = !!(e && e.isIntersecting); kick(); });
  io.observe(canvas);
  const onVis = () => kick();
  document.addEventListener('visibilitychange', onVis);
  reduce.addEventListener('change', kick);

  resize();
  kick();

  return {
    pluck,
    destroy() {
      alive = false;
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('rd:theme', readColors);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerdown', onDown);
    },
  };
}
