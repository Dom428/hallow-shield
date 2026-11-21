// Hallow Shield performance check (CI runs it with the REAL rules, after tools/build.mjs): a heavy local test page
// (about 4,000 elements, 120 images and scripts, 6 same-site frames, no ads - so blocking can't make Shield look
// faster - on a .com address, so the biggest page-fix bundle, the .com one, is loaded in every frame) is loaded in Chromium without Shield and with Shield at Optimal (the default), taking turns, and the medians
// are compared:
//   - page load time (navigation start -> load event end)
//   - the content-script cost: the extra main-thread script time with Shield (Chrome's ScriptDuration metric, which
//     counts Shield's content scripts and page fixes too), and the extra style / layout time (its hiding CSS)
// It fails if Shield adds more than 15 % or more than 50 ms to the load time, or more than 50 ms of script time.
// Each round is judged on its own; a round over budget gets up to two fresh rounds (noisy CI machines) before it fails.
//   node test/perf.mjs              (PERF_RUNS=15 by default)
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const { chromium } = await import('playwright').catch(() => createRequire(import.meta.url)('playwright'));

const RUNS = Number(process.env.PERF_RUNS || 15), WARM = 3;
const BUDGET_PCT = 15, BUDGET_MS = 50, SCRIPT_MS = 50;
// every response takes this long, as on a fast connection: with a zero-latency local server, work that overlaps with
// waiting for the network on the real web shows up in full (PERF_LATENCY=0 measures that worst case)
const LATENCY = Number(process.env.PERF_LATENCY ?? 20);

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'extension');
const EXT = fs.mkdtempSync(path.join(os.tmpdir(), 'shield-perf-ext-'));
fs.cpSync(SRC, EXT, { recursive: true });
const mf = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
// a release build, as users get it
fs.writeFileSync(path.join(EXT, 'version.json'), JSON.stringify({ name: 'Hallow Shield', version: mf.version, browser: 'chrome', built: new Date().toISOString(), dev: false }));
const meta = JSON.parse(fs.readFileSync(path.join(EXT, 'rules', 'meta.json'), 'utf8'));
const fs_size = p => { try { return fs.statSync(path.join(EXT, p)).size; } catch { return 0; } };

