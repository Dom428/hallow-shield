// Hallow Shield end-to-end test: the real extension in Chromium, with the browser's proxy pointed at a local test server
// (so "ads.example", "news.test" and "youtube.test" are pages and files served here). Checks what the browser really
// blocks, redirects, strips, hides and lets through; procedural filters; scriptlets (a fake YouTube page included);
// pausing a site; the blocking levels; switching lists; the dynamic-rule fallback; and the popup. Build the sample rules first:
//   node tools/build.mjs --sample && node test/e2e.mjs
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
// Playwright from this project (CI: npm install) or from the machine (a global install)
const { chromium } = await import('playwright').catch(() => createRequire(import.meta.url)('playwright'));

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'extension');
// a copy for the test: the popup's count needs the access Chrome gives when you click the toolbar icon ("activeTab"),
// which a test can't click - so the copy also gets declarativeNetRequestFeedback (the shipped extension doesn't)
const EXT = fs.mkdtempSync(path.join(os.tmpdir(), 'shield-ext-'));
fs.cpSync(SRC, EXT, { recursive: true });
const mf = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8')); mf.permissions.push('declarativeNetRequestFeedback');
fs.writeFileSync(path.join(EXT, 'manifest.json'), JSON.stringify(mf));
const scriptletBundles = JSON.parse(fs.readFileSync(path.join(EXT, 'rules', 'scriptlets.json'), 'utf8')).length;

