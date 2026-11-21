// Hallow Shield 1.5 unit tests: the JSONPath-like edits (uBO's documented syntax subset) and every new scriptlet with
// fixtures - json-edit (JSON.parse, fetch / XHR responses, JSON lines, request bodies), edit-inbound / outbound-object,
// trusted-replace-argument, href-sanitizer, trusted-prevent-dom-bypass - plus the per-site modes "Try fixing this
// site" uses, the badge colours and the per-site cookie-banner count.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { SCRIPTLETS, bundle, bundleSites, JSON_EDIT_SOURCE as jsonEdit } from '../tools/scriptlets.mjs';
import { SCRIPTLET_ALIASES } from '../extension/convert.js';
import { convertList } from '../tools/convert.mjs';
import { siteModeOf, withSiteMode, FIX_STEPS, MODE_KEYS, MODE_LABEL, badgeColor, BADGE_COLORS, genericKey } from '../extension/shared.js';
import { emptyStats, addClick, clicksOn, prune } from '../extension/stats.js';

const edit = (q, obj, trusted = true) => { const e = jsonEdit(q, trusted); if (!e) return null; const changed = e(obj); return { changed, obj }; };

// ---- JSONPath fixtures: [query, input, trusted, expected output, changed] ----
const FIXTURES = [
  // the older uBO style the lists use most (no "$")
  ['.props.pageProps.state.authStore.isAdsFree=true', { props: { pageProps: { state: { authStore: { x: 1 } } } } }, true, { props: { pageProps: { state: { authStore: { x: 1, isAdsFree: true } } } } }, true],
  ['..show_ads=false', { a: { show_ads: true, b: [{ show_ads: 1 }] } }, true, { a: { show_ads: false, b: [{ show_ads: false }] } }, true],
  ['[?.type=="ads"].visibility.status="hidden"', { type: 'ads', visibility: { status: 'v' } }, true, { type: 'ads', visibility: { status: 'hidden' } }, true],
  ['[?.type=="ads"].visibility.status="hidden"', { type: 'news', visibility: { status: 'v' } }, true, { type: 'news', visibility: { status: 'v' } }, false],
  ['.tracks.*[?.metadata.uri^="spotify:ad:"].file_id=1', { tracks: [{ metadata: { uri: 'spotify:ad:1' }, file_id: 9 }, { metadata: { uri: 'spotify:track:2' }, file_id: 9 }] }, true,
    { tracks: [{ metadata: { uri: 'spotify:ad:1' }, file_id: 1 }, { metadata: { uri: 'spotify:track:2' }, file_id: 9 }] }, true],
  ['[?.attestationRequest][?.context.client.userAgent*="adunit"].context.client[?.clientName=="WEB"]+={"clientScreen":"ADUNIT"}',
    { attestationRequest: {}, context: { client: { userAgent: 'x adunit', clientName: 'WEB' } } }, true,
    { attestationRequest: {}, context: { client: { userAgent: 'x adunit', clientName: 'WEB', clientScreen: 'ADUNIT' } } }, true],
  ['..data.viewer..nodes.*[?.__typename=="AdsSideFeedUnit"]', { data: { viewer: { side: { nodes: [{ __typename: 'AdsSideFeedUnit' }, { __typename: 'X' }, { __typename: 'AdsSideFeedUnit' }] } } } }, false,
    { data: { viewer: { side: { nodes: [{ __typename: 'X' }] } } } }, true],
  ['.preroll.ad', { preroll: { ad: 1, k: 2 } }, false, { preroll: { k: 2 } }, true],
  ['.*[?.operationName=="TrackEvent"]', [{ operationName: 'TrackEvent' }, { operationName: 'Q' }], false, [{ operationName: 'Q' }], true],
  ['[?..minimumPlaybackRate==100]..playerConfig.speed+={"min":25}', { a: { minimumPlaybackRate: 100 }, b: { playerConfig: { speed: { x: 1 } } } }, true,
    { a: { minimumPlaybackRate: 100 }, b: { playerConfig: { speed: { x: 1, min: 25 } } } }, true],
  ['.ads={"movie":false}', { ads: { movie: true, x: 1 } }, true, { ads: { movie: false } }, true],
  // RFC 9535 style ("$", "@") and uBO's v2 extensions
  ['$..book[?@.price>10]', { store: { book: [{ price: 5 }, { price: 15 }, { price: 20 }] } }, false, { store: { book: [{ price: 5 }] } }, true],
  ['$..book[?@.price>20].price=0', { store: { book: [{ price: 5 }, { price: 25 }] } }, true, { store: { book: [{ price: 5 }, { price: 0 }] } }, true],
  ['$..book[-1]', { book: [1, 2, 3] }, false, { book: [1, 2] }, true],
  ['$[1]', ['a', 'b', 'c'], false, ['a', 'c'], true],
  ["$.o['j j']", { o: { 'j j': 1, k: 2 } }, false, { o: { k: 2 } }, true],
  ['$.o["a","b"]', { o: { a: 1, b: 2, c: 3 } }, false, { o: { c: 3 } }, true],
  ['$.store.*', { store: { a: 1, b: 2 }, x: 1 }, false, { store: {}, x: 1 }, true],
  ['$.a[?@>3.5]', { a: [1, 4, 5, 2] }, false, { a: [1, 2] }, true],
  ['$..book[?@.author!="Rob"]', { book: [{ author: 'Rob' }, { author: 'Ann' }] }, false, { book: [{ author: 'Rob' }] }, true],
  ['v2:$..book[?@.author=/R/]', { book: [{ author: 'Rob' }, { author: 'ann' }] }, false, { book: [{ author: 'ann' }] }, true],
  ['v2:$..book[?@.author$="b"]', { book: [{ author: 'Rob' }, { author: 'ann' }] }, false, { book: [{ author: 'ann' }] }, true],
  ['v2:$.param_stores.*./^interstitial_/.value.shouldShow=false', { param_stores: { a: { interstitial_x: { value: { shouldShow: true } }, other: { value: { shouldShow: true } } } } }, true,
    { param_stores: { a: { interstitial_x: { value: { shouldShow: false } }, other: { value: { shouldShow: true } } } } }, true],
  ['v2:$..[/^ad/]', { adA: 1, x: { adB: 2, keep: 3 } }, false, { x: { keep: 3 } }, true],
  // sub-queries with quantifiers: the last one runs only if the others match
  ['$.store.bicycle;$..book[?@.price<10]', { store: { bicycle: {}, book: [{ price: 5 }] } }, false, { store: { bicycle: {}, book: [] } }, true],
  ['$.store.bicycle{0};$..book[?@.price<10]', { store: { bicycle: {}, book: [{ price: 5 }] } }, false, { store: { bicycle: {}, book: [{ price: 5 }] } }, false],
  ['$.store.car{0};$..book[?@.price<10]', { store: { book: [{ price: 5 }] } }, false, { store: { book: [] } }, true],
  ['$..x{2,};$.y', { a: { x: 1 }, y: 1 }, false, { a: { x: 1 }, y: 1 }, false],
  // replacing inside strings
  ['.s=repl({"regex":"a+","replacement":"b"})', { s: 'caat' }, true, { s: 'cbt' }, true],
  ['.s=repl({"pattern":"a.","replacement":"-"})', { s: 'xa.ya' }, true, { s: 'x-ya' }, true],
  // nothing matches: nothing changes
  ['.missing.path', { a: 1 }, false, { a: 1 }, false],
];
test('JSONPath edits: the fixture table (uBO\'s older style, RFC style, v2 extensions, sub-queries, repl)', () => {
  for (const [q, input, trusted, want, changed] of FIXTURES) {
    const r = edit(q, structuredClone(input), trusted);
    assert.ok(r, 'compiles: ' + q);
    assert.deepEqual(r.obj, want, q);
    assert.equal(r.changed, changed, 'changed? ' + q);
  }
});
test('JSONPath edits: values can only be changed by trusted lists; calls, broken queries and the root itself are refused', () => {
  assert.equal(jsonEdit('.x=1', false), null, 'untrusted: removal only');
  assert.equal(jsonEdit('.x+={"a":1}', false), null);
  assert.equal(jsonEdit('$.a=call(["${obj}","removeAttribute","${key}"])', true), null, 'call() is not supported');
  assert.equal(jsonEdit('', true), null); assert.equal(jsonEdit('$.a[', false), null); assert.equal(jsonEdit('$.a+=[1]', true), null, '+= needs an object');
  const r = edit('[?.x]', { x: 1 }, false);
  assert.deepEqual([r.changed, r.obj], [false, { x: 1 }], 'the root is never removed');
  const cyc = { a: { ad: 1 } }; cyc.a.self = cyc;
  assert.equal(edit('..ad', cyc, false).changed, true, 'cycles are walked once');
  assert.equal(edit('.x', null, false).changed, false); assert.equal(edit('.x', 'text', false).changed, false);
});

