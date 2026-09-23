// test-geo.mjs — node unit tests for geo.js (pure module).
import { COUNTRIES, CUES, CUE_BY_ID, CUE_GROUPS, scoreCues, regionRollup, parseExif, analyzePixels, suggestCues } from './geo.js';

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log('  ok', name); }
  else { fail++; console.log('  FAIL', name, extra); }
};

// ---- synthetic EXIF builder (little- or big-endian TIFF in APP1) ----
function buildJpeg({ le = true, gps = null, make = 'Apple', model = 'iPhone 15', datetime = '2026:09:22 21:30:00' } = {}) {
  const buf = [];
  const push8 = v => buf.push(v & 0xff);
  const push16 = v => le ? (push8(v), push8(v >> 8)) : (push8(v >> 8), push8(v));
  const push32 = v => le ? (push16(v), push16(v >> 16)) : (push16(v >> 16), push16(v));
  const pushStr = s => { for (const c of s) push8(c.charCodeAt(0)); push8(0); };
  // TIFF body built separately so offsets are relative to TIFF start
  const t = [];
  const t8 = v => t.push(v & 0xff);
  const t16 = v => le ? (t8(v), t8(v >> 8)) : (t8(v >> 8), t8(v));
  const t32 = v => le ? (t16(v), t16(v >> 16)) : (t16(v >> 16), t16(v));
  const tStr = s => { const at = t.length; for (const c of s) t8(c.charCodeAt(0)); t8(0); return at; };
  const tAsciiEntry = (tag, s) => {
    const at = tStr(s);
    return [tag, 2, s.length + 1, at];
  };
  const tRat = (num, den) => { const at = t.length; t32(num); t32(den); return at; };
  t8(le ? 0x49 : 0x4d); t8(le ? 0x49 : 0x4d); t16(42); t32(8);
  // IFD0 entries collected, data area appended after
  const entries0 = [];
  entries0.push(tAsciiEntry(0x010f, make));
  entries0.push(tAsciiEntry(0x0110, model));
  let gpsIfdAt = null, exifIfdAt = null;
  if (gps) {
    // reserve placeholder, fill after GPS IFD built
    gpsIfdAt = 0; // patched below
  }
  // We need data offsets before writing entries; build data first.
  // Simpler: entries reference absolute tiff-relative offsets computed now.
  // Write IFD0 at offset 8:
  const ifd0At = 8;
  // data starts after entries: 2 + n*12 + 4
  const n0 = entries0.length + (gps ? 1 : 0) + 1; // +gps ptr +exif ptr
  const dataStart = ifd0At + 2 + n0 * 12 + 4;
  while (t.length < dataStart) t8(0);
  // ascii data already written inline above via tStr? No — tStr wrote at current
  // position which is wrong. Redo cleanly: rebuild with two passes.
  return buildJpegClean({ le, gps, make, model, datetime });
}

