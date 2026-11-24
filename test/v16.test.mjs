// Hallow Shield 1.6: the Hallow family bridge, the extension's side - what is sent (only counts, never addresses), the
// browser's name, the fixed extension ID from the manifest key, and that the bridge's C# side agrees on the names.
//   node --test test/v16.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { familyReport, browserName, newProfileId, FAMILY_HOST, FAMILY_KEYS } from '../extension/family.js';
import { emptyStats, addBlock, addClick, dayOf } from '../extension/stats.js';

const read = p => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const mf = JSON.parse(read('../extension/manifest.json'));
const NOW = new Date(2026, 10, 21, 15, 0, 0).getTime();
const DAY = 86400000;

function sampleStats() {
  const st = emptyStats();
  addBlock(st, { t: NOW - 1000, cat: 'ads', site: 'news.example', domain: 'ads.example' }, 5);
  addBlock(st, { t: NOW - 2000, cat: 'trackers', site: 'shop.example', domain: 'track.example' }, 3);
  addBlock(st, { t: NOW - 3 * DAY, cat: 'other', site: 'old.example' }, 10);
  addBlock(st, { t: NOW - 9 * DAY, cat: 'ads', site: 'older.example' }, 100);   // outside the 7 days
  addClick(st, NOW - 500, 'news.example'); addClick(st, NOW - 400, 'news.example');
  addClick(st, NOW - 2 * DAY, 'x.example');
  return st;
}

test('the report: today, the last 7 days and banners today, with level, version, browser, profile and day', () => {
  const r = familyReport({ stats: sampleStats(), counted: true, level: 'optimal', version: '1.6', browser: 'Edge', profile: 'a1b2c3d4e5f60718', now: NOW });
  assert.deepEqual(r, { blockedToday: 8, blockedWeek: 18, bannersToday: 2, level: 'optimal', version: '1.6', browser: 'Edge', profile: 'a1b2c3d4e5f60718', day: dayOf(NOW) });
  assert.deepEqual(Object.keys(r).sort(), [...FAMILY_KEYS].sort());
});

test('never a URL, a site, a host or history - only numbers and the few fixed fields', () => {
  const r = familyReport({ stats: sampleStats(), counted: true, level: 'complete', version: '1.6', browser: 'Chrome', profile: 'abc', now: NOW });
  const s = JSON.stringify(r);
  for (const bad of ['example', 'http', 'sites', 'domains', 'clickSites', '://']) assert.ok(!s.includes(bad), bad + ' in ' + s);
  for (const k of ['blockedToday', 'blockedWeek', 'bannersToday']) assert.equal(typeof r[k], 'number');
});

test('stats off (no blocked-counts access): null counts, level and version only', () => {
  const r = familyReport({ stats: sampleStats(), counted: false, level: 'basic', version: '1.6', browser: 'Brave', profile: 'abc', now: NOW });
  assert.equal(r.blockedToday, null); assert.equal(r.blockedWeek, null); assert.equal(r.bannersToday, null);
  assert.equal(r.level, 'basic'); assert.equal(r.version, '1.6');
  const n = familyReport({ stats: null, counted: true, level: 'optimal', version: '1.6', browser: 'Chrome', profile: 'abc', now: NOW });
  assert.equal(n.blockedToday, null);
});

test('no stats yet: zeros; odd values cleaned (unknown level -> null, bad profile id -> empty)', () => {
  const r = familyReport({ stats: emptyStats(), counted: true, level: 'evil', version: '1.6', browser: 'Chrome', profile: '../x', now: NOW });
  assert.equal(r.blockedToday, 0); assert.equal(r.blockedWeek, 0); assert.equal(r.bannersToday, 0);
  assert.equal(r.level, null); assert.equal(r.profile, '');
});

test('the browser by name', () => {
  const b = (...brands) => brands.map(brand => ({ brand, version: '130' }));
  assert.equal(browserName({ brands: b('Not?A_Brand', 'Chromium', 'Google Chrome') }), 'Chrome');
  assert.equal(browserName({ brands: b('Chromium', 'Microsoft Edge') }), 'Edge');
  assert.equal(browserName({ brands: b('Chromium', 'Brave') }), 'Brave');
  assert.equal(browserName({ brands: b('Chromium'), brave: true }), 'Brave');
  assert.equal(browserName({ brands: b('Chromium', 'Opera') }), 'Opera');
  assert.equal(browserName({ ua: 'Mozilla/5.0 ... Chrome/130 Safari/537.36 OPR/115' }), 'Opera');
  assert.equal(browserName({ ua: 'Mozilla/5.0 (Windows NT 10.0; rv:140.0) Gecko/20100101 Firefox/140.0' }), 'Firefox');
  assert.equal(browserName({ firefox: true }), 'Firefox');
  assert.equal(browserName({ brands: b('Chromium') }), 'Chromium');
  assert.equal(browserName({}), 'Chrome');
});

test('a profile id is 16 random hex characters', () => {
  const a = newProfileId(), c = newProfileId();
  assert.match(a, /^[0-9a-f]{16}$/); assert.notEqual(a, c);
});

test('the manifest: a fixed key (ID afghaliocnljjjegfnaonfghpjgpebni), nativeMessaging only optional', () => {
  const der = Buffer.from(mf.key, 'base64');
  const id = crypto.createHash('sha256').update(der).digest('hex').slice(0, 32).split('').map(h => String.fromCharCode(97 + parseInt(h, 16))).join('');
  assert.equal(id, 'afghaliocnljjjegfnaonfghpjgpebni');
  assert.ok(mf.optional_permissions.includes('nativeMessaging'));
  assert.ok(!mf.permissions.includes('nativeMessaging'), 'off until you turn it on');
});

test('the bridge (C#) and the extension agree: host name, extension IDs, version', () => {
  const cs = read('../bridge/Bridge.cs');
  assert.equal(FAMILY_HOST, 'com.hallow.shield');
  assert.ok(cs.includes('HostName = "com.hallow.shield"'));
  assert.ok(cs.includes('ChromeId = "afghaliocnljjjegfnaonfghpjgpebni"'));
  assert.ok(cs.includes('FirefoxId = "hallow-shield@dom428.github.io"'));
  assert.ok(read('../tools/package.mjs').includes("id: 'hallow-shield@dom428.github.io'"));
  assert.ok(cs.includes(`Version = "${mf.version}"`), 'the bridge version follows Shield');
});

test('the options page has the switch, off by default, and says what is shared', () => {
  const html = read('../extension/options.html');
  assert.match(html, /id="familyShare"/);
  assert.ok(!/id="familyShare"[^>]*checked/.test(html));
  assert.match(html, /Share counts with Hallow apps on this PC/);
  assert.match(html, /Never an address, a site or your history/);
});

test('the version is the same everywhere (1.6+)', () => {
  const pkg = JSON.parse(read('../package.json'));
  assert.equal(pkg.version, mf.version + '.0'); { const [a, b] = mf.version.split('.').map(Number); assert.ok(a > 1 || b >= 6, mf.version); }
});
