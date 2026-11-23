// Hallow Shield 1.8 unit tests: the new scriptlets (trusted-replace-outbound-text, trusted-suppress-native-method,
// m3u-prune, nobab, popads-dummy / popads.net, refresh-defuser, prevent-canvas, set-cookie-reload and its trusted twin,
// prevent-navigation, prevent-clipboard-write, edit-object-on-setter, fingerprint2) in a sandbox, their names, and the
// page fixes split by site (core.js + a loader per bundle + shards): for every site the split bundles run exactly the
// filters the 1.5 / 1.7 bundles ran. The DOM ones (xml-prune, trusted-create-html, prevent-innerHTML, spoof-css,
// trusted-override-element-method, disable-newtab-links, prevent-dialog, refresh-defuser's real effect) are checked in
// Chromium by test/e2e.mjs on fixture pages.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { SCRIPTLETS, bundle, bundleSites, siteBundle, coreBundle, bloomIndexes, shardOf, SL_RUN } from '../tools/scriptlets.mjs';
import { SCRIPTLET_ALIASES, convertList } from '../tools/convert.mjs';

const mf = JSON.parse(fs.readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
function page(hostname, extra = {}) {
  const ctx = vm.createContext({ location: { hostname, href: `https://${hostname}/p`, pathname: '/p', search: '' }, Response, Headers, Request, URL, console, setTimeout, clearTimeout, atob, btoa, ...extra });
  ctx.window = ctx;
  return ctx;
}
const run = (ctx, name, args, host) => vm.runInContext(bundle(name, { args, hosts: { [host || ctx.location.hostname]: args.map((_, i) => i) }, exc: {} }), ctx);
const NEW = ['trusted-replace-outbound-text', 'trusted-suppress-native-method', 'trusted-create-html', 'xml-prune', 'mpegdash-prune', 'm3u-prune', 'refresh-defuser',
  'nobab', 'popads-dummy', 'popads.net', 'prevent-innerHTML', 'prevent-canvas', 'spoof-css', 'trusted-override-element-method', 'disable-newtab-links', 'set-cookie-reload',
  'trusted-set-cookie-reload', 'prevent-dialog', 'prevent-navigation', 'prevent-clipboard-write', 'fingerprint2', 'edit-object-on-setter', 'trusted-edit-object-on-setter'];

test('1.8: the manifest says 1.8', () => { assert.equal(mf.version, '1.8'); });
test('every new scriptlet has its uBO name, is implemented, and bundles as a classic script; trusted ones only from trusted lists', () => {
  for (const n of NEW) {
    assert.equal(SCRIPTLET_ALIASES[n], n, n); assert.equal(typeof SCRIPTLETS[n], 'function', n);
    new vm.Script(bundle(n, { args: [['x']], hosts: { 'a.test': [0] }, exc: {} }));
  }
  assert.equal(SCRIPTLET_ALIASES['bab-defuser'], 'nobab');
  for (const v of Object.values(SCRIPTLET_ALIASES)) if (v !== 'trusted-click-element') assert.ok(SCRIPTLETS[v], 'alias target implemented: ' + v);
  const r = convertList('a.test##+js(trusted-create-html, body, <p>x</p>)\na.test##+js(xml-prune, VAST > Ad, , /vast)', { trusted: false });
  assert.equal(r.scriptlets.filter(s => !s.unsupported).length, 1, 'trusted-create-html refused from an untrusted list');
});

test('trusted-replace-outbound-text: atob\'s result emptied when it matches the condition; literal = first match; base64 encoding', () => {
  const ctx = page('w.test');
  run(ctx, 'trusted-replace-outbound-text', [['atob', '/.+/', '', 'condition', '/cloudfront\\.net\\/.+\\.js$/'], ['getText', 'ads', 'none'], ['getB64', 'ads on', 'ads off', 'encoding', 'base64']]);
  assert.equal(vm.runInContext('atob(btoa("x.cloudfront.net/a.js"))', ctx), '');
  assert.equal(vm.runInContext('atob(btoa("hello"))', ctx), 'hello', 'the condition says no');
  vm.runInContext('window.getText = () => "ads, more ads"; window.getB64 = () => btoa("ads on");', ctx);
  assert.equal(vm.runInContext('getText()', ctx), 'none, more ads', 'a literal pattern replaces the first match (as uBO)');
  assert.equal(vm.runInContext('atob(getB64())', ctx), 'ads off');
  vm.runInContext('window.num = () => 5;', ctx); run(ctx, 'trusted-replace-outbound-text', [['num', '5', '6']]);
  assert.equal(vm.runInContext('num()', ctx), 5, 'not a text: left alone');
});

test('trusted-suppress-native-method: signature items (quoted, /regex/, object, window, empty), abort / prevent, stack condition', () => {
  const ctx = page('s.test');
  vm.runInContext('window.obj = { m(a, b) { return "called"; }, n(a) { return "n"; }, o(a) { return "o"; }, w(a) { return "w"; } };', ctx);
  run(ctx, 'trusted-suppress-native-method', [['obj.m', '"script"|', 'prevent'], ['obj.n', '{"className":"adsbygoogle"}'], ['obj.o', '/^\\[object Obj\\]$/|"a|b"', 'prevent'], ['obj.w', 'window', 'prevent', 'badCaller']]);
  assert.equal(vm.runInContext('obj.m("script")', ctx), undefined, 'prevented');
  assert.equal(vm.runInContext('obj.m("div", 1)', ctx), 'called');
  assert.throws(() => vm.runInContext('obj.n({ className: "x adsbygoogle" })', ctx), /Shield/, 'abort is the default');
  assert.equal(vm.runInContext('obj.n({ className: "x" })', ctx), 'n');
  assert.equal(vm.runInContext('obj.o({ toString() { return "[object Obj]"; } }, "a|b")', ctx), undefined, 'a | inside quotes is part of the item');
  assert.equal(vm.runInContext('obj.o({ toString() { return "[object Obj]"; } }, "c")', ctx), 'o');
  assert.equal(vm.runInContext('(function badCaller() { return obj.w(window); })()', ctx), undefined, 'stack matches');
  assert.equal(vm.runInContext('(function goodCaller() { return obj.w(window); })()', ctx), 'w', 'stack doesn\'t match');
  assert.equal(vm.runInContext('(function badCaller() { return obj.w(1); })()', ctx), 'w', 'window token');
  vm.runInContext('window.F = function F(x) { this.x = x; };', ctx); run(ctx, 'trusted-suppress-native-method', [['F', '"debugger"']]);
  assert.throws(() => vm.runInContext('new F("debugger")', ctx), /Shield/, 'construct too');
  assert.equal(vm.runInContext('new F("ok").x', ctx), 'ok');
});

const fetchPage = (bodies) => { const ctx = page('www.tv.test', { BODIES: bodies }); vm.runInContext('window.fetch = async u => new Response(BODIES[u] || "", { status: 200 });', ctx); return ctx; };
const get = (ctx, u) => vm.runInContext(`fetch(${JSON.stringify(u)}).then(r => r.text())`, ctx);
const M3U = ['#EXTM3U', '#EXT-X-TARGETDURATION:6', '#EXTINF:6.0,', 'https://cdn.tv.test/seg1.ts', '#EXT-X-DISCONTINUITY', '#EXTINF:6.0,Amazon|ad', '#EXT-X-BYTERANGE:100@0', 'https://ads.tv.test/ad1.ts',
  '#EXTINF:6.0,', 'https://ads.tv.test/dclk_video_ads/ad2.ts', '#EXT-X-DISCONTINUITY', '#EXTINF:6.0,', 'https://cdn.tv.test/seg2.ts', ''].join('\n');
test('m3u-prune: a literal drops the segment (its #EXTINF and address) that names it; a /re/m works on the whole text; other addresses / non-playlists untouched', async () => {
  const ctx = fetchPage({ 'https://cdn.tv.test/a.m3u8': M3U, 'https://cdn.tv.test/b.m3u8': M3U, 'https://cdn.tv.test/c.json': '#EXTM3U? no', 'https://other.test/z.m3u8': M3U });
  run(ctx, 'm3u-prune', [['dclk_video_ads', '/a\\.m3u8/'], ['/#EXT-X-DISCONTINUITY\\n#EXTINF:6\\.0,Amazon[\\s\\S]*?#EXT-X-DISCONTINUITY\\n/m', 'b.m3u8'], ['Amazon|ad', 'a.m3u8']]);
  const a = await get(ctx, 'https://cdn.tv.test/a.m3u8');
  assert.ok(!a.includes('dclk_video_ads') && !a.includes('ad1.ts') && !a.includes('Amazon') && !a.includes('BYTERANGE'), a);
  assert.ok(a.includes('seg1.ts') && a.includes('seg2.ts') && a.startsWith('#EXTM3U'), a);
  assert.equal(a.split('\n').filter(l => l.startsWith('#EXTINF')).length, 2, 'two segments left');
  const b = await get(ctx, 'https://cdn.tv.test/b.m3u8');
  assert.ok(!b.includes('ad1.ts') && !b.includes('ad2.ts') && b.includes('seg1.ts') && b.includes('seg2.ts'), b);
  assert.equal(await get(ctx, 'https://other.test/z.m3u8'), M3U, 'an address no filter names: untouched');
  assert.equal(await get(ctx, 'https://cdn.tv.test/c.json'), '#EXTM3U? no', 'not a playlist for any filter');
});

test('nobab: BlockAdBlock-style code given to eval / setTimeout doesn\'t run; other code does', () => {
  const ctx = page('b.test');
  run(ctx, 'nobab', [[]]);
  vm.runInContext('eval("window.ran1 = 1 /* blockadblock */"); eval("window.ran2 = 2"); setTimeout("window.ran3 = 3; var s = \'babasbmsgx\'", 0);', ctx);
  assert.equal(vm.runInContext('typeof ran1', ctx), 'undefined'); assert.equal(vm.runInContext('ran2', ctx), 2);
});

test('popads-dummy gives dummies; popads.net makes the script fail on its first look', () => {
  const a = page('p.test'); run(a, 'popads-dummy', [[]]);
  assert.equal(vm.runInContext('typeof PopAds + typeof popns', a), 'objectobject');
  vm.runInContext('window.PopAds = 5;', a); assert.equal(vm.runInContext('typeof PopAds', a), 'object', 'the page can\'t replace them');
  const b = page('p.test', { addEventListener() { } }); run(b, 'popads.net', [[]]);
  assert.throws(() => vm.runInContext('PopAds', b), /popads/); assert.throws(() => vm.runInContext('window.popns = {}', b));
});

test('refresh-defuser: the page stops loading before a <meta http-equiv="refresh"> fires (now for 0 s, just before for later ones)', async () => {
  for (const [content, delay, wantSoon] of [['0;url=/away', '', 1], ['3;url=/away', '', 0], ['0;url=/away', '1', 0]]) {
    let stops = 0;
    const ctx = page('r.test', { stop() { stops++; }, document: { readyState: 'complete', querySelector: () => ({ getAttribute: () => content }) } });
    run(ctx, 'refresh-defuser', [[delay]]);
    assert.equal(stops, wantSoon, content + ' / ' + delay);
  }
  let stops = 0;
  const none = page('r.test', { stop() { stops++; }, document: { readyState: 'complete', querySelector: () => null } });
  run(none, 'refresh-defuser', [['']]); assert.equal(stops, 0, 'no meta refresh: nothing');
});

test('prevent-canvas: getContext("2d") gives null, other types work', () => {
  const ctx = page('c.test'); vm.runInContext('class HTMLCanvasElement { getContext(t) { return { t }; } } window.HTMLCanvasElement = HTMLCanvasElement;', ctx);
  run(ctx, 'prevent-canvas', [['2d']]);
  assert.equal(vm.runInContext('new HTMLCanvasElement().getContext("2d")', ctx), null); assert.equal(vm.runInContext('new HTMLCanvasElement().getContext("webgl").t', ctx), 'webgl');
});

function cookiePage() {
  let jar = {}, reloads = 0;
  const document = { get cookie() { return Object.entries(jar).map(([k, v]) => k + '=' + v).join('; '); }, set cookie(s) { const [kv] = s.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i).trim()] = kv.slice(i + 1); } };
  const ctx = page('k.test', { document });
  ctx.location.reload = () => { reloads++; };
  return { ctx, reloads: () => reloads, jar: () => jar };
}
test('set-cookie-reload / trusted-set-cookie-reload: the cookie is set and the page reloaded once - not again when it\'s already set', () => {
  const p = cookiePage(); run(p.ctx, 'set-cookie-reload', [['gdpr', '1']]);
  assert.equal(p.jar().gdpr, '1'); assert.equal(p.reloads(), 1);
  run(p.ctx, 'set-cookie-reload', [['gdpr', '1']]); assert.equal(p.reloads(), 1, 'the next load: already set, no reload');
  run(p.ctx, 'set-cookie-reload', [['evil', 'some-tracking-value']]); assert.equal(p.jar().evil, undefined, 'set-cookie\'s safe values only'); assert.equal(p.reloads(), 1);
  const t = cookiePage(); run(t.ctx, 'trusted-set-cookie-reload', [['cookieConsent', 'onlyNeeded']]);
  assert.equal(t.jar().cookieConsent, 'onlyNeeded'); assert.equal(t.reloads(), 1);
  run(t.ctx, 'trusted-set-cookie-reload', [['cookieConsent', 'onlyNeeded']]); assert.equal(t.reloads(), 1);
});