const seen = [];
const html = (title, body) => `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;
const COMMON = `
  <p id="content">Real content</p>
  <div class="ad-banner" id="generic">ad box</div>
  <div class="sponsored" id="site">sponsored box</div>
  <div id="sponsor-1">sponsor box</div>
  <div class="everywhere-box" id="sg">specific-generic box</div>
  <script src="http://ads.example/ad.js"></script>
  <script src="http://ads.example/allowed.js"></script>
  <img src="http://tracker-ads.test/banner/x.png">
  <img src="http://metrics.example/p.gif">
  <img src="http://cdn.example/ad-1.png">
  <script src="http://cdn.example/ad-2.js"></script>
  <script src="http://fine.example/lib.js"></script>
  <script src="http://other3p.example/x.js"></script>
  <img src="http://regex.example/banner12.png"><img src="http://regex.example/other.png">
  <script src="http://redirect.example/gpt.js"></script>
  <img src="http://fine.example/p.gif?utm_source=x&keep=1&fbclid=2">
  <script src="http://important.example/x.js"></script>
  <script src="http://cancelled.example/x.js"></script>
  <script src="http://mv3only.example/x.js"></script>
  <script>window.inlineRan = true; window.gptStub = !!(window.googletag && window.googletag.apiReady);</script>`;
const NEWS = `
  <div class="post" id="post-ad">This is Sponsored content</div>
  <div class="post" id="post-ok">A normal post</div>
  <div id="gp"><div><span class="label">Promoted</span></div></div>
  <div class="side" id="side" style="position:absolute;top:0">side</div>
  <div class="junk" id="junk">junk</div>
  <div class="hl" id="hl">highlight</div>
  <div class="card" id="card-ad"><span class="tag">Ad</span></div>
  <div class="card" id="card-ok"><span class="tag">News</span></div>
  <div data-kind="advert" id="xp">xpath ad</div>
  <a class="clicky" id="clicky" onclick="void 0" href="#x">link</a>
  <script>
    window.result = {};
    window.adsConfig = { enabled: true };
    result.adsEnabled = adsConfig.enabled;
    window.adBlockDetector = {};
    try { adBlockDetector.x; result.aopr = 'read'; } catch (e) { result.aopr = 'threw'; }
    setTimeout(function adTimer() { result.timer = 'ran'; }, 10);
    setTimeout(function other() { result.other = 'ran'; }, 10);
    fetch('/ads/config.json').then(r => r.text()).then(t => { result.fetched = t; }).catch(e => { result.fetched = 'error'; });
    setTimeout(() => { const d = document.createElement('div'); d.className = 'later'; d.id = 'later'; d.textContent = 'Late ad here'; document.body.appendChild(d); }, 500);
  </script>`;
// a fake YouTube watch page: initial player data with ad fields, then the player API over fetch and XHR
const PLAYER = { videoDetails: { videoId: 'abc', title: 'Test video' }, streamingData: { formats: [{ itag: 18 }] }, adPlacements: [{ adPlacementRenderer: {} }], playerAds: [{ playerLegacyDesktopWatchAdsRenderer: {} }], adSlots: [{ adSlotRenderer: {} }] };
const YT = `
  <div id="player">loading</div>
  <script>var ytInitialPlayerResponse = ${JSON.stringify(PLAYER)};</script>
  <script>
    window.result = {};
    result.initialAds = !!(ytInitialPlayerResponse.adPlacements || ytInitialPlayerResponse.playerAds || ytInitialPlayerResponse.adSlots);
    result.initialVideo = ytInitialPlayerResponse.videoDetails.videoId;
    var parsed = JSON.parse('{"playerResponse":{"adPlacements":[1],"videoDetails":{"videoId":"abc"}}}');
    result.parseAds = !!parsed.playerResponse.adPlacements; result.parseVideo = parsed.playerResponse.videoDetails.videoId;
    fetch('/youtubei/v1/player?key=k', { method: 'POST', body: '{}' }).then(r => r.json()).then(j => {
      result.fetchAds = !!(j.adPlacements || j.playerAds || j.adSlots); result.fetchVideo = j.videoDetails.videoId; result.fetchHeartbeat = j.adBreakHeartbeatParams;
      document.getElementById('player').textContent = 'playing ' + j.videoDetails.videoId;
    }).catch(e => { result.fetchError = String(e); });
    var x = new XMLHttpRequest(); x.open('POST', '/youtubei/v1/next');
    x.onload = function () { var j = JSON.parse(x.responseText); result.xhrAds = !!(j.playerAds || j.adPlacements); result.xhrOk = j.contents === 'ok'; };
    x.send('{}');
  </script>`;
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://' + req.headers.host);   // as a proxy, the request line has the whole address
  const host = u.hostname; seen.push(host + u.pathname + u.search);
  const send = (type, body) => { res.writeHead(200, { 'Content-Type': type }); res.end(body); };
  if (u.pathname === '/youtubei/v1/player') return send('application/json', JSON.stringify({ ...PLAYER, adBreakHeartbeatParams: 'QUQ=' }));
  if (u.pathname === '/youtubei/v1/next') return send('application/json', JSON.stringify({ contents: 'ok', playerAds: [1], adPlacements: [1] }));
  if (u.pathname === '/watch') return send('text/html', html('video', YT));
  if (u.pathname.startsWith('/page')) return send('text/html', html(host, COMMON + (host.endsWith('news.test') ? NEWS : '')));
  if (u.pathname.endsWith('.json')) return send('application/json', '{"ads":true}');
  if (u.pathname.endsWith('.js')) return send('text/javascript', '');
  send('image/gif', Buffer.from('R0lGODlhAQABAAAAACw=', 'base64'));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const got = s => seen.includes(s);
const gotAny = s => seen.some(x => x.startsWith(s));

let passed = 0, failed = 0;
async function step(name, f) { try { await f(); passed++; console.log('ok   ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + (e && e.message)); } }

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'shield-'));
const ctx = await chromium.launchPersistentContext(profile, {
  headless: true, channel: 'chromium',
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, `--proxy-server=http://127.0.0.1:${PORT}`, '--proxy-bypass-list=<-loopback>'],
});
const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
const until = async (f, ms = 8000, what = 'condition') => { const t0 = Date.now(); for (;;) { if (await f()) return; if (Date.now() - t0 > ms) throw new Error('timed out: ' + what); await new Promise(r => setTimeout(r, 100)); } };
const scripts = () => sw.evaluate(() => chrome.scripting.getRegisteredContentScripts());
const enabled = () => sw.evaluate(() => chrome.declarativeNetRequest.getEnabledRulesets());
const set = v => sw.evaluate(v => chrome.storage.local.set(v), v);
const ALL_LISTS = ['ublock-filters', 'easylist', 'easyprivacy', 'ublock-badware', 'ublock-privacy', 'ublock-unbreak', 'ublock-quick-fixes', 'plowe'];
await until(async () => (await scripts()).length === 3 + scriptletBundles, 10000, 'content scripts registered');
await until(async () => (await enabled()).length === ALL_LISTS.length, 10000, 'every list enabled');