// ---- the scriptlets, in a sandbox that looks enough like a page ----
function page(hostname, extra = {}) {
  const ctx = vm.createContext({ location: { hostname, href: `https://${hostname}/p`, pathname: '/p', search: '' }, Response, Headers, Request, URL, console, setTimeout, clearTimeout, atob, ...extra });
  ctx.window = ctx;
  return ctx;
}
const run = (ctx, name, args, host = 'site.test') => vm.runInContext(bundle(name, { args, hosts: { [host]: args.map((_, i) => i) }, exc: {} }), ctx);
const FAKE_XHR = `
  class XMLHttpRequest {
    open(m, u) { this.url = u; this.readyState = 1; }
    send(body) { this.sent = body; this.readyState = 4; this._text = BODIES[this.url] || ''; }
    get responseText() { return this._text; }
    get response() { return this._text; }
  }
  window.XMLHttpRequest = XMLHttpRequest;`;
const xhrPage = bodies => { const ctx = page('www.site.test', { BODIES: bodies }); vm.runInContext(FAKE_XHR, ctx); return ctx; };

test('every new scriptlet has its uBO name (and trusted- twin), only trusted lists may use the trusted ones', () => {
  for (const n of ['json-edit', 'json-edit-fetch-response', 'json-edit-xhr-response', 'jsonl-edit-xhr-response', 'jsonl-edit-fetch-response', 'json-edit-fetch-request', 'json-edit-xhr-request', 'edit-inbound-object', 'edit-outbound-object']) {
    assert.equal(SCRIPTLET_ALIASES[n], n); assert.ok(SCRIPTLETS[n], n);
    assert.equal(SCRIPTLET_ALIASES['trusted-' + n], 'trusted-' + n); assert.ok(SCRIPTLETS['trusted-' + n], 'trusted-' + n);
  }
  for (const n of ['trusted-replace-argument', 'href-sanitizer', 'trusted-prevent-dom-bypass']) { assert.equal(SCRIPTLET_ALIASES[n], n); assert.ok(SCRIPTLETS[n]); }
  for (const v of Object.values(SCRIPTLET_ALIASES)) if (v !== 'trusted-click-element') assert.ok(SCRIPTLETS[v], 'implemented: ' + v);
  const u = convertList('x.test##+js(trusted-replace-argument, a, 0, 1)\nx.test##+js(trusted-json-edit, .a=1)\nx.test##+js(json-edit, .a)\nx.test##+js(href-sanitizer, a)');
  assert.equal(u.stats.skipped['trusted scriptlet from untrusted list'], 2);
  assert.equal(u.scriptlets.filter(s => !s.unsupported).length, 2, 'json-edit and href-sanitizer are fine in any list');
});

