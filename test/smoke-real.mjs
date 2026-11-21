// Hallow Shield smoke test with the REAL rules (after `node tools/build.mjs` and `node tools/check-regex.mjs`):
//   - the sizes are inside the browser's limits (30,000 rules enabled at install, 1,000 regex rules, 50 rulesets)
//   - Chromium loads every ruleset, and sample rules from each really match (so none was refused)
//   - every regex rule is accepted by the browser
//   - a well-known ad server (doubleclick.net) and tracker (google-analytics.com) are blocked, a normal site is not
//   - the real uBO YouTube filters on a fake YouTube page (served locally as www.youtube.com): ad fields gone, video plays
//   - the cookie-banner lists are on by default and the annoyance lists off; with "Hide annoyances" on every list loads,
//     and real generic cookie-notice / annoyance selectors hide matching boxes on a test page
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const { chromium } = await import('playwright').catch(() => createRequire(import.meta.url)('playwright'));

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'extension');
const EXT = fs.mkdtempSync(path.join(os.tmpdir(), 'shield-real-ext-'));
fs.cpSync(SRC, EXT, { recursive: true });
const mf = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
mf.permissions.push('declarativeNetRequestFeedback');   // testMatchOutcome (the shipped extension doesn't have it)
fs.writeFileSync(path.join(EXT, 'manifest.json'), JSON.stringify(mf));
const meta = JSON.parse(fs.readFileSync(path.join(EXT, 'rules', 'meta.json'), 'utf8'));
const L = meta.lists;
assert.ok(L.easylist.network > 20000 && L.easyprivacy.network > 20000 && L['ublock-filters'].network > 3000 && L.plowe.network > 1000, 'real lists converted: ' + JSON.stringify(Object.fromEntries(Object.entries(L).map(([k, v]) => [k, v.network]))));
assert.ok(meta.enabledAtInstall <= 30000, `enabled at install ${meta.enabledAtInstall} > 30,000 guaranteed`);
assert.ok(meta.regex <= 1000, `${meta.regex} regex rules`);
assert.ok(Object.keys(meta.rulesets).length <= 50);
assert.ok(meta.scriptlets.used['json-prune'] || meta.scriptlets.used['set-constant'], 'scriptlets built');
assert.ok(L['easylist-cookies'].cosmetic > 1000 && L['ublock-cookies'].lines > 1000 && L['ublock-annoyances'].lines > 1000 && L['fanboy-annoyances'].cosmetic > 1000 && L['fanboy-social'].cosmetic > 500,
  'annoyance lists converted: ' + JSON.stringify(Object.fromEntries(['ublock-cookies', 'easylist-cookies', 'ublock-annoyances', 'fanboy-annoyances', 'fanboy-social'].map(k => [k, [L[k].lines, L[k].network, L[k].cosmetic]]))));
