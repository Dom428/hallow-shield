// Hallow Shield options page: My filters, Sites (per-site Strict / Off, with Delete) and Stats (from the background,
// kept in storage.local; "Clear stats"). My filters: Converted here with the same converter as the lists (convert.js via
// userfilters.js) so every line shows what it became or why it was refused; the background turns the saved text into
// dynamic rules and hiding CSS. Export / import use a plain text file on this PC - nothing is sent anywhere.
import { compileUserFilters } from './userfilters.js';
import { MODE_KEYS, MODE_LABEL } from './shared.js';
const ext = globalThis.browser ?? chrome;
const $ = id => document.getElementById(id);
const box = $('filters');
let saved = (await ext.storage.local.get({ myFilters: '' })).myFilters;
box.value = saved;

const frag = document.createDocumentFragment();
const validSelector = sel => { try { frag.querySelector(sel); return true; } catch { return false; } };
const compile = text => compileUserFilters(text, { validSelector });

// regex filters: the browser says whether its regex engine takes them (before they're saved)
async function regexErrors(out) {
  const errs = [];
  if (!ext.declarativeNetRequest.isRegexSupported) return errs;
  for (const r of out.rules) {
    const c = r.condition;
    if (!c.regexFilter) continue;
    try {
      const v = await ext.declarativeNetRequest.isRegexSupported({ regex: c.regexFilter, isCaseSensitive: !!c.isUrlFilterCaseSensitive });
      if (!v.isSupported) errs.push({ line: out.lineOf[r.id], error: 'The browser can\'t use this regex (' + (v.reason || 'not supported') + ').' });
    } catch { }
  }
  return errs;
}
function status(text, ok = true) { $('status').textContent = text; $('status').className = 'small ' + (ok ? 'ok' : 'bad'); }
function render(out, extra = []) {
  const lines = box.value.split(/\r?\n/);
  const all = [...out.errors.map(e => ({ line: e.line, error: e.error })), ...extra].sort((a, b) => a.line - b.line);
  $('errors').replaceChildren(...all.map(e => {
    const li = document.createElement('li'); li.dataset.line = e.line;
    const b = document.createElement('b'); b.textContent = `Line ${e.line}: `;
    const code = document.createElement('code'); code.textContent = (lines[e.line - 1] || '').trim().slice(0, 300);
    li.append(b, document.createTextNode(e.error + ' '), code);
    li.onclick = () => jump(e.line);
    return li;
  }));
  const c = out.counts;
  $('summary').textContent = `${c.network} network rule${c.network === 1 ? '' : 's'}, ${c.cosmetic} hiding filter${c.cosmetic === 1 ? '' : 's'}` +
    (c.flags ? `, ${c.flags} hiding exception${c.flags === 1 ? '' : 's'}` : '') + (all.length ? ` - ${all.length} line${all.length === 1 ? '' : 's'} not used:` : '');
  renderZapped();
}
function jump(n) {
  const lines = box.value.split('\n'); let at = 0;
  for (let i = 0; i < n - 1 && i < lines.length; i++) at += lines[i].length + 1;
  box.focus(); box.setSelectionRange(at, at + (lines[n - 1] || '').length);
}
// the per-site hiding lines, each with Delete
function renderZapped() {
  const items = [];
  saved.split(/\r?\n/).forEach((l, i) => { const t = l.trim(); if (/^[a-z0-9.*~,-]+##/i.test(t) && !t.includes('##+js(')) items.push([i, t]); });
  $('zapped').replaceChildren(...items.map(([i, t]) => {
    const li = document.createElement('li');
    const code = document.createElement('code'); code.textContent = t;
    const del = document.createElement('button'); del.textContent = 'Delete'; del.title = 'Delete this filter and save';
    del.onclick = async () => {
      const lines = saved.split(/\r?\n/); if ((lines[i] || '').trim() !== t) return;
      lines.splice(i, 1); box.value = lines.join('\n'); await save('Deleted ' + t);
    };
    li.append(code, del); return li;
  }));
}
async function save(msg) {
  const text = box.value.replace(/\r\n/g, '\n');
  const out = compile(text);
  const extra = await regexErrors(out);
  saved = text;
  await ext.storage.local.set({ myFilters: text });
  render(out, extra);
  status(msg || (out.errors.length + extra.length ? `Saved. ${out.errors.length + extra.length} line(s) can't be used - see below.` : 'Saved.'), true);
  // what the browser itself refused (after the background has applied the new text)
  for (let i = 0; i < 30; i++) {
    const r = await ext.storage.local.get({ userSynced: null, userRefused: [] });
    if (r.userSynced === text) { if (r.userRefused.length) render(out, [...extra, ...r.userRefused]); break; }
    await new Promise(res => setTimeout(res, 100));
  }
}
$('save').onclick = () => save();
$('revert').onclick = () => { box.value = saved; render(compile(saved)); status('Back to what was saved.'); };
let timer = 0;
box.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { render(compile(box.value)); $('status').textContent = box.value === saved ? '' : 'Not saved yet.'; $('status').className = 'small'; }, 250); });
box.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); save(); } });