test('json-edit / trusted-json-edit: objects from JSON.parse; "matches" limits it to some texts', () => {
  const ctx = page('www.site.test');
  run(ctx, 'json-edit', [['..adSlots'], ['.big', 'matches', '/^.{30,}/']]);
  run(ctx, 'trusted-json-edit', [['.config.ads=false']]);
  assert.equal(vm.runInContext('JSON.stringify(JSON.parse(\'{"a":{"adSlots":[1]},"config":{"ads":true}}\'))', ctx), '{"a":{},"config":{"ads":false}}');
  assert.equal(vm.runInContext('JSON.stringify(JSON.parse(\'{"big":1}\'))', ctx), '{"big":1}', 'short text: "matches" says no');
  assert.equal(vm.runInContext('JSON.stringify(JSON.parse(\'{"big":1,"padding":"xxxxxxxxxxxxxxxxxx"}\'))', ctx), '{"padding":"xxxxxxxxxxxxxxxxxx"}');
  assert.equal(vm.runInContext('JSON.parse("5")', ctx), 5, 'non-objects pass through');
  const other = page('other.test'); run(other, 'json-edit', [['..adSlots']]);
  assert.equal(vm.runInContext('JSON.stringify(JSON.parse(\'{"adSlots":[1]}\'))', other), '{"adSlots":[1]}', 'other sites untouched');
});

