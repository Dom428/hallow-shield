// Hallow Shield end-to-end test: the real extension in Chromium, with the browser's proxy pointed at a local test server
// (so "ads.example", "news.test" and "youtube.test" are pages and files served here). Checks what the browser really
// blocks, redirects, strips, hides and lets through; procedural filters; scriptlets (a fake YouTube page included);
// pausing a site; the blocking levels; switching lists; the dynamic-rule fallback; the cookie-banner and annoyance switches;
// the element zapper (hide + persist, zap once, cancel, inside a frame); My filters (network + hiding, errors per line,
// export / import); 1.3: cookie banners answered with "Reject" (selector chains, closed shadow roots, extra-match, frames,
// exceptions; never when paused, switched off or at Basic), per-site Strict / Normal / Off, the Sites list, the stats
// (counting and clearing); and the popup. Build the sample rules first:
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
// a release build's version.json (dev: false), so the stats come the way they do for users: from getMatchedRules
fs.writeFileSync(path.join(EXT, 'version.json'), JSON.stringify({ name: 'Hallow Shield', version: mf.version, browser: 'chrome', built: new Date().toISOString(), dev: false }));
const bundles = JSON.parse(fs.readFileSync(path.join(EXT, 'rules', 'scriptlets.json'), 'utf8'));
const META = JSON.parse(fs.readFileSync(path.join(EXT, 'rules', 'meta.json'), 'utf8'));
// content scripts for the cosmetic groups that are on: generic + specific-generic CSS per group, content.js, scriptlets
const expectedScripts = groups => 1 + 2 * groups.length + bundles.filter(b => groups.includes(b.group || 'main')).length;

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
  <script>fetch("http://fine.example/p.json?utm_source=x&keep=1&fbclid=2").catch(() => { });</script>
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
  </script>
  <script>result.rm = 'removeMe ran';</script>`;
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
// cookie banners and annoyances (sample lists test/sample-cookies.txt, test/sample-annoyances.txt)
const COOKIE = `
  <p id="content">Real content</p>
  <div class="cookie-banner" id="cb">We use cookies</div>
  <div id="consent-box">Accept all?</div>
  <div class="gdpr-wall" id="gw">We value your privacy</div>
  <div class="newsletter-popup" id="nl">Subscribe!</div>
  <div class="chat-bubble" id="chat">Chat with us</div>
  <div class="social-share" id="ss">Share</div>
  <script src="http://consent-cdn.example/consent.js"></script>
  <script src="http://chat-widget.example/w.js"></script>`;
// the zapper's page and My filters' page
const ZAP = `
  <div class="promo-wrap" id="wrap" style="padding:30px;margin:20px;width:400px"><p class="promo-text" id="ptext" style="margin:0;padding:10px">Buy now</p></div>
  <div class="keep" id="keep" style="padding:30px;margin:20px;width:400px">Keep me</div>
  <div class="other" id="other" style="padding:30px;margin:20px;width:400px">Other</div>`;
// cookie-consent dialogs with Accept and Reject (the sample uBlock cookie list says which to click, per site)
const REC = `<script>window.clicked = []; function rec(x) { clicked.push(x); }
  function openPanel() { rec('settings'); setTimeout(() => document.body.insertAdjacentHTML('beforeend', '<div id="cmp-panel"><button class="accept-all" onclick="rec(\\'accept\\')">Accept all</button><button class="necessary-only" onclick="rec(\\'necessary\\')">Necessary only</button></div>'), 250); }</script>`;
const CMP = REC + `<p id="content">Real content</p>
  <div id="cmp"><button class="accept-all" onclick="rec('accept')">Accept all</button><button class="reject-all" onclick="rec('reject')">Reject all</button></div>`;
const CMPCHAIN = REC + `<button id="cmp-settings" onclick="openPanel()">Settings</button>`;
const CMPSHADOW = REC + `<script>
  const h = document.createElement('div'); h.id = 'cmp-host'; document.body.appendChild(h);
  const root = h.attachShadow({ mode: 'closed' });
  root.innerHTML = '<button class="accept">Accept</button><button class="reject">Reject</button>';
  root.querySelector('.accept').addEventListener('click', () => rec('shadow-accept'));
  root.querySelector('.reject').addEventListener('click', () => rec('shadow-reject'));
