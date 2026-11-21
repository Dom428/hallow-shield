// Hallow Shield 1.3 unit tests: the cookie-banner clicker (selector chain, ">>>" shadow roots, extra-match, delay,
// timeout, exact matches only), the stats (per day, top sites / hosts, 30 days, categories), the per-site modes and
// the Strict rules, and the version file the zips carry.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { siteModeOf, withSiteMode, strictRule, STRICT_BASE, USER_BASE, PAUSE_BASE } from '../extension/shared.js';
import { emptyStats, addBlock, addClick, prune, summary, categoryOf, domainOfRule, dayOf, lastDays, SHARED, STATS_DAYS } from '../extension/stats.js';
import { SCRIPTLET_ALIASES } from '../extension/convert.js';

const read = f => fs.readFileSync(new URL(f, import.meta.url), 'utf8');
const sandbox = { setTimeout, clearTimeout, Date };
vm.createContext(sandbox); sandbox.globalThis = sandbox;
vm.runInContext(read('../extension/clicker.js'), sandbox);
const C = sandbox.HallowShieldClicker;

// ---- a fake DOM for the clicker: selectors are looked up in a table; elements record clicks ----
class FakeEl {
  constructor(name, { matches = [], shadow = null } = {}) { this.name = name; this.sels = matches; this.nodeType = 1; this.isConnected = true; this.clicks = 0; this.shadow = shadow; }
  matches(sel) { return this.sels.includes(sel); }
  click() { this.clicks++; log.push(this.name); }
  get openOrClosedShadowRoot() { return this.shadow; }
}
let log = [];
class FakeRoot { constructor(map = {}) { this.map = map; } querySelector(sel) { if (sel.includes('!!')) throw new Error('bad selector'); return this.map[sel] || null; } }
const wait = ms => new Promise(r => setTimeout(r, ms));
const runAndWait = (job, doc, opts = {}) => new Promise(res => { const clicked = []; C.runJob(job, { doc, env: () => ({ cookies: opts.cookies || '', storage: opts.storage || [] }), timeout: opts.timeout ?? 1500, onClick: s => clicked.push(s), onDone: (n, why) => res({ n, why, clicked }) }); });

test('clicker: one selector - clicks exactly that element once, then stops', async () => {
  log = [];
  const reject = new FakeEl('reject', { matches: ['#cmp .reject-all'] }), accept = new FakeEl('accept', { matches: ['#cmp .accept-all'] });
  const r = await runAndWait(['#cmp .reject-all'], new FakeRoot({ '#cmp .reject-all': reject, '#cmp .accept-all': accept }));
  assert.deepEqual([r.n, r.why, r.clicked], [1, 'done', ['#cmp .reject-all']]);
  assert.equal(reject.clicks, 1); assert.equal(accept.clicks, 0);
});

test('clicker: a selector chain is clicked in order, waiting for each element to appear', async () => {
  log = [];
  const map = { '#cmp-settings': new FakeEl('settings', { matches: ['#cmp-settings'] }) }, doc = new FakeRoot(map);
  setTimeout(() => { map['#cmp-panel .necessary-only'] = new FakeEl('necessary', { matches: ['#cmp-panel .necessary-only'] }); }, 300);
  const r = await runAndWait(['#cmp-settings, #cmp-panel .necessary-only', '', '100'], doc);
  assert.equal(r.why, 'done'); assert.deepEqual(log, ['settings', 'necessary']);
});

test('clicker: ">>>" looks inside (closed) shadow roots', async () => {
  log = [];
  const inner = new FakeRoot({ 'button.reject': new FakeEl('shadow-reject', { matches: ['button.reject'] }) });
  const r = await runAndWait(['#cmp-host >>> button.reject'], new FakeRoot({ '#cmp-host': new FakeEl('host', { shadow: inner }) }));
  assert.equal(r.n, 1); assert.deepEqual(log, ['shadow-reject']);
});

test('clicker: only an element that matches the selector itself is clicked; gives up after the timeout', async () => {
  log = [];
  // the lookup returns an element that doesn't match the list's selector (as if the page lied): never clicked
  const liar = new FakeEl('accept', { matches: ['#cmp .accept-all'] });
  const r = await runAndWait(['#cmp .reject-all'], new FakeRoot({ '#cmp .reject-all': liar }), { timeout: 600 });
  assert.equal(r.why, 'timeout'); assert.equal(r.n, 0); assert.equal(liar.clicks, 0);
  // a detached element isn't clicked either
  const gone = new FakeEl('gone', { matches: ['#x'] }); gone.isConnected = false;
  const r2 = await runAndWait(['#x'], new FakeRoot({ '#x': gone }), { timeout: 400 });
  assert.equal(r2.why, 'timeout'); assert.equal(gone.clicks, 0);
  // nothing to find: stops at the timeout
  const t0 = Date.now(); const r3 = await runAndWait(['#nothing'], new FakeRoot(), { timeout: 500 });
  assert.equal(r3.why, 'timeout'); assert.ok(Date.now() - t0 < 1500);
  assert.equal(C.TIMEOUT, 10000);
});