test('json-edit-fetch-response / trusted / jsonl: only matching requests change; propsToMatch positional or named', async () => {
  const bodies = { '/api/feed': '{"items":[1],"adSlots":[2]}', '/api/config': '{"ads":{"enabled":true}}', '/api/lines': '{"t":"ad","x":1}\n{"t":"post","x":2}\n', '/api/other': '{"adSlots":[2]}' };
  const ctx = page('www.site.test', { fetch: async u => new Response(bodies[new URL(String(u), 'https://www.site.test').pathname] || '{}', { status: 200, headers: { 'content-type': 'application/json' } }) });
  run(ctx, 'json-edit-fetch-response', [['..adSlots', 'propsToMatch', '/api/feed']]);
  run(ctx, 'trusted-json-edit-fetch-response', [['.ads.enabled=false', '/api/config']]);
  run(ctx, 'jsonl-edit-fetch-response', [['[?.t=="ad"].x', '', 'propsToMatch', '/api/lines']]);
  const get = p => vm.runInContext(`fetch(${JSON.stringify(p)}).then(r => r.text())`, ctx);
  assert.equal(await get('/api/feed'), '{"items":[1]}');
  assert.equal(await get('/api/config'), '{"ads":{"enabled":false}}');
  assert.equal(await get('/api/lines'), '{"t":"ad"}\n{"t":"post","x":2}\n');
  assert.equal(await get('/api/other'), '{"adSlots":[2]}', 'not matched: untouched');
  const r = await vm.runInContext('fetch("/api/feed")', ctx);
  assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'application/json');
  // the untrusted one can't set values: a filter like that does nothing
  const ctx2 = page('www.site.test', { fetch: async () => new Response('{"ads":true}') });
  run(ctx2, 'json-edit-fetch-response', [['.ads=false']]);
  assert.equal(await vm.runInContext('fetch("/x").then(r => r.text())', ctx2), '{"ads":true}');
});

test('json-edit-xhr-response / trusted / jsonl: response and responseText', () => {
  const ctx = xhrPage({ '/api/list': '{"items":[{"id":1},{"id":2,"sponsored":true}]}', '/api/cfg': '{"ad":true}', '/api/l': '{"ad":1}\n{"ok":1}', '/x': '{"ad":true}' });
  run(ctx, 'json-edit-xhr-response', [['$.items[?@.sponsored==true]', 'propsToMatch', '/api/list']]);
  run(ctx, 'trusted-json-edit-xhr-response', [['.ad=false', '/api/cfg']]);
  run(ctx, 'jsonl-edit-xhr-response', [['.ad', '/api/l']]);
  const get = u => vm.runInContext(`(() => { const x = new XMLHttpRequest(); x.open('GET', ${JSON.stringify(u)}); x.send(); return x.responseText + ' | ' + x.response; })()`, ctx);
  assert.equal(get('/api/list'), '{"items":[{"id":1}]} | {"items":[{"id":1}]}');
  assert.equal(get('/api/cfg'), '{"ad":false} | {"ad":false}');
  assert.equal(get('/api/l'), '{}\n{"ok":1} | {}\n{"ok":1}');
  assert.equal(get('/x'), '{"ad":true} | {"ad":true}');
});