function buildJpegClean({ le = true, gps = null, make = 'Apple', model = 'iPhone 15', datetime = '2026:09:22 21:30:00' }) {
  const t = [];
  const t8 = v => t.push(v & 0xff);
  const t16 = v => le ? (t8(v), t8(v >> 8)) : (t8(v >> 8), t8(v));
  const t32 = v => le ? (t16(v), t16(v >> 16)) : (t16(v >> 16), t16(v));
  t8(le ? 0x49 : 0x4d); t8(le ? 0x49 : 0x4d); t16(42); t32(8);
  // pass 1: collect data blobs
  const blobs = [];
  const blob = bytes => { const at = null; blobs.push(bytes); return blobs.length - 1; };
  const strBytes = s => { const a = []; for (const c of s) a.push(c.charCodeAt(0)); a.push(0); return a; };
  const bMake = blob(strBytes(make)), bModel = blob(strBytes(model)), bDt = blob(strBytes(datetime));
  let bLatRef, bLat, bLonRef, bLon;
  if (gps) {
    bLatRef = blob([gps.latRef.charCodeAt(0), 0]);
    const la = Math.abs(gps.lat), lo = Math.abs(gps.lon);
    const dms = v => { const d = Math.floor(v); const m = Math.floor((v - d) * 60); const s = Math.round(((v - d) * 60 - m) * 60 * 100); return [d, 1, m, 1, s, 100]; };
    const rats = arr => { const a = []; const push32le = x => le ? (a.push(x & 0xff, (x >> 8) & 0xff, (x >> 16) & 0xff, (x >> 24) & 0xff)) : (a.push((x >> 24) & 0xff, (x >> 16) & 0xff, (x >> 8) & 0xff, x & 0xff)); for (const x of arr) push32le(x); return a; };
    bLat = blob(rats(dms(la))); bLonRef = blob([gps.lonRef.charCodeAt(0), 0]); bLon = blob(rats(dms(lo)));
  }
  // pass 2: layout — IFD0 at 8, then data area, then sub-IFDs
  const ifd = (entries) => {
    const a = []; const p16 = v => { if (le) a.push(v & 0xff, (v >> 8) & 0xff); else a.push((v >> 8) & 0xff, v & 0xff); };
    const p32 = v => { if (le) { p16(v & 0xffff); p16((v >>> 16) & 0xffff); } else { p16((v >>> 16) & 0xffff); p16(v & 0xffff); } };
    p16(entries.length);
    for (let [tag, type, count, val] of entries) {
      // TIFF: short inline ASCII is byte-ordered — chars occupy the FIRST
      // bytes of the 4-byte field in both endiannesses. The caller packs
      // chars little-endian (c0 in the low byte); repack for big-endian.
      if (!le && type === 2 && count <= 4) {
        let be = 0;
        for (let i = 0; i < count; i++) be |= ((val >> (8 * i)) & 0xff) << (8 * (3 - i));
        val = be;
      }
      p16(tag); p16(type); p32(count); p32(val);
    }
    p32(0);
    return a;
  };
  const ifd0At = 8;
  const n0ents = 2 + 1 + (gps ? 1 : 0); // make, model, exifptr, (+gpsptr)
  const dataAt = ifd0At + 2 + n0ents * 12 + 4;
  const blobOff = [];
  let cur = dataAt;
  for (const b of blobs) { blobOff.push(cur); cur += b.length; }
  const exifIfdAt = cur;
  const exifEntries = ifd([[0x9003, 2, datetime.length + 1, blobOff[bDt]]]);
  cur += exifEntries.length;
  let gpsIfdAt = 0;
  let gpsEntries = [];
  if (gps) {
    gpsIfdAt = cur;
    gpsEntries = ifd([
      [0x0001, 2, 2, gps.latRef.charCodeAt(0)], // short ASCII stored inline per spec
      [0x0002, 5, 3, blobOff[bLat]],
      [0x0003, 2, 2, gps.lonRef.charCodeAt(0)],
      [0x0004, 5, 3, blobOff[bLon]],
    ]);
    cur += gpsEntries.length;
  }
  const ifd0ents = [
    [0x010f, 2, make.length + 1, blobOff[bMake]],
    [0x0110, 2, model.length + 1, blobOff[bModel]],
    [0x8769, 4, 1, exifIfdAt],
  ];
  if (gps) ifd0ents.push([0x8825, 4, 1, gpsIfdAt]);
  const ifd0 = ifd(ifd0ents);
  const tiff = [];
  const cat = a => { for (const x of a) tiff.push(x); };
  // header 8 bytes already conceptually; build full tiff:
  const hdr = [];
  const h8 = v => hdr.push(v & 0xff);
  const h16 = v => le ? (h8(v), h8(v >> 8)) : (h8(v >> 8), h8(v));
  const h32 = v => le ? (h16(v), h16(v >> 16)) : (h16(v >> 16), h16(v));
  h8(le ? 0x49 : 0x4d); h8(le ? 0x49 : 0x4d); h16(42); h32(8);
  cat(hdr); cat(ifd0);
  for (let i = 0; i < blobs.length; i++) cat(blobs[i]);
  cat(exifEntries); cat(gpsEntries);
  // APP1 segment
  const exifHead = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]; // "Exif\0\0"
  const seg = [...exifHead, ...tiff];
  const file = [0xFF, 0xD8, 0xFF, 0xE1, (seg.length + 2) >> 8, (seg.length + 2) & 0xff, ...seg, 0xFF, 0xD9];
  return new Uint8Array(file);
}

console.log('EXIF parser');
{
  const jpg = buildJpegClean({ le: true, gps: { lat: 39.9, lon: -79.7333, latRef: 'N', lonRef: 'W' } });
  const r = parseExif(jpg);
  ok(r.hasExif, 'detects exif');
  ok(r.make === 'Apple', 'make', r.make);
  ok(r.model === 'iPhone 15', 'model', r.model);
  ok(r.datetime === '2026:09:22 21:30:00', 'datetime', r.datetime);
  ok(Math.abs(r.lat - 39.9) < 0.001, 'lat N', String(r.lat));
  ok(Math.abs(r.lon - (-79.7333)) < 0.001, 'lon W', String(r.lon));
}
{
  const jpg = buildJpegClean({ le: false, gps: { lat: 51.5, lon: -0.12, latRef: 'N', lonRef: 'W' } });
  const r = parseExif(jpg);
  ok(Math.abs(r.lat - 51.5) < 0.001 && Math.abs(r.lon - (-0.12)) < 0.001, 'big-endian gps');
}
{
  const jpg = buildJpegClean({ le: true, gps: null });
  const r = parseExif(jpg);
  ok(r.hasExif && r.lat === null && r.lon === null, 'no-gps exif');
  ok(r.make === 'Apple', 'no-gps keeps make');
}
{
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const r = parseExif(png);
  ok(!r.hasExif && r.lat === null, 'non-jpeg rejected');
}
{
  const jpg = buildJpegClean({ le: true, gps: { lat: 33.3, lon: 44.4, latRef: 'N', lonRef: 'E' } });
  // corrupt: flip SOI
  jpg[0] = 0x00;
  const r = parseExif(jpg);
  ok(!r.hasExif, 'corrupt handled gracefully');
}

