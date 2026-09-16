// roll.js — canvas piano-roll renderer + interactions. No imports.
// Usage:
//   const roll = createRoll(canvas, { onAudition(note), onSeek(sec) });
//   roll.setData(notes, duration);
//   roll.setPlayhead(sec | null);
//   roll.zoomBy(f), roll.zoomFit()

const BLACK = new Set([1, 3, 6, 8, 10]);
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const midiName = m => NOTE_NAMES[m % 12] + (Math.floor(m / 12) - 1);

export function createRoll(canvas, opts = {}) {
  const ctx = canvas.getContext('2d');
  const S = {
    notes: [], duration: 0,
    pxPerSec: 120, scrollX: 0, scrollY: 0,
    lo: 48, hi: 72, keyH: 18, keyW: 64,
    playhead: null, selected: -1,
    dpr: 1, W: 0, H: 0,
  };

  function resize() {
    const r = canvas.getBoundingClientRect();
    S.dpr = Math.min(2, window.devicePixelRatio || 1);
    S.W = Math.max(50, r.width); S.H = Math.max(50, r.height);
    canvas.width = S.W * S.dpr; canvas.height = S.H * S.dpr;
    draw();
  }
  new ResizeObserver(resize).observe(canvas);

  const xOf = t => S.keyW + t * S.pxPerSec - S.scrollX;
  const tOf = x => (x - S.keyW + S.scrollX) / S.pxPerSec;
  const yOf = m => S.H - (m - S.lo + 1) * S.keyH - S.scrollY;
  const midiOfY = y => S.lo - 1 + (S.H - y - S.scrollY) / S.keyH;

  function setData(notes, duration) {
    S.notes = notes; S.duration = duration; S.selected = -1; S.playhead = null;
    if (notes.length) {
      const ms = notes.map(n => n.midi);
      S.lo = Math.max(0, Math.min(...ms) - 4);
      S.hi = Math.min(127, Math.max(...ms) + 5);
      if (S.hi - S.lo < 23) { const mid = (S.lo + S.hi) / 2; S.lo = Math.max(0, Math.round(mid - 12)); S.hi = Math.min(127, S.lo + 24); }
    }
    zoomFit();
  }

  function zoomFit() {
    const avail = Math.max(100, S.W - S.keyW - 20);
    S.pxPerSec = avail / Math.max(0.5, S.duration);
    S.scrollX = 0; S.scrollY = 0;
    draw();
  }
  function zoomBy(f, cx) {
    const t = cx == null ? tOf(S.keyW + (S.W - S.keyW) / 2) : tOf(cx);
    S.pxPerSec = Math.min(4000, Math.max(8, S.pxPerSec * f));
    S.scrollX = S.keyW + t * S.pxPerSec - (cx == null ? (S.W - S.keyW) / 2 + S.keyW : cx);
    draw();
  }

  function gridStep() {
    for (const s of [0.1, 0.25, 0.5, 1, 2, 5, 10, 30]) if (s * S.pxPerSec >= 70) return s;
    return 60;
  }

  function draw() {
    const { W, H, dpr } = S;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#14161b'; ctx.fillRect(0, 0, W, H);

    // lane shading: black-key rows darker
    for (let m = S.lo; m <= S.hi; m++) {
      const y = yOf(m);
      if (y < -S.keyH || y > H) continue;
      if (BLACK.has(m % 12)) { ctx.fillStyle = 'rgba(255,255,255,0.025)'; ctx.fillRect(S.keyW, y, W - S.keyW, S.keyH); }
      ctx.strokeStyle = 'rgba(255,255,255,0.05)';
      ctx.beginPath(); ctx.moveTo(S.keyW, y + S.keyH); ctx.lineTo(W, y + S.keyH); ctx.stroke();
    }
    // time grid
    const step = gridStep();
    ctx.font = '10px -apple-system, system-ui, sans-serif';
    ctx.fillStyle = '#6b7280'; ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    for (let t = Math.floor(tOf(S.keyW) / step) * step; t <= S.duration + step; t += step) {
      if (t < 0) continue;
      const x = xOf(t);
      if (x < S.keyW || x > W) continue;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
      ctx.fillText(t.toFixed(step < 1 ? 1 : 0) + 's', x + 4, 12);
    }

    // notes
    S.notes.forEach((n, i) => {
      const x = xOf(n.start), w = Math.max(2, n.dur * S.pxPerSec);
      const y = yOf(n.midi) + 2, h = S.keyH - 4;
      if (x + w < S.keyW || x > W || y > H || y + h < 0) return;
      const a = 0.55 + 0.45 * Math.min(1, Math.max(0, n.conf || 0.7));
      ctx.fillStyle = i === S.selected ? `rgba(229,192,123,${a})` : `rgba(97,175,239,${a})`;
      ctx.beginPath();
      const r = Math.min(4, h / 2, w / 2);
      ctx.roundRect(x, y, w, h, r);
      ctx.fill();
      S._hit = S._hit || [];
      S._hit[i] = [x, y, w, h];
    });

    // piano keys
    for (let m = S.lo; m <= S.hi; m++) {
      const y = yOf(m);
      if (y < -S.keyH || y > H) continue;
      const black = BLACK.has(m % 12);
      ctx.fillStyle = black ? '#2a2e37' : '#dfe3ea';
      ctx.fillRect(0, y, black ? S.keyW * 0.62 : S.keyW, S.keyH);
      ctx.strokeStyle = '#14161b'; ctx.strokeRect(0, y, black ? S.keyW * 0.62 : S.keyW, S.keyH);
      if (m % 12 === 0) { ctx.fillStyle = '#6b7280'; ctx.fillText(midiName(m), 6, y + S.keyH - 5); }
    }
    // playhead
    if (S.playhead != null) {
      const x = xOf(S.playhead);
      if (x >= S.keyW && x <= W) {
        ctx.strokeStyle = '#e06c75'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
        ctx.lineWidth = 1;
      }
    }
  }

  // interactions
  let drag = null;
  function pos(e) {
    const r = canvas.getBoundingClientRect();
    return [(e.touches ? e.touches[0].clientX : e.clientX) - r.left,
            (e.touches ? e.touches[0].clientY : e.clientY) - r.top];
  }
  function hitNote(x, y) {
    for (let i = S.notes.length - 1; i >= 0; i--) {
      const b = S._hit && S._hit[i];
      if (b && x >= b[0] && x <= b[0] + b[2] && y >= b[1] && y <= b[1] + b[3]) return i;
    }
    return -1;
  }
  canvas.addEventListener('pointerdown', e => {
    canvas.setPointerCapture(e.pointerId);
    const [x, y] = pos(e);
    const i = hitNote(x, y);
    if (i >= 0) {
      S.selected = i; draw();
      if (opts.onAudition) opts.onAudition(S.notes[i]);
      drag = null;
    } else {
      drag = { x, y, sx: S.scrollX, sy: S.scrollY, moved: false };
    }
  });
  canvas.addEventListener('pointermove', e => {
    if (!drag) return;
    const [x, y] = pos(e);
    const dx = x - drag.x, dy = y - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
    S.scrollX = drag.sx - dx;
    S.scrollY = Math.max(-40, Math.min((S.hi - S.lo + 1) * S.keyH - S.H + 40, drag.sy + dy));
    draw();
  });
  canvas.addEventListener('pointerup', e => {
    if (drag && !drag.moved) {
      const [x] = pos(e);
      if (x >= S.keyW && opts.onSeek) opts.onSeek(Math.max(0, Math.min(S.duration, tOf(x))));
    }
    drag = null;
  });
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    const [x] = pos(e);
    zoomBy(e.deltaY < 0 ? 1.2 : 1 / 1.2, x);
  }, { passive: false });

  // follow playhead while playing
  function follow(t) {
    const x = xOf(t);
    if (x > S.W - 60) { S.scrollX += x - (S.W - 60); draw(); }
    else if (x < S.keyW) { S.scrollX = Math.max(0, S.keyW + t * S.pxPerSec - S.keyW - 40); draw(); }
  }

  resize();
  return {
    setData, setPlayhead(t) { S.playhead = t; draw(); },
    follow, zoomBy, zoomFit, draw,
    get duration() { return S.duration; },
  };
}
