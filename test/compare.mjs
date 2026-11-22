// Hallow Shield 1.8: what the split page fixes changed, measured against the previous release (CI runs it with the REAL
// rules, after tools/build.mjs; the previous release comes from Shield's own GitHub release, sha256-checked):
//   node test/compare.mjs <folder with the previous release unpacked> [--no-real]
// 1. A heavy local page on a .com address with 6 frames (the .com page-fix bundle was 0.7 MB in every frame): the
//    bytes of Shield's scripts each frame gets (the browser's own count of every script it compiled from Shield, plus
//    the shard files 1.8's loaders read), load time, main-thread script time and JS memory - old and new, taking turns.
// 2. Real sites (YouTube, Twitch, a news site) with no extension, the previous release and this build, each in a fresh
//    throw-away profile (headless - nothing on screen, no sign-ins): blocked requests, hidden elements, Shield's bytes
//    in the top frame, script time, JS memory, and on YouTube whether the player data still carries ads. The point:
//    no loss in blocking (the counts should match), less work for the browser.
// Writes /tmp/shield-compare.json and a table to the CI summary. Fails only on a clear loss in blocking.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { bloomIndexes, shardOf } from '../tools/scriptlets.mjs';
const { chromium } = await import('playwright').catch(() => createRequire(import.meta.url)('playwright'));

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OLD = path.resolve(process.argv[2] || '');
if (!process.argv[2] || !fs.existsSync(path.join(OLD, 'manifest.json'))) { console.error('usage: node test/compare.mjs <previous release folder> [--no-real | --only-real]'); process.exit(2); }
const REAL = !process.argv.includes('--no-real'), HEAVY = !process.argv.includes('--only-real');
const copy = (src, tag) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'shield-cmp-' + tag + '-'));
  fs.cpSync(src, d, { recursive: true, filter: f => !f.includes('_metadata') && !f.includes(path.sep + 'bridge') });
  // a release build's version.json, as users get it
  const mf = JSON.parse(fs.readFileSync(path.join(d, 'manifest.json'), 'utf8'));
  fs.writeFileSync(path.join(d, 'version.json'), JSON.stringify({ name: 'Hallow Shield', version: mf.version, browser: 'chrome', built: new Date().toISOString(), dev: false }));
  return { dir: d, version: mf.version };
};
const EXTS = { old: copy(OLD, 'old'), new: copy(path.join(ROOT, 'extension'), 'new') };
console.log(`comparing Hallow Shield ${EXTS.old.version} (previous release) with ${EXTS.new.version} (this build)`);

