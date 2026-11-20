// Hallow Shield smoke test with the REAL rules (after `node tools/build.mjs`): Chromium loads every ruleset, a well-known
// ad server (doubleclick.net) and a well-known tracker (google-analytics.com) are blocked, a normal site is not.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const { chromium } = await import('playwright').catch(() => createRequire(import.meta.url)('playwright'));

const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'extension');
const meta = JSON.parse(fs.readFileSync(path.join(EXT, 'rules', 'meta.json'), 'utf8'));
assert.ok(meta.rules.ads > 5000 && meta.rules.privacy > 3000, 'real lists converted: ' + JSON.stringify(meta.rules));
const seen = [];
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://' + req.headers.host); seen.push(u.hostname + u.pathname);
  if (u.pathname === '/page') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(`<!doctype html><body><p>news</p>
    <script src="http://securepubads.g.doubleclick.net/tag/js/gpt.js"></script>
    <script src="http://www.google-analytics.com/analytics.js"></script>
    <script src="http://cdn.example.org/app.js"></script></body>`); }
  res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end('');
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'shield-real-')), {
  headless: true, channel: 'chromium',
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, `--proxy-server=http://127.0.0.1:${server.address().port}`, '--proxy-bypass-list=<-loopback>'],
});
const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
const sets = await sw.evaluate(() => chrome.declarativeNetRequest.getEnabledRulesets());
assert.deepEqual(sets.sort(), ['ads', 'privacy']);
const p = await ctx.newPage(); await p.goto('http://news.example.org/page'); await p.waitForTimeout(800);
assert.ok(seen.includes('cdn.example.org/app.js'), 'a normal script loads');
assert.ok(!seen.some(s => s.includes('doubleclick.net')), 'doubleclick.net blocked');
assert.ok(!seen.some(s => s.includes('google-analytics.com')), 'google-analytics.com blocked');
await ctx.close(); server.close();
console.log('real rules OK:', JSON.stringify(meta.rules), 'lists', JSON.stringify(Object.fromEntries(Object.entries(meta.lists).map(([k, v]) => [k, v.version]))));
