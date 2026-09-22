// midi.js — minimal SMF0 writer for progression export. Pure JS, zero imports.
// Browser + Node. One track: pad chords, bass pattern, optional 16th arp.

function vlq(n) {
  const bytes = [n & 0x7f];
  n >>= 7;
  while (n > 0) { bytes.unshift((n & 0x7f) | 0x80); n >>= 7; }
  // set continuation bits on all but the last
  for (let i = 0; i < bytes.length - 1; i++) bytes[i] |= 0x80;
  return bytes;
}

// events: [{tick, bytes:[...]}] -> Uint8Array of a complete .mid file
// humanize: tiny timing/velocity jitter on bass+arp so the export doesn't
// feel quantized-dead (pads stay grid-locked — they're the harmonic bed)
export function writeMidi({ tempo = 122, chords, bassPattern, arp = false, tpb = 480, humanize = true, seed = 1 }) {
  let s = seed;
  const jrnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  const jit = (amt) => humanize ? Math.round((jrnd() * 2 - 1) * amt) : 0;
  const jvel = (v, amt) => Math.max(1, Math.min(127, v + (humanize ? Math.round((jrnd() * 2 - 1) * amt) : 0)));

  const ev = [];
  const add = (tick, bytes) => ev.push({ tick, bytes });

  // tempo + time signature at tick 0
  const mpq = Math.round(60000000 / tempo);
  add(0, [0xFF, 0x51, 0x03, (mpq >> 16) & 0xff, (mpq >> 8) & 0xff, mpq & 0xff]);
  add(0, [0xFF, 0x58, 0x04, 0x04, 0x02, 0x18, 0x08]);

  const barTicks = 4 * tpb;
  chords.forEach((ch, ci) => {
    const start = ci * barTicks;
    for (const n of ch.notes) {
      add(start, [0x90, n, 90]);
      add(start + barTicks - 24, [0x80, n, 0]);
    }
    for (const bp of bassPattern) {
      const t = start + Math.round(bp.t * tpb) + jit(6);
      const dur = Math.round(bp.d * tpb);
      const n = ch.bass + bp.oct * 12 + (bp.semi || 0);
      const v = jvel(bp.oct > 0 ? 88 : 100, 8);
      add(t, [0x90, n, v]);
      add(t + dur, [0x80, n, 0]);
    }
    if (arp) {
      const tones = [];
      for (let o = 0; o < 2; o++) for (const n of ch.notes) tones.push(n + o * 12);
      for (let s2 = 0; s2 < 16; s2++) {
        const t = start + s2 * (tpb / 4) + jit(5);
        const n = tones[s2 % tones.length];
        add(Math.round(t), [0x90, n, jvel(s2 % 4 === 0 ? 72 : 60, 10)]);
        add(Math.round(t + tpb / 4) - 12, [0x80, n, 0]);
      }
    }
  });

  ev.sort((a, b) => a.tick - b.tick || (a.bytes[0] === 0x80 ? -1 : 1));

  const track = [];
  let last = 0;
  for (const e of ev) {
    track.push(...vlq(Math.max(0, e.tick - last)), ...e.bytes);
    last = e.tick;
  }
  track.push(0x00, 0xFF, 0x2F, 0x00); // end of track

  const hdr = [
    0x4D, 0x54, 0x68, 0x64, 0x00, 0x00, 0x00, 0x06, // MThd, len 6
    0x00, 0x00, 0x00, 0x01,                         // format 0, 1 track
    (tpb >> 8) & 0xff, tpb & 0xff,
  ];
  const trk = [
    0x4D, 0x54, 0x72, 0x6B,
    (track.length >>> 24) & 0xff, (track.length >>> 16) & 0xff,
    (track.length >>> 8) & 0xff, track.length & 0xff,
  ];
  return new Uint8Array([...hdr, ...trk, ...track]);
}

// quick sanity parse: returns {noteOns, noteOffs, hasTempo} or throws
export function parseMidiInfo(u8) {
  const s = String.fromCharCode(...u8.slice(0, 4));
  if (s !== 'MThd') throw new Error('not a MIDI file');
  let i = 14; // skip header chunk (always 14 bytes here)
  const ts = String.fromCharCode(...u8.slice(i, i + 4));
  if (ts !== 'MTrk') throw new Error('no MTrk');
  const len = (u8[i + 4] << 24) | (u8[i + 5] << 16) | (u8[i + 6] << 8) | u8[i + 7];
  let p = i + 8;
  const end = p + len;
  let noteOns = 0, noteOffs = 0, hasTempo = false;
  const readVlq = () => { let v = 0, b; do { b = u8[p++]; v = (v << 7) | (b & 0x7f); } while (b & 0x80); return v; };
  while (p < end) {
    readVlq();
    const st = u8[p++];
    if (st === 0xFF) {
      const type = u8[p++], l = readVlq();
      if (type === 0x51) hasTempo = true;
      if (type === 0x2F) break;
      p += l;
    } else if (st === 0x90 || st === 0x80) {
      const vel = u8[p + 1]; p += 2;
      if (st === 0x90 && vel > 0) noteOns++; else noteOffs++;
    } else { throw new Error('unexpected status ' + st.toString(16)); }
  }
  return { noteOns, noteOffs, hasTempo };
}
