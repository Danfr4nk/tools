// app.js — prog2keys UI: chips, keyboard, WebAudio. Needs prog2keys.js.
(function () {
'use strict';
const P = Prog2Keys;

// ---------- state ----------
let base = [];          // parsed chords, untransposed
let sel = 0;
let inv = {};           // idx -> inversion
let semis = 0;          // transposition
let flats = false;
let flatsAuto = true;   // follow the typed spelling until the user picks
let bpm = 90, beatsPer = 4;
let playing = false, stopFlag = false;

const disp = i => P.transposeChord(base[i], semis);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- audio ----------
let AC = null;
function ac() {
  if (!AC) AC = new (window.AudioContext || window.webkitAudioContext)();
  if (AC.state === 'suspended') AC.resume();
  return AC;
}
function playMidis(midis, dur) {
  if (!midis.length) return;
  const c = ac(), t = c.currentTime + 0.01;
  const vel = Math.min(0.3, 0.1 + 0.5 / midis.length);
  midis.forEach(m => {
    const o = c.createOscillator(), g = c.createGain();
    o.type = 'triangle';
    o.frequency.value = 440 * Math.pow(2, (m - 69) / 12);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vel, t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(c.destination);
    o.start(t); o.stop(t + dur + 0.05);
  });
}
function playCurrent(dur) {
  const ch = disp(sel);
  if (!ch || ch.error) return;
  playMidis(P.voicing(ch, inv[sel] || 0), dur || 1.8);
}

// ---------- keyboard ----------
const KB_LO = 48, KB_HI = 83; // C3..B5
const WHITE_PC = new Set([0, 2, 4, 5, 7, 9, 11]);
const keyEls = {};
function buildKeyboard() {
  const kb = document.getElementById('kb');
  const whites = document.createElement('div'); whites.className = 'whites';
  const blacks = document.createElement('div'); blacks.className = 'blacks';
  let nw = 0;
  for (let m = KB_LO; m <= KB_HI; m++) if (WHITE_PC.has(m % 12)) nw++;
  for (let m = KB_LO; m <= KB_HI; m++) {
    const k = document.createElement('div');
    k.dataset.midi = m;
    k.innerHTML = '<span>' + P.SHARP[m % 12] + '</span>';
    if (WHITE_PC.has(m % 12)) { k.className = 'wk'; whites.appendChild(k); }
    else {
      k.className = 'bk';
      let below = 0;
      for (let x = KB_LO; x < m; x++) if (WHITE_PC.has(x % 12)) below++;
      k.style.left = (below / nw * 100) + '%';
      blacks.appendChild(k);
    }
    keyEls[m] = k;
  }
  kb.appendChild(whites); kb.appendChild(blacks);
}
function renderKeyboard() {
  Object.values(keyEls).forEach(k => k.classList.remove('on', 'root'));
  const readout = document.getElementById('readout');
  if (!base.length || !base[sel] || base[sel].error) { readout.textContent = ''; return; }
  const ch = disp(sel);
  const midis = P.voicing(ch, inv[sel] || 0);
  midis.forEach(m => {
    const el = keyEls[m];
    if (!el) return;
    el.classList.add('on');
    if (m % 12 === ch.root) el.classList.add('root');
  });
  const names = (flats ? P.FLAT : P.SHARP);
  const n = ch.intervals.length;
  const invName = P.INV_NAMES[(inv[sel] || 0) % n] + ' position';
  readout.textContent =
    P.chordName(ch, flats) + '  ·  ' +
    midis.map(m => names[m % 12] + (Math.floor(m / 12) - 1)).join(' – ') +
    '  ·  ' + invName;
}

// ---------- chips ----------
function renderChips() {
  const row = document.getElementById('chips');
  row.innerHTML = '';
  base.forEach((ch, i) => {
    const b = document.createElement('button');
    b.className = 'chip' + (i === sel ? ' sel' : '') + (ch.error ? ' bad' : '');
    b.textContent = ch.error ? ch.name + ' ?' : P.chordName(disp(i), flats);
    b.title = ch.error ? ch.error : 'click: hear it · shift+click: next inversion';
    b.onclick = e => {
      if (ch.error) return;
      if (e.shiftKey) inv[i] = ((inv[i] || 0) + 1) % ch.intervals.length;
      sel = i;
      renderAll();
      playCurrent();
    };
    row.appendChild(b);
  });
  document.getElementById('invLabel').textContent =
    base[sel] && !base[sel].error
      ? P.INV_NAMES[(inv[sel] || 0) % base[sel].intervals.length]
      : '—';
  document.getElementById('transposeLabel').textContent =
    (semis > 0 ? '+' : '') + semis;
}

function renderAll() { renderChips(); renderKeyboard(); }

// ---------- progression input ----------
function setProgression(text) {
  base = P.parseProgression(text);
  sel = 0; inv = {};
  if (flatsAuto) {
    // spell roots the way they were typed: "Bb Eb F" shouldn't come back
    // as "A# D# F". Counts root/bass accidentals only (not the b in "7b9").
    const nFlat = (text.match(/[A-G][b♭]/g) || []).length;
    const nSharp = (text.match(/[A-G][#♯]/g) || []).length;
    if (nFlat !== nSharp) flats = nFlat > nSharp;
    document.getElementById('acc').textContent = flats ? '♭' : '#';
  }
  renderAll();
}

// ---------- transport ----------
async function playAll() {
  if (playing) { stopFlag = true; return; }
  if (!base.length) return;
  playing = true; stopFlag = false;
  const btn = document.getElementById('playAll');
  btn.textContent = '■ stop'; btn.classList.add('stop');
  const beatMs = 60000 / bpm * beatsPer;
  for (let i = 0; i < base.length && !stopFlag; i++) {
    if (base[i].error) continue;
    sel = i; renderAll();
    playMidis(P.voicing(disp(i), inv[i] || 0), beatMs / 1000 * 0.92);
    await sleep(beatMs);
  }
  playing = false;
  btn.textContent = '▶ play all'; btn.classList.remove('stop');
}

// ---------- wire up ----------
document.addEventListener('DOMContentLoaded', () => {
  buildKeyboard();
  const input = document.getElementById('prog');
  input.addEventListener('input', () => setProgression(input.value));
  document.querySelectorAll('[data-preset]').forEach(a => {
    a.onclick = e => { e.preventDefault(); input.value = a.dataset.preset; setProgression(input.value); };
  });
  document.getElementById('tDown').onclick = () => { semis--; renderAll(); };
  document.getElementById('tUp').onclick = () => { semis++; renderAll(); };
  document.getElementById('acc').onclick = e => {
    flatsAuto = false;
    flats = !flats; e.target.textContent = flats ? '♭' : '#'; renderAll();
  };
  document.getElementById('invDown').onclick = () => {
    const ch = base[sel]; if (!ch || ch.error) return;
    inv[sel] = (((inv[sel] || 0) - 1) % ch.intervals.length + ch.intervals.length) % ch.intervals.length;
    renderAll(); playCurrent(1.2);
  };
  document.getElementById('invUp').onclick = () => {
    const ch = base[sel]; if (!ch || ch.error) return;
    inv[sel] = ((inv[sel] || 0) + 1) % ch.intervals.length;
    renderAll(); playCurrent(1.2);
  };
  document.getElementById('bpm').onchange = e => {
    bpm = Math.min(220, Math.max(40, +e.target.value || 90));
    e.target.value = bpm;
  };
  document.getElementById('beats').onchange = e => { beatsPer = +e.target.value; };
  document.getElementById('playAll').onclick = playAll;
  input.value = 'Cmaj7 Am7 Dm7 G7';
  setProgression(input.value);
});
})();
