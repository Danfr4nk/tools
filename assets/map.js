/* MAP — the reuse graph, drawn from the registry.
 *
 * Every edge here is a real one: a tool that imports a sibling's module, or
 * downloads a model, runtime or API that another tool also uses. That makes it
 * answer a question the card grid cannot — "what is already cached, and what
 * is this about to pull down" — before you tap a 174 MB instrument on a tether.
 *
 * Canvas 2D, ~40 nodes, springs + repulsion. Pre-settled before first paint so
 * it opens composed rather than exploding, and frozen entirely under
 * prefers-reduced-motion.
 */

import { INSTRUMENTS, DEPS } from './registry.js';

const KIND_R = { tool: 10, shared: 6.5, model: 6, cdn: 5.5, api: 5.5 };
const KIND_VAR = { tool: '--acc', shared: '--violet', model: '--amber', cdn: '--blue', api: '--rose' };

export function buildGraph() {
  const nodes = [], index = {};
  const add = (n) => { index[n.id] = n; nodes.push(n); return n; };

  for (const i of INSTRUMENTS) {
    add({ id: i.id, kind: 'tool', label: i.name, note: i.kicker, href: i.external ? i.href : i.href, domain: i.domain, ext: !!i.external });
  }
  const used = new Set();
  for (const i of INSTRUMENTS) for (const d of i.deps || []) used.add(d);
  for (const id of used) {
    const d = DEPS[id];
    if (!d) continue;
    add({ id, kind: d.kind, label: d.label, note: d.note });
  }

  const edges = [];
  for (const i of INSTRUMENTS) for (const d of i.deps || []) {
    if (index[d]) edges.push({ a: i.id, b: d });
  }

  for (const n of nodes) { n.deg = 0; }
  for (const e of edges) { index[e.a].deg++; index[e.b].deg++; }
  return { nodes, edges, index };
}

function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