// ---- the heavy page ----
const WORDS = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua'.split(' ');
const text = (i, n) => Array.from({ length: n }, (_, k) => WORDS[(i * 7 + k * 3) % WORDS.length]).join(' ');
function heavyPage() {
  const parts = ['<header class="site-header"><nav class="main-nav">' + Array.from({ length: 40 }, (_, i) => `<a class="nav-link" href="/s/${i}">${text(i, 1)}</a>`).join('') + '</nav></header><main id="main">'];
  for (let a = 0; a < 120; a++) {
    parts.push(`<article class="card story story-${a % 9}" data-id="${a}"><div class="card-media"><img class="thumb" src="http://img.heavy-news-example.com/t/${a}.gif" width="80" height="60"></div>` +
      `<div class="card-body"><h2 class="title"><a href="/story/${a}">${text(a, 6)}</a></h2><p class="meta"><span class="author">${text(a + 1, 2)}</span> <time>${a} min</time></p>` +
      `<ul class="tags">${Array.from({ length: 6 }, (_, t) => `<li class="tag tag-${t}">${text(a + t, 1)}</li>`).join('')}</ul>` +
      `<div class="excerpt"><p>${text(a, 30)}</p><p>${text(a + 2, 24)}</p></div>` +
      `<div class="comments">${Array.from({ length: 4 }, (_, c) => `<div class="comment"><b class="who">${text(c, 1)}</b><span class="said">${text(a + c, 10)}</span></div>`).join('')}</div></div></article>`);
  }
  parts.push('</main><aside class="sidebar">' + Array.from({ length: 6 }, (_, f) => `<iframe class="widget" src="/frame/${f}" width="300" height="150"></iframe>`).join('') + '</aside>');
  parts.push('<footer class="site-footer">' + Array.from({ length: 60 }, (_, i) => `<a class="foot-link" href="/f/${i}">${text(i, 2)}</a>`).join(' ') + '</footer>');
  parts.push(Array.from({ length: 20 }, (_, i) => `<script src="http://cdn.heavy-news-example.com/lib/${i}.js"></script>`).join(''));
  parts.push('<script>let s = 0; for (let i = 0; i < 200000; i++) s += Math.sqrt(i); document.title = "heavy " + Math.round(s % 10); document.querySelectorAll(".card").forEach(c => c.classList.add("ready"));</script>');
  return `<!doctype html><html><head><title>heavy</title><link rel="stylesheet" href="http://cdn.heavy-news-example.com/site.css"></head><body>${parts.join('\n')}</body></html>`;
}
const HEAVY = heavyPage();
const FRAME = `<!doctype html><html><body><div class="widget-body">${Array.from({ length: 80 }, (_, i) => `<div class="row"><span>${text(i, 5)}</span></div>`).join('')}</div></body></html>`;
const CSS = '.card{display:flex;gap:8px;margin:8px;padding:8px;border:1px solid #ddd}.thumb{width:80px;height:60px}.tags li{display:inline-block;margin-right:4px}.comment{font-size:12px}.sidebar iframe{display:block}';
const GIF = Buffer.from('R0lGODlhAQABAAAAACw=', 'base64');
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://' + req.headers.host);
  const send = (type, body) => setTimeout(() => { res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(body); }, LATENCY);
  if (u.pathname === '/page') return send('text/html', u.searchParams.get('frames') === '0' ? HEAVY.replace(/<iframe[^>]*><\/iframe>/g, '') : HEAVY);
  if (u.pathname.startsWith('/frame/')) return send('text/html', FRAME);
  if (u.pathname.endsWith('.css')) return send('text/css', CSS);
  if (u.pathname.endsWith('.js')) return send('text/javascript', `window.libs = (window.libs || 0) + 1;`);
  if (u.pathname.endsWith('.gif')) return send('image/gif', GIF);
  send('text/plain', 'ok');
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const proxy = [`--proxy-server=http://127.0.0.1:${PORT}`, '--proxy-bypass-list=<-loopback>'];

const base = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'perf-base-')), { headless: true, channel: 'chromium', args: proxy });
const shield = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'perf-shield-')), {
  headless: true, channel: 'chromium', args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, ...proxy],
});
const sw = shield.serviceWorkers()[0] || await shield.waitForEvent('serviceworker');
for (let t0 = Date.now(); ; ) {
  const [scripts, sets] = await sw.evaluate(async () => [(await chrome.scripting.getRegisteredContentScripts()).length, (await chrome.declarativeNetRequest.getEnabledRulesets()).length]);
  if (scripts > 0 && sets > 0) { console.log(`Shield ready: ${scripts} content scripts, ${sets} rulesets, level ${await sw.evaluate(async () => (await chrome.storage.local.get('level')).level || 'optimal (default)')}`); break; }
  if (Date.now() - t0 > 20000) throw new Error('Shield never got ready');
  await new Promise(r => setTimeout(r, 200));
}