// a few real generic selectors of the plain ".class" / "#id" kind, to put on a test page
const simple = file => fs.readFileSync(path.join(EXT, 'rules', file), 'utf8').split('\n').map(l => l.replace(/\{display:none!important\}$/, '')).filter(s => /^[.#][a-zA-Z][\w-]*$/.test(s));
const COOKIE_SEL = simple('cookies/generic.css').slice(0, 5), ANNOY_SEL = simple('annoyances/generic.css').slice(0, 5);
assert.ok(COOKIE_SEL.length && ANNOY_SEL.length, 'simple generic selectors in the cookie and annoyance lists');
const boxes = (sels, tag) => sels.map((s, i) => s[0] === '#' ? `<div id="${s.slice(1)}" data-t="${tag}${i}">x</div>` : `<div class="${s.slice(1)}" data-t="${tag}${i}">x</div>`).join('');

const seen = [];
const PLAYER = { videoDetails: { videoId: 'abc', title: 'Test video' }, streamingData: { formats: [{ itag: 18 }] }, playabilityStatus: { status: 'OK' },
  adPlacements: [{ adPlacementRenderer: { config: {} } }], playerAds: [{ playerLegacyDesktopWatchAdsRenderer: {} }], adSlots: [{ adSlotRenderer: {} }] };
const YT = `<!doctype html><html><head><title>video</title></head><body><div id="player">loading</div>
  <script>var ytInitialPlayerResponse = ${JSON.stringify(PLAYER)};</script>
  <script>
    var result = {};
    result.initialAds = !!(ytInitialPlayerResponse.adPlacements || ytInitialPlayerResponse.playerAds || ytInitialPlayerResponse.adSlots);
    result.initialVideo = ytInitialPlayerResponse.videoDetails && ytInitialPlayerResponse.videoDetails.videoId;
    fetch('/youtubei/v1/player?prettyPrint=false', { method: 'POST', body: '{"videoId":"abc"}' }).then(r => r.json()).then(j => {
      result.fetchAds = !!(j.adPlacements || j.adSlots); result.fetchPlayerAds = !!j.playerAds; result.fetchVideo = j.videoDetails && j.videoDetails.videoId;
      document.getElementById('player').textContent = 'playing ' + result.fetchVideo;
    }).catch(e => { result.fetchError = String(e); });
  </script></body></html>`;
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://' + req.headers.host); seen.push(u.hostname + u.pathname);
  if (u.pathname === '/page') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(`<!doctype html><body><p>news</p>
    <script src="http://securepubads.g.doubleclick.net/tag/js/gpt.js"></script>
    <script src="http://www.google-analytics.com/analytics.js"></script>
    <script src="http://cdn.example.org/app.js"></script></body>`); }
  if (u.pathname === '/boxes') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(`<!doctype html><body><p id="real">real</p>${boxes(COOKIE_SEL, 'c')}${boxes(ANNOY_SEL, 'a')}</body>`); }
  if (u.pathname === '/watch') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(YT); }
  if (u.pathname.startsWith('/youtubei/v1/player')) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(PLAYER)); }
  res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end('');
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'shield-real-')), {
  headless: true, channel: 'chromium',
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, `--proxy-server=http://127.0.0.1:${server.address().port}`, '--proxy-bypass-list=<-loopback>'],
});
const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 120000 }).catch(async e => { const p = await ctx.newPage(); await p.goto('chrome://extensions-internals').catch(() => { }); console.log((await p.textContent('body').catch(() => '')).slice(0, 4000)); throw e; });
const until = async (f, ms) => { const t0 = Date.now(); for (;;) { if (await f()) return true; if (Date.now() - t0 > ms) return false; await new Promise(r => setTimeout(r, 200)); } };
const LISTS = Object.keys(L);
const DEFAULT = LISTS.filter(id => L[id].defaultOn);
assert.ok(DEFAULT.includes('easylist-cookies') && !DEFAULT.includes('fanboy-social'), 'cookie lists on by default, annoyances off');
const loaded = async ids => {
  const on = await sw.evaluate(() => chrome.declarativeNetRequest.getEnabledRulesets());
  const fb = (await sw.evaluate(async () => (await chrome.storage.local.get('fallback')).fallback)) || {};
  const done = (await sw.evaluate(async () => (await chrome.storage.local.get('scriptErrors')).scriptErrors)) !== undefined;
  return done && ids.every(id => on.includes(id) || fb[id]);
};
await until(() => loaded(DEFAULT), 30000);
const defaultOn = await sw.evaluate(() => chrome.declarativeNetRequest.getEnabledRulesets());
console.log('enabled by default:', defaultOn.join(', '));
assert.ok(!defaultOn.includes('fanboy-social') && !defaultOn.includes('ublock-annoyances'), 'annoyance lists off by default');
// the cookie-banner boxes hidden by default, the annoyance boxes not
const hiddenOn = async () => { const b = await ctx.newPage(); await b.goto('http://boxes.example.org/boxes'); await b.waitForTimeout(700);
  const r = await b.evaluate(() => Object.fromEntries([...document.querySelectorAll('[data-t]')].map(e => [e.dataset.t, getComputedStyle(e).display === 'none']).concat([['real', getComputedStyle(document.getElementById('real')).display === 'none']])));
  await b.close(); return r; };
const h1 = await hiddenOn();
console.log('real generic selectors - cookies:', COOKIE_SEL.join(' '), '| annoyances:', ANNOY_SEL.join(' '), '| hidden by default:', JSON.stringify(h1));
assert.ok(COOKIE_SEL.every((_, i) => h1['c' + i]), 'real cookie-notice selectors hide by default');
assert.equal(h1.real, false);
// "Hide annoyances" on: every list
await sw.evaluate(() => chrome.storage.local.set({ annoyances: true }));
await until(async () => (await loaded(LISTS)) && (await sw.evaluate(() => chrome.scripting.getRegisteredContentScripts())).some(c => c.id === 'shield-generic-annoyances'), 30000);
const h2 = await hiddenOn();
console.log('hidden with annoyances on:', JSON.stringify(h2));
assert.ok(ANNOY_SEL.every((_, i) => h2['a' + i]), 'real annoyance selectors hide with the switch on');
// the background switches on the lists the manifest leaves off (shared pool), or loads them as dynamic rules
await until(async () => {
  const on = await sw.evaluate(() => chrome.declarativeNetRequest.getEnabledRulesets());
  const fb = (await sw.evaluate(async () => (await chrome.storage.local.get('fallback')).fallback)) || {};
  const done = (await sw.evaluate(async () => (await chrome.storage.local.get('scriptErrors')).scriptErrors)) !== undefined;
  return done && LISTS.every(id => on.includes(id) || fb[id]);
}, 30000);
const state = await sw.evaluate(async () => ({
  on: await chrome.declarativeNetRequest.getEnabledRulesets(), room: await chrome.declarativeNetRequest.getAvailableStaticRuleCount(),
  fallback: (await chrome.storage.local.get('fallback')).fallback || {}, dynamic: (await chrome.declarativeNetRequest.getDynamicRules()).length,
  scripts: (await chrome.scripting.getRegisteredContentScripts()).length, scriptErrors: (await chrome.storage.local.get('scriptErrors')).scriptErrors,
}));
const enabledRules = state.on.reduce((n, id) => n + (meta.rulesets[id]?.rules || 0), 0);
console.log('enabled rulesets:', state.on.join(', '), `= ${enabledRules} rules; shared-pool room left ${state.room}; dynamic fallback ${JSON.stringify(state.fallback)} (${state.dynamic} dynamic rules); ${state.scripts} content scripts`);
console.log('content script errors:', JSON.stringify(state.scriptErrors));
assert.ok(state.scripts >= 3 + meta.scriptlets.bundles, 'content scripts registered: ' + state.scripts);
for (const id of LISTS) assert.ok(state.on.includes(id) || state.fallback[id]?.loaded > 0, id + ' neither enabled nor loaded as dynamic rules');

