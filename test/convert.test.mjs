// Hallow Shield converter, scriptlet and helper tests (node --test). The sample lists are written for these tests,
// not copied from EasyList or uBlock filters.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { networkRule, cosmeticRule, convertList, validRule, preprocess, badfilters, filterKey, compileProcedural, splitArgs, merge, PRI, REDIRECT_FILES } from '../tools/convert.mjs';
import { SCRIPTLETS, bundle } from '../tools/scriptlets.mjs';
import { LISTS, RULESET_IDS } from '../tools/lists.mjs';
import { ruleMatches, decide } from '../tools/match.mjs';
import { hostsFor, cosmeticKeys, siteCosmetics, siteOf, pauseRule, validDomain, wantedRulesets, shardOf, PAUSE_PRIORITY } from '../extension/shared.js';

const read = f => fs.readFileSync(new URL(f, import.meta.url), 'utf8');
const req = (url, initiator = 'https://news.test/', type = 'script') => ({ url, initiator, type });

test('a domain filter blocks everything a page loads from that domain, never the page itself', () => {
  const r = networkRule('||ads.example^').rule;
  assert.equal(r.action.type, 'block'); assert.equal(r.condition.urlFilter, '||ads.example^'); assert.equal(r.priority, PRI.block);
  assert.ok(!r.condition.resourceTypes.includes('main_frame') && r.condition.resourceTypes.includes('script'));
  assert.equal(networkRule('ads.example.com').rule.condition.urlFilter, '||ads.example.com^', 'a bare hostname means ||host^ (uBO)');
});
test('options: types, party, domains, exceptions, document exceptions, uBO aliases', () => {
  const a = networkRule('||t.test/b/*$image,third-party').rule;
  assert.deepEqual(a.condition.resourceTypes, ['image']); assert.equal(a.condition.domainType, 'thirdParty');
  const b = networkRule('||cdn.example/ad-$~image').rule;
  assert.ok(!b.condition.resourceTypes.includes('image') && b.condition.resourceTypes.includes('script'));
  const c = networkRule('||safe.example^$domain=news.test|~blog.news.test').rule;
  assert.deepEqual(c.condition.initiatorDomains, ['news.test']); assert.deepEqual(c.condition.excludedInitiatorDomains, ['blog.news.test']);
  assert.deepEqual(networkRule('||safe.example^$from=news.test').rule.condition.initiatorDomains, ['news.test'], '$from = $domain');
  const d = networkRule('@@||ads.example/allowed.js$script').rule;
  assert.equal(d.action.type, 'allow'); assert.ok(d.priority > PRI.block && d.priority > PRI.redirect);
  const e = networkRule('@@||trusted.example^$document');
  assert.equal(e.rule.action.type, 'allowAllRequests'); assert.deepEqual(e.rule.condition.resourceTypes, ['main_frame', 'sub_frame']); assert.deepEqual(e.elemhide, ['trusted.example']);
  assert.deepEqual(networkRule('||x.example^$xhr,css,frame,3p').rule.condition, { urlFilter: '||x.example^', domainType: 'thirdParty', resourceTypes: ['xmlhttprequest', 'stylesheet', 'sub_frame'] });
  assert.ok(networkRule('@@||x.example^$~document,script').rule.action.type === 'allow', '~document on an exception is not a $document exception');
  assert.deepEqual(networkRule('||x.example/a$method=post|~get').rule.condition.requestMethods, ['post']);
  assert.deepEqual(networkRule('||x.example^$all').rule.condition.resourceTypes.includes('main_frame'), true);
  assert.deepEqual(networkRule('||bad.example^$doc').rule.condition.resourceTypes, ['main_frame']);
  assert.equal(networkRule('||x.example^$_,script').rule.action.type, 'block', 'the no-op option');
});
test('$to and $denyallow become request domains', () => {
  const r = networkRule('*$script,3p,denyallow=fine.example|cdn.example,domain=strict.test').rule;
  assert.deepEqual(r.condition.excludedRequestDomains, ['fine.example', 'cdn.example']); assert.deepEqual(r.condition.initiatorDomains, ['strict.test']);
  assert.equal(r.condition.urlFilter, undefined);
  assert.ok(ruleMatches(r, req('https://other.example/x.js', 'https://strict.test/')) && !ruleMatches(r, req('https://fine.example/x.js', 'https://strict.test/')));
  const t = networkRule('*$image,to=pix.example|~ok.pix.example').rule;
  assert.deepEqual(t.condition.requestDomains, ['pix.example']); assert.deepEqual(t.condition.excludedRequestDomains, ['ok.pix.example']);
  assert.equal(networkRule('*$image').skip, 'too broad', 'no address and no site: never everything');
});
test('$important beats exceptions; exceptions beat ordinary blocks and redirects', () => {
  const imp = networkRule('||important.example^$important').rule, ex = networkRule('@@||important.example^').rule, plain = networkRule('||important.example/x.js').rule;
  assert.ok(imp.priority > ex.priority && ex.priority > plain.priority);
  const rules = [imp, ex, plain].map((r, i) => ({ id: i + 1, ...r }));
  assert.equal(decide(rules, req('https://important.example/x.js')).action.type, 'block');
  assert.equal(decide(rules.slice(1), req('https://important.example/x.js')).action.type, 'allow');
  assert.ok(pauseRule('x.test', 1).priority > imp.priority && PAUSE_PRIORITY > PRI.importantRedirect, 'a paused site wins over everything');
});
test('$badfilter cancels the filter it names, in any list', () => {
  assert.equal(filterKey('||a.example^$script,domain=b.test|a.test'), filterKey('||a.example^$domain=a.test|b.test,script,badfilter'));
  const keys = badfilters('||cancelled.example^$badfilter\n||other.example^$script,badfilter');
  assert.ok(keys.has('||cancelled.example^') && keys.has('||other.example^$script'));
  const { rules, stats } = convertList('||cancelled.example^\n||kept.example^\n||other.example^$image', { bad: keys });
  assert.equal(stats.badfiltered, 1); assert.equal(rules.length, 2);
  assert.ok(networkRule('||x^$badfilter').badfilter);
});
test('regex filters: RE2-compatible ones become regexFilter, the rest are skipped, the budget is respected', () => {
  const r = networkRule('/^https?:\\/\\/regex\\.example\\/banner\\d+\\.png/$image').rule;
  assert.equal(r.condition.regexFilter, '^https?:\\/\\/regex\\.example\\/banner\\d+\\.png'); assert.deepEqual(r.condition.resourceTypes, ['image']);
  assert.ok(ruleMatches(r, req('http://regex.example/banner12.png', 'https://news.test/', 'image')));
  assert.equal(networkRule('/loader.min.js$xhr,script,domain=a.test,replace=/x\\)/y/').skip, 'option replace', 'starts and ends with / but is not a regex filter');
  assert.equal(networkRule('/ads/banner.js$script,domain=a.test').rule.condition.urlFilter, '/ads/banner.js');
  assert.equal(networkRule('/^https:\\/\\/x\\.example\\/$/').rule.condition.regexFilter, '^https:\\/\\/x\\.example\\/$', 'a regex ending in $');
  assert.equal(networkRule('/x\\.example\\/ad$/$script').rule.condition.regexFilter, 'x\\.example\\/ad$');
  assert.equal(networkRule('/ad(?=s)/').skip, 'regex unsupported', 'look-ahead');
  assert.equal(networkRule('/(a)\\1/').skip, 'regex unsupported', 'back-reference');
  const many = Array.from({ length: 5 }, (_, i) => `/^https:\\/\\/r${i}\\.example\\//`).join('\n');
  const { stats } = convertList(many, { maxRegex: 3 });
  assert.equal(stats.regex, 3); assert.equal(stats.skipped['regex over budget'], 2);
});
test('$redirect / $redirect-rule go to Shield\'s own stand-ins', () => {
  const r = networkRule('||redirect.example/gpt.js$script,redirect=googletagservices_gpt.js').rule;
  assert.deepEqual(r.action, { type: 'redirect', redirect: { extensionPath: '/web/googletagservices_gpt.js' } }); assert.equal(r.priority, PRI.redirect);
  assert.equal(networkRule('||r.example/p.gif$image,redirect=1x1.gif:5').rule.action.redirect.extensionPath, '/web/1x1.gif', 'priority suffix');
  assert.equal(networkRule('||r.example/a.js$script,redirect-rule=noopjs').rule.action.redirect.extensionPath, '/web/noop.js');
  assert.equal(networkRule('*$script,redirect-rule=noopjs,domain=x.test').skip, 'redirect-rule broad', 'no blanket redirects');
  assert.equal(networkRule('||r.example/a.mp4$media,redirect=noopmp4-1s').skip, 'redirect noopmp4-1s');
  for (const f of REDIRECT_FILES) assert.ok(fs.existsSync(new URL('../extension/web/' + f, import.meta.url)), 'stand-in exists: ' + f);
  const rules = [networkRule('||redirect.example^').rule, r].map((x, i) => ({ id: i + 1, ...x }));
  assert.equal(decide(rules, req('https://redirect.example/gpt.js')).action.type, 'redirect', 'the redirect wins over the plain block');
});
test('$removeparam strips tracking parameters (one rule per condition), $csp adds a header, $inline-script too', () => {
  const { rules } = convertList('$removeparam=utm_source\n$removeparam=fbclid\n||shop.test^$removeparam=ref');
  const generic = rules.find(r => !r.condition.urlFilter);
  assert.deepEqual(generic.action.redirect.transform.queryTransform.removeParams, ['utm_source', 'fbclid']);
  assert.deepEqual(generic.condition.resourceTypes, ['main_frame', 'sub_frame', 'xmlhttprequest']);
  assert.ok(generic.priority < PRI.block, 'a block still wins over a parameter rule');
  assert.equal(networkRule('$removeparam=/^utm_/').skip, 'removeparam regex');
  assert.deepEqual(networkRule('||x.test^$removeparam').rule.action.redirect.transform, { query: '' });
  const c = networkRule("||csp.test^$csp=script-src 'self'").rule;
  assert.deepEqual(c.action, { type: 'modifyHeaders', responseHeaders: [{ header: 'content-security-policy', operation: 'append', value: "script-src 'self'" }] });
  assert.deepEqual(c.condition.resourceTypes, ['main_frame', 'sub_frame']);
  assert.match(networkRule('||x.test^$inline-script').rule.action.responseHeaders[0].value, /script-src/);
  assert.equal(networkRule('@@||x.test^$csp').skip, 'csp exception');
});
test('$popup: whole ad hosts opened from another site (strict ruleset); the rest skipped', () => {
  const p = networkRule('||popunder.example^$popup');
  assert.equal(p.kind, 'popup'); assert.deepEqual(p.rule.condition, { urlFilter: '||popunder.example^', domainType: 'thirdParty', resourceTypes: ['main_frame'] });
  assert.equal(networkRule('/popup/*$popup').skip, 'popup not a host');
  assert.equal(networkRule('||x.example^$script,popup').kind, 'block', 'the other types still apply');
  const { rules, popups } = convertList('||popunder.example^$popup\n||ads.example^');
  assert.equal(popups.length, 1); assert.equal(rules.length, 1);
});
test('cosmetic exceptions in network filters: $generichide, $elemhide, $specifichide', () => {
  assert.deepEqual(networkRule('@@||plain.test^$generichide').cosmeticException, { type: 'generichide', domains: ['plain.test'] });
  assert.deepEqual(networkRule('@@$ghide,domain=a.test|b.test').cosmeticException, { type: 'generichide', domains: ['a.test', 'b.test'] });
  assert.equal(networkRule('@@||x.test^$ehide').cosmeticException.type, 'elemhide');
  assert.equal(networkRule('||x.test^$generichide').skip, 'option generichide');
  assert.equal(networkRule('||x.test^$header=via:1.1 google').skip, 'option header');
});
test('what can\'t be expressed is skipped, not half-converted', () => {
  assert.equal(networkRule('||wild.example^$domain=news.*').skip, 'domain wildcard');
  assert.equal(networkRule('ad').skip, 'too broad');
  assert.equal(networkRule('||x.test^$webrtc').skip, 'webrtc');
  assert.equal(networkRule('||x.test^$replace=/a/b/').skip, 'option replace');
});
test('host filters with the same options share one rule (requestDomains), subdomains of a listed domain are dropped', () => {
  const out = merge(['||a.example^', '||b.example^', '||x.b.example^', '||c.example^$script', '||d.example/path'].map(l => networkRule(l).rule));
  const shared = out.find(r => r.condition.requestDomains);
  assert.deepEqual(shared.condition.requestDomains, ['a.example', 'b.example']);
  assert.equal(out.length, 3);
  assert.ok(out.some(r => r.condition.urlFilter === '||c.example^'), 'a group of one keeps its urlFilter');
  const big = merge(Array.from({ length: 2500 }, (_, i) => networkRule(`||h${i}.example^`).rule));
  assert.equal(big.length, 3); assert.ok(big.every(r => r.condition.requestDomains.length <= 1000));
  assert.ok(ruleMatches({ action: { type: 'block' }, ...shared }, req('https://sub.a.example/x.js')));
});
test('the gpt.js case from the real EasyList: kept even when the list is far bigger than the budget', () => {
  const filler = Array.from({ length: 40000 }, (_, i) => `||filler${i}.example^`).join('\n');
  const list = `/gpt.js$script\n${filler}\n||g.doubleclick.net^\n@@||g.doubleclick.net/tag/js/gpt.js$script,domain=allowed.test`;
  const { rules, stats } = convertList(list, { maxRules: 20000 });
  assert.equal(stats.dropped, 0);
  const ided = rules.map((r, i) => ({ id: i + 1, ...r }));
  assert.equal(decide(ided, req('http://securepubads.g.doubleclick.net/tag/js/gpt.js', 'http://news.example.org/page')).action.type, 'block');
  assert.equal(decide(ided, req('http://securepubads.g.doubleclick.net/tag/js/gpt.js', 'https://allowed.test/')).action.type, 'allow', 'the exception stays limited to its site');
});
test('cosmetic: generic, per site, exceptions, entities, specific-generic, :style, procedural, scriptlets', () => {
  assert.deepEqual(cosmeticRule('##.ad-banner'), { kind: 'hide', inc: [], exc: [], exception: false, selector: '.ad-banner' });
  assert.deepEqual(cosmeticRule('news.test##.sponsored').inc, ['news.test']);
  assert.equal(cosmeticRule('news.test#@#.ad-banner').exception, true);
  assert.deepEqual(cosmeticRule('google.*,~mail.google.com##.ad').inc, ['google.*']);
  assert.deepEqual(cosmeticRule('*##.everywhere').inc, []);
  assert.deepEqual(cosmeticRule('x.test##.hl:style(color: red)'), { kind: 'style', inc: ['x.test'], exc: [], exception: false, selector: '.hl', style: 'color: red' });
  assert.equal(cosmeticRule('x.test##.a:style(background: url(http://x))').skip, 'style unsafe');
  assert.equal(cosmeticRule('x.test##div:has(> .ad)').kind, 'hide', 'plain :has() is native CSS');
  assert.equal(cosmeticRule('example.org#?#.box:-abp-has(.ad)').kind, 'hide', ':-abp-has is :has');
  assert.equal(cosmeticRule('x.test##^script:has-text(ad)').skip, 'html filter');
  assert.equal(cosmeticRule('x.test#$#.a { color: red }').skip, 'adguard css');
  assert.equal(cosmeticRule('||x.test/#foo##bar'), null, 'a network filter with # is not cosmetic');
  const p = cosmeticRule('weird.example##.a:has-text(Ad)');
  assert.equal(p.kind, 'procedural'); assert.deepEqual(p.prog, { s: '.a', t: [['text', 'Ad']] });
  const s = cosmeticRule('news.test##+js(set, adsConfig.enabled, false)');
  assert.deepEqual([s.kind, s.canonical, s.args], ['scriptlet', 'set-constant', ['adsConfig.enabled', 'false']]);
  assert.equal(cosmeticRule('example.org##+js(nowebrtc)').canonical, 'nowebrtc'); assert.equal(cosmeticRule('example.org##+js(not-a-scriptlet)').canonical, null);
  assert.equal(cosmeticRule('sub.news.test#@#+js()').exception, true);
});
test('procedural selectors compile into small programs', () => {
  assert.deepEqual(compileProcedural('.label:has-text(Promoted):upward(2)'), { s: '.label', t: [['text', 'Promoted'], ['up', 2]] });
  assert.deepEqual(compileProcedural('div.card:has(> .tag:has-text(Ad))'), { s: 'div.card', t: [['has', { s: '> .tag', t: [['text', 'Ad']] }]] });
  assert.deepEqual(compileProcedural('.junk:remove()'), { s: '.junk', t: [], a: ['remove'] });
  assert.deepEqual(compileProcedural('.side:matches-css(position: absolute)'), { s: '.side', t: [['css', null, 'position', 'absolute']] });
  assert.deepEqual(compileProcedural('.x:matches-css-before(content: /Ad/)').t[0], ['css', '::before', 'content', '/Ad/']);
  assert.deepEqual(compileProcedural(':xpath(//div[@data-kind="advert"])'), { s: '', t: [['xpath', '//div[@data-kind="advert"]']] });
  assert.deepEqual(compileProcedural('.post:has-text(/spon(so)red/i) > .body'), { s: '.post', t: [['text', '/spon(so)red/i'], ['spath', ' > .body']] });
  assert.deepEqual(compileProcedural('.a:not(:has-text(keep))'), { s: '.a', t: [['not', { s: '', t: [['text', 'keep']] }]] });
  assert.deepEqual(compileProcedural('.a:upward(.wrap):remove-attr(onclick)'), { s: '.a', t: [['up', '.wrap']], a: ['ra', 'onclick'] });
  assert.equal(compileProcedural('.a:others()').skip, 'procedural others');
  assert.equal(compileProcedural('.a:remove() .b').skip, 'procedural action not last');
  assert.equal(compileProcedural(':has-text(x)').skip, 'procedural no base');
});
test('scriptlet arguments: commas, escapes, quotes', () => {
  assert.deepEqual(splitArgs('set, a.b, false'), ['set', 'a.b', 'false']);
  assert.deepEqual(splitArgs('nostif, a\\, b, 100'), ['nostif', 'a, b', '100']);
  assert.deepEqual(splitArgs(`trusted-replace-fetch-response, '"a", "b"', '', /player/`), ['trusted-replace-fetch-response', '"a", "b"', '', '/player/']);
  assert.deepEqual(splitArgs('json-prune-fetch-response, a b, , propsToMatch, /p?'), ['json-prune-fetch-response', 'a b', '', 'propsToMatch', '/p?']);
  assert.deepEqual(splitArgs('x, /"a":"[^"]*"/, "a":"", /p/'), ['x', '/"a":"[^"]*"/', '"a":""', '/p/'], 'a quote only counts when it wraps the whole argument');
  assert.deepEqual(splitArgs('x, a,'), ['x', 'a', '']);
});
test('the !#if preprocessor answers like uBO Lite on Chromium MV3', () => {
  const env = { env_mv3: true, ext_ublock: true, env_chromium: true };
  assert.equal(preprocess('a\n!#if env_mv3\nb\n!#else\nc\n!#endif\nd', env), 'a\nb\nd');
  assert.equal(preprocess('!#if !env_mv3 || env_firefox\nx\n!#endif\ny', env), 'y');
  assert.equal(preprocess('!#if env_chromium\n!#if cap_html_filtering\nh\n!#endif\nk\n!#endif', env), 'k');
  assert.equal(preprocess('!#if (ext_ublock && !env_safari)\nz\n!#endif', env), 'z');
});
test('a whole list: ids, exceptions first, every rule valid, budget respected', () => {
  const { rules, cosmetic, stats } = convertList(read('./sample-ads.txt'));
  assert.ok(rules.map((r, i) => ({ id: i + 1, ...r })).every(validRule));
  assert.notEqual(rules[0].action.type, 'block'); assert.notEqual(rules[1].action.type, 'block'); assert.equal(stats.allow, 2);
  assert.deepEqual([...cosmetic.generic].sort(), ['.ad-banner', 'div[id^="sponsor-"]']);
  assert.ok(cosmetic.hide.some(c => c.selector === '.sponsored' && c.inc[0] === 'news.test'));
  assert.ok(cosmetic.hide.some(c => c.selector === '.ad-banner' && c.exception));
  assert.ok(stats.skipped['domain wildcard']);
  const capped = convertList(read('./sample-ads.txt'), { maxRules: 3 });
  assert.equal(capped.rules.length, 3);
  assert.ok(capped.rules.slice(0, 2).every(r => r.action.type !== 'block'), 'exceptions are never the ones dropped');
  const u = convertList(read('./sample-ublock.txt'), { trusted: true });
  assert.ok(u.rules.map((r, i) => ({ id: i + 1, ...r })).every(validRule));
  assert.equal(u.stats.skipped['scriptlet some-unknown-scriptlet'], 1);
  assert.equal(convertList('x.test##+js(trusted-replace-fetch-response, a, b, c)').stats.skipped['trusted scriptlet from untrusted list'], 1);
});
test('the lists, the manifest and the background agree', () => {
  const mf = JSON.parse(read('../extension/manifest.json'));
  assert.deepEqual(mf.declarative_net_request.rule_resources.map(r => r.id), RULESET_IDS);
  for (const r of mf.declarative_net_request.rule_resources) assert.equal(r.path, `rules/${r.id}.json`);
  const bg = read('../extension/background.js');
  assert.match(bg, new RegExp(`const LIST_IDS = ${JSON.stringify(LISTS.map(l => l.id)).replace(/"/g, "'").replace(/[[\]]/g, '\\$&').replace(/,/g, ', ')}`));
  assert.ok(mf.web_accessible_resources[0].resources.includes('web/*'));
});
test('helpers: hosts, entity keys, site cosmetics, sites, pause rule, levels', () => {
  assert.deepEqual(hostsFor('a.b.news.test'), ['a.b.news.test', 'b.news.test', 'news.test']);
  assert.ok(cosmeticKeys('www.google.co.uk').includes('google.*') && cosmeticKeys('google.com').includes('google.*'));
  const entries = [{ h: ['.sponsored', '.gone'], x: ['.gone', '.ad-banner'], s: [['.hl', 'color: red']], p: [['.a:has-text(x)', { s: '.a', t: [['text', 'x']] }]] }];
  const out = siteCosmetics(entries, { isGeneric: s => s === '.ad-banner' });
  assert.match(out.css, /\.sponsored\{display:none!important\}/); assert.doesNotMatch(out.css, /\.gone/);
  assert.match(out.css, /\.ad-banner\{display:revert!important\}/); assert.match(out.css, /\.hl\{color: red!important\}/);
  assert.equal(out.proc.length, 1);
  assert.equal(siteCosmetics([{ h: ['.x'], p: [['.y:has-text(z)', {}]], x: ['.y:has-text(z)'] }]).proc.length, 0, 'procedural exceptions');
  assert.equal(siteCosmetics(entries, { specifichide: true }).css.includes('.sponsored'), false);
  assert.equal(siteOf('https://www.News.test/a?b'), 'news.test'); assert.equal(siteOf('chrome://extensions'), null); assert.equal(siteOf('nonsense'), null);
  assert.deepEqual(pauseRule('news.test', 7).condition, { requestDomains: ['news.test'], resourceTypes: ['main_frame', 'sub_frame'] });
  assert.ok(validDomain('news.test') && !validDomain('localhost') && !validDomain('a b.test'));
  assert.deepEqual(wantedRulesets({ level: 'optimal', lists: { easyprivacy: false } }, ['easylist', 'easyprivacy']), ['easylist']);
  assert.deepEqual(wantedRulesets({ level: 'complete', lists: {} }, ['easylist']), ['easylist', 'popups']);
  assert.ok(shardOf('news.test') >= 0 && shardOf('news.test') < 32 && shardOf('news.test') === shardOf('news.test'));
});