// ---- 1.8's loaders: which shard files a frame on this host reads (the same Bloom filter and hash as the loader) ----
function shardBytes(ext, hostname) {
  const reg = JSON.parse(fs.readFileSync(path.join(ext.dir, 'rules', 'scriptlets.json'), 'utf8'));
  const p = hostname.toLowerCase().split('.'), keys = [];
  for (let i = 0; i < p.length; i++) keys.push(p.slice(i).join('.'));
  for (let i = 0; i < p.length - 1; i++) if (p.length - i - 1 <= 2) keys.push(p[i] + '.*');
  let bytes = 0, files = 0; const hits = [];
  for (const b of reg) {
    if (b.world !== 'ISOLATED' || b.group !== 'main' && b.group !== 'cookies') continue;
    const tld = '.' + p[p.length - 1];
    if (!b.matches.some(m => m === '*://*/*' || m === `*://*${tld}/*`)) continue;
    const src = fs.readFileSync(path.join(ext.dir, b.file), 'utf8');
    const m = /shieldLoader\("([^"]+)", (\d+), (\d+), "([^"]*)"/.exec(src); if (!m) continue;
    const n = Number(m[2]), M = Number(m[3]), bits = Buffer.from(m[4], 'base64');
    const want = keys.filter(k => bloomIndexes(k, M).every(x => bits[x >> 3] & (1 << (x & 7))));
    for (const s of new Set(want.map(k => shardOf(k, n)))) {
      const file = path.join(ext.dir, 'rules', 'sl', `${m[1]}-${s}.json`), real = want.filter(k => shardOf(k, n) === s && JSON.parse(fs.readFileSync(file, 'utf8')).k[k]);
      bytes += fs.statSync(file).size; files++; hits.push(m[1] + ':' + (real.length ? real.join('+') : '(false positive)'));
    }
  }
  return { bytes, files, hits };
}

async function launch(ext, proxy = []) {
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'shield-cmp-profile-'));
  const args = ext ? [`--disable-extensions-except=${ext.dir}`, `--load-extension=${ext.dir}`, ...proxy] : proxy;
  const ctx = await chromium.launchPersistentContext(prof, { headless: true, channel: 'chromium', args, viewport: { width: 1280, height: 900 } });
  if (ext) {
    const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
    for (let t0 = Date.now(); ;) {
      const [scripts, sets] = await sw.evaluate(async () => [(await chrome.scripting.getRegisteredContentScripts()).length, (await chrome.declarativeNetRequest.getEnabledRulesets()).length]);
      if (scripts > 0 && sets > 0) break;
      if (Date.now() - t0 > 20000) throw new Error('Shield never got ready');
      await new Promise(r => setTimeout(r, 200));
    }
  }
  return ctx;
}
// one visit: Shield's scripts the browser compiled in each frame (bytes), metrics, blocked requests
async function visit(ctx, url, { settle = 3000, timeout = 30000, after = null } = {}) {
  const pg = await ctx.newPage();
  const cdp = await ctx.newCDPSession(pg);
  const frames = {}, contexts = {};
  cdp.on('Runtime.executionContextCreated', e => { contexts[e.context.id] = e.context.auxData && e.context.auxData.frameId; });
  cdp.on('Debugger.scriptParsed', e => {
    if (!/^chrome-extension:/.test(e.url)) return;
    const f = (e.executionContextAuxData && e.executionContextAuxData.frameId) || contexts[e.executionContextId] || '?';
    frames[f] = (frames[f] || 0) + (e.length || 0);
  });
  await cdp.send('Runtime.enable'); await cdp.send('Debugger.enable'); await cdp.send('Performance.enable');
  let blocked = 0, requests = 0; const blockedHosts = {};
  pg.on('request', () => { requests++; });
  pg.on('requestfailed', r => { if ((r.failure() || {}).errorText === 'net::ERR_BLOCKED_BY_CLIENT') { blocked++; try { const h = new URL(r.url()).hostname; blockedHosts[h] = (blockedHosts[h] || 0) + 1; } catch { } } });
  const t0 = Date.now(); let loaded = true;
  try { await pg.goto(url, { waitUntil: 'load', timeout }); } catch { loaded = false; }
  await pg.waitForTimeout(settle);
  const m = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(x => [x.name, x.value]));
  const nav = await pg.evaluate(() => { const n = performance.getEntriesByType('navigation')[0]; return n ? { load: n.loadEventEnd - n.startTime, dcl: n.domContentLoadedEventEnd - n.startTime } : {}; }).catch(() => ({}));
  const hidden = await pg.evaluate(() => { let n = 0; for (const e of document.querySelectorAll('body *')) if (getComputedStyle(e).display === 'none') n++; return n; }).catch(() => null);
  const extra = after ? await after(pg).catch(e => ({ error: String(e) })) : null;
  const mainFrameId = await cdp.send('Page.getFrameTree').then(t => t.frameTree.frame.id).catch(() => null);
  await cdp.detach().catch(() => { }); await pg.close();
  return { url, loaded, ms: Date.now() - t0, load: nav.load, dcl: nav.dcl, script: m.ScriptDuration * 1000, heapMB: m.JSHeapUsedSize / 1048576, nodes: m.Nodes,
    blocked, requests, blockedHosts, hidden, frames, topBytes: mainFrameId ? frames[mainFrameId] || 0 : null, extra };
}
const median = a => { const s = a.filter(x => typeof x === 'number' && !isNaN(x)).sort((x, y) => x - y); if (!s.length) return null; const h = s.length >> 1; return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };
const kb = b => b === null || b === undefined ? '-' : (b / 1024).toFixed(1) + ' KB';
const f1 = x => x === null || x === undefined ? '-' : x.toFixed(1);
const out = { old: EXTS.old.version, new: EXTS.new.version, heavy: {}, real: {} };
const summary = [];

