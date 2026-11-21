// Hallow Shield 1.6 end-to-end test: the Hallow family bridge. The real extension in Chromium; "Share counts with Hallow
// apps on this PC" switched on on the options page; a page with an ad (its address carries a marker); then a native
// message has to reach the host, and status.json has to hold the counts - and never the marker, a URL or a site.
//   Windows (CI): the host is the real bridge\HallowShieldBridge.exe (build it first: bridge\build.ps1), registered for
//                 this user under the Chromium / Chrome for Testing keys; status.json goes to a temp folder.
//   Linux (CI):   the host is test/bridge-standin.mjs (records each message as it arrived, answers like the bridge),
//                 found in the profile's NativeMessagingHosts folder.
// Build the sample rules first:  node tools/build.mjs --sample && node test/bridge-e2e.mjs
// Only run where a throwaway Chromium may be registered (CI): it writes HKCU keys on Windows (removed at the end).
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const { chromium } = await import('playwright').catch(() => createRequire(import.meta.url)('playwright'));

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WIN = process.platform === 'win32';
const MARK = 'secret-marker-7f3a';
// a copy of the extension: "nativeMessaging" and the stats access granted up front (a test can't click the browser's
// permission prompt; the options switch still asks for nativeMessaging, which then resolves at once)
const EXT = fs.mkdtempSync(path.join(os.tmpdir(), 'shield-ext-'));
fs.cpSync(path.join(ROOT, 'extension'), EXT, { recursive: true });
const mf = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
mf.permissions.push('declarativeNetRequestFeedback', 'nativeMessaging');
fs.writeFileSync(path.join(EXT, 'manifest.json'), JSON.stringify(mf));
fs.writeFileSync(path.join(EXT, 'version.json'), JSON.stringify({ name: 'Hallow Shield', version: mf.version, browser: 'chrome', built: new Date().toISOString(), dev: false }));
assert.ok(mf.key, 'the manifest has a fixed key');

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shield-bridge-'));
const statusDir = path.join(work, 'status'), log = path.join(work, 'messages.log'), profile = path.join(work, 'profile');
fs.mkdirSync(profile);
const ID = 'afghaliocnljjjegfnaonfghpjgpebni';
const REG = ['Software\\Chromium', 'Software\\Google\\Chrome for Testing', 'Software\\Google\\Chrome'].map(k => `HKCU\\${k}\\NativeMessagingHosts\\com.hallow.shield`);
let hostManifest;
if (WIN) {
  const exe = path.join(ROOT, 'bridge', 'HallowShieldBridge.exe');
  assert.ok(fs.existsSync(exe), 'build the bridge first (bridge\\build.ps1)');
  hostManifest = path.join(work, 'com.hallow.shield.json');
  fs.writeFileSync(hostManifest, JSON.stringify({ name: 'com.hallow.shield', description: 'test', path: exe, type: 'stdio', allowed_origins: [`chrome-extension://${ID}/`] }));
  for (const k of REG) execFileSync('reg', ['add', k, '/ve', '/d', hostManifest, '/f'], { stdio: 'ignore' });
} else {
  const host = path.join(work, 'host.sh');
  fs.writeFileSync(host, `#!/bin/sh\nexec "${process.execPath}" "${path.join(ROOT, 'test', 'bridge-standin.mjs')}" "$@"\n`); fs.chmodSync(host, 0o755);
  const m = JSON.stringify({ name: 'com.hallow.shield', description: 'test', path: host, type: 'stdio', allowed_origins: [`chrome-extension://${ID}/`] });
  for (const d of [path.join(profile, 'NativeMessagingHosts'), ...(process.env.CI ? ['chromium', 'google-chrome-for-testing', 'google-chrome'].map(b => path.join(os.homedir(), '.config', b, 'NativeMessagingHosts')) : [])]) {
    fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'com.hallow.shield.json'), m);
  }
}