</script>`;
const CMPFRAME = `<p>outer</p><iframe id="fr" src="/cmp" style="width:600px;height:200px"></iframe>`;
// the zapper inside a frame of the page's own site
const ZAPFRAME = `<p id="outer">outer page</p><iframe id="zf" src="/zapinner" style="width:520px;height:320px;border:4px solid #000;padding:6px;margin:10px"></iframe>`;
const ZAPINNER = `<div class="frame-promo" id="fpromo" style="padding:30px;margin:20px;width:300px">Frame promo</div><div class="frame-keep" id="fkeep" style="padding:30px;margin:20px;width:300px">Keep me</div>`;
const MF = `
  <div class="my-hide" id="mh">mine</div><div class="my-generic" id="mg">generic</div><div id="stay">stay</div>
  <script src="http://myblock.example/x.js"></script><script src="http://fine.example/lib.js"></script>`;
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://' + req.headers.host);   // as a proxy, the request line has the whole address
  const host = u.hostname; seen.push(host + u.pathname + u.search);
  const send = (type, body) => { res.writeHead(200, { 'Content-Type': type }); res.end(body); };
  if (u.pathname === '/youtubei/v1/player') return send('application/json', JSON.stringify({ ...PLAYER, adBreakHeartbeatParams: 'QUQ=' }));
  if (u.pathname === '/youtubei/v1/next') return send('application/json', JSON.stringify({ contents: 'ok', playerAds: [1], adPlacements: [1] }));
  if (u.pathname === '/watch') return send('text/html', html('video', YT));
  if (u.pathname === '/cookie') return send('text/html', html('cookies', COOKIE));
  if (u.pathname === '/zap') return send('text/html', html('zap', ZAP));
  if (u.pathname === '/mf') return send('text/html', html('mf', MF));
  if (u.pathname === '/cmp') { if (u.searchParams.get('consent')) res.setHeader('Set-Cookie', 'consent_given=1; Path=/'); return send('text/html', html('cmp', CMP)); }
  if (u.pathname === '/cmpchain') return send('text/html', html('cmp', CMPCHAIN));
  if (u.pathname === '/cmpshadow') return send('text/html', html('cmp', CMPSHADOW));
  if (u.pathname === '/cmpframe') return send('text/html', html('cmp', CMPFRAME));
  if (u.pathname === '/zapframe') return send('text/html', html('zapframe', ZAPFRAME));
  if (u.pathname === '/zapinner') return send('text/html', html('zapinner', ZAPINNER));
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
const ALL_LISTS = ['ublock-filters', 'easylist', 'easyprivacy', 'ublock-badware', 'ublock-privacy', 'ublock-unbreak', 'ublock-quick-fixes', 'plowe', 'ublock-cookies', 'easylist-cookies'];
const EVERY_LIST = Object.keys(META.lists);
await until(async () => (await scripts()).length === expectedScripts(['main', 'cookies']), 10000, 'content scripts registered');
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

await step('every list is on except the annoyance lists (off by default); cookie-banner lists are on', async () => {
  assert.deepEqual((await enabled()).sort(), [...ALL_LISTS].sort());
  assert.equal(EVERY_LIST.length, 13);
  const ids = (await scripts()).map(c => c.id);
  assert.ok(ids.includes('shield-generic-cookies') && ids.includes('shield-sl-cookies-set-cookie') && !ids.includes('shield-generic-annoyances'), ids.join(' '));
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
  assert.ok(got('fine.example/p.json?keep=1'), 'fetch without utm_source / fbclid: ' + seen.filter(s => s.includes('p.json')).join(' '));
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
  assert.equal(r.rm, undefined, 'remove-node-text emptied the inline script');
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

await step('a filter for google.* (entity) runs on google.test and nowhere else', async () => {
  const g = await visit('google.test');
  assert.equal(await g.evaluate(() => window.entityTest), true);
  await g.close();
  const o = await visit('other.test');
  assert.equal(await o.evaluate(() => window.entityTest), undefined);
  await o.close();
});

await step('a $document exception lets a whole site load everything', async () => {
  const p = await visit('trusted.example');
  if (!got('ads.example/ad.js')) {
    const tabId = await sw.evaluate(async () => (await chrome.tabs.query({ url: '*://trusted.example/*' }))[0].id);
    console.log('     matched:', JSON.stringify(await sw.evaluate(t => chrome.declarativeNetRequest.getMatchedRules({ tabId: t }), tabId)));
    console.log('     main frame:', JSON.stringify(await sw.evaluate(() => chrome.declarativeNetRequest.testMatchOutcome({ url: 'http://trusted.example/page', type: 'main_frame' }))));
    console.log('     ad.js:', JSON.stringify(await sw.evaluate(() => chrome.declarativeNetRequest.testMatchOutcome({ url: 'http://ads.example/ad.js', type: 'script', initiator: 'http://trusted.example', tabId: -1 }))));
    console.log('     seen:', seen.join(' '));
  }
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
  assert.ok(got('fine.example/p.json?keep=1'), 'removeparam (dynamic)');
  await p.close();
  await set({ debugNoRoom: [] });
  await until(async () => (await enabled()).includes('ublock-filters'), 5000, 'static set back');
  await until(async () => (await sw.evaluate(() => chrome.declarativeNetRequest.getDynamicRules())).length === 0, 5000, 'dynamic rules removed');
});

await step('cookie banners: hidden (and their scripts blocked) by default, shown with the switch off; annoyances only with theirs on', async () => {
  let p = await visit('www.cookie.test', '/cookie', 700);
  await until(async () => !(await shown(p, 'gw')), 3000, 'procedural cookie filter');
  assert.equal(await shown(p, 'cb'), false, 'generic cookie banner hidden'); assert.equal(await shown(p, 'consent-box'), false, 'site cookie box hidden');
  assert.ok(!gotAny('consent-cdn.example'), 'consent script blocked');
  assert.equal(await shown(p, 'nl'), true, 'newsletter nag shown (annoyances off by default)'); assert.equal(await shown(p, 'chat'), true); assert.equal(await shown(p, 'ss'), true);
  assert.ok(gotAny('chat-widget.example'), 'chat widget loads with annoyances off');
  assert.equal(await shown(p, 'content'), true);
  await p.close();
  await set({ cookies: false });
  await until(async () => !(await enabled()).includes('easylist-cookies') && !(await scripts()).some(c => c.id === 'shield-generic-cookies'), 5000, 'cookie lists off');
  p = await visit('www.cookie.test', '/cookie', 900);
  assert.equal(await shown(p, 'cb'), true, 'banner shown with the switch off'); assert.equal(await shown(p, 'consent-box'), true); assert.equal(await shown(p, 'gw'), true);
  assert.ok(gotAny('consent-cdn.example'), 'consent script loads with the switch off');
  await p.close();
  await set({ cookies: true, annoyances: true });
  await until(async () => (await enabled()).includes('fanboy-annoyances') && (await enabled()).includes('easylist-cookies') && (await scripts()).length === expectedScripts(['main', 'cookies', 'annoyances']), 5000, 'annoyances on');
  p = await visit('www.cookie.test', '/cookie', 900);
  assert.equal(await shown(p, 'nl'), false, 'newsletter nag hidden'); assert.equal(await shown(p, 'chat'), false, 'chat bubble hidden'); assert.equal(await shown(p, 'ss'), false, 'site social widget hidden');
  assert.equal(await shown(p, 'cb'), false, 'cookie banner hidden again');
  assert.ok(!gotAny('chat-widget.example'), 'chat widget blocked');
  await p.close();
  await set({ annoyances: false });
  await until(async () => !(await enabled()).includes('fanboy-annoyances') && (await scripts()).length === expectedScripts(['main', 'cookies']), 5000, 'annoyances off');
});

// ---- 1.3: cookie banners answered ----
const clickedOn = p => p.evaluate(() => window.clicked || []);
const settle = async (p, ms = 1500) => { await p.waitForTimeout(ms); return clickedOn(p); };
await step('cookie banners: the list\'s "Reject" is clicked (selector chains, closed shadow roots, entities, frames) and "Accept" never', async () => {
  assert.equal(META.scriptlets.clicks.filters, 6, 'click filters built: ' + JSON.stringify(META.scriptlets.clicks));
  assert.equal(META.scriptlets.skipped['trusted-click-element (outside the cookie lists)'], 1, 'a main-list click filter is not used');
  let p = await visit('www.clicker.test', '/cmp', 200);
  await until(async () => (await clickedOn(p)).length > 0, 4000, 'clicked');
  assert.deepEqual(await settle(p, 800), ['reject'], 'Reject clicked once, Accept never');
  await p.close();
  p = await visit('chain.test', '/cmpchain', 200);
  await until(async () => (await clickedOn(p)).length >= 2, 5000, 'chain clicked');
  assert.deepEqual(await settle(p, 800), ['settings', 'necessary'], 'settings, then "Necessary only"');
  await p.close();
  p = await visit('shadow.test', '/cmpshadow', 200);
  await until(async () => (await clickedOn(p)).length > 0, 4000, 'shadow clicked');
  assert.deepEqual(await settle(p, 600), ['shadow-reject'], 'inside a closed shadow root');
  await p.close();
  p = await visit('www.cookie.test', '/cmp', 200);
  await until(async () => (await clickedOn(p)).length > 0, 4000, 'entity clicked');
  assert.deepEqual(await settle(p, 500), ['reject'], 'cookie.* (entity)');
  await p.close();
  p = await visit('frames.test', '/cmpframe', 300);
  const fr = () => p.frames().find(f => f.url().endsWith('/cmp'));
  await until(async () => fr() && (await fr().evaluate(() => (window.clicked || []).length)) > 0, 4000, 'clicked in the frame');
  assert.deepEqual(await fr().evaluate(() => window.clicked), ['reject'], 'in a frame of the site');
  await p.close();
  p = await visit('extra.test', '/cmp', 200);
  await until(async () => (await clickedOn(p)).length > 0, 4000, 'extra.test clicked without the consent cookie');
  await p.close();
  p = await visit('extra.test', '/cmp?consent=1', 200);
  assert.deepEqual(await settle(p), [], 'extra-match !cookie:consent_given: already answered, nothing clicked');
  await p.close();
  p = await visit('sub.clicker.test', '/cmp', 200);
  assert.deepEqual(await settle(p), [], '#@#+js(trusted-click-element, ...) exception');
  await p.close();
  p = await visit('other.test', '/cmp', 200);
  assert.deepEqual(await settle(p), [], 'no filter for this site (and the main list\'s isn\'t used)');
  await p.close();
});

await step('cookie banners: nothing is clicked on a paused site, with the switch off, or at Basic', async () => {
  await set({ paused: ['clicker.test'] });
  await until(async () => ((await scripts()).find(c => c.id === 'shield-cosmetic')?.excludeMatches || []).includes('*://*.clicker.test/*'), 5000, 'paused');
  let p = await visit('www.clicker.test', '/cmp', 200);
  assert.deepEqual(await settle(p), [], 'paused: nothing clicked');
  await p.close();
  await set({ paused: [], cookies: false });
  await until(async () => !(await scripts()).some(c => c.id === 'shield-generic-cookies') && !((await scripts()).find(c => c.id === 'shield-cosmetic')?.excludeMatches || []).length, 5000, 'switch off');
  p = await visit('www.clicker.test', '/cmp', 200);
  assert.deepEqual(await settle(p), [], 'switch off: nothing clicked');
  await p.close();
  await set({ cookies: true, level: 'basic' });
  await until(async () => (await scripts()).length === 0, 5000, 'basic');
  p = await visit('www.clicker.test', '/cmp', 200);
  assert.deepEqual(await settle(p), [], 'Basic: nothing clicked');
  await p.close();
  await set({ level: 'optimal' });
  await until(async () => (await scripts()).length === expectedScripts(['main', 'cookies']), 5000, 'back to Optimal');
  p = await visit('www.clicker.test', '/cmp', 200);
  await until(async () => (await clickedOn(p)).length > 0, 4000, 'clicking again');
  await p.close();
});

const popupFor = async hostGlob => {
  const id = sw.url().split('/')[2];
  const tabId = await sw.evaluate(async g => (await chrome.tabs.query({ url: g }))[0].id, hostGlob);
  const pop = await ctx.newPage();
  await pop.goto(`chrome-extension://${id}/popup.html?tab=${tabId}`);
  await pop.waitForTimeout(500);
  return pop;
};
const myFilters = () => sw.evaluate(async () => (await chrome.storage.local.get({ myFilters: '' })).myFilters);
const center = (p, sel) => p.evaluate(s => { const r = document.querySelector(s).getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }, sel);
const pickerOpen = p => p.evaluate(() => !!document.querySelector('hallow-shield-picker'));