test('clicker: invalid selectors are left out; the delay waits before a single click', async () => {
  const r = await runAndWait(['div!!bad'], new FakeRoot());
  assert.equal(r.why, 'no-selector');
  const el = new FakeEl('late', { matches: ['#late'] });
  const t0 = Date.now(); const r2 = await runAndWait(['#late', '', '300'], new FakeRoot({ '#late': el }));
  assert.equal(r2.n, 1); assert.ok(Date.now() - t0 >= 280, 'waited ' + (Date.now() - t0));
});

test('clicker: extra-match on cookies and localStorage', async () => {
  const p = C.parseExtra('!cookie:consent_given');
  assert.equal(C.extraOk(p, { cookies: 'a=1; b=2' }), true, 'no consent cookie yet: click');
  assert.equal(C.extraOk(p, { cookies: 'a=1; consent_given=1' }), false, 'already answered: no click');
  assert.equal(C.extraOk(C.parseExtra('cookie:/^cmp=v2/'), { cookies: 'cmp=v2x' }), true);
  assert.equal(C.extraOk(C.parseExtra('cookie:/^cmp=v2/'), { cookies: 'cmp=v1' }), false);
  assert.equal(C.extraOk(C.parseExtra('cookie:euconsent=yes'), { cookies: 'euconsent=yes' }), true);
  assert.equal(C.extraOk(C.parseExtra('localStorage:seen'), { storage: [{ key: 'seen', value: '' }] }), true);
  assert.equal(C.extraOk(C.parseExtra('!localStorage:seen'), { storage: [{ key: 'seen', value: '' }] }), false);
  assert.equal(C.parseExtra('').length, 0); assert.equal(C.parseExtra('unknown:x').length, 0, 'unknown kinds ignored');
  const el = new FakeEl('r', { matches: ['#r'] });
  const r = await runAndWait(['#r', '!cookie:consent_given'], new FakeRoot({ '#r': el }), { cookies: 'consent_given=1' });
  assert.equal(r.why, 'extra-match'); assert.equal(el.clicks, 0);
  assert.deepEqual([...C.splitSelectors('a ,b,  c d')], ['a', 'b', 'c d']);
});

test('clicker: trusted-click-element is known to the converter', () => {
  assert.equal(SCRIPTLET_ALIASES['trusted-click-element'], 'trusted-click-element');
});

test('per-site mode: Off is the paused list, Strict its own list, Normal neither; subdomains follow', () => {
  const s = { paused: ['off.test'], strict: ['strict.test'] };
  assert.equal(siteModeOf(s, 'off.test'), 'off'); assert.equal(siteModeOf(s, 'www.off.test'), 'off');
  assert.equal(siteModeOf(s, 'strict.test'), 'strict'); assert.equal(siteModeOf(s, 'a.strict.test'), 'strict');
  assert.equal(siteModeOf(s, 'other.test'), 'normal'); assert.equal(siteModeOf({}, 'x.test'), 'normal');
  const none = { noHide: [], blockOnly: [] };   // 1.5's two extra modes
  assert.deepEqual(withSiteMode(s, 'off.test', 'strict'), { paused: [], strict: ['strict.test', 'off.test'], ...none });
  assert.deepEqual(withSiteMode(s, 'strict.test', 'off'), { paused: ['off.test', 'strict.test'], strict: [], ...none });
  assert.deepEqual(withSiteMode(s, 'strict.test', 'normal'), { paused: ['off.test'], strict: [], ...none });
});

test('Strict rules: limited to the Strict sites; regex / redirect / header rules left out', () => {
  const block = { id: 7, priority: 1, action: { type: 'block' }, condition: { requestDomains: ['chat.example'], resourceTypes: ['script'] } };
  assert.deepEqual(strictRule(block, ['a.test', 'b.test'], STRICT_BASE + 1).condition.initiatorDomains, ['a.test', 'b.test']);
  assert.equal(strictRule(block, ['a.test'], STRICT_BASE + 1).id, STRICT_BASE + 1);
  assert.equal(block.condition.initiatorDomains, undefined, 'the original rule is untouched');
  // a rule for some sites: only where they meet the Strict sites
  const some = { ...block, condition: { ...block.condition, initiatorDomains: ['a.test', 'x.b.test', 'z.test'] } };
  assert.deepEqual(strictRule(some, ['b.test', 'a.test'], 1).condition.initiatorDomains.sort(), ['a.test', 'x.b.test']);
  assert.equal(strictRule(some, ['q.test'], 1), null);
  const exc = { ...block, condition: { ...block.condition, excludedInitiatorDomains: ['a.test'] } };
  assert.deepEqual(strictRule(exc, ['a.test', 'b.test'], 1).condition.initiatorDomains, ['b.test']);
  assert.equal(strictRule({ ...block, condition: { regexFilter: 'x' } }, ['a.test'], 1), null);
  assert.equal(strictRule({ ...block, action: { type: 'redirect', redirect: { extensionPath: '/web/noop.js' } } }, ['a.test'], 1), null);
  assert.equal(strictRule({ ...block, action: { type: 'modifyHeaders' } }, ['a.test'], 1), null);
  assert.equal(strictRule(block, [], 1), null);
  assert.ok(STRICT_BASE > USER_BASE && USER_BASE > PAUSE_BASE);
});