// ---- scriptlets, run in a sandbox that looks enough like a page ----
function page(hostname, extra = {}) {
  const ctx = vm.createContext({ location: { hostname, href: `https://${hostname}/watch`, pathname: '/watch', search: '' }, Response, Headers, Request, URL, console, setTimeout, ...extra });
  ctx.window = ctx;
  return ctx;
}
const run = (ctx, name, args, hosts) => vm.runInContext(bundle(name, { args, hosts, exc: {} }), ctx);
test('every scriptlet bundle is valid JavaScript with no module syntax', () => {
  for (const name of Object.keys(SCRIPTLETS)) { const code = bundle(name, { args: [['x']], hosts: { 'a.test': [0] }, exc: {} }); new vm.Script(code); assert.doesNotMatch(code, /^\s*(import|export)\s/m); }
});
test('set-constant: YouTube-style initial data loses its ad fields, set before or after the page defines it', () => {
  const ctx = page('www.youtube.test');
  run(ctx, 'set-constant', [['ytInitialPlayerResponse.adPlacements', 'undefined'], ['ytInitialPlayerResponse.playerAds', 'undefined'], ['adsConfig.enabled', 'false']], { 'youtube.test': [0, 1, 2] });
  vm.runInContext('var ytInitialPlayerResponse = { videoDetails: { videoId: "abc" }, adPlacements: [1], playerAds: [2] }; window.adsConfig = { enabled: true };', ctx);
  assert.equal(vm.runInContext('ytInitialPlayerResponse.adPlacements', ctx), undefined);
  assert.equal(vm.runInContext('ytInitialPlayerResponse.playerAds', ctx), undefined);
  assert.equal(vm.runInContext('ytInitialPlayerResponse.videoDetails.videoId', ctx), 'abc');
  assert.equal(vm.runInContext('adsConfig.enabled', ctx), false);
  const other = page('other.test'); run(other, 'set-constant', [['x.y', 'false']], { 'youtube.test': [0] });
  vm.runInContext('window.x = { y: true }', other); assert.equal(vm.runInContext('x.y', other), true, 'other sites untouched');
});
test('json-prune: JSON.parse and Response.json lose the named fields; required fields gate it', async () => {
  const ctx = page('m.youtube.test');
  run(ctx, 'json-prune', [['playerResponse.adPlacements adPlacements playerAds'], ['ads.[].x', 'needed']], { 'youtube.test': [0, 1] });
  assert.equal(vm.runInContext('JSON.stringify(JSON.parse(\'{"playerResponse":{"adPlacements":[1],"v":1},"adPlacements":2,"playerAds":3,"k":4}\'))', ctx), '{"playerResponse":{"v":1},"k":4}');
  assert.equal(vm.runInContext('JSON.stringify(JSON.parse(\'{"needed":1,"ads":[{"x":1},{"y":2}]}\'))', ctx), '{"needed":1,"ads":[{},{"y":2}]}');
  assert.equal(vm.runInContext('JSON.stringify(JSON.parse(\'{"ads":[{"x":1}]}\'))', ctx), '{"ads":[{"x":1}]}', 'without "needed" nothing is pruned');
  const j = await vm.runInContext('new Response(\'{"adPlacements":[1],"ok":true}\').json()', ctx);
  assert.deepEqual(JSON.parse(JSON.stringify(j)), { ok: true });
});
test('json-prune-fetch-response, trusted-replace-fetch-response, prevent-fetch: only matching requests change', async () => {
  const body = JSON.stringify({ videoDetails: { videoId: 'abc' }, adPlacements: [1], playerAds: [1], adBreakHeartbeatParams: 'QUQ=' });
  const ctx = page('www.youtube.test', { fetch: async (u) => new Response(String(u).includes('/ads/') ? 'AD' : body, { status: 200 }) });
  run(ctx, 'json-prune-fetch-response', [['playerAds adPlacements adSlots', '', 'propsToMatch', '/youtubei/v1/player']], { 'youtube.test': [0] });
  run(ctx, 'trusted-replace-fetch-response', [['/"adBreakHeartbeatParams":"[^"]*"/', '"adBreakHeartbeatParams":""', '/youtubei/v1/player']], { 'youtube.test': [0] });
  run(ctx, 'prevent-fetch', [['/ads/config']], { 'youtube.test': [0] });
  const a = JSON.parse(await vm.runInContext('fetch("/youtubei/v1/player?key=1", { method: "POST" }).then(r => r.text())', ctx));
  assert.deepEqual(a, { videoDetails: { videoId: 'abc' }, adBreakHeartbeatParams: '' });
  const b = JSON.parse(await vm.runInContext('fetch("/youtubei/v1/browse").then(r => r.text())', ctx));
  assert.ok(b.adPlacements, 'other addresses untouched');
  assert.equal(await vm.runInContext('fetch("/ads/config.json").then(r => r.text())', ctx), '', 'prevent-fetch answers itself');
});
test('timers, events, window.open, abort-on-property-read, storage and cookie scriptlets', async () => {
  const calls = [];
  const ctx = page('news.test', {
    setTimeout: (f, d) => { calls.push([typeof f === 'function' ? f.toString() : f, d]); return 1; },
    setInterval: (f, d) => { calls.push(['interval', d]); return 1; },
    open: () => 'real window', document: { implementation: { createHTMLDocument: () => ({}) } },
    EventTarget: class { addEventListener(t) { calls.push(['listen', t]); } },
  });
  run(ctx, 'prevent-setTimeout', [['adTimer']], { 'news.test': [0] });
  run(ctx, 'adjust-setInterval', [['', '1000', '0.05']], { 'news.test': [0] });
  run(ctx, 'no-window-open-if', [['popunder']], { 'news.test': [0] });
  run(ctx, 'addEventListener-defuser', [['scroll', 'adblock']], { 'news.test': [0] });
  run(ctx, 'abort-on-property-read', [['adBlockDetector']], { 'news.test': [0] });
  vm.runInContext('setTimeout(function adTimer(){ return 1 }, 10); setTimeout(function keep(){ return 2 }, 10); setInterval(function(){}, 1000);', ctx);
  assert.doesNotMatch(calls[0][0], /adTimer/); assert.match(calls[1][0], /keep/); assert.deepEqual(calls[2], ['interval', 50]);
  assert.notEqual(vm.runInContext('open("https://popunder.example/")', ctx), 'real window');
  assert.equal(vm.runInContext('open("https://fine.example/")', ctx), 'real window');
  vm.runInContext('new EventTarget().addEventListener("scroll", function adblockCheck(){}); new EventTarget().addEventListener("scroll", function ok(){})', ctx);
  assert.equal(calls.filter(c => c[0] === 'listen').length, 1);
  assert.throws(() => vm.runInContext('adBlockDetector', ctx));
  const store = new Map();
  const ls = page('news.test', { localStorage: { setItem: (k, v) => store.set(k, v), removeItem: k => store.delete(k) }, document: { cookie: '' } });
  run(ls, 'set-local-storage-item', [['consent', 'true'], ['evil', '<script>']], { 'news.test': [0, 1] });
  assert.equal(store.get('consent'), 'true'); assert.equal(store.has('evil'), false, 'only safe values');
  run(ls, 'set-cookie', [['cookie_ok', 'accept']], { 'news.test': [0] });
  assert.match(ls.document.cookie, /cookie_ok=accept/);
});