// export: the saved filters as a text file; import: a text file's filters added to yours (lines you already have are skipped)
$('export').onclick = () => {
  const blob = new Blob([saved], { type: 'text/plain' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'hallow-shield-my-filters.txt';
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  status('Exported to hallow-shield-my-filters.txt.');
};
$('import').onclick = () => $('file').click();
$('file').onchange = async () => {
  const f = $('file').files[0]; $('file').value = '';
  if (!f) return;
  if (f.size > 2 * 1024 * 1024) { status('That file is too big for a filter list here (2 MB at most).', false); return; }
  const text = (await f.text()).replace(/\r\n/g, '\n');
  const have = new Set(box.value.split('\n').map(l => l.trim()).filter(Boolean));
  const add = text.split('\n').filter(l => !l.trim() || !have.has(l.trim()));
  const base = box.value.replace(/\n+$/, '');
  box.value = base ? base + '\n' + add.join('\n').replace(/^\n+/, '') : add.join('\n');
  await save(`Imported ${add.filter(l => l.trim()).length} line(s) from ${f.name} and saved.`);
};

// the zapper may save while this page is open: show it, unless you're in the middle of editing
ext.storage.onChanged.addListener((ch, area) => {
  if (area !== 'local' || !ch.myFilters) return;
  const v = ch.myFilters.newValue || '';
  if (v === saved) return;
  const editing = box.value !== saved;
  saved = v;
  if (!editing) { box.value = v; render(compile(v)); } else renderZapped();
});
render(compile(saved));

// ---- tabs: #filters, #sites, #stats ----
function showTab() {
  const t = ['filters', 'sites', 'stats'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'filters';
  for (const p of document.querySelectorAll('.pane')) p.hidden = p.dataset.pane !== t;
  for (const a of document.querySelectorAll('.tabs a')) { a.classList.toggle('on', a.dataset.tab === t); a.setAttribute('aria-selected', a.dataset.tab === t); }
  if (t === 'stats') loadStats();
  if (t === 'sites') renderSites();
}
window.addEventListener('hashchange', showTab);

// ---- Sites: the per-site modes chosen in the popup (Strict / Off, and the No hiding / Blocking only steps "Try fixing
// this site" can leave), each with Delete (back to Normal) ----
async function renderSites() {
  const s = await ext.storage.local.get({ paused: [], strict: [], noHide: [], blockOnly: [], strictRules: 0, strictError: '' });
  const rows = Object.entries(MODE_KEYS).flatMap(([mode, k]) => s[k].map(d => [d, mode])).sort((a, b) => a[0] < b[0] ? -1 : 1);
  $('siteRows').replaceChildren(...rows.map(([d, mode]) => {
    const tr = document.createElement('tr'); tr.dataset.site = d;
    const a = document.createElement('td'); a.textContent = d;
    const b = document.createElement('td'); b.className = 'mode-' + mode; b.textContent = MODE_LABEL[mode];
    const c = document.createElement('td');
    const del = document.createElement('button'); del.textContent = 'Delete'; del.title = 'Back to Normal on ' + d;
    del.onclick = async () => {
      const k = MODE_KEYS[mode], cur = await ext.storage.local.get({ [k]: [] });
      await ext.storage.local.set({ [k]: cur[k].filter(x => x !== d) });
      renderSites();
    };
    c.append(del); tr.append(a, b, c); return tr;
  }));
  $('sitesEmpty').hidden = rows.length > 0;
  $('strictInfo').textContent = s.strict.length ? (s.strictError ? 'The browser refused the Strict rules: ' + s.strictError : `Strict sites use ${s.strictRules} extra rules (pop-up and annoyance lists, limited to those sites).`) : '';
}
ext.storage.onChanged.addListener((ch, area) => { if (area === 'local' && (ch.paused || ch.strict || ch.noHide || ch.blockOnly || ch.strictRules) && !document.querySelector('[data-pane="sites"]').hidden) renderSites(); });

// ---- Stats ----
const num = n => n.toLocaleString();
function renderStats(v) {
  if (!v || v.error) { $('statsStatus').textContent = 'Couldn\'t read the stats' + (v && v.error ? ': ' + v.error : '.'); return; }
  $('statsAccess').hidden = v.feedback;
  $('tBlocked').textContent = num(v.totals.blocked); $('tToday').textContent = num(v.today.blocked);
  $('tAds').textContent = num(v.totals.ads); $('tTrackers').textContent = num(v.totals.trackers); $('tClicks').textContent = num(v.totals.clicks);
  // 30 stacked bars (ads, trackers, other), one per day
  const W = 860, H = 170, padL = 34, padB = 18, padT = 6, bw = (W - padL) / v.days.length;
  const max = Math.max(1, ...v.days.map(d => d.ads + d.trackers + d.other));
  const nice = (() => { const p = 10 ** Math.floor(Math.log10(max)); for (const m of [1, 2, 5, 10]) if (m * p >= max) return m * p; return max; })();
  const y = n => H - padB - (n / nice) * (H - padB - padT);
  const NS = 'http://www.w3.org/2000/svg', el = (t, a) => { const e = document.createElementNS(NS, t); for (const [k, x] of Object.entries(a)) e.setAttribute(k, x); return e; };
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none' });
  for (const f of [0, 0.5, 1]) {
    svg.append(el('line', { x1: padL, x2: W, y1: y(nice * f), y2: y(nice * f), class: 'grid' }));
    const t = el('text', { x: padL - 4, y: y(nice * f) + 3, 'text-anchor': 'end' }); t.textContent = num(Math.round(nice * f)); svg.append(t);
  }
  v.days.forEach((d, i) => {
    let base = 0;
    const g = el('g', {}); const title = el('title', {}); title.textContent = `${d.day}: ${num(d.ads)} ads, ${num(d.trackers)} trackers, ${num(d.other)} other, ${num(d.clicks)} cookie banners answered`; g.append(title);
    for (const k of ['ads', 'trackers', 'other']) {
      if (!d[k]) continue;
      const y1 = y(base + d[k]), y0 = y(base);
      g.append(el('rect', { x: padL + i * bw + 1.5, y: y1, width: Math.max(1, bw - 3), height: Math.max(1, y0 - y1), class: k }));
      base += d[k];
    }
    svg.append(g);
    if (i % 5 === 4 || i === v.days.length - 1) { const t = el('text', { x: padL + i * bw + bw / 2, y: H - 4, 'text-anchor': 'middle' }); t.textContent = d.label; svg.append(t); }
  });
  $('chart').replaceChildren(svg);
  const list = (id, rows) => $(id).replaceChildren(...rows.map(([k, n]) => { const li = document.createElement('li'); li.textContent = k; const sp = document.createElement('span'); sp.textContent = num(n); li.append(sp); return li; }));
  list('topSites', v.topSites); list('topDomains', v.topDomains);
  $('sharedNote').textContent = v.shared ? `${num(v.shared)} more blocked by rules that cover many hosts at once (the host isn't known).` : '';
  $('statsStatus').textContent = v.source === 'clicks-only' ? 'Only cookie-banner clicks are counted until blocked counts are turned on.' : v.source === 'debug' ? 'Development build: every block is counted as it happens.' : '';
}
async function loadStats() { renderStats(await ext.runtime.sendMessage({ t: 'stats-get' })); }
$('statsRefresh').onclick = loadStats;
$('statsClear').onclick = async () => {
  if (!confirm('Clear all of Shield\'s stats? This can\'t be undone.')) return;
  renderStats(await ext.runtime.sendMessage({ t: 'stats-clear' }));
  $('statsStatus').textContent = 'Stats cleared.';
};
$('statsGrant').onclick = async () => {
  let ok = false;
  try { ok = await ext.permissions.request({ permissions: ['declarativeNetRequestFeedback'] }); } catch { }
  $('statsStatus').textContent = ok ? 'Blocked counts are on: from now on Shield counts what the browser blocks.' : 'Not turned on.';
  if (ok) loadStats();
};
showTab();