test('json-edit-fetch-request / xhr-request: the JSON body sent is edited', async () => {
  const sent = [];
  const ctx = xhrPage({});
  ctx.fetch = async (u, init) => { sent.push(init && init.body); return new Response('ok'); };
  run(ctx, 'json-edit-fetch-request', [['.*[?.operationName=="TrackEvent"]', 'propsToMatch', '/v1/api']]);
  run(ctx, 'trusted-json-edit-fetch-request', [['.context.client+={"clientScreen":"ADUNIT"}', '/get_watch']]);
  run(ctx, 'json-edit-xhr-request', [['.tracking', '/collect']]);
  await vm.runInContext('fetch("/v1/api", { method: "POST", body: JSON.stringify([{ operationName: "TrackEvent" }, { operationName: "Search" }]) })', ctx);
  await vm.runInContext('fetch("/get_watch?x", { method: "POST", body: \'{"context":{"client":{"v":1}}}\' })', ctx);
  await vm.runInContext('fetch("/elsewhere", { method: "POST", body: \'[{"operationName":"TrackEvent"}]\' })', ctx);
  assert.deepEqual(sent, ['[{"operationName":"Search"}]', '{"context":{"client":{"v":1,"clientScreen":"ADUNIT"}}}', '[{"operationName":"TrackEvent"}]']);
  assert.equal(vm.runInContext('(() => { const x = new XMLHttpRequest(); x.open("POST", "/collect"); x.send(\'{"tracking":1,"keep":2}\'); return x.sent; })()', ctx), '{"keep":2}');
});

test('edit-inbound-object / edit-outbound-object: an argument (a copy) or the return value is edited', async () => {
  const ctx = page('www.site.test');
  run(ctx, 'trusted-edit-inbound-object', [['JSON.stringify', '0', '[?.attestationRequest].context.client+={"clientScreen":"ADUNIT"}']]);
  vm.runInContext('window.req = { attestationRequest: {}, context: { client: { name: "WEB" } } };', ctx);
  assert.equal(vm.runInContext('JSON.stringify(req)', ctx), '{"attestationRequest":{},"context":{"client":{"name":"WEB","clientScreen":"ADUNIT"}}}');
  assert.equal(vm.runInContext('req.context.client.clientScreen', ctx), undefined, 'the page\'s own object is left as it was');
  assert.equal(vm.runInContext('JSON.stringify({ context: { client: {} } })', ctx), '{"context":{"client":{}}}', 'the filter\'s condition');
  assert.equal(vm.runInContext('JSON.stringify(5)', ctx), '5');
  const o = page('www.site.test');
  vm.runInContext('window.api = { config() { return { ads: [1], ok: true }; }, later() { return Promise.resolve({ ads: [1], ok: 1 }); } }; window.sink = { take(a, b) { return JSON.stringify(b); } };', o);
  run(o, 'edit-outbound-object', [['api.config', '.ads'], ['api.later', '.ads']]);
  run(o, 'edit-inbound-object', [['sink.take', '-1', '.ads']]);
  assert.equal(vm.runInContext('JSON.stringify(api.config())', o), '{"ok":true}');
  assert.deepEqual(JSON.parse(JSON.stringify(await vm.runInContext('api.later()', o))), { ok: 1 });
  assert.equal(vm.runInContext('sink.take(1, { ads: 1, k: 2 })', o), '{"k":2}', 'negative position counts from the end');
  // created later by the page: wrapped when it appears
  const l = page('www.site.test');
  run(l, 'edit-outbound-object', [['lib.load', '.adConfig']]);
  vm.runInContext('window.lib = { load: () => ({ adConfig: 1, v: 2 }) };', l);
  assert.equal(vm.runInContext('JSON.stringify(lib.load())', l), '{"v":2}');
});

test('trusted-replace-argument: values, json:, repl:, "this", negative positions, conditions and constructors', () => {
  const calls = [];
  const ctx = page('www.site.test');
  vm.runInContext(`
    window.log = []; window.document = { querySelector(s) { log.push('qs ' + s); return s; } };
    window.later = function (ms) { log.push('timer ' + ms); };
    window.Watch = class { constructor(cb) { this.cb = cb; } };
    window.useArgs = function (a, b, c) { log.push([a, b, c].join(',')); };
  `, ctx);
  run(ctx, 'trusted-replace-argument', [
    ['document.querySelector', '0', 'json:"#real"', 'condition', '.ad-zone'],
    ['later', '0', '0', 'condition', '/^5000$/'],
    ['Watch', '0', 'noopFunc'],
    ['useArgs', '-1', 'repl:/ads=1/ads=0/'],
    ['String.prototype.includes', 'this', 'json:"subscribed"', 'condition', '/^anon$/'],
  ]);
  vm.runInContext('document.querySelector(".ad-zone"); document.querySelector(".news"); later(5000); later(300); useArgs(1, 2, "x&ads=1"); window.w = new Watch(function evil() { return 1; });', ctx);
  assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(log)', ctx)), ['qs #real', 'qs .news', 'timer 0', 'timer 300', '1,2,x&ads=0']);
  assert.equal(vm.runInContext('w.cb()', ctx), undefined, 'constructor argument replaced');
  assert.equal(vm.runInContext('w instanceof Watch', ctx), true);
  assert.equal(vm.runInContext('"anon".includes("subscribed")', ctx), true, '"this" replaced when the condition matches');
  assert.equal(vm.runInContext('"other".includes("subscribed")', ctx), false);
  assert.equal(calls.length, 0);
  // bad arguments: nothing is wrapped
  const b = page('www.site.test'); vm.runInContext('window.f = function () { return 1; };', b); const before = vm.runInContext('f', b);
  run(b, 'trusted-replace-argument', [['f', 'x', '1'], ['f', '0', 'repl:nope'], ['f', '0', 'json:{bad']]);
  assert.equal(vm.runInContext('f', b), before);
});