async function visit(host, p = '/page', wait = 500) {
  seen.length = 0;
  const pg = await ctx.newPage();
  await pg.goto(`http://${host}${p}`, { waitUntil: 'load' });
  await pg.waitForTimeout(wait);
  return pg;
}
const shown = (p, id) => p.evaluate(i => { const e = document.getElementById(i); return !!e && getComputedStyle(e).display !== 'none'; }, id);
const exists = (p, id) => p.evaluate(i => !!document.getElementById(i), id);
const result = p => p.evaluate(() => window.result);

await step('every list is on: the manifest\'s sets plus the ones the background switches on', async () => {
  assert.deepEqual((await enabled()).sort(), [...ALL_LISTS].sort());
});

await step('network: blocks, exceptions, regex, redirect to a stand-in, $important, $badfilter, !#if', async () => {
  const p = await visit('other.test');
  assert.ok(got('other.test/page'), 'the page itself loads');
  assert.ok(!got('ads.example/ad.js'), 'ads.example blocked');
  assert.ok(got('ads.example/allowed.js'), '@@ exception lets allowed.js through');
  assert.ok(!got('tracker-ads.test/banner/x.png'), 'third-party banner image blocked');
  assert.ok(!got('metrics.example/p.gif'), 'tracker (privacy list) blocked');
  assert.ok(got('cdn.example/ad-1.png') && !got('cdn.example/ad-2.js'), '$~image: the image passes, the script is blocked');
  assert.ok(got('fine.example/lib.js') && got('other3p.example/x.js'), 'unrelated scripts load');
  assert.ok(!got('regex.example/banner12.png') && got('regex.example/other.png'), 'regex filter');
  assert.ok(!gotAny('redirect.example'), 'gpt.js never reaches the ad server');
  assert.equal(await p.evaluate(() => window.gptStub), true, '...and the page got Shield\'s googletag stand-in instead');
  assert.ok(!gotAny('important.example'), '$important beats the @@ exception');
  assert.ok(got('cancelled.example/x.js'), '$badfilter in one list cancels the filter in another');
  assert.ok(!gotAny('mv3only.example'), '!#if env_mv3 block used');
  assert.ok(await shown(p, 'content'));
  await p.close();
});

await step('$removeparam: tracking parameters are stripped from requests and from the page address', async () => {
  let p = await visit('other.test');
  assert.ok(got('fine.example/p.gif?keep=1'), 'image request without utm_source / fbclid: ' + seen.filter(s => s.includes('p.gif')).join(' '));
  await p.close();
  p = await visit('other.test', '/page?utm_source=mail&x=1');
  assert.ok(got('other.test/page?x=1'), 'page address: ' + seen.filter(s => s.startsWith('other.test/page')).join(' '));
  await p.close();
});

await step('$csp: the site\'s inline scripts are refused; other sites unaffected', async () => {
  const c = await visit('csp.test');
  assert.equal(await c.evaluate(() => window.inlineRan), undefined);
  await c.close();
  const o = await visit('other.test');
  assert.equal(await o.evaluate(() => window.inlineRan), true);
  await o.close();
});

await step('$denyallow: on strict.test every third-party script is blocked except the allowed hosts', async () => {
  const p = await visit('strict.test');
  assert.ok(!got('other3p.example/x.js') && got('fine.example/lib.js'));
  await p.close();
});