await step('the zapper: hover, widen with the Up key, click - hidden and saved as site##selector, still hidden after a reload', async () => {
  const p = await visit('www.zap.test', '/zap', 300);
  const pop = await popupFor('*://www.zap.test/*');
  await pop.click('#pick');
  await until(() => pickerOpen(p), 3000, 'picker injected'); await p.bringToFront();
  assert.equal(await p.evaluate(() => document.querySelector('hallow-shield-picker').shadowRoot), null, 'closed shadow root');
  const [x, y] = await center(p, '#ptext');
  await p.mouse.move(x - 5, y - 2); await p.mouse.move(x, y);
  await p.keyboard.press('ArrowUp');            // from the text to the box around it
  await p.mouse.click(x, y);
  await until(async () => !(await shown(p, 'wrap')), 3000, 'the widened element is hidden');
  assert.equal(await shown(p, 'keep'), true); assert.equal(await shown(p, 'other'), true);
  assert.equal(await pickerOpen(p), false, 'picker closed after hiding');
  await until(async () => /^zap\.test##.+$/m.test(await myFilters()), 3000, 'saved');
  const line = (await myFilters()).split('\n').find(l => l.startsWith('zap.test##'));
  console.log('     saved: ' + line);
  assert.ok(await p.evaluate(s => document.querySelector(s) === document.getElementById('wrap'), line.slice('zap.test##'.length)), 'the saved selector names the box');
  await p.reload(); await p.waitForTimeout(500);
  await until(async () => !(await shown(p, 'wrap')), 3000, 'still hidden after a reload');
  assert.equal(await shown(p, 'keep'), true);
  await pop.close(); await p.close();
});

await step('the zapper: Zap once removes without saving; Esc cancels', async () => {
  const before = await myFilters();
  const p = await visit('www.zap.test', '/zap', 300);
  let pop = await popupFor('*://www.zap.test/*');
  await pop.click('#zap');
  await until(() => pickerOpen(p), 3000, 'picker injected'); await p.bringToFront();
  const [x, y] = await center(p, '#keep');
  await p.mouse.move(x - 3, y); await p.mouse.move(x, y);
  await p.mouse.click(x, y);
  await until(async () => !(await exists(p, 'keep')), 3000, 'zapped');
  assert.equal(await myFilters(), before, 'nothing saved');
  await pop.close();
  pop = await popupFor('*://www.zap.test/*');
  await pop.click('#pick');
  await until(() => pickerOpen(p), 3000, 'picker injected again'); await p.bringToFront();
  const [ox, oy] = await center(p, '#other');
  await p.mouse.move(ox, oy);
  await p.keyboard.press('Escape');
  await until(async () => !(await pickerOpen(p)), 3000, 'Esc closes the picker');
  await p.mouse.click(ox, oy);
  assert.equal(await shown(p, 'other'), true, 'nothing hidden after Esc');
  assert.equal(await myFilters(), before);
  await p.reload(); await p.waitForTimeout(400);
  assert.equal(await exists(p, 'keep'), true, 'a zapped element is back after a reload');
  await pop.close(); await p.close();
});

const optionsPage = async () => {
  const id = sw.url().split('/')[2];
  const op = await ctx.newPage();
  await op.goto(`chrome-extension://${id}/options.html`);
  await op.waitForSelector('#filters');
  return op;
};
await step('My filters: network and hiding filters work after Save; refused lines are listed by line number; zapper rules can be deleted', async () => {
  const op = await optionsPage();
  const zapLine = (await myFilters()).split('\n').find(l => l.startsWith('zap.test##'));
  assert.ok((await op.inputValue('#filters')).includes(zapLine), 'the zapper\'s rule is in My filters');
  assert.ok((await op.textContent('#zapped')).includes(zapLine), '...and in the per-site list');
  const text = (await op.inputValue('#filters')).replace(/\n*$/, '\n') + ['! mine', '||myblock.example^', 'myfilters.test##.my-hide', '##.my-generic', 'news.test##+js(set, x, 1)', '||bad.example^$replace=/a/b/'].join('\n') + '\n';
  await op.fill('#filters', text);
  await op.click('#save');
  await until(async () => /Saved/.test(await op.textContent('#status')), 3000, 'saved');
  const errs = await op.$$eval('#errors li', l => l.map(e => [Number(e.dataset.line), e.textContent]));
  console.log('     errors: ' + JSON.stringify(errs));
  const lines = text.split('\n');
  assert.deepEqual(errs.map(e => e[0]), [lines.indexOf('news.test##+js(set, x, 1)') + 1, lines.indexOf('||bad.example^$replace=/a/b/') + 1]);
  assert.match(errs[0][1], /Scriptlet/); assert.match(errs[1][1], /replace/);
  await until(async () => (await sw.evaluate(() => chrome.declarativeNetRequest.getDynamicRules())).some(r => r.id >= 2000000), 5000, 'dynamic rule from My filters');
  const p = await visit('www.myfilters.test', '/mf', 600);
  assert.ok(!gotAny('myblock.example') && got('fine.example/lib.js'), 'my network filter blocks: ' + seen.join(' '));
  await until(async () => !(await shown(p, 'mh')), 3000, 'my site hiding filter');
  assert.equal(await shown(p, 'mg'), false, 'my generic hiding filter'); assert.equal(await shown(p, 'stay'), true);
  await p.close();
  // delete the zapper's rule from the list: the box is back
  await op.click(`#zapped li:has(code:text-is("${zapLine}")) button`);
  await until(async () => !(await myFilters()).includes(zapLine), 3000, 'deleted');
  const z = await visit('www.zap.test', '/zap', 700);
  assert.equal(await shown(z, 'wrap'), true, 'shown again after deleting the rule');
  await z.close(); await op.close();
});

await step('My filters: export to a text file, clear, import it again - the same filters', async () => {
  const op = await optionsPage();
  const before = await myFilters();
  assert.ok(before.includes('||myblock.example^'));
  const [dl] = await Promise.all([op.waitForEvent('download'), op.click('#export')]);
  assert.equal(dl.suggestedFilename(), 'hallow-shield-my-filters.txt');
  const file = path.join(os.tmpdir(), 'shield-export-' + Date.now() + '.txt');
  await dl.saveAs(file);
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'the export is exactly what was saved');
  await op.fill('#filters', ''); await op.click('#save');
  await until(async () => (await myFilters()) === '', 3000, 'cleared');
  await until(async () => !(await sw.evaluate(() => chrome.declarativeNetRequest.getDynamicRules())).some(r => r.id >= 2000000), 5000, 'rules removed');
  await op.setInputFiles('#file', file);
  await until(async () => (await myFilters()) === before, 3000, 'imported');
  assert.match(await op.textContent('#status'), /Imported/);
  assert.equal(await op.inputValue('#filters'), before);
  await until(async () => (await sw.evaluate(() => chrome.declarativeNetRequest.getDynamicRules())).some(r => r.id >= 2000000), 5000, 'rules back');
  const p = await visit('www.myfilters.test', '/mf', 500);
  assert.ok(!gotAny('myblock.example'), 'blocking again after the import');
  await p.close();
  // clean up for the next steps
  await op.fill('#filters', ''); await op.click('#save');
  await until(async () => (await myFilters()) === '', 3000, 'cleared');
  await op.close();
});