// ---- 1. the heavy local page ----
if (HEAVY) {
  const WORDS = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore'.split(' ');
  const text = (i, n) => Array.from({ length: n }, (_, k) => WORDS[(i * 7 + k * 3) % WORDS.length]).join(' ');
  const cards = Array.from({ length: 120 }, (_, a) => `<article class="card story"><img class="thumb" src="/t/${a}.gif" width="80" height="60"><h2 class="title">${text(a, 6)}</h2><p>${text(a, 40)}</p></article>`).join('');
  const HEAVY = `<!doctype html><html><head><title>heavy</title></head><body><main id="main">${cards}</main><aside>${Array.from({ length: 6 }, (_, f) => `<iframe src="/frame/${f}" width="300" height="150"></iframe>`).join('')}</aside>` +
    `<script>let s = 0; for (let i = 0; i < 200000; i++) s += Math.sqrt(i); document.title = 'heavy ' + Math.round(s % 10);</script></body></html>`;
  const FRAME = `<!doctype html><html><body>${Array.from({ length: 80 }, (_, i) => `<div class="row">${text(i, 5)}</div>`).join('')}</body></html>`;
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://' + req.headers.host);
    const send = (t, b) => setTimeout(() => { res.writeHead(200, { 'Content-Type': t, 'Cache-Control': 'no-store' }); res.end(b); }, 20);
    if (u.pathname === '/page') return send('text/html', HEAVY);
    if (u.pathname.startsWith('/frame/')) return send('text/html', FRAME);
    send('image/gif', Buffer.from('R0lGODlhAQABAAAAACw=', 'base64'));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const proxy = [`--proxy-server=http://127.0.0.1:${server.address().port}`, '--proxy-bypass-list=<-loopback>'];
  const ctxs = { base: await launch(null, proxy), old: await launch(EXTS.old, proxy), new: await launch(EXTS.new, proxy) };
  const URL_ = 'http://www.heavy-news-example.com/page', RUNS = Number(process.env.CMP_RUNS || 9);
  const s = { base: [], old: [], new: [] };
  for (let i = 0; i < RUNS + 2; i++) {
    const order = [['base', 'old', 'new'], ['new', 'old', 'base'], ['old', 'new', 'base']][i % 3];
    for (const k of order) { const r = await visit(ctxs[k], URL_, { settle: 400, timeout: 20000 }); if (i >= 2) s[k].push(r); }
  }
  for (const k of Object.keys(ctxs)) await ctxs[k].close();
  server.close();
  const per = k => {
    const r = s[k], frames = r.map(x => Object.values(x.frames));
    const perFrame = median(frames.map(fr => fr.length ? fr.reduce((a, b) => a + b, 0) / fr.length : 0));
    return { load: median(r.map(x => x.load)), script: median(r.map(x => x.script)), heapMB: median(r.map(x => x.heapMB)), framesSeen: median(frames.map(fr => fr.length)), scriptBytesPerFrame: perFrame };
  };
  const h = { base: per('base'), old: per('old'), new: per('new') };
  const sh = shardBytes(EXTS.new, 'www.heavy-news-example.com');
  h.new.shardBytesPerFrame = sh.bytes; h.new.shardFiles = sh.files;
  out.heavy = h;
  summary.push(`Heavy local page (.com, 6 frames, ${RUNS} runs each, medians):`,
    `  Shield's scripts per frame   ${EXTS.old.version}: ${kb(h.old.scriptBytesPerFrame)}   ${EXTS.new.version}: ${kb(h.new.scriptBytesPerFrame)} + ${kb(sh.bytes)} of shards (${sh.files} files: ${sh.hits.join(', ')})`,
    `  page load                    none: ${f1(h.base.load)} ms   ${EXTS.old.version}: ${f1(h.old.load)} ms   ${EXTS.new.version}: ${f1(h.new.load)} ms`,
    `  main-thread script time      none: ${f1(h.base.script)} ms   ${EXTS.old.version}: ${f1(h.old.script)} ms   ${EXTS.new.version}: ${f1(h.new.script)} ms`,
    `  JS memory (top page)         none: ${f1(h.base.heapMB)} MB   ${EXTS.old.version}: ${f1(h.old.heapMB)} MB   ${EXTS.new.version}: ${f1(h.new.heapMB)} MB`);
  console.log(summary.join('\n'));
}