await step('$document (badware): the page itself is blocked', async () => {
  seen.length = 0;
  const p = await ctx.newPage();
  await assert.rejects(p.goto('http://badware.example/page'));
  assert.ok(!gotAny('badware.example'));
  await p.close();
});

await step('ad boxes: generic everywhere, per-site, site exceptions, $generichide, specific-generic', async () => {
  const o = await visit('other.test');
  assert.equal(await shown(o, 'generic'), false, '##.ad-banner hidden on any site');
  assert.equal(await shown(o, 'sponsor-1'), false, 'attribute selector hidden');
  assert.equal(await shown(o, 'site'), true, '.sponsored only hidden on news.test');
  assert.equal(await shown(o, 'sg'), false, '*## specific-generic');
  await o.close();
  const n = await visit('www.news.test');
  await until(() => shown(n, 'site').then(v => !v), 3000, 'news.test##.sponsored applied');
  assert.equal(await shown(n, 'generic'), true, 'news.test#@#.ad-banner keeps it visible there');
  await n.close();
  const g = await visit('plain.test');
  assert.equal(await shown(g, 'generic'), true, '$generichide: generic hiding off on plain.test');
  assert.equal(await shown(g, 'sg'), false, 'specific-generic still applies');
  await g.close();
});

await step('procedural filters: :has-text, :upward, :matches-css, :remove, :style, :has(procedural), :xpath, and later DOM changes', async () => {
  const n = await visit('news.test', '/page', 900);
  await until(async () => !(await shown(n, 'post-ad')), 3000, ':has-text');
  assert.equal(await shown(n, 'post-ok'), true);
  assert.equal(await shown(n, 'gp'), false, ':upward(2)');
  assert.equal(await shown(n, 'side'), false, ':matches-css');
  assert.equal(await exists(n, 'junk'), false, ':remove()');
  assert.equal(await n.evaluate(() => getComputedStyle(document.getElementById('hl')).color), 'rgb(255, 0, 0)', ':style()');
  assert.equal(await shown(n, 'card-ad'), false, ':has(> .tag:has-text(Ad))'); assert.equal(await shown(n, 'card-ok'), true);
  assert.equal(await shown(n, 'xp'), false, ':xpath');
  await until(async () => (await exists(n, 'later')) && !(await shown(n, 'later')), 3000, 'an ad added later is hidden too');
  await n.close();
});

await step('scriptlets: set-constant, abort-on-property-read, prevent-setTimeout, remove-attr, prevent-fetch, and a site exception', async () => {
  const n = await visit('news.test', '/page', 800);
  const r = await result(n);
  assert.equal(r.adsEnabled, false, 'set-constant');
  assert.equal(r.aopr, 'threw', 'abort-on-property-read');
  assert.equal(r.timer, undefined, 'prevent-setTimeout'); assert.equal(r.other, 'ran', 'other timers run');
  assert.equal(r.fetched, '', 'prevent-fetch answered without the network'); assert.ok(!got('news.test/ads/config.json'));
  assert.equal(await n.evaluate(() => document.getElementById('clicky').hasAttribute('onclick')), false, 'remove-attr');
  await n.close();
  const s = await visit('sub.news.test', '/page', 800);
  const rs = await result(s);
  assert.equal(rs.adsEnabled, true, '#@#+js(set, ...) turns that one off on sub.news.test'); assert.equal(rs.aopr, 'threw', 'the others still run');
  await s.close();
});