test('prevent-navigation, prevent-clipboard-write, edit-object-on-setter, fingerprint2', async () => {
  const listeners = [];
  const nav = page('n.test', { navigation: { addEventListener: (t, f) => listeners.push(f) } });
  run(nav, 'prevent-navigation', [['/werbeblocker/i']]);
  const ev = url => { const e = { cancelable: true, destination: { url }, prevented: false, preventDefault() { this.prevented = true; } }; listeners.forEach(f => f(e)); return e.prevented; };
  assert.equal(ev('https://n.test/Werbeblocker.html'), true); assert.equal(ev('https://n.test/article'), false);

  const clip = page('c.test');
  vm.runInContext('window.written = []; class Clipboard { writeText(t) { written.push(t); return Promise.resolve(); } } window.Clipboard = Clipboard; class DataTransfer { setData(k, v) { written.push(v); } } window.DataTransfer = DataTransfer;', clip);
  run(clip, 'prevent-clipboard-write', [['/^powershell /']]);
  await vm.runInContext('new Clipboard().writeText("powershell -w h iex"); new Clipboard().writeText("hello"); new DataTransfer().setData("text/plain", "powershell x"); 0', clip);
  assert.equal(vm.runInContext('JSON.stringify(written)', clip), '["hello"]');

  const eo = page('e.test');
  run(eo, 'edit-object-on-setter', [['flashvars', 'v2:$./^adv_/']]);
  vm.runInContext('window.flashvars = { adv_pre: "x", adv_post: "y", video: "v" };', eo);
  assert.equal(vm.runInContext('JSON.stringify(flashvars)', eo), '{"video":"v"}');
  run(eo, 'edit-object-on-setter', [['initials.cfg', '.advertising']]);
  vm.runInContext('window.initials = {}; initials.cfg = { advertising: { a: 1 }, other: 1 };', eo);
  assert.equal(vm.runInContext('JSON.stringify(initials.cfg)', eo), '{"other":1}', 'a property of a property, set later');

  const fp = page('f.test'); run(fp, 'fingerprint2', [[]]);
  const id = await vm.runInContext('new Promise(r => Fingerprint2.getV18(h => r(h)))', fp);
  assert.match(id, /^[0-9a-f]{32}$/); assert.equal(await vm.runInContext('Fingerprint2.getPromise().then(c => c.length)', fp), 0);
});

