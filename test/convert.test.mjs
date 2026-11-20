// Hallow Shield converter tests (node --test). The sample lists are written for these tests, not copied from EasyList.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { networkRule, cosmeticRule, convertList, validRule, DOMAINS_PER_RULE } from '../tools/convert.mjs';
import { hostsFor, siteCss, siteOf, pauseRule, validDomain } from '../extension/shared.js';

test('a domain filter blocks everything a page loads from that domain, never the page itself', () => {
  const r = networkRule('||ads.example^').rule;
  assert.equal(r.action.type, 'block'); assert.equal(r.condition.urlFilter, '||ads.example^');
  assert.ok(!r.condition.resourceTypes.includes('main_frame') && r.condition.resourceTypes.includes('script'));
});
test('options: types, third-party, domains, exceptions, document exceptions', () => {
  const a = networkRule('||t.test/b/*$image,third-party').rule;
  assert.deepEqual(a.condition.resourceTypes, ['image']); assert.equal(a.condition.domainType, 'thirdParty');
  const b = networkRule('||cdn.example/ad-$~image').rule;
  assert.ok(!b.condition.resourceTypes.includes('image') && b.condition.resourceTypes.includes('script'));
  const c = networkRule('||safe.example^$domain=news.test|~blog.news.test').rule;
  assert.deepEqual(c.condition.initiatorDomains, ['news.test']); assert.deepEqual(c.condition.excludedInitiatorDomains, ['blog.news.test']);
  const d = networkRule('@@||ads.example/allowed.js$script').rule;
  assert.equal(d.action.type, 'allow'); assert.ok(d.priority > 1);
  const e = networkRule('@@||trusted.example^$document').rule;
  assert.equal(e.action.type, 'allowAllRequests'); assert.deepEqual(e.condition.resourceTypes, ['main_frame', 'sub_frame']);
});
test('what Manifest V3 cannot do is skipped, not half-converted', () => {
  assert.equal(networkRule('||popups.example^$popup').skip, 'option popup');
  assert.equal(networkRule('/^https?:\\/\\/regex\\.example\\//').skip, 'regex');
  assert.equal(networkRule('||wild.example^$domain=news.*').skip, 'domain wildcard');
  assert.equal(networkRule('ad').skip, 'too broad');
  assert.equal(networkRule('||ex.test^$csp=script-src none').skip, 'option csp');
  assert.equal(cosmeticRule('example.org#?#.box:-abp-has(.ad)'), null);   // not a ## / #@# filter at all
  assert.equal(cosmeticRule('example.org##+js(nowebrtc)').skip, 'procedural');
  assert.equal(cosmeticRule('weird.example##.a:has-text(Ad)').skip, 'procedural');
});
test('cosmetic: generic, per site, and exceptions', () => {
  assert.deepEqual(cosmeticRule('##.ad-banner'), { exception: false, selector: '.ad-banner', inc: [], exc: [] });
  assert.deepEqual(cosmeticRule('news.test##.sponsored'), { exception: false, selector: '.sponsored', inc: ['news.test'], exc: [] });
  assert.equal(cosmeticRule('news.test#@#.ad-banner').exception, true);
});
test('a whole list: ids, exceptions first, every rule valid, budget respected', () => {
  const { rules, cosmetic, stats } = convertList(fs.readFileSync(new URL('./sample-ads.txt', import.meta.url), 'utf8'));
  assert.ok(rules.every(validRule)); assert.deepEqual(rules.map(r => r.id), rules.map((_, i) => i + 1));
  assert.notEqual(rules[0].action.type, 'block'); assert.notEqual(rules[1].action.type, 'block');
  assert.equal(rules.filter(r => r.action.type === 'block').length, 5);
  assert.deepEqual(cosmetic.generic.sort(), ['.ad-banner', 'div[id^="sponsor-"]']);
  assert.deepEqual(cosmetic.sites, { 'news.test': ['.sponsored'] }); assert.deepEqual(cosmetic.except, { 'news.test': ['.ad-banner'] });
  assert.ok(stats.skipped['option popup'] && stats.skipped.regex && stats.skipped.procedural);
  const capped = convertList(fs.readFileSync(new URL('./sample-ads.txt', import.meta.url), 'utf8'), { maxRules: 3 });
  assert.equal(capped.rules.length, 3); assert.equal(capped.stats.dropped, 4);
  assert.ok(capped.rules.slice(0, 2).every(r => r.action.type !== 'block'), 'exceptions are never the ones dropped');
});
test('helpers: hosts, site CSS, sites, pause rule', () => {
  assert.deepEqual(hostsFor('a.b.news.test'), ['a.b.news.test', 'b.news.test', 'news.test']);
  const css = siteCss({ sites: { 'news.test': ['.sponsored'] }, except: { 'news.test': ['.ad-banner'] } }, 'www.news.test');
  assert.match(css, /\.sponsored\{display:none!important\}/); assert.match(css, /\.ad-banner\{display:revert!important\}/);
  assert.equal(siteCss({ sites: {}, except: {} }, 'other.test'), '');
  assert.equal(siteOf('https://www.News.test/a?b'), 'news.test'); assert.equal(siteOf('chrome://extensions'), null); assert.equal(siteOf('nonsense'), null);
  assert.deepEqual(pauseRule('news.test', 7).condition, { requestDomains: ['news.test'], resourceTypes: ['main_frame', 'sub_frame'] });
  assert.ok(validDomain('news.test') && !validDomain('localhost') && !validDomain('a b.test'));
});

test('plain domain filters with the same options share one rule (lists hold far more domains than Chrome allows rules)', () => {
  const lines = [];
  for (let i = 0; i < 2500; i++) lines.push(`||ad${i}.example^`);
  for (let i = 0; i < 300; i++) lines.push(`||t${i}.example^$third-party`);
  lines.push('||ad7.example^', '||Case.example^$match-case', '||prefix.example', '||ads.example/path^', '@@||ok1.example^', '@@||ok2.example^');
  const { rules, stats } = convertList(lines.join('\n'), { maxRules: 100 });
  assert.ok(rules.every(validRule), 'every rule valid');
  const plain = rules.filter(r => r.action.type === 'block' && r.condition.requestDomains && !r.condition.domainType);
  assert.equal(plain.length, 3); assert.equal(plain.reduce((n, r) => n + r.condition.requestDomains.length, 0), 2500, 'duplicates counted once');
  assert.ok(plain.every(r => r.condition.requestDomains.length <= DOMAINS_PER_RULE));
  const third = rules.find(r => r.condition.domainType === 'thirdParty'); assert.equal(third.condition.requestDomains.length, 300);
  assert.equal(rules.filter(r => r.condition.urlFilter).length, 3, 'case-sensitive, no-^ and path filters stay single rules');
  assert.equal(rules[0].action.type, 'allow'); assert.deepEqual(rules[0].condition.requestDomains, ['ok1.example', 'ok2.example']);
  assert.equal(stats.dropped, 0); assert.equal(stats.domainsMerged, 2802);
});