// a fake DOM for href-sanitizer: links with attributes, text and a resolved href
function linkPage(links) {
  const ctx = page('www.site.test', { atob });
  ctx.location.href = 'https://www.site.test/p';
  const els = links.map(([id, href, text = '', attrs = {}, cls = '']) => {
    const a = { id, cls, textContent: text, attrs: { href, ...attrs },
      get href() { return new URL(this.attrs.href, 'https://www.site.test/p').href; },
      hasAttribute(n) { return n in this.attrs; }, getAttribute(n) { return n in this.attrs ? this.attrs[n] : null; }, setAttribute(n, v) { this.attrs[n] = String(v); } };
    return a;
  });
  ctx.document = { readyState: 'complete', querySelectorAll: sel => els.filter(e => sel.split(',').some(s => s.trim() === 'a' || s.trim() === '#' + e.id || s.trim() === 'a.' + e.cls)), addEventListener() { } };
  ctx.MutationObserver = class { observe() { } };
  return { ctx, el: id => els.find(e => e.id === id) };
}
test('href-sanitizer: ?param, attributes, the link text, base64, +https, &1, regex - and only http(s) addresses', () => {
  const { ctx, el } = linkPage([
    ['q', '/out?url=https%3A%2F%2Fdest.example%2Fa%3Fid%3D7'],
    ['t', '/go/123', 'https://text.example/page'],
    ['bad', '/go/9', 'javascript:alert(1)'],
    ['attr', '/away.php?to=x', '', { title: 'https://title.example/' }],
    ['b64', '/r?u=aHR0cHM6Ly9iNjQuZXhhbXBsZS9wYWdl'],
    ['https', '/aff?aff_sub3=shop.example/item'],
    ['first', '/jump.php?https%3A%2F%2Ffirst.example%2F'],
    ['re', '/CL0/https%3A%2F%2Fre.example%2Fx/1/abc'],
    ['nested', '/r?url=' + encodeURIComponent('https://mid.example/r?to=' + encodeURIComponent('https://final.example/'))],
    ['none', '/out?nothing=1'],
  ]);
  run(ctx, 'href-sanitizer', [['#q', '?url'], ['#t'], ['#bad'], ['#attr', '[title]'], ['#b64', '?u -base64'], ['#https', '?aff_sub3 +https'], ['#first', '&1'],
    ['#re', '/CL0\\/(.*?)\\/1/ -uricomponent'], ['#nested', '?url ?to'], ['#none', '?url']]);
  assert.equal(el('q').attrs.href, 'https://dest.example/a?id=7');
  assert.equal(el('t').attrs.href, 'https://text.example/page', 'no tokens: the link text');
  assert.equal(el('bad').attrs.href, '/go/9', 'never a javascript: address');
  assert.equal(el('attr').attrs.href, 'https://title.example/');
  assert.equal(el('b64').attrs.href, 'https://b64.example/page');
  assert.equal(el('https').attrs.href, 'https://shop.example/item');
  assert.equal(el('first').attrs.href, 'https://first.example/');
  assert.equal(el('re').attrs.href, 'https://re.example/x');
  assert.equal(el('nested').attrs.href, 'https://final.example/', 'steps one after the other');
  assert.equal(el('none').attrs.href, '/out?nothing=1', 'no destination: left alone');
});