const stor = k => sw.evaluate(async k => (await chrome.storage.local.get(k))[k], k);
const dynCount = () => sw.evaluate(async () => (await chrome.declarativeNetRequest.getDynamicRules()).filter(r => r.id >= 3000000).length);
const popunder = async host => { const p = await visit(host, '/cookie', 300); seen.length = 0; await p.evaluate(() => { location.href = 'http://popunder.example/page'; }); await p.waitForTimeout(800); await p.close(); return gotAny('popunder.example'); };
await step('per-site mode from the popup: Strict (Complete + annoyances there only), Normal, Off (= Pause); the Sites list', async () => {
  let p = await visit('www.cookie.test', '/cookie', 300);
  let pop = await popupFor('*://www.cookie.test/*');
  assert.equal(await pop.getAttribute('[data-mode="normal"]', 'aria-checked'), 'true', 'Normal at first');
  await pop.click('[data-mode="strict"]');
  await until(async () => JSON.stringify(await stor('strict')) === '["cookie.test"]', 3000, 'strict saved');
  await until(async () => (await scripts()).some(c => c.id === 'shield-generic-annoyances' && c.matches.join() === '*://*.cookie.test/*') && (await dynCount()) > 0, 5000, 'Strict applied');
  await pop.close(); await p.close();
  p = await visit('www.cookie.test', '/cookie', 900);
  assert.equal(await shown(p, 'nl'), false, 'Strict: newsletter nag hidden'); assert.equal(await shown(p, 'chat'), false, 'chat bubble hidden'); assert.equal(await shown(p, 'ss'), false);
  assert.ok(!gotAny('chat-widget.example'), 'Strict: the annoyance list\'s network filter blocks there');
  assert.equal(await shown(p, 'cb'), false, 'cookie banner still hidden');
  await p.close();
  assert.equal(await popunder('www.cookie.test'), false, 'Strict: pop-under hosts blocked (Complete) on that site');
  p = await visit('www.plaincookie.test', '/cookie', 900);
  assert.equal(await shown(p, 'nl'), true, 'other sites: Normal'); assert.ok(gotAny('chat-widget.example'), 'other sites: chat widget loads');
  await p.close();
  assert.equal(await popunder('www.plaincookie.test'), true, 'other sites: no strict pop-up blocking');
  // Strict at Basic still gets its hiding
  await set({ level: 'basic' });
  await until(async () => (await scripts()).some(c => c.id === 'shield-generic' && c.matches.join() === '*://*.cookie.test/*'), 5000, 'Strict at Basic');
  p = await visit('www.cookie.test', '/cookie', 900);
  assert.equal(await shown(p, 'cb'), false, 'Basic + Strict site: banner hidden'); assert.equal(await shown(p, 'nl'), false);
  await p.close();
  p = await visit('www.plaincookie.test', '/cookie', 700);
  assert.equal(await shown(p, 'cb'), true, 'Basic elsewhere: nothing hidden');
  await p.close();
  await set({ level: 'optimal' });
  // Normal
  p = await visit('www.cookie.test', '/cookie', 300);
  pop = await popupFor('*://www.cookie.test/*');
  assert.equal(await pop.getAttribute('[data-mode="strict"]', 'aria-checked'), 'true');
  await pop.click('[data-mode="normal"]');
  await until(async () => (await stor('strict')).length === 0 && (await dynCount()) === 0, 5000, 'Normal');
  await until(async () => (await scripts()).length === expectedScripts(['main', 'cookies']), 5000, 'scripts back to normal');
  await pop.close(); await p.close();
  p = await visit('www.cookie.test', '/cookie', 900);
  assert.equal(await shown(p, 'nl'), true, 'Normal: annoyances shown again (switch off)'); assert.equal(await shown(p, 'cb'), false);
  await p.close();
  // Off
  p = await visit('www.cookie.test', '/cookie', 300);
  pop = await popupFor('*://www.cookie.test/*');
  await pop.click('[data-mode="off"]');
  await until(async () => JSON.stringify(await stor('paused')) === '["cookie.test"]', 3000, 'Off = paused');
  await until(async () => ((await scripts()).find(c => c.id === 'shield-generic')?.excludeMatches || []).includes('*://*.cookie.test/*'), 5000, 'Off applied');
  await pop.close(); await p.close();
  p = await visit('www.cookie.test', '/cookie', 900);
  assert.equal(await shown(p, 'cb'), true, 'Off: nothing hidden'); assert.ok(gotAny('consent-cdn.example'), 'Off: nothing blocked');
  await p.close();
  // the Sites list on the options page, with Delete
  await set({ paused: ['cookie.test'], strict: ['strict-site.test'] });
  const id = sw.url().split('/')[2];
  const op = await ctx.newPage(); await op.goto(`chrome-extension://${id}/options.html#sites`);
  await until(async () => (await op.locator('#siteRows tr').count()) === 2, 3000, 'two sites listed');
  assert.match(await op.textContent('#siteRows tr[data-site="strict-site.test"]'), /Strict/);
  assert.match(await op.textContent('#siteRows tr[data-site="cookie.test"]'), /Off/);
  await op.click('#siteRows tr[data-site="strict-site.test"] button');
  await until(async () => (await stor('strict')).length === 0, 3000, 'deleted');
  await op.click('#siteRows tr[data-site="cookie.test"] button');
  await until(async () => (await stor('paused')).length === 0, 3000, 'deleted');
  await until(async () => (await op.locator('#siteRows tr').count()) === 0, 3000, 'list empty');
  await op.close();
  await until(async () => (await scripts()).length === expectedScripts(['main', 'cookies']) && (await dynCount()) === 0, 5000, 'all Normal');
});