export function mountMap(canvas, { onOpen, tip } = {}) {
  const g = buildGraph();
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const N = g.nodes;
  const adj = new Map(N.map((n) => [n.id, new Set()]));
  for (const e of g.edges) { adj.get(e.a).add(e.b); adj.get(e.b).add(e.a); }

  let W = 0, H = 0, dpr = 1;
  let cam = { x: 0, y: 0, z: 1 };
  let hover = null, pinned = null, drag = null, panning = null;
  let alpha = 1, raf = 0, settled = false;

  /* deterministic seed so the layout is the same every visit */
  let seed = 20260919;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
  N.forEach((n, i) => {
    const a = (i / N.length) * Math.PI * 2;
    const r = n.kind === 'tool' ? 150 + rnd() * 60 : 260 + rnd() * 90;
    n.x = Math.cos(a) * r; n.y = Math.sin(a) * r; n.vx = 0; n.vy = 0;
  });

  function tick(dt) {
    const K = 0.9;
    for (let i = 0; i < N.length; i++) {
      const a = N[i];
      for (let j = i + 1; j < N.length; j++) {
        const b = N[j];
        let dx = b.x - a.x, dy = b.y - a.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) { d2 = 1; dx = (rnd() - .5); dy = (rnd() - .5); }
        const d = Math.sqrt(d2);
        const rep = (5200 * K) / d2;
        const fx = (dx / d) * rep, fy = (dy / d) * rep;
        a.vx -= fx; a.vy -= fy; b.vx += fx; b.vy += fy;
      }
      /* centre gravity, weaker horizontally so the graph spreads into a
         landscape canvas instead of a circle with dead air either side */
      a.vx += -a.x * 0.0010; a.vy += -a.y * 0.0026;
    }
    for (const e of g.edges) {
      const a = g.index[e.a], b = g.index[e.b];
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.max(1, Math.hypot(dx, dy));
      const rest = 128;
      const f = (d - rest) * 0.018;
      const fx = (dx / d) * f, fy = (dy / d) * f;
      a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
    }
    for (const n of N) {
      if (drag && drag.node === n) { n.vx = n.vy = 0; continue; }
      n.vx *= 0.82; n.vy *= 0.82;
      n.x += n.vx * dt * alpha; n.y += n.vy * dt * alpha;
    }
  }

  function settle(steps) { const a = alpha; alpha = 1; for (let i = 0; i < steps; i++) tick(1); alpha = a; }

  function resize() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    const r = canvas.getBoundingClientRect();
    W = Math.max(1, r.width); H = Math.max(1, r.height);
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    fit();
    draw();
  }

  /* frame the whole graph, labels included, whatever the container size */
  function fit() {
    if (!N.length || !W || !H) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const nd of N) {
      x0 = Math.min(x0, nd.x); x1 = Math.max(x1, nd.x);
      y0 = Math.min(y0, nd.y); y1 = Math.max(y1, nd.y);
    }
    const padX = 78, padY = 34;           /* labels hang below and to the sides */
    const gw = Math.max(1, x1 - x0), gh = Math.max(1, y1 - y0);
    cam.z = Math.max(0.3, Math.min(1.6, Math.min((W - padX * 2) / gw, (H - padY * 2 - 18) / gh)));
    cam.x = -(x0 + x1) / 2;
    cam.y = -(y0 + y1) / 2;
  }

  const toScreen = (n) => ({ x: W / 2 + (n.x + cam.x) * cam.z, y: H / 2 + (n.y + cam.y) * cam.z });

  function active() { return pinned || hover; }
  function isLit(id) {
    const a = active();
    if (!a) return true;
    return id === a || adj.get(a).has(id);
  }

  function draw() {
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const line = cssVar('--dimmer', '#3f4e5c');
    const dim = cssVar('--dimmer', '#3f4e5c');
    const txt = cssVar('--txt', '#ccd8e4');
    const acc = cssVar('--acc', '#2dd4bf');
    const a = active();

    ctx.lineWidth = 1;
    for (const e of g.edges) {
      const p = toScreen(g.index[e.a]), q = toScreen(g.index[e.b]);
      const lit = !a || e.a === a || e.b === a;
      ctx.strokeStyle = lit && a ? acc : line;
      ctx.lineWidth = lit && a ? 1.5 : 1;
      ctx.globalAlpha = a ? (lit ? .9 : .08) : .8;
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
    }
    ctx.globalAlpha = 1;

    for (const n of N) {
      const p = toScreen(n);
      const lit = isLit(n.id);
      const r = (KIND_R[n.kind] || 6) * (n.id === a ? 1.5 : 1) * Math.min(1.4, cam.z);
      const col = cssVar(KIND_VAR[n.kind] || '--acc', '#2dd4bf');

      ctx.globalAlpha = lit ? 1 : .18;
      if (n.kind === 'tool') {
        ctx.beginPath(); ctx.arc(p.x, p.y, r + 5, 0, 7); ctx.strokeStyle = col;
        ctx.globalAlpha = lit ? .35 : .08; ctx.stroke(); ctx.globalAlpha = lit ? 1 : .18;
      }
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, 7);
      ctx.fillStyle = n.kind === 'tool' ? col : cssVar('--panel', '#0a0f16');
      ctx.fill();
      ctx.strokeStyle = col; ctx.lineWidth = n.kind === 'tool' ? 1 : 1.6; ctx.stroke();

      ctx.globalAlpha = 1;
    }

    /* labels last, haloed — names collide constantly at this density */
    const panel = cssVar('--panel', '#0a0f16');
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.lineJoin = 'round';
    for (const n of N) {
      const show = n.kind === 'tool' || n.id === a || (a && adj.get(a).has(n.id)) || cam.z > 1.35;
      if (!show) continue;
      const p = toScreen(n);
      const lit = isLit(n.id);
      const r = (KIND_R[n.kind] || 6) * (n.id === a ? 1.5 : 1) * Math.min(1.4, cam.z);
      const label = n.label.length > 26 ? n.label.slice(0, 25) + '…' : n.label;
      ctx.font = `${n.kind === 'tool' ? 600 : 400} ${n.kind === 'tool' ? 11 : 10}px ui-monospace, SFMono-Regular, Menlo, monospace`;
      ctx.globalAlpha = lit ? 1 : .15;
      ctx.strokeStyle = panel; ctx.lineWidth = 3.5;
      ctx.strokeText(label, p.x, p.y + r + 6);
      ctx.fillStyle = n.kind === 'tool' ? txt : dim;
      ctx.fillText(label, p.x, p.y + r + 6);
    }
    ctx.globalAlpha = 1;
  }

  function loop() {
    raf = 0;
    if (!reduce && alpha > 0.004) {
      tick(1);
      alpha *= 0.975;
      draw();
      raf = requestAnimationFrame(loop);
    } else { draw(); settled = true; }
  }
  function kick(a = 0.45) { if (reduce) { settle(40); draw(); return; } alpha = Math.max(alpha, a); if (!raf) raf = requestAnimationFrame(loop); }

  function pick(cx, cy) {
    let best = null, bd = 26 * 26;
    for (const n of N) {
      const p = toScreen(n);
      const d = (p.x - cx) ** 2 + (p.y - cy) ** 2;
      if (d < bd) { bd = d; best = n; }
    }
    return best;
  }

  function pos(ev) {
    const r = canvas.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  }

  function showTip(n, at) {
    if (!tip) return;
    if (!n) { tip.classList.remove('on'); return; }
    const kindLabel = { tool: 'instrument', shared: 'shared module', model: 'model weights', cdn: 'runtime', api: 'network api' }[n.kind] || n.kind;
    const users = n.kind === 'tool' ? [] : [...adj.get(n.id)].map((id) => g.index[id].label);
    tip.innerHTML =
      `<div class="t">${kindLabel}</div><div><b>${esc(n.label)}</b></div>` +
      (n.note ? `<div class="n">${esc(n.note)}</div>` : '') +
      (users.length ? `<div class="n">used by ${users.length}: ${esc(users.join(' · '))}</div>` : '') +
      (n.kind === 'tool' ? `<div class="n">click to open</div>` : `<div class="n">click to pin the highlight</div>`);
    tip.classList.add('on');
    const r = canvas.getBoundingClientRect();
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    tip.style.left = Math.max(6, Math.min(r.width - tw - 6, at.x + 14)) + 'px';
    tip.style.top = Math.max(6, Math.min(r.height - th - 6, at.y + 14)) + 'px';
  }
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ---- interaction ---- */
  canvas.addEventListener('pointermove', (ev) => {
    const p = pos(ev);
    if (drag) {
      drag.node.x = (p.x - W / 2) / cam.z - cam.x;
      drag.node.y = (p.y - H / 2) / cam.z - cam.y;
      kick(0.25); return;
    }
    if (panning) {
      cam.x += (p.x - panning.x) / cam.z; cam.y += (p.y - panning.y) / cam.z;
      panning = p; draw(); return;
    }
    const n = pick(p.x, p.y);
    if (n?.id !== hover) { hover = n ? n.id : null; draw(); }
    showTip(n, p);
    canvas.style.cursor = n ? 'pointer' : 'grab';
  });
  canvas.addEventListener('pointerleave', () => { hover = null; showTip(null); draw(); });
  canvas.addEventListener('pointerdown', (ev) => {
    const p = pos(ev);
    const n = pick(p.x, p.y);
    canvas.setPointerCapture(ev.pointerId);
    if (n) drag = { node: n, moved: 0, at: p }; else panning = p;
  });
  canvas.addEventListener('pointerup', (ev) => {
    const p = pos(ev);
    if (drag) {
      const moved = Math.hypot(p.x - drag.at.x, p.y - drag.at.y);
      const n = drag.node; drag = null;
      if (moved < 5) {
        if (n.kind === 'tool') { onOpen && onOpen(n); }
        else { pinned = (pinned === n.id) ? null : n.id; draw(); }
      }
    }
    panning = null;
    try { canvas.releasePointerCapture(ev.pointerId); } catch (e) {}
  });
  canvas.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const k = Math.exp(-ev.deltaY * 0.0014);
    cam.z = Math.max(0.45, Math.min(2.6, cam.z * k));
    draw();
  }, { passive: false });

  const ro = new ResizeObserver(resize);
  ro.observe(canvas);

  settle(460);
  resize();

  return {
    reset() { pinned = null; hover = null; settle(460); fit(); draw(); },
    refresh: draw,
    focus(id) { pinned = g.index[id] ? id : null; draw(); },
    destroy() { ro.disconnect(); if (raf) cancelAnimationFrame(raf); },
    graph: g,
  };
}