test('trusted-prevent-dom-bypass: blank frames added by the method hand back the page\'s own function (or window)', () => {
  const ctx = page('www.site.test');
  vm.runInContext(`
    window.fetch = function pageFetch() {};
    class Element { constructor() { this.kids = []; } append(...n) { this.kids.push(...n); } appendChild(n) { this.kids.push(n); return n; } querySelectorAll() { return this.kids.filter(k => k instanceof HTMLIFrameElement); } }
    class HTMLIFrameElement extends Element { constructor(href) { super(); this.contentWindow = { location: { href }, fetch: function frameFetch() {} }; } }
    class HTMLFrameElement extends Element {}
    class DocumentFragment { constructor(kids) { this.children = kids; } }
    Object.assign(window, { Element, HTMLIFrameElement, HTMLFrameElement, DocumentFragment });
  `, ctx);
  run(ctx, 'trusted-prevent-dom-bypass', [['Element.prototype.append', 'fetch'], ['Element.prototype.appendChild']]);
  vm.runInContext(`
    const body = new Element();
    window.a = new HTMLIFrameElement('about:blank'); body.append(a);
    window.b = new HTMLIFrameElement('https://other.example/'); body.append(b);
    window.c = new HTMLIFrameElement('about:blank'); body.appendChild(c);
    const wrap = new Element(); window.d = new HTMLIFrameElement('about:blank'); wrap.kids.push(d); body.append(wrap);
  `, ctx);
  assert.equal(vm.runInContext('a.contentWindow.fetch === window.fetch', ctx), true, 'targetProp: the frame\'s fetch is the page\'s');
  assert.equal(vm.runInContext('b.contentWindow.fetch.name', ctx), 'frameFetch', 'a frame of another address is left alone');
  assert.equal(vm.runInContext('c.contentWindow === window', ctx), true, 'no targetProp: the frame\'s window is the page\'s');
  assert.equal(vm.runInContext('d.contentWindow.fetch === window.fetch', ctx), true, 'frames inside the added element too');
  assert.equal(vm.runInContext('new Element().append(1, "x")', ctx), undefined, 'other arguments are fine');
});

