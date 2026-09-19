/* Shared card renderer — used by the root rack and by the category hubs, so a
   card looks and says the same thing wherever it appears. Pure: takes the
   registry entry plus the vault's per-tool roll-up, returns HTML. */

import { fmtBytes } from './vault.js';

export const esc = (s) => String(s == null ? '' : s)
  .replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const NET_LABEL = { none: 'NO NETWORK', models: 'MODEL DOWNLOAD', cdn: 'CDN AT LOAD', api: 'CALLS AN API' };

export function postureChips(i) {
  const out = [];
  out.push(i.posture.device ? '<span class="pill ok">ON-DEVICE</span>' : '<span class="pill net">OFF-DEVICE</span>');
  out.push(`<span class="pill ${i.posture.net === 'none' ? 'ok' : 'net'}">${NET_LABEL[i.posture.net] || esc(i.posture.net)}</span>`);
  if (i.posture.weight) out.push(`<span class="pill dl">⇩ ${esc(i.posture.weight)}</span>`);
  return out.join('');
}

export function stateChip(i, state) {
  const s = state && state[i.id];
  if (!s || !s.keys) return '';
  const bits = s.bits.slice(0, 2).join(' · ');
  return `<span class="pill state" title="${esc(fmtBytes(s.bytes))} saved in this browser">● ${esc(bits || 'saved locally')}</span>`;
}

export function card(i, n, state, { prefix = '' } = {}) {
  const href = (h) => (/^https?:|^#/.test(h) ? h : prefix + h);
  const subs = (i.subs || []).length
    ? `<details class="subs"><summary>${i.subs.length} more</summary><ul>${i.subs.map((s) =>
        `<li><a href="${esc(href(s.href))}"${s.ext ? ' target="_blank" rel="noopener"' : ''}>${esc(s.label)}${s.ext ? ' ↗' : ''}</a>${s.note ? `<small>${esc(s.note)}</small>` : ''}</li>`).join('')}</ul></details>`
    : '';
  return `
<article class="mod" data-id="${i.id}" data-domain="${i.domain}" tabindex="-1">
  <span class="brk" style="top:-1px;left:-1px;border-right:0;border-bottom:0"></span>
  <span class="brk" style="top:-1px;right:-1px;border-left:0;border-bottom:0"></span>
  <span class="brk" style="bottom:-1px;left:-1px;border-right:0;border-top:0"></span>
  <span class="brk" style="bottom:-1px;right:-1px;border-left:0;border-top:0"></span>
  <div class="top">
    <span class="no">${String(n).padStart(2, '0')}</span>
    <span class="no">${esc(i.domain.toUpperCase())}</span>
    ${i.badge ? `<span class="badge">${esc(i.badge)}</span>` : ''}
  </div>
  <h2><a href="${esc(href(i.href))}"${i.external ? ' target="_blank" rel="noopener"' : ''}>${esc(i.name)}</a></h2>
  <div class="kicker">${esc(i.kicker)}</div>
  <p class="blurb">${esc(i.blurb)}</p>
  ${(i.facts || []).length ? `<ul class="facts">${i.facts.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}
  <div class="posture">${postureChips(i)}${stateChip(i, state)}</div>
  ${subs}
</article>`;
}

/* pointer spotlight + whole-card click, shared by every grid that renders cards */
export function wireCards(root, onOpen) {
  root.querySelectorAll('.mod').forEach((el) => {
    el.addEventListener('pointermove', (ev) => {
      const r = el.getBoundingClientRect();
      el.style.setProperty('--mx', (ev.clientX - r.left) + 'px');
      el.style.setProperty('--my', (ev.clientY - r.top) + 'px');
    });
    el.addEventListener('click', (ev) => {
      if (ev.target.closest('a, button, summary, details')) return;
      onOpen(el.dataset.id, el);
    });
  });
}