await step('fake YouTube page: no ad fields in the initial data, the player API (fetch and XHR) or JSON.parse - and the video still plays', async () => {
  const y = await visit('www.youtube.test', '/watch', 1000);
  const r = await result(y);
  console.log('     youtube.test result:', JSON.stringify(r));
  assert.equal(r.initialAds, false, 'ytInitialPlayerResponse ad fields'); assert.equal(r.initialVideo, 'abc');
  assert.equal(r.parseAds, false, 'json-prune'); assert.equal(r.parseVideo, 'abc');
  assert.equal(r.fetchAds, false, '/youtubei/v1/player over fetch'); assert.equal(r.fetchVideo, 'abc'); assert.equal(r.fetchHeartbeat, '', 'trusted-replace-fetch-response');
  assert.equal(r.xhrAds, false, '/youtubei/v1/next over XHR'); assert.equal(r.xhrOk, true);
  assert.equal(await y.textContent('#player'), 'playing abc');
  await y.close();
  // the same page with Shield paused there: the ads are back (so the test above really tested something)
  await set({ paused: ['youtube.test'] });
  await until(async () => (await scripts()).every(c => (c.excludeMatches || []).includes('*://*.youtube.test/*')), 5000, 'scripts left out on youtube.test');
  const yp = await visit('www.youtube.test', '/watch', 1000);
  const rp = await result(yp);
  assert.equal(rp.initialAds, true); assert.equal(rp.fetchAds, true); assert.equal(rp.xhrAds, true);
  await yp.close();
  await set({ paused: [] });
  await until(async () => (await scripts()).every(c => !(c.excludeMatches || []).includes('*://*.youtube.test/*')), 5000, 'resumed');
});

await step('a $document exception lets a whole site load everything', async () => {
  const p = await visit('trusted.example');
  assert.ok(got('ads.example/ad.js'), 'nothing blocked on trusted.example');
  await p.close();
});

await step('Pause on this site: everything loads and shows there; other sites stay protected; Resume works', async () => {
  await set({ paused: ['news.test'] });
  await until(async () => (await sw.evaluate(() => chrome.declarativeNetRequest.getDynamicRules())).length === 1, 5000, 'pause rule');
  await until(async () => ((await scripts()).find(c => c.id === 'shield-generic')?.excludeMatches || []).includes('*://*.news.test/*'), 5000, 'CSS left out for news.test');
  const n = await visit('news.test');
  assert.ok(got('ads.example/ad.js') && got('metrics.example/p.gif') && gotAny('important.example'), 'paused: requests go through, $important too');
  assert.equal(await shown(n, 'generic'), true); assert.equal(await shown(n, 'site'), true); assert.equal(await shown(n, 'post-ad'), true);
  assert.equal((await result(n)).adsEnabled, true, 'no scriptlets on a paused site');
  await n.close();
  const o = await visit('other.test');
  assert.ok(!got('ads.example/ad.js'), 'other sites still blocked');
  await o.close();
  await set({ paused: [] });
  await until(async () => (await sw.evaluate(() => chrome.declarativeNetRequest.getDynamicRules())).length === 0, 5000, 'resume');
  const n2 = await visit('news.test');
  assert.ok(!got('ads.example/ad.js'), 'resumed: blocked again');
  await n2.close();
});

await step('levels: Basic = network only; Complete adds strict pop-up blocking; Optimal is the default', async () => {
  assert.equal(await sw.evaluate(async () => (await chrome.storage.local.get('level')).level), 'optimal');
  const pop = async () => { const p = await visit('other.test'); seen.length = 0; await p.evaluate(() => { location.href = 'http://popunder.example/page'; }); await p.waitForTimeout(800); await p.close(); return gotAny('popunder.example'); };
  assert.equal(await pop(), true, 'Optimal: a pop-under host opened from a site still loads');
  await set({ level: 'basic' });
  await until(async () => (await scripts()).length === 0, 5000, 'nothing runs in pages at Basic');
  const b = await visit('news.test', '/page', 700);
  assert.ok(!got('ads.example/ad.js'), 'Basic still blocks');
  assert.equal(await shown(b, 'generic'), true, 'no hiding at Basic'); assert.equal((await result(b)).adsEnabled, true, 'no scriptlets at Basic');
  await b.close();
  await set({ level: 'complete' });
  await until(async () => (await enabled()).includes('popups') && (await scripts()).length > 0, 5000, 'Complete');
  assert.equal(await pop(), false, 'Complete: the pop-under host is blocked');
  await set({ level: 'optimal' });
  await until(async () => !(await enabled()).includes('popups'), 5000, 'back to Optimal');
});

