// midi.js — minimal Standard MIDI File (type 0) writer. Pure JS, no imports.
// notesToMidi(notes) -> Uint8Array. notes: [{midi, start, dur, conf}]

function vlq(value) {
  let v = Math.max(0, Math.floor(value));
  const bytes = [v & 0x7f];
  v >>= 7;
  while (v > 0) { bytes.unshift((v & 0x7f) | 0x80); v >>= 7; }
  // set continuation bits on all but last
  for (let i = 0; i < bytes.length - 1; i++) bytes[i] |= 0x80;
  return bytes;
}

export function notesToMidi(notes, { bpm = 120, ticksPerQuarter = 480 } = {}) {
  const mpq = Math.round(60000000 / bpm); // microseconds per quarter
  const secToTick = s => Math.round(s * bpm / 60 * ticksPerQuarter);
  const events = [];
  const sorted = [...notes].sort((a, b) => a.start - b.start || a.midi - b.midi);
  for (const n of sorted) {
    const on = secToTick(n.start);
    const off = secToTick(n.start + Math.max(0.03, n.dur));
    const vel = Math.round(64 + 48 * Math.min(1, Math.max(0, n.conf || 0.7)));
    events.push({ tick: on, bytes: [0x90, n.midi & 0x7f, vel & 0x7f] });
    events.push({ tick: off, bytes: [0x80, n.midi & 0x7f, 64] });
  }
  events.sort((a, b) => a.tick - b.tick);

  const track = [];
  // tempo + time signature
  track.push(...vlq(0), 0xff, 0x51, 0x03, (mpq >> 16) & 0xff, (mpq >> 8) & 0xff, mpq & 0xff);
  track.push(...vlq(0), 0xff, 0x58, 0x04, 0x04, 0x02, 0x18, 0x08);
  // track name
  const name = [...'MELODY'].map(c => c.charCodeAt(0));
  track.push(...vlq(0), 0xff, 0x03, name.length, ...name);

  let lastTick = 0;
  const active = new Set();
  for (const ev of events) {
    const isOn = ev.bytes[0] === 0x90;
    const key = ev.bytes[1];
    // guard: never double-on without off (can happen on merged overlaps)
    if (isOn && active.has(key)) {
      track.push(...vlq(ev.tick - lastTick), 0x80, key, 64);
      lastTick = ev.tick;
      active.delete(key);
    }
    track.push(...vlq(ev.tick - lastTick), ...ev.bytes);
    lastTick = ev.tick;
    if (isOn) active.add(key); else active.delete(key);
  }
  track.push(...vlq(0), 0xff, 0x2f, 0x00); // end of track

  const header = [
    0x4d, 0x54, 0x68, 0x64, // MThd
    0x00, 0x00, 0x00, 0x06, // length 6
    0x00, 0x00,             // format 0
    0x00, 0x01,             // 1 track
    (ticksPerQuarter >> 8) & 0xff, ticksPerQuarter & 0xff,
  ];
  const thead = [
    0x4d, 0x54, 0x72, 0x6b, // MTrk
    (track.length >>> 24) & 0xff, (track.length >>> 16) & 0xff,
    (track.length >>> 8) & 0xff, track.length & 0xff,
  ];
  return new Uint8Array([...header, ...thead, ...track]);
}

// quick self-test when run directly in Node
if (typeof process !== 'undefined' && process.argv[1] && process.argv[1].endsWith('midi.js')) {
  const data = notesToMidi([
    { midi: 60, start: 0, dur: 0.5, conf: 0.9 },
    { midi: 64, start: 0.5, dur: 0.5, conf: 0.5 },
    { midi: 67, start: 0.5, dur: 0.25, conf: 0.8 }, // overlap stress
  ]);
  const okHdr = data[0] === 0x4d && data[1] === 0x54 && data[2] === 0x68 && data[3] === 0x64;
  const okTrk = data[14] === 0x4d && data[15] === 0x54 && data[16] === 0x72 && data[17] === 0x6b;
  const tlen = (data[18] << 24) | (data[19] << 16) | (data[20] << 8) | data[21];
  const okLen = data.length === 22 + tlen;
  // count note-ons (0x90) in the track body
  let ons = 0;
  for (let i = 22; i < data.length - 2; i++) if (data[i] === 0x90) ons++;
  console.log('header', okHdr ? 'OK' : 'FAIL', '| track', okTrk ? 'OK' : 'FAIL',
    '| length', okLen ? 'OK' : 'FAIL', '| note-ons', ons === 3 ? 'OK(3)' : `FAIL(${ons})`,
    '| bytes', data.length);
  process.exit(okHdr && okTrk && okLen && ons === 3 ? 0 : 1);
}