async function once(ctx, frames = true) {
  const pg = await ctx.newPage();
  const cdp = await ctx.newCDPSession(pg);
  await cdp.send('Performance.enable');
  await pg.goto(`http://www.heavy-news-example.com/page${frames ? '' : '?frames=0'}`, { waitUntil: 'load' });
  const nav = await pg.evaluate(() => { const n = performance.getEntriesByType('navigation')[0]; return { load: n.loadEventEnd - n.startTime, dcl: n.domContentLoadedEventEnd - n.startTime }; });
  await pg.waitForTimeout(400);   // Shield's work after load (cosmetic message, CSS) is counted too
  const m = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(x => [x.name, x.value]));
  const ok = await pg.evaluate(() => window.libs === 20 && document.querySelectorAll('.card').length === 120);
  await pg.close();
  if (!ok) throw new Error('the heavy page did not load completely (was something blocked?)');
  return { load: nav.load, dcl: nav.dcl, script: m.ScriptDuration * 1000, style: (m.RecalcStyleDuration + m.LayoutDuration) * 1000 };
}
const median = a => { const s = [...a].sort((x, y) => x - y), h = s.length >> 1; return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };
const samples = { base: [], shield: [] };
async function round(n, warm) {
  for (let i = 0; i < n + warm; i++) {
    // take turns, and swap who goes first every time, so drift on the machine hits both
    const order = i % 2 ? ['shield', 'base'] : ['base', 'shield'];
    for (const k of order) { const r = await once(k === 'base' ? base : shield); if (i >= warm) samples[k].push(r); }
  }
}
function verdict() {
  const med = k => Object.fromEntries(['load', 'dcl', 'script', 'style'].map(f => [f, median(samples[k].map(r => r[f]))]));
  const b = med('base'), s = med('shield');
  const over = s.load - b.load, pct = over / b.load * 100, script = s.script - b.script, style = s.style - b.style;
  const fail = [];
  if (pct > BUDGET_PCT) fail.push(`load overhead ${pct.toFixed(1)} % > ${BUDGET_PCT} %`);
  if (over > BUDGET_MS) fail.push(`load overhead ${over.toFixed(1)} ms > ${BUDGET_MS} ms`);
  if (script > SCRIPT_MS) fail.push(`content-script cost ${script.toFixed(1)} ms > ${SCRIPT_MS} ms`);
  return { b, s, over, pct, script, style, fail, runs: samples.base.length };
}
// each round is judged on its own; a CI machine has noisy minutes, so a round over budget gets up to two fresh rounds
// (a real slowdown fails all three)
const rounds = [];
let v;
for (let r = 0; r < 3; r++) {
  samples.base.length = 0; samples.shield.length = 0;
  await round(RUNS, r ? 1 : WARM);
  v = verdict(); rounds.push(v);
  console.log(`round ${r + 1}: overhead ${v.over.toFixed(1)} ms (${v.pct.toFixed(1)} %), content-script cost ${v.script.toFixed(1)} ms${v.fail.length ? ' - over budget: ' + v.fail.join('; ') : ''}`);
  if (!v.fail.length) break;
}
const f = x => x.toFixed(1);
const lines = [
  `Hallow Shield ${mf.version} performance (round ${rounds.length}: ${v.runs} runs each, medians, ${LATENCY} ms per response; rules: ${meta.sample ? 'SAMPLE lists' : 'real lists, built ' + meta.built.slice(0, 10)}, ${meta.total} rules, generic hiding selectors ${meta.cosmetic.generic})`,
  `  page load    without ${f(v.b.load)} ms   with Shield ${f(v.s.load)} ms   overhead ${f(v.over)} ms (${f(v.pct)} %)   budget ${BUDGET_PCT} % / ${BUDGET_MS} ms`,
  `  DOMContentLoaded  without ${f(v.b.dcl)} ms   with ${f(v.s.dcl)} ms`,
  `  script time  without ${f(v.b.script)} ms   with ${f(v.s.script)} ms   content-script cost ${f(v.script)} ms   budget ${SCRIPT_MS} ms`,
  `  style+layout without ${f(v.b.style)} ms   with ${f(v.s.style)} ms   extra ${f(v.style)} ms`,
];
console.log(lines.join('\n'));
fs.writeFileSync(path.join(os.tmpdir(), 'shield-perf.json'), JSON.stringify({ version: mf.version, runs: v.runs, without: v.b, with: v.s, overheadMs: v.over, overheadPct: v.pct, scriptMs: v.script, styleMs: v.style, fail: v.fail, rounds: rounds.map(r => ({ overheadMs: r.over, overheadPct: r.pct, scriptMs: r.script })) }, null, 1));
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, '### Performance\n```\n' + lines.join('\n') + '\n```\n' + (v.fail.length ? '**Over budget:** ' + v.fail.join('; ') + '\n' : 'Within budget.\n'));
// over budget: where does the time go? (Shield with parts of it switched off; printed, not judged)
if (v.fail.length || process.env.PERF_DIAG) {
  const all = await sw.evaluate(() => chrome.scripting.getRegisteredContentScripts());
  const sizes = all.filter(c => c.css).map(c => c.id + ' ' + c.css.map(p => Math.round(fs_size(p) / 1024) + ' KB').join('+'));
  console.log('content scripts: ' + all.length + '; CSS: ' + sizes.join(', '));
  const only = async keep => { await sw.evaluate(async ids => { const cur = await chrome.scripting.getRegisteredContentScripts(); if (cur.length) await chrome.scripting.unregisterContentScripts({ ids: cur.map(c => c.id) }); }, null);
    const want = all.filter(keep); if (want.length) await sw.evaluate(async w => chrome.scripting.registerContentScripts(w), want); };
  const variant = async (name, keep, frames = true) => {
    await only(keep);
    const b = [], s = [];
    for (let i = 0; i < 7; i++) { b.push(await once(base, frames)); s.push(await once(shield, frames)); }
    const mb = median(b.slice(1).map(r => r.load)), ms = median(s.slice(1).map(r => r.load));
    console.log(`  diag ${name.padEnd(34)} without ${mb.toFixed(1)} ms  with ${ms.toFixed(1)} ms  overhead ${(ms - mb).toFixed(1)} ms  (style ${median(s.map(r => r.style)).toFixed(1)} / ${median(b.map(r => r.style)).toFixed(1)}, script ${median(s.map(r => r.script)).toFixed(1)} / ${median(b.map(r => r.script)).toFixed(1)})`);
  };
  await variant('everything', () => true);
  await variant('no content scripts (network only)', () => false);
  // which rules cost the network side: one ruleset at a time, and every ruleset without its regex rules
  const sets = await sw.evaluate(() => chrome.declarativeNetRequest.getEnabledRulesets());
  for (const id of sets) {
    await sw.evaluate(async ([on, all]) => { await chrome.declarativeNetRequest.updateEnabledRulesets({ disableRulesetIds: all.filter(x => x !== on), enableRulesetIds: [on] }); }, [id, sets]);
    await variant(`network only, just ${id} (${meta.rulesets[id].rules}, ${meta.rulesets[id].regex} regex)`, () => false);
  }
  await sw.evaluate(ids => chrome.declarativeNetRequest.updateEnabledRulesets({ enableRulesetIds: ids }), sets);
  const regexIds = Object.fromEntries(sets.map(id => [id, JSON.parse(fs.readFileSync(path.join(EXT, 'rules', id + '.json'), 'utf8')).filter(r => r.condition.regexFilter).map(r => r.id)]));
  const kinds = Object.fromEntries(sets.map(id => [id, JSON.parse(fs.readFileSync(path.join(EXT, 'rules', id + '.json'), 'utf8')).reduce((o, r) => { o[r.action.type] = (o[r.action.type] || 0) + 1; return o; }, {})]));
  console.log('  rule kinds: ' + JSON.stringify(kinds));
  await sw.evaluate(async m => { for (const [id, ids] of Object.entries(m)) if (ids.length) await chrome.declarativeNetRequest.updateStaticRules({ rulesetId: id, disableRuleIds: ids }); }, regexIds);
  await variant('network only, regex rules off', () => false);
  await sw.evaluate(async m => { for (const [id, ids] of Object.entries(m)) if (ids.length) await chrome.declarativeNetRequest.updateStaticRules({ rulesetId: id, enableRuleIds: ids }); }, regexIds);
  const sets2 = await sw.evaluate(() => chrome.declarativeNetRequest.getEnabledRulesets());
  await sw.evaluate(ids => chrome.declarativeNetRequest.updateEnabledRulesets({ disableRulesetIds: ids }), sets2);
  await variant('no content scripts, no rulesets', () => false);
  await sw.evaluate(ids => chrome.declarativeNetRequest.updateEnabledRulesets({ enableRulesetIds: ids }), sets2);
  await only(() => true);
}
await base.close(); await shield.close(); server.close();
if (v.fail.length) { console.log('FAIL ' + v.fail.join('; ')); process.exit(1); }
console.log('perf OK');