console.log('pixel heuristics');
{
  const w = 30, h = 30, data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { // green bottom 2/3, blue top 1/3
    const y = Math.floor(i / w);
    const o = i * 4;
    if (y < h / 3) { data[o] = 60; data[o + 1] = 120; data[o + 2] = 220; }
    else { data[o] = 40; data[o + 1] = 160; data[o + 2] = 60; }
    data[o + 3] = 255;
  }
  const r = analyzePixels({ data, width: w, height: h });
  ok(r.veg > 0.9, 'veg detected', String(r.veg));
  ok(r.sky > 0.9, 'sky detected', String(r.sky));
  ok(!r.night, 'daytime');
}
{
  const w = 10, h = 10, data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { data[i * 4] = 8; data[i * 4 + 1] = 8; data[i * 4 + 2] = 10; data[i * 4 + 3] = 255; }
  const r = analyzePixels({ data, width: w, height: h });
  ok(r.night && r.veg === 0 && r.sky === 0, 'night image');
}
{
  const s = suggestCues({ veg: 0.5, sky: 0.5, bright: 0.6, warm: 0.1, night: false });
  ok(s.some(x => x.id === 'auto-veg') && s.some(x => x.id === 'auto-sky'), 'suggestions for green/blue');
  const n = suggestCues({ veg: 0, sky: 0, bright: 0.05, warm: 0, night: true });
  ok(n.some(x => x.id === 'auto-night') && n.length === 1, 'night suggestion only');
}

console.log('scoring engine');
{
  const top = scoreCues(['script-cyrillic', 'drive-right']).slice(0, 5).map(r => r.country.id);
  ok(['ru', 'ua', 'bg', 'rs', 'kz'].every(id => top.includes(id)), 'cyrillic+right → EE/C.Asia', top.join(','));
}
{
  const top = scoreCues(['drive-left', 'plate-uk']).slice(0, 3).map(r => r.country.id);
  ok(top[0] === 'gb', 'left + UK plates → GB', top.join(','));
}
{
  const top = scoreCues(['script-arabic', 'veg-desert']).slice(0, 6).map(r => r.country.id);
  ok(top.includes('sa') && top.includes('ae') && top.includes('eg'), 'arabic+desert → Gulf/Egypt', top.join(','));
}
{
  const top = scoreCues(['script-hangul']).map(r => r.country.id);
  ok(top[0] === 'kr', 'hangul → Korea', top.slice(0, 3).join(','));
}
{
  const top = scoreCues(['st-schoolbus', 'mark-yellow']).map(r => r.country.id);
  ok(top[0] === 'us' || top[0] === 'ca', 'schoolbus+yellow → US/CA', top.slice(0, 3).join(','));
}
{
  const top = scoreCues(['st-keicar', 'pole-wires']).map(r => r.country.id);
  ok(top[0] === 'jp', 'keicar+wires → Japan', top.slice(0, 3).join(','));
}
{
  const top = scoreCues(['script-georgian']).map(r => r.country.id);
  ok(top[0] === 'ge', 'georgian → Georgia', top.slice(0, 3).join(','));
}
{
  const top = scoreCues(['drive-left', 'script-thai', 'st-tuktuk']).map(r => r.country.id);
  ok(top[0] === 'th', 'thai left tuktuk → Thailand', top.slice(0, 3).join(','));
}
{
  const ranked = scoreCues(['script-cjk', 'drive-left', 'pole-wires']);
  ok(ranked[0].country.id === 'jp', 'cjk+left+wires → Japan', ranked[0].country.id);
  ok(ranked[0].pct > 50, 'confidence sane', String(ranked[0].pct));
  ok(ranked[0].matched.length >= 3, 'evidence listed');
}
{
  const ranked = scoreCues(['drive-left', 'script-arabic']); // contradictory-ish
  const pk = ranked.find(r => r.country.id === 'pk');
  ok(pk && pk.matched.includes('Arabic script') && pk.matched.includes('Driving on the LEFT'), 'Pakistan matches arabic+left');
}
{
  const rr = regionRollup(scoreCues(['script-cyrillic', 'drive-right']));
  ok(rr[0].region.includes('Europe'), 'region rollup Europe', rr[0].region);
}
{
  const empty = scoreCues([]);
  ok(empty.every(r => r.pct === 0), 'no cues → zero confidence');
}
{
  // cue registry sanity
  const ids = new Set(CUES.map(c => c.id));
  ok(ids.size === CUES.length, 'cue ids unique');
  ok(CUE_GROUPS.length >= 8, 'cue groups', CUE_GROUPS.join('|'));
  for (const c of COUNTRIES) {
    for (const f of ['scripts', 'plates', 'marks', 'poles', 'arch', 'veg', 'terrain', 'street']) {
      if (!Array.isArray(c[f])) { ok(false, `country ${c.id} field ${f} not array`); break; }
    }
  }
  ok(true, 'country fields are arrays');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
