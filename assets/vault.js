/* VAULT — the local-data console.
 *
 * Every instrument in this suite keeps its state in localStorage, which is
 * per-origin: one "clear site data" and a year of scored weeks is gone. The
 * vault reads those exact keys (never renames them), summarises what is in
 * them, and can round-trip the whole lot through a single backup file.
 *
 * Rules this module holds to:
 *   - reads are lossless: values are carried as the raw strings the tools
 *     wrote, never re-serialised through JSON.parse/stringify
 *   - it never writes unless the user explicitly confirms an import
 *   - secrets (the frame-describe API key) are never rendered and are left
 *     out of exports unless deliberately opted in
 */

import { STORAGE, BY_ID } from './registry.js';

export const SCHEMA = 'tools_vault/v1';
const SPEC = Object.fromEntries(STORAGE.map((s) => [s.key, s]));
/* keys written by an instrument but not enumerable up front */
const PREFIX_OWNERS = [];

export function safeLS() {
  try {
    const t = '__vault_probe__';
    localStorage.setItem(t, '1');
    localStorage.removeItem(t);
    return localStorage;
  } catch (e) { return null; }
}

export function utf16Bytes(s) { return (s == null ? 0 : String(s).length) * 2; }

export function fmtBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(b < 10240 ? 1 : 0) + ' KB';
  return (b / 1048576).toFixed(2) + ' MB';
}

function summarise(spec, raw) {
  if (!spec || typeof spec.sum !== 'function') return [];
  let parsed = raw;
  if (raw && (raw[0] === '{' || raw[0] === '[')) {
    try { parsed = JSON.parse(raw); } catch (e) { return ['unparseable — left untouched']; }
  }
  try {
    const out = spec.sum(parsed);
    return (Array.isArray(out) ? out : [out]).filter(Boolean).map(String);
  } catch (e) { return ['present']; }
}

function startedAt(spec, raw) {
  if (!spec || typeof spec.started !== 'function') return null;
  try { return spec.started(JSON.parse(raw)); } catch (e) { return null; }
}

/** Read everything on this origin. Known keys first, then anything else. */
export function scan() {
  const ls = safeLS();
  if (!ls) return { ok: false, known: [], foreign: [], bytes: 0, reason: 'localStorage is unavailable (private window, or site data blocked)' };

  const all = [];
  for (let i = 0; i < ls.length; i++) all.push(ls.key(i));

  const known = [], foreign = [];
  let bytes = 0;

  for (const key of all) {
    let raw = '';
    try { raw = ls.getItem(key) ?? ''; } catch (e) { raw = ''; }
    const size = utf16Bytes(key) + utf16Bytes(raw);
    bytes += size;

    const spec = SPEC[key] || PREFIX_OWNERS.find((p) => key.startsWith(p.prefix))?.spec;
    const rec = { key, raw, size, spec: spec || null };
    if (spec) {
      rec.tool = spec.tool || null;
      rec.toolName = spec.tool && BY_ID[spec.tool] ? BY_ID[spec.tool].name : (spec.own ? 'SITE' : null);
      rec.label = spec.label;
      rec.secret = !!spec.secret;
      rec.own = !!spec.own;
      rec.summary = spec.secret ? [`${raw.length} chars · never shown, never exported by default`] : summarise(spec, raw);
      rec.startedAt = startedAt(spec, raw);
      known.push(rec);
    } else {
      rec.summary = [`${fmtBytes(size)} — not written by anything in this repo`];
      foreign.push(rec);
    }
  }

  known.sort((a, b) => (a.tool || '~').localeCompare(b.tool || '~') || a.key.localeCompare(b.key));
  foreign.sort((a, b) => b.size - a.size);
  return { ok: true, known, foreign, bytes };
}

/** Per-instrument roll-up for the rack's live state chips.
 *  Settings and view prefs are skipped here — a chip should mean "there is work
 *  saved in this instrument", not "you once picked a dropdown". They are still
 *  listed in the vault and still included in backups. */
export function byTool(scanResult) {
  const map = {};
  for (const r of scanResult.known || []) {
    if (!r.tool || r.secret || r.spec?.pref) continue;
    const e = (map[r.tool] = map[r.tool] || { bytes: 0, keys: 0, bits: [], startedAt: null });
    e.bytes += r.size; e.keys += 1;
    for (const b of r.summary) if (e.bits.length < 3) e.bits.push(b);
    if (r.startedAt && !e.startedAt) e.startedAt = r.startedAt;
  }
  return map;
}

/** Build a backup payload. Raw strings in, raw strings out — nothing reshaped. */
export function buildExport({ keys = null, includeSecrets = false, includeForeign = false } = {}) {
  const s = scan();
  if (!s.ok) throw new Error(s.reason);
  const pick = [];
  for (const r of s.known) {
    if (keys && !keys.includes(r.key)) continue;
    if (r.secret && !includeSecrets) continue;
    if (r.own) continue;                       // this page's own view prefs are not data
    pick.push(r);
  }
  if (includeForeign && !keys) pick.push(...s.foreign);

  const out = {};
  for (const r of pick) out[r.key] = r.raw;
  return {
    schema: SCHEMA,
    exportedAt: new Date().toISOString(),
    origin: location.origin,
    site: location.pathname.replace(/[^/]*$/, ''),
    counts: { keys: pick.length, bytes: pick.reduce((a, r) => a + r.size, 0) },
    secretsIncluded: !!includeSecrets && pick.some((r) => r.secret),
    keys: out,
  };
}

/** What an import would do, before it does it. */
export function planImport(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('not a JSON object');
  if (payload.schema !== SCHEMA) throw new Error(`expected "${SCHEMA}", got "${payload.schema || 'nothing'}"`);
  if (!payload.keys || typeof payload.keys !== 'object') throw new Error('no "keys" block');
  const ls = safeLS();
  if (!ls) throw new Error('localStorage is unavailable — nothing can be restored here');

  const add = [], overwrite = [], same = [], bad = [];
  for (const [key, val] of Object.entries(payload.keys)) {
    if (typeof val !== 'string') { bad.push(key); continue; }
    let cur = null;
    try { cur = ls.getItem(key); } catch (e) { cur = null; }
    const spec = SPEC[key] || null;
    const row = { key, val, cur, spec, known: !!spec, bytes: utf16Bytes(key) + utf16Bytes(val) };
    if (cur === null) add.push(row);
    else if (cur === val) same.push(row);
    else overwrite.push(row);
  }
  return { add, overwrite, same, bad, total: add.length + overwrite.length + same.length };
}

/** Apply a plan. Returns what actually landed. */
export function applyImport(plan, { overwrite = true } = {}) {
  const ls = safeLS();
  if (!ls) throw new Error('localStorage is unavailable');
  const rows = [...plan.add, ...(overwrite ? plan.overwrite : [])];
  const written = [], failed = [];
  for (const r of rows) {
    try { ls.setItem(r.key, r.val); written.push(r.key); }
    catch (e) { failed.push({ key: r.key, err: String(e && e.message || e) }); }
  }
  return { written, failed, skipped: overwrite ? [] : plan.overwrite.map((r) => r.key) };
}

export function download(filename, text, type = 'application/json') {
  const blob = new Blob([text], { type: type + ';charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function stamp() {
  const d = new Date(), p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}
