// Hallow Shield end-to-end test: the real extension in Chromium, with the browser's proxy pointed at a local test server
// (so "ads.example" and "news.test" are pages and files served here, on the normal port 80 as far as the browser knows). Checks what the browser really blocks, hides,
// lets through, and that pausing a site works. Build the sample rules first:
//   node tools/build.mjs --ads test/sample-ads.txt --privacy test/sample-privacy.txt && node test/e2e.mjs
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
const seen = [];
const page = (title, body) => `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://' + req.headers.host);   // as a proxy, the request line has the whole address
  const host = u.hostname; seen.push(host + u.pathname);
  if (u.pathname.startsWith('/page')) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(page(host, `
      <p id="content">Real content</p>
      <div class="ad-banner" id="generic">ad box</div>
      <div class="sponsored" id="site">sponsored box</div>
      <div id="sponsor-1">sponsor box</div>
      <script src="${base('ads.example')}/ad.js"></script>
      <script src="${base('ads.example')}/allowed.js"></script>
      <img src="${base('tracker-ads.test')}/banner/x.png">
      <img src="${base('metrics.example')}/p.gif">
      <img src="${base('cdn.example')}/ad-1.png">
      <script src="${base('cdn.example')}/ad-2.js"></script>
      <script src="${base('fine.example')}/lib.js"></script>`));
  }
  res.writeHead(200, { 'Content-Type': u.pathname.endsWith('.js') ? 'text/javascript' : 'image/gif' });
  res.end(u.pathname.endsWith('.js') ? '' : Buffer.from('R0lGODlhAQABAAAAACw=', 'base64'));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const base = h => `http://${h}`;
const got = (h, p) => seen.includes(h + p);

let passed = 0, failed = 0;
async function step(name, f) { try { await f(); passed++; console.log('ok   ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + (e && e.message)); } }

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'shield-'));
const ctx = await chromium.launchPersistentContext(profile, {
  headless: true, channel: 'chromium',
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, `--proxy-server=http://127.0.0.1:${PORT}`, '--proxy-bypass-list=<-loopback>'],
});
let sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
const until = async (f, ms = 8000, what = 'condition') => { const t0 = Date.now(); for (;;) { if (await f()) return; if (Date.now() - t0 > ms) throw new Error('timed out: ' + what); await new Promise(r => setTimeout(r, 100)); } };
await until(async () => (await sw.evaluate(() => chrome.scripting.getRegisteredContentScripts())).length === 1, 10000, 'ad-box CSS registered');

async function visit(host) {
  seen.length = 0;
  const p = await ctx.newPage();
  await p.goto(`${base(host)}/page`, { waitUntil: 'load' });
  await p.waitForTimeout(400);
  return p;
}
const shown = (p, id) => p.evaluate(i => { const e = document.getElementById(i); return !!e && getComputedStyle(e).display !== 'none'; }, id);

await step('ad and tracker requests are blocked by the browser; normal ones and list exceptions go through', async () => {
  const p = await visit('other.test');
  assert.ok(got('other.test', '/page'), 'the page itself loads');
  assert.ok(!got('ads.example', '/ad.js'), 'ads.example blocked');
  assert.ok(got('ads.example', '/allowed.js'), '@@ exception lets allowed.js through');
  assert.ok(!got('tracker-ads.test', '/banner/x.png'), 'third-party banner image blocked');
  assert.ok(!got('metrics.example', '/p.gif'), 'tracker (privacy list) blocked');
  assert.ok(got('cdn.example', '/ad-1.png') && !got('cdn.example', '/ad-2.js'), '$~image: the image passes, the script is blocked');
  assert.ok(got('fine.example', '/lib.js'), 'unrelated script loads');
  assert.ok(await shown(p, 'content'));
  await p.close();
});