// ---- per-site modes for "Try fixing this site", badge colours, cookie banners answered per site ----
test('site modes: No hiding / Blocking only next to Strict / Off; one mode per site; the fix steps and labels', () => {
  const s = { paused: ['off.test'], strict: ['strict.test'], noHide: ['nh.test'], blockOnly: ['bo.test', 'nh2.test'] };
  assert.equal(siteModeOf(s, 'www.nh.test'), 'nohide'); assert.equal(siteModeOf(s, 'bo.test'), 'blockonly'); assert.equal(siteModeOf(s, 'x.test'), 'normal');
  assert.equal(siteModeOf({ paused: ['a.test'], blockOnly: ['a.test'] }, 'a.test'), 'off', 'Off wins');
  assert.deepEqual(withSiteMode(s, 'strict.test', 'nohide'), { paused: ['off.test'], strict: [], noHide: ['nh.test', 'strict.test'], blockOnly: ['bo.test', 'nh2.test'] });
  assert.deepEqual(withSiteMode(s, 'nh.test', 'normal'), { paused: ['off.test'], strict: ['strict.test'], noHide: [], blockOnly: ['bo.test', 'nh2.test'] });
  assert.deepEqual(FIX_STEPS, ['normal', 'nohide', 'blockonly', 'off'], 'mildest first');
  for (const m of [...FIX_STEPS, 'strict']) assert.ok(MODE_LABEL[m], m);
  assert.deepEqual(Object.keys(MODE_KEYS).sort(), ['blockonly', 'nohide', 'off', 'strict']);
});
test('badge colour: follows the level, a site\'s own mode wins on its tabs', () => {
  assert.equal(badgeColor('optimal'), '#f07820'); assert.equal(badgeColor('complete'), '#e0306a'); assert.equal(badgeColor('basic'), '#5b6b85');
  assert.equal(badgeColor('nonsense'), '#f07820', 'unknown level: the default');
  assert.equal(badgeColor('basic', 'strict'), '#c0392b'); assert.equal(badgeColor('complete', 'blockonly'), BADGE_COLORS.blockonly); assert.equal(badgeColor('complete', 'normal'), '#e0306a');
  for (const c of Object.values(BADGE_COLORS)) assert.match(c, /^#[0-9a-f]{6}$/);
});
test('stats: cookie banners answered per site (subdomains counted for the site), last 30 days only', () => {
  const now = new Date(2026, 10, 20, 12).getTime(), st = emptyStats();
  addClick(st, now, 'news.test'); addClick(st, now, 'news.test'); addClick(st, now - 86400000, 'shop.news.test'); addClick(st, now, 'other.test'); addClick(st, now);
  addClick(st, now - 40 * 86400000, 'news.test');
  assert.equal(clicksOn(st, 'news.test', now), 3); assert.equal(clicksOn(st, 'other.test', now), 1); assert.equal(clicksOn(st, 'none.test', now), 0); assert.equal(clicksOn(st, '', now), 0);
  prune(st, now);
  assert.equal(Object.keys(st.days).length, 2, 'older days dropped');
});
test('bundles per top-level domain: the page finds its site (and parent domains, entities) in the table; exceptions apply', () => {
  const parts = {
    'set-constant': { args: [['a.x', 'false'], ['b.x', 'true'], ['c.x', '1']], hosts: { 'news.test': [0, 1], 'sub.news.test': [2], 'google.*': [2] }, exc: { 'off.news.test': [-1], 'b.news.test': [1] } },
    'abort-on-property-read': { args: [['detector']], hosts: { 'news.test': [0] }, exc: { 'b.news.test': [0] } },
  };
  const code = bundleSites(parts, 'test');
  assert.doesNotMatch(code, /^\s*(import|export)\s/m); new vm.Script(code);
  const at = host => { const ctx = page(host); vm.runInContext(code, ctx); return ctx; };
  const n = at('www.news.test');
  const nn = at('news.test'); vm.runInContext('window.a = { x: true };', nn); assert.equal(vm.runInContext('a.x', nn), false);
  vm.runInContext('window.b = { x: false };', n); assert.equal(vm.runInContext('b.x', n), true); assert.throws(() => vm.runInContext('detector', n));
  const s = at('sub.news.test'); vm.runInContext('window.c = { x: 0 }; window.a = { x: true };', s); assert.equal(vm.runInContext('c.x', s), 1, 'its own filter and the parent\'s');
  assert.equal(vm.runInContext('a.x', s), false);
  const off = at('off.news.test'); vm.runInContext('window.a = { x: true };', off); assert.equal(vm.runInContext('a.x', off), true, 'every set-constant off there');
  assert.throws(() => vm.runInContext('detector', off), 'the other scriptlet still runs');
  const bx = at('b.news.test'); vm.runInContext('window.b = { x: false }; window.detector = 1;', bx); assert.equal(vm.runInContext('b.x', bx), false); assert.equal(vm.runInContext('detector', bx), 1, 'one filter off');
  const g = at('www.google.co.uk'); vm.runInContext('window.c = { x: 0 };', g); assert.equal(vm.runInContext('c.x', g), 1, 'entities');
  const o = at('other.test'); vm.runInContext('window.a = { x: true };', o); assert.equal(vm.runInContext('a.x', o), true, 'other sites untouched');
  const bn = at('notnews.test'); vm.runInContext('window.a = { x: true };', bn); assert.equal(vm.runInContext('a.x', bn), true, 'no partial-name matches');
});
test('generic hiding by class / id: the token a selector needs, or none (those stay in generic.css)', () => {
  const cases = { '.ad-box': '.ad-box', '.ad-box > a': '.ad-box', 'div.ad-box': '.ad-box', '#ad': '#ad', '#div-gpt-ad-1 iframe': '#div-gpt-ad-1', '.ad:not(.x)': '.ad', '.ad[data-x]': '.ad',
    '[id^="ad-"]': null, 'a[href*="ads."]': null, '.a, .b': null, 'div': null, ':root .x': null, '.-x': '.-x' };
  for (const [sel, key] of Object.entries(cases)) assert.equal(genericKey(sel), key, sel);
});
test('the version is 1.5 everywhere', async () => {
  const fs = await import('node:fs');
  const mf = JSON.parse(fs.readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(mf.version, '1.5'); assert.equal(pkg.version, '1.5.0');
});