test('stats: blocks per day by kind, top sites and hosts, clicks; 30 days kept', () => {
  const now = new Date(2026, 10, 20, 15, 0, 0).getTime(), day = 86400000;
  const st = emptyStats();
  addBlock(st, { t: now, cat: 'ads', site: 'news.test', domain: 'ads.example' });
  addBlock(st, { t: now, cat: 'ads', site: 'news.test', domain: 'ads.example' });
  addBlock(st, { t: now, cat: 'trackers', site: 'shop.test', domain: SHARED });
  addBlock(st, { t: now - day, cat: 'other', site: 'news.test', domain: 'bad.example' }, 3);
  addBlock(st, { t: now - 40 * day, cat: 'ads', site: 'old.test', domain: 'old.example' }, 99);
  addClick(st, now); addClick(st, now - day);
  prune(st, now);
  assert.equal(Object.keys(st.days).length, 2, 'the day 40 days ago is gone');
  const v = summary(st, now);
  assert.equal(v.days.length, STATS_DAYS); assert.equal(v.days[29].day, dayOf(now)); assert.equal(v.days[28].day, dayOf(now - day));
  assert.deepEqual(v.totals, { ads: 2, trackers: 1, other: 3, clicks: 2, blocked: 6 });
  assert.deepEqual(v.today, { blocked: 3, clicks: 1 });
  assert.deepEqual(v.topSites, [['news.test', 5], ['shop.test', 1]]);
  assert.deepEqual(v.topDomains, [['bad.example', 3], ['ads.example', 2]], 'shared rules aren\'t a host');
  assert.equal(v.shared, 1);
  assert.equal(lastDays(now)[0].day, dayOf(now - 29 * day));
});

test('stats: what counts as a block, and as ads / trackers / other; the host a rule names', () => {
  const meta = { rulesets: { easylist: { allow: 10, modify: 5 }, easyprivacy: { allow: 0, modify: 0 }, 'easylist-cookies': { allow: 0, modify: 0 } } };
  assert.equal(categoryOf({ rulesetId: 'easylist', ruleId: 3 }, meta), null, 'an exception');
  assert.equal(categoryOf({ rulesetId: 'easylist', ruleId: 14 }, meta), null, 'a header / parameter rule');
  assert.equal(categoryOf({ rulesetId: 'easylist', ruleId: 16 }, meta), 'ads');
  assert.equal(categoryOf({ rulesetId: 'easyprivacy', ruleId: 1 }, meta), 'trackers');
  assert.equal(categoryOf({ rulesetId: 'easylist-cookies', ruleId: 1 }, meta), 'other');
  assert.equal(categoryOf({ rulesetId: '_dynamic', ruleId: PAUSE_BASE + 1 }, meta), null, 'a paused site');
  assert.equal(categoryOf({ rulesetId: '_dynamic', ruleId: USER_BASE + 1 }, meta, { user: new Set([USER_BASE + 1]) }), null);
  assert.equal(categoryOf({ rulesetId: '_dynamic', ruleId: USER_BASE + 2 }, meta, { user: new Set() }), 'other');
  assert.equal(categoryOf({ rulesetId: '_dynamic', ruleId: STRICT_BASE + 2 }, meta, { strict: new Set() }), 'other');
  assert.equal(categoryOf({ rulesetId: 'nope', ruleId: 1 }, meta), null);
  assert.equal(domainOfRule({ condition: { urlFilter: '||ads.example^' } }), 'ads.example');
  assert.equal(domainOfRule({ condition: { urlFilter: '||Cdn.Example.com/ads/' } }), 'cdn.example.com');
  assert.equal(domainOfRule({ condition: { requestDomains: ['one.example'] } }), 'one.example');
  assert.equal(domainOfRule({ condition: { requestDomains: ['a.example', 'b.example'] } }), SHARED);
  assert.equal(domainOfRule({ condition: { urlFilter: '/banner/' } }), null);
});

test('the version is the same everywhere, and the zips get a version.json', () => {
  const mf = JSON.parse(read('../extension/manifest.json')), pkg = JSON.parse(read('../package.json'));
  assert.equal(pkg.version, mf.version + '.0');
  assert.ok(mf.permissions.includes('alarms')); assert.ok(!mf.permissions.includes('declarativeNetRequestFeedback'), 'feedback access stays optional');
  assert.deepEqual(mf.optional_permissions, ['declarativeNetRequestFeedback']);
  assert.match(read('../tools/package.mjs'), /version\.json/);
});