await step('ad boxes are hidden: generic everywhere, per-site on its site, and a site exception shows a box again', async () => {
  const o = await visit('other.test');
  assert.equal(await shown(o, 'generic'), false, '##.ad-banner hidden on any site');
  assert.equal(await shown(o, 'sponsor-1'), false, 'attribute selector hidden');
  assert.equal(await shown(o, 'site'), true, '.sponsored only hidden on news.test');
  await o.close();
  const n = await visit('www.news.test');
  await until(() => shown(n, 'site').then(v => !v), 3000, 'news.test##.sponsored applied');
  assert.equal(await shown(n, 'generic'), true, 'news.test#@#.ad-banner keeps it visible there');
  await n.close();
});

await step('a $document exception lets a whole site load everything', async () => {
  const p = await visit('trusted.example');
  assert.ok(got('ads.example', '/ad.js'), 'nothing blocked on trusted.example');
  await p.close();
});

await step('Pause on this site: everything loads and shows there; other sites stay protected; Resume works', async () => {
  await sw.evaluate(() => chrome.storage.local.set({ paused: ['news.test'] }));
  await until(async () => (await sw.evaluate(() => chrome.declarativeNetRequest.getDynamicRules())).length === 1, 5000, 'pause rule');
  await until(async () => ((await sw.evaluate(() => chrome.scripting.getRegisteredContentScripts()))[0]?.excludeMatches || []).length === 2, 5000, 'CSS left out for news.test');
  const n = await visit('news.test');
  assert.ok(got('ads.example', '/ad.js') && got('metrics.example', '/p.gif'), 'paused: requests go through');
  assert.equal(await shown(n, 'generic'), true); assert.equal(await shown(n, 'site'), true);
  await n.close();
  const o = await visit('other.test');
  assert.ok(!got('ads.example', '/ad.js'), 'other sites still blocked');
  await o.close();
  await sw.evaluate(() => chrome.storage.local.set({ paused: [] }));
  await until(async () => (await sw.evaluate(() => chrome.declarativeNetRequest.getDynamicRules())).length === 0, 5000, 'resume');
  const n2 = await visit('news.test');
  assert.ok(!got('ads.example', '/ad.js'), 'resumed: blocked again');
  await n2.close();
});

await step('switches: trackers off lets trackers through but still blocks ads; ad-box hiding off shows boxes', async () => {
  await sw.evaluate(() => chrome.storage.local.set({ privacy: false, hide: false }));
  await until(async () => !(await sw.evaluate(() => chrome.declarativeNetRequest.getEnabledRulesets())).includes('privacy'), 5000, 'privacy off');
  await until(async () => (await sw.evaluate(() => chrome.scripting.getRegisteredContentScripts())).length === 0, 5000, 'css off');
  const p = await visit('other.test');
  assert.ok(got('metrics.example', '/p.gif') && !got('ads.example', '/ad.js'));
  assert.equal(await shown(p, 'generic'), true);
  await p.close();
  await sw.evaluate(() => chrome.storage.local.set({ privacy: true, hide: true }));
});

await step('the popup shows the site and how much was blocked on it', async () => {
  const p = await visit('other.test');
  const id = sw.url().split('/')[2];
  const pop = await ctx.newPage();
  // open the popup as a page for the ad page's tab (the real popup gets that tab from tabs.query)
  const tabId = await sw.evaluate(async () => (await chrome.tabs.query({ url: '*://other.test/*' }))[0].id);
  await pop.goto(`chrome-extension://${id}/popup.html?tab=${tabId}`);
  await pop.waitForTimeout(600);
  assert.equal(await pop.textContent('#site'), 'other.test');
  const n = Number(await pop.textContent('#count'));
  assert.ok(n >= 4, 'blocked count on the page: ' + n);   // ad.js, banner, tracker, ad-2.js (the allowed one isn't counted)
  await pop.setViewportSize({ width: 300, height: 420 });
  await pop.screenshot({ path: path.join(os.tmpdir(), 'shield-popup.png') });
  await pop.close(); await p.close();
});

await ctx.close(); server.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