// every regex rule accepted by the browser
const regexes = [];
for (const id of Object.keys(meta.rulesets)) for (const r of JSON.parse(fs.readFileSync(path.join(EXT, 'rules', id + '.json'), 'utf8'))) if (r.condition.regexFilter) regexes.push(r.condition.regexFilter);
const refused = await sw.evaluate(async list => { let n = 0; for (const regex of list) if (!(await chrome.declarativeNetRequest.isRegexSupported({ regex })).isSupported) n++; return n; }, regexes);
assert.equal(refused, 0, `${refused} of ${regexes.length} regex rules refused by the browser`);
assert.ok(regexes.length <= 1000);

// sample rules from every enabled ruleset really match (a refused or ignored rule would not)
const samples = [];
for (const id of state.on) {
  const rules = JSON.parse(fs.readFileSync(path.join(EXT, 'rules', id + '.json'), 'utf8'))
    .filter(r => r.action.type === 'block' && r.condition.requestDomains && !r.condition.urlFilter && !r.condition.regexFilter && !r.condition.requestMethods && !r.condition.initiatorDomains && !r.condition.excludedRequestDomains && !r.condition.excludedInitiatorDomains && r.condition.resourceTypes.includes('script') && r.condition.domainType !== 'firstParty');
  for (const r of rules.slice(0, 15)) samples.push({ id, rule: r.id, url: `https://${r.condition.requestDomains[r.condition.requestDomains.length - 1]}/x.js` });
}
const outcomes = await sw.evaluate(async list => {
  const out = [];
  for (const s of list) { const o = await chrome.declarativeNetRequest.testMatchOutcome({ url: s.url, type: 'script', initiator: 'https://news.example.org' }); out.push(o.matchedRules.map(m => m.rulesetId + '#' + m.ruleId)); }
  return out;
}, samples);
const missed = samples.filter((s, i) => !outcomes[i].length);
console.log(`sample rules: ${samples.length} checked with testMatchOutcome, ${missed.length} matched nothing`);
assert.equal(missed.length, 0, 'rules that did not load: ' + JSON.stringify(missed.slice(0, 5)));

const p = await ctx.newPage(); await p.goto('http://news.example.org/page'); await p.waitForTimeout(800);
assert.ok(seen.includes('cdn.example.org/app.js'), 'a normal script loads');
assert.ok(!seen.some(s => s.includes('doubleclick.net')), 'doubleclick.net blocked');
assert.ok(!seen.some(s => s.includes('google-analytics.com')), 'google-analytics.com blocked');
await p.close();

// the real YouTube filters on a fake page
const y = await ctx.newPage();
const errors = []; y.on('pageerror', e => errors.push(String(e)));
await y.goto('http://www.youtube.com/watch?v=abc'); await y.waitForTimeout(1500);
const r = await y.evaluate(() => window.result);
console.log('fake YouTube with the real filters:', JSON.stringify(r), errors.length ? 'page errors: ' + errors.join(' | ') : '');
assert.equal(r.initialAds, false, 'ytInitialPlayerResponse ad fields removed'); assert.equal(r.initialVideo, 'abc');
assert.equal(r.fetchAds, false, '/youtubei/v1/player adPlacements and adSlots removed (the uBO filters leave playerAds on www.youtube.com)'); assert.equal(r.fetchVideo, 'abc');
assert.equal(await y.textContent('#player'), 'playing abc');
await y.close();
await ctx.close(); server.close();
const counts = Object.fromEntries(Object.entries(meta.rulesets).map(([k, v]) => [k, v.rules]));
console.log('real rules OK:', JSON.stringify(counts), 'total', meta.total, 'regex', meta.regex, 'lists', JSON.stringify(Object.fromEntries(Object.entries(L).map(([k, v]) => [k, v.version]))));
console.log('scriptlets:', meta.scriptlets.filtersUsed, 'filters used,', meta.scriptlets.filtersSkipped, 'skipped,', meta.scriptlets.bundles, 'bundles');
console.log('rules: default lists', meta.defaultOn, '| every list', meta.allLists, '| enabled at install', meta.enabledAtInstall, '| groups', JSON.stringify(meta.groups));