await step('stats: blocked counts per day / site, cookie-banner clicks, and Clear stats', async () => {
  const id = sw.url().split('/')[2];
  const op = await ctx.newPage(); op.on('dialog', d => d.accept());
  await op.goto(`chrome-extension://${id}/options.html#stats`);
  await op.waitForTimeout(500);
  assert.equal(await op.isVisible('#statsAccess'), false, 'blocked counts available (the test build has the access)');
  await op.click('#statsClear');
  await until(async () => /cleared/.test(await op.textContent('#statsStatus')), 3000, 'cleared');
  assert.equal(await op.textContent('#tBlocked'), '0'); assert.equal(await op.textContent('#tClicks'), '0');
  const p = await visit('other.test', '/page', 900);
  const c = await visit('www.clicker.test', '/cmp', 200);
  await until(async () => (await clickedOn(c)).length > 0, 4000, 'a click to count');
  await c.waitForTimeout(800);
  await op.click('#statsRefresh');
  await until(async () => Number((await op.textContent('#tBlocked')).replace(/\D/g, '')) >= 5, 5000, 'blocked counted');
  const v = await op.evaluate(async () => chrome.runtime.sendMessage({ t: 'stats-get' }));
  console.log('     stats: ' + JSON.stringify({ totals: v.totals, topSites: v.topSites, topDomains: v.topDomains, shared: v.shared, source: v.source }));
  assert.equal(v.source, 'matched', 'a release build reads the browser\'s matched rules');
  assert.ok(v.totals.ads >= 1 && v.totals.trackers >= 1, 'ads and trackers counted');
  assert.ok(v.topSites.some(([s]) => s === 'other.test'), 'other.test is a top site');
  assert.ok(v.topDomains.length > 0 || v.shared > 0, 'blocked hosts counted');
  assert.ok(v.totals.clicks >= 1, 'the cookie-banner click is counted');
  assert.equal(v.days.length, 30);
  assert.equal(await op.locator('#chart rect').count() > 0, true, 'today has a bar');
  await p.close(); await c.close();
  await op.click('#statsClear');
  await until(async () => (await op.textContent('#tBlocked')) === '0' && (await op.textContent('#tClicks')) === '0', 3000, 'cleared again');
  const after = await op.evaluate(async () => chrome.runtime.sendMessage({ t: 'stats-get' }));
  assert.equal(after.totals.blocked, 0); assert.equal(after.topSites.length, 0);
  assert.equal(JSON.stringify((await stor('stats')).days), '{}', 'storage emptied');
  await op.close();
});