const server = http.createServer((req, res) => {
  const host = (req.headers.host || '').split(':')[0];
  if (host === 'news.test') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<!doctype html><title>t</title><p>news</p><script src="http://ads.example/ad.js?${MARK}"></script><img src="http://ads.example/x.png">`); return; }
  res.writeHead(200, { 'content-type': 'application/javascript' }); res.end('');
});
await new Promise(r => server.listen(0, '127.0.0.1', r));

let passed = 0, failed = 0;
async function step(name, f) { try { await f(); passed++; console.log('ok   ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + (e && e.message)); } }
const until = async (f, ms = 15000, what = 'condition') => { const t0 = Date.now(); for (;;) { if (await f()) return; if (Date.now() - t0 > ms) throw new Error('timed out: ' + what); await new Promise(r => setTimeout(r, 200)); } };

const ctx = await chromium.launchPersistentContext(profile, {
  headless: true, channel: 'chromium',
  env: { ...process.env, HALLOW_SHIELD_STATUS_DIR: statusDir, HALLOW_SHIELD_TEST_LOG: log },
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, `--proxy-server=http://127.0.0.1:${server.address().port}`, '--proxy-bypass-list=<-loopback>'],
});
try {
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
  const statusFile = path.join(statusDir, 'status.json');
  const messages = () => WIN ? [] : (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
  const sent = () => WIN ? fs.existsSync(statusFile) : messages().length > 0;

  await step('the extension ID is the fixed one from the manifest key', async () => {
    assert.equal(new URL(sw.url()).host, ID);
  });

  await step('off by default: nothing is sent', async () => {
    assert.equal((await sw.evaluate(() => chrome.storage.local.get({ family: false }))).family, false);
    await new Promise(r => setTimeout(r, 1500));
    assert.equal(sent(), false);
  });

  // something to count: a page with an ad (and the marker in its addresses)
  const pg = await ctx.newPage();
  await pg.goto(`http://news.test/${MARK}?u=${MARK}`, { waitUntil: 'load' });
  await pg.waitForTimeout(800);
  await pg.close();

  const opt = await ctx.newPage();
  await opt.goto(`chrome-extension://${ID}/options.html#stats`);
  await step('the options switch turns sharing on, and a message reaches the host', async () => {
    const sw2 = opt.locator('#familyShare');
    assert.equal(await sw2.isChecked(), false);
    await opt.locator('label:has(#familyShare)').click();
    await until(async () => (await sw.evaluate(() => chrome.storage.local.get({ family: false }))).family === true, 5000, 'family on');
    await until(async () => sent(), 15000, 'a message at the host');
  });

  await step('the counts arrive (blocked today >= 1), with level, version and browser', async () => {
    await until(async () => {
      const v = WIN ? JSON.parse(fs.readFileSync(statusFile, 'utf8')) : messages().at(-1);
      return (WIN ? v.blockedToday : v.blockedToday) >= 1;
    }, 15000, 'blockedToday >= 1 (the popup / options page asks for fresh stats)').catch(async e => {
      // the stats are read from the browser about once a minute; asking for them (as the stats page does) sends again
      await opt.evaluate(() => chrome.runtime.sendMessage({ t: 'family-send' }));
      await until(async () => (WIN ? JSON.parse(fs.readFileSync(statusFile, 'utf8')) : messages().at(-1)).blockedToday >= 1, 10000, 'blockedToday >= 1 after a send');
    });
    if (WIN) {
      const s = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
      assert.equal(s.version, mf.version); assert.ok(Array.isArray(s.browsers) && s.browsers.length === 1, JSON.stringify(s));
      const b = s.browsers[0];
      assert.equal(b.level, 'optimal'); assert.equal(b.version, mf.version); assert.equal(b.profile, 'Default');
      assert.ok(['Chrome', 'Chromium'].includes(b.name), b.name);
      assert.ok(b.blockedToday >= 1 && b.blockedWeek >= b.blockedToday && b.bannersToday === 0, JSON.stringify(b));
      assert.equal(s.blockedToday, b.blockedToday); assert.equal(s.blockedWeek, b.blockedWeek);
    } else {
      const m = messages().at(-1);
      assert.deepEqual(Object.keys(m).sort(), ['bannersToday', 'blockedToday', 'blockedWeek', 'browser', 'day', 'level', 'profile', 'version']);
      assert.equal(m.level, 'optimal'); assert.equal(m.version, mf.version); assert.match(m.profile, /^[0-9a-f]{16}$/);
      assert.ok(m.blockedWeek >= m.blockedToday && m.bannersToday === 0, JSON.stringify(m));
    }
  });

  await step('no URLs, sites or the marker in anything sent or written', async () => {
    const all = (WIN ? fs.readFileSync(statusFile, 'utf8') : fs.readFileSync(log, 'utf8'));
    for (const bad of [MARK, 'http', 'news.test', 'ads.example', '://']) assert.ok(!all.includes(bad), 'found ' + bad + ' in ' + all);
    if (WIN) assert.deepEqual(fs.readdirSync(statusDir), ['status.json']);
  });

  await step('opening the popup sends too', async () => {
    const before = WIN ? fs.statSync(statusFile).mtimeMs : messages().length;
    await new Promise(r => setTimeout(r, 1100));
    const p = await ctx.newPage(); await p.goto(`chrome-extension://${ID}/popup.html`);
    await until(async () => WIN ? fs.statSync(statusFile).mtimeMs > before : messages().length > before, 8000, 'a send on popup open');
    await p.close();
  });

  await step('switched off: the setting is off and nothing more is sent', async () => {
    await opt.reload(); await opt.locator('label:has(#familyShare)').click();
    await until(async () => (await sw.evaluate(() => chrome.storage.local.get({ family: true }))).family === false, 5000, 'family off');
    const before = WIN ? fs.statSync(statusFile).mtimeMs : messages().length;
    await opt.evaluate(() => chrome.runtime.sendMessage({ t: 'family-send' }));
    await new Promise(r => setTimeout(r, 2000));
    assert.equal(WIN ? fs.statSync(statusFile).mtimeMs : messages().length, before);
    assert.equal(await opt.locator('#familyShare').isChecked(), false);
  });
} finally {
  await ctx.close(); server.close();
  if (WIN) for (const k of REG) try { execFileSync('reg', ['delete', k, '/f'], { stdio: 'ignore' }); } catch { }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