// ---- the page fixes split by site: the same filters run as with the 1.5 bundles ----
function fakeDom(files) {
  const listeners = {};
  class CustomEvent { constructor(type, o = {}) { this.type = type; this.detail = o.detail; this.cancelable = !!o.cancelable; this.defaultPrevented = false; } preventDefault() { if (this.cancelable) this.defaultPrevented = true; } }
  const document = {
    readyState: 'loading',
    addEventListener(t, f) { (listeners[t] ||= []).push(f); }, removeEventListener(t, f) { listeners[t] = (listeners[t] || []).filter(x => x !== f); },
    dispatchEvent(e) { for (const f of [...(listeners[e.type] || [])]) f(e); return !e.defaultPrevented; },
  };
  const reads = [];
  class XMLHttpRequest { open(m, u) { this.u = u; } send() { const f = this.u.replace('ext://x/', ''); reads.push(f); if (!(f in files)) { this.status = 404; return; } this.status = 200; this.responseText = files[f]; } }
  return { CustomEvent, document, XMLHttpRequest, chrome: { runtime: { getURL: p => 'ext://x/' + p } }, reads };
}
const PARTS = {
  'set-constant': { args: [['a.x', 'false'], ['b.x', 'true'], ['c.x', '1'], ['d.x', '2']], hosts: { 'news.test': [0, 1], 'sub.news.test': [2], 'google.*': [2], 'only.other.test': [3] }, exc: { 'off.news.test': [-1], 'b.news.test': [1], 'nob.google.de': [2] } },
  'abort-on-property-read': { args: [['detector'], ['tracker']], hosts: { 'news.test': [0], 'sub.news.test': [1] }, exc: { 'b.news.test': [0] } },
};
const HOSTS = ['news.test', 'www.news.test', 'sub.news.test', 'x.sub.news.test', 'off.news.test', 'b.news.test', 'www.google.co.uk', 'google.de', 'nob.google.de', 'other.test', 'only.other.test',
  'notnews.test', 'a.b.c.d.news.test', 'localhost'];