await step('lists: switching EasyPrivacy off lets trackers through but still blocks ads', async () => {
  await set({ lists: { easyprivacy: false } });
  await until(async () => !(await enabled()).includes('easyprivacy'), 5000, 'easyprivacy off');
  const p = await visit('other.test');
  assert.ok(got('metrics.example/p.gif') && !got('ads.example/ad.js'));
  await p.close();
  await set({ lists: {} });
  await until(async () => (await enabled()).includes('easyprivacy'), 5000, 'easyprivacy on');
});

await step('no room in the shared pool: the list is loaded as dynamic rules and still blocks, redirects and strips', async () => {
  await set({ debugNoRoom: ['ublock-filters'] });
  await until(async () => !(await enabled()).includes('ublock-filters'), 5000, 'static set off');
  await until(async () => ((await sw.evaluate(async () => (await chrome.storage.local.get('fallback')).fallback)) || {})['ublock-filters']?.loaded > 0, 5000, 'dynamic fallback loaded');
  const p = await visit('other.test');
  assert.ok(!got('regex.example/banner12.png'), 'regex rule (dynamic)');
  assert.ok(!gotAny('redirect.example') && await p.evaluate(() => window.gptStub), 'redirect (dynamic)');
  assert.ok(!gotAny('important.example'), '$important (dynamic)');
  assert.ok(got('fine.example/p.gif?keep=1'), 'removeparam (dynamic)');
  await p.close();
  await set({ debugNoRoom: [] });
  await until(async () => (await enabled()).includes('ublock-filters'), 5000, 'static set back');
  await until(async () => (await sw.evaluate(() => chrome.declarativeNetRequest.getDynamicRules())).length === 0, 5000, 'dynamic rules removed');
});

await step('the popup: site, count, level switch, lists, and the broken-site report (clipboard only)', async () => {
  const p = await visit('other.test', '/page?utm_source=a&secret=1');
  const id = sw.url().split('/')[2];
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: `chrome-extension://${id}` }).catch(() => { });
  const pop = await ctx.newPage();
  const tabId = await sw.evaluate(async () => (await chrome.tabs.query({ url: '*://other.test/*' }))[0].id);
  await pop.goto(`chrome-extension://${id}/popup.html?tab=${tabId}`);
  await pop.waitForTimeout(700);
  assert.equal(await pop.textContent('#site'), 'other.test');
  const n = Number(await pop.textContent('#count'));
  assert.ok(n >= 6, 'blocked count on the page: ' + n);
  assert.equal(await pop.getAttribute('[data-level="optimal"]', 'aria-checked'), 'true');
  assert.equal(await pop.locator('#lists input[type=checkbox]').count(), ALL_LISTS.length);
  await pop.setViewportSize({ width: 320, height: 640 });
  await pop.screenshot({ path: path.join(os.tmpdir(), 'shield-popup.png'), fullPage: true });
  seen.length = 0;
  await pop.click('#report');
  await pop.waitForTimeout(300);
  const note = await pop.textContent('#reportNote');
  assert.ok(note.length > 0, 'report note shown');
  if (note.startsWith('Copied')) {
    const clip = await pop.evaluate(() => navigator.clipboard.readText());
    assert.match(clip, /Page: http:\/\/other\.test\/page\n/); assert.doesNotMatch(clip, /secret/, 'no query string in the report');
    console.log('     report:\n       ' + clip.split('\n').join('\n       '));
  } else console.log('     (clipboard not available in this browser: ' + note + ')');
  assert.equal(seen.length, 0, 'the report sent nothing');
  await pop.click('[data-level="complete"]');
  await until(async () => (await sw.evaluate(async () => (await chrome.storage.local.get('level')).level)) === 'complete', 3000, 'level from the popup');
  await pop.click('[data-level="optimal"]');
  await pop.close(); await p.close();
});

await ctx.close(); server.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
