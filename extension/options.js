// Hallow Shield options page: My filters. Converted here with the same converter as the lists (convert.js via
// userfilters.js) so every line shows what it became or why it was refused; the background turns the saved text into
// dynamic rules and hiding CSS. Export / import use a plain text file on this PC - nothing is sent anywhere.
import { compileUserFilters } from './userfilters.js';
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