await step('the zapper inside a frame of the same site: hover in the frame, click - hidden and saved, still hidden after a reload', async () => {
  const p = await visit('www.zap.test', '/zapframe', 500);
  const pop = await popupFor('*://www.zap.test/*');
  await pop.click('#pick');
  await until(() => pickerOpen(p), 3000, 'picker injected'); await p.bringToFront();
  const fr = p.frames().find(f => f.url().endsWith('/zapinner'));
  const [fx, fy] = await p.evaluate(() => { const f = document.getElementById('zf'), r = f.getBoundingClientRect(), cs = getComputedStyle(f); return [r.left + f.clientLeft + parseFloat(cs.paddingLeft), r.top + f.clientTop + parseFloat(cs.paddingTop)]; });
  const [ix, iy] = await fr.evaluate(() => { const r = document.getElementById('fpromo').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; });
  await p.mouse.move(fx + ix - 4, fy + iy - 2); await p.mouse.move(fx + ix, fy + iy);
  await p.waitForTimeout(200);
  await p.mouse.click(fx + ix, fy + iy);
  await until(async () => !(await fr.evaluate(() => getComputedStyle(document.getElementById('fpromo')).display !== 'none')), 3000, 'hidden in the frame');
  assert.equal(await fr.evaluate(() => getComputedStyle(document.getElementById('fkeep')).display !== 'none'), true, 'the rest of the frame stays');
  assert.equal(await shown(p, 'outer'), true);
  await until(async () => /^zap\.test##.+$/m.test(await myFilters()), 3000, 'saved for the site');
  const line = (await myFilters()).split('\n').find(l => l.startsWith('zap.test##'));
  console.log('     saved: ' + line);
  assert.ok(await fr.evaluate(s => document.querySelector(s) === document.getElementById('fpromo'), line.slice('zap.test##'.length)), 'the saved selector names the frame\'s box');
  await p.reload(); await p.waitForTimeout(800);
  const fr2 = p.frames().find(f => f.url().endsWith('/zapinner'));
  await until(async () => !(await fr2.evaluate(() => getComputedStyle(document.getElementById('fpromo')).display !== 'none')), 3000, 'still hidden in the frame after a reload');
  await pop.close(); await p.close();
  await set({ myFilters: '' });
});

await step('the popup: site, count, level switch, lists, and the broken-site report (clipboard only)', async () => {
  const p = await visit('other.test', '/page?utm_source=a&secret=1', 1200);
  const id = sw.url().split('/')[2];
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: `chrome-extension://${id}` }).catch(() => { });
  const pop = await ctx.newPage();
  const tabId = await sw.evaluate(async () => (await chrome.tabs.query({ url: '*://other.test/*' }))[0].id);
  await pop.goto(`chrome-extension://${id}/popup.html?tab=${tabId}`);
  await pop.waitForTimeout(700);
  assert.equal(await pop.textContent('#site'), 'other.test');
  const n = Number(await pop.textContent('#count'));
  assert.ok(n >= 5, 'blocked count on the page: ' + n);
  assert.equal(await pop.getAttribute('[data-level="optimal"]', 'aria-checked'), 'true');
  assert.equal(await pop.getAttribute('[data-mode="normal"]', 'aria-checked'), 'true', 'this site: Normal');
  assert.match(await pop.textContent('label:has(#cookies)'), /Handle cookie banners \(reject where possible\)/);
  assert.equal(await pop.locator('#lists input[data-list]').count(), EVERY_LIST.length);
  assert.equal(await pop.isChecked('#cookies'), true, 'Hide cookie banners: on'); assert.equal(await pop.isChecked('#annoyances'), false, 'Hide annoyances: off');
  assert.equal(await pop.isChecked('#lists input[data-group="cookies"]'), true, 'the same switch under Advanced');
  await pop.click('label:has(#annoyances)');
  await until(async () => (await sw.evaluate(async () => (await chrome.storage.local.get('annoyances')).annoyances)) === true, 3000, 'annoyances switch from the popup');
  assert.equal(await pop.isChecked('#lists input[data-group="annoyances"]'), true, 'Advanced follows');
  await pop.click('label:has(#annoyances)');
  await until(async () => (await sw.evaluate(async () => (await chrome.storage.local.get('annoyances')).annoyances)) === false, 3000, 'and off again');
  await pop.setViewportSize({ width: 320, height: 640 });
  await pop.screenshot({ path: path.join(os.tmpdir(), 'shield-popup.png'), fullPage: true });
  seen.length = 0;
  await pop.click('#report');
  await pop.waitForTimeout(300);
  const note = await pop.textContent('#reportNote');
  assert.ok(note.length > 0, 'report note shown');
  {
    const clip = await pop.evaluate(() => window.shieldReport);
    console.log('     clipboard: ' + note);
    assert.match(clip, /Page: http:\/\/other\.test\/page\n/); assert.doesNotMatch(clip, /secret/, 'no query string in the report');
    console.log('     report:\n       ' + clip.split('\n').join('\n       '));
  }
  assert.equal(seen.length, 0, 'the report sent nothing');
  await pop.click('[data-level="complete"]');
  await until(async () => (await sw.evaluate(async () => (await chrome.storage.local.get('level')).level)) === 'complete', 3000, 'level from the popup');
  await pop.click('[data-level="optimal"]');
  await pop.close(); await p.close();
});

await ctx.close(); server.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