// ---- 2. real sites ----
let lost = [];
if (REAL) {
  const yt = async pg => pg.evaluate(() => {
    const r = window.ytInitialPlayerResponse;
    return { player: !!r, status: r && r.playabilityStatus && r.playabilityStatus.status, ads: !!(r && (r.adPlacements || r.playerAds || r.adSlots)), video: !!document.querySelector('video'), title: document.title.slice(0, 60) };
  });
  const tw = async pg => pg.evaluate(() => ({ video: !!document.querySelector('video'), title: document.title.slice(0, 60) }));
  const SITES = [
    { name: 'YouTube (watch page)', url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw', after: yt },
    { name: 'YouTube (home)', url: 'https://www.youtube.com/', after: yt },
    { name: 'Twitch (front page)', url: 'https://www.twitch.tv/', after: tw },
    { name: 'Twitch (directory)', url: 'https://www.twitch.tv/directory', after: tw },
    { name: 'news: CNN', url: 'https://edition.cnn.com/' },
    { name: 'news: The Guardian', url: 'https://www.theguardian.com/international' },
  ];
  const RUNS = Number(process.env.CMP_REAL_RUNS || 2);
  const res = {};
  for (const k of ['base', 'old', 'new']) {
    const ctx = await launch(k === 'base' ? null : EXTS[k]);
    for (const site of SITES) {
      for (let i = 0; i < RUNS; i++) {
        let r; try { r = await visit(ctx, site.url, { settle: 4000, timeout: 30000, after: site.after }); } catch (e) { r = { error: String(e) }; }
        ((res[site.name] ||= {})[k] ||= []).push(r);
      }
    }
    await ctx.close();
  }
  summary.push('', `Real sites (headless, throw-away profiles, ${RUNS} visits each, medians; "blocked" = requests the browser refused for Shield):`);
  for (const site of SITES) {
    const o = res[site.name], row = {};
    for (const k of ['base', 'old', 'new']) {
      const r = (o[k] || []).filter(x => !x.error);
      row[k] = { loaded: r.filter(x => x.loaded).length + '/' + (o[k] || []).length, blocked: median(r.map(x => x.blocked)), requests: median(r.map(x => x.requests)), hidden: median(r.map(x => x.hidden)),
        topBytes: median(r.map(x => x.topBytes)), script: median(r.map(x => x.script)), heapMB: median(r.map(x => x.heapMB)), extra: r.map(x => x.extra).filter(Boolean),
        blockedHosts: r[0] ? Object.entries(r[0].blockedHosts).sort((a, b) => b[1] - a[1]).slice(0, 8) : [] };
    }
    const host = new URL(site.url).hostname, sh = shardBytes(EXTS.new, host);
    row.new.shardBytes = sh.bytes;
    out.real[site.name] = row;
    const ex = k => row[k].extra.length ? ' ' + JSON.stringify(row[k].extra[row[k].extra.length - 1]) : '';
    summary.push(`  ${site.name}`,
      `    blocked      none: ${row.base.blocked}   ${EXTS.old.version}: ${row.old.blocked}   ${EXTS.new.version}: ${row.new.blocked}   (requests ${row.base.requests} / ${row.old.requests} / ${row.new.requests})`,
      `    hidden elems none: ${row.base.hidden}   ${EXTS.old.version}: ${row.old.hidden}   ${EXTS.new.version}: ${row.new.hidden}`,
      `    Shield's scripts in the top frame   ${EXTS.old.version}: ${kb(row.old.topBytes)}   ${EXTS.new.version}: ${kb(row.new.topBytes)} + ${kb(sh.bytes)} of shards`,
      `    script time  none: ${f1(row.base.script)} ms   ${EXTS.old.version}: ${f1(row.old.script)} ms   ${EXTS.new.version}: ${f1(row.new.script)} ms;  JS memory ${f1(row.base.heapMB)} / ${f1(row.old.heapMB)} / ${f1(row.new.heapMB)} MB`,
      `    loaded ${row.base.loaded} / ${row.old.loaded} / ${row.new.loaded};  page${ex('base')} |${ex('old')} |${ex('new')}`,
      `    blocked hosts  ${EXTS.old.version}: ${row.old.blockedHosts.map(([h, n]) => h + ' ' + n).join(', ')}`,
      `    blocked hosts  ${EXTS.new.version}: ${row.new.blockedHosts.map(([h, n]) => h + ' ' + n).join(', ')}`,
      `    shards read (${EXTS.new.version}): ${sh.hits.join(', ') || 'none'}`);
    // a clear loss: the new build blocks much less than the old one on the same page, or YouTube's player data keeps its ads
    if (row.old.blocked !== null && row.new.blocked !== null && row.new.blocked < row.old.blocked * 0.7 - 2) lost.push(`${site.name}: blocked ${row.new.blocked} < ${row.old.blocked}`);
    const ads = k => row[k].extra.some(x => x && x.ads);
    if (site.after === yt && ads('new') && !ads('old')) lost.push(`${site.name}: the player data kept its ads`);
  }
}
console.log(summary.join('\n'));
fs.writeFileSync(path.join(os.tmpdir(), 'shield-compare.json'), JSON.stringify(out, null, 1));
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### ${EXTS.old.version} vs ${EXTS.new.version}\n\`\`\`\n${summary.join('\n')}\n\`\`\`\n`);
if (lost.length) { console.log('LOSS IN BLOCKING: ' + lost.join('; ')); process.exit(1); }
console.log('compare OK');