// what a page sees: which constants were set and which properties throw
const probe = ctx => vm.runInContext(`(() => { window.a = { x: 'A' }; window.b = { x: 'B' }; window.c = { x: 'C' }; window.d = { x: 'D' }; const o = { a: a.x, b: b.x, c: c.x, d: d.x };
  for (const k of ['detector', 'tracker']) { try { void window[k]; o[k] = 'read'; } catch (e) { o[k] = 'threw'; } } return JSON.stringify(o); })()`, ctx);
test('split page fixes: for every site the loader + core run exactly what the 1.5 bundle ran (exceptions, parents, entities), in either order', () => {
  const old = bundleSites(PARTS, 'old');
  for (const shardBytes of [6000, 40]) {   // one shard, and many
    const b = siteBundle('tld-test', PARTS, 'test', shardBytes);
    const files = Object.fromEntries(b.shards.map((s, i) => ['rules/sl/tld-test-' + i + '.json', s]));
    const core = coreBundle(Object.keys(PARTS));
    for (const host of HOSTS) {
      const o = page(host); vm.runInContext(old, o);
      const want = probe(o);
      for (const order of ['core-first', 'loader-first']) {
        const dom = fakeDom(files), n = page(host, dom);
        if (order === 'core-first') { vm.runInContext(core, n); vm.runInContext(b.loader, n); } else { vm.runInContext(b.loader, n); vm.runInContext(core, n); }
        assert.equal(probe(n), want, `${host} (${order}, ${b.shards.length} shards)`);
        if (['other.test', 'notnews.test', 'localhost'].includes(host)) assert.equal(dom.reads.length, 0, host + ': not in the Bloom filter, nothing read');
      }
    }
  }
});
test('split page fixes: the Bloom filter knows every site of the bundle; shards hold only their own sites; the core takes only well-formed messages', () => {
  const b = siteBundle('t', PARTS, 'test', 40);
  const m = Number(/shieldLoader\("t", (\d+), (\d+),/.exec(b.loader)[2]), n = b.shards.length;
  const bits = Buffer.from(/, "([A-Za-z0-9+/=]+)", "hallowshield/.exec(b.loader)[1], 'base64');
  const keys = ['news.test', 'sub.news.test', 'google.*', 'only.other.test', 'off.news.test', 'b.news.test', 'nob.google.de'];
  for (const k of keys) {
    assert.ok(bloomIndexes(k, m).every(x => bits[x >> 3] & (1 << (x & 7))), 'in the filter: ' + k);
    assert.ok(JSON.parse(b.shards[shardOf(k, n)]).k[k], 'in its shard: ' + k);
  }
  assert.equal(b.keys, keys.length);
  // a message that isn't one of ours: nothing happens
  const dom = fakeDom({}), ctx = page('news.test', dom);
  vm.runInContext(coreBundle(['set-constant']), ctx);
  vm.runInContext(`document.dispatchEvent(new CustomEvent(${JSON.stringify(SL_RUN)}, { detail: 'not json', cancelable: true }))`, ctx);
  vm.runInContext(`document.dispatchEvent(new CustomEvent(${JSON.stringify(SL_RUN)}, { detail: JSON.stringify({ c: [['no-such', []], ['set-constant', ['z.x', 'true']]] }), cancelable: true }))`, ctx);
  assert.equal(vm.runInContext('window.z = {}; z.x', ctx), true, 'unknown names are skipped, known ones run');
});
test('split page fixes: core.js has each scriptlet\'s code once and no module syntax; a loader is small', () => {
  const core = coreBundle(['set-cookie', 'set-cookie-reload', 'mpegdash-prune', 'xml-prune', 'set-constant']);
  assert.doesNotMatch(core, /^\s*(import|export)\s/m); new vm.Script(core);
  for (const f of ['function setCookie(', 'function xmlPrune(', 'function shieldXmlPruner(', 'function shieldTrap(']) assert.equal(core.split(f).length - 1, 1, f);
  const b = siteBundle('t', PARTS, 'test');
  assert.ok(b.loader.length < 4000, 'loader ' + b.loader.length + ' bytes'); assert.doesNotMatch(b.loader, /function setConstant/);
});
test('split page fixes: the Bloom filter rarely sends a frame to a shard for nothing (< 0.1% per key, .com-sized bundle)', () => {
  const hosts = {}; for (let i = 0; i < 15000; i++) hosts['site' + i + '.com'] = [0];
  const b = siteBundle('big', { 'set-constant': { args: [['a', '1']], hosts, exc: {} } }, 'big');
  const m = /shieldLoader\("big", (\d+), (\d+), "([^"]+)"/.exec(b.loader), M = Number(m[2]), bits = Buffer.from(m[3], 'base64');
  const inBloom = k => bloomIndexes(k, M).every(x => bits[x >> 3] & (1 << (x & 7)));
  assert.ok(Object.keys(hosts).every(inBloom), 'no false negatives');
  let fp = 0; const N = 40000; for (let i = 0; i < N; i++) if (inBloom('other' + i + '.com')) fp++;
  assert.ok(fp / N < 0.001, `false positives ${fp} of ${N}`);
  assert.ok(m[3].length < 45000, 'filter size ' + m[3].length);
});
