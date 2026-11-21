// Hallow Shield 1.2 unit tests: the element picker's selectors (with a small fake DOM), My filters (converted in the
// extension with the build's converter) and the cookie-banner / annoyance groups.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { compileUserFilters, zapLine } from '../extension/userfilters.js';
import { wantedRulesets, groupOn, USER_BASE, USER_MAX, PAUSE_BASE } from '../extension/shared.js';
import { LISTS, GROUPS, DEFAULT_ON, cosmeticGroup } from '../tools/lists.mjs';
import { validRule } from '../tools/convert.mjs';

const read = f => fs.readFileSync(new URL(f, import.meta.url), 'utf8');

// ---- a fake DOM: just enough for the picker (tag, id, class, parent, children) and a matcher for the selectors it makes
class El {
  constructor(tag, { id = '', cls = '' } = {}, kids = []) {
    this.tagName = tag.toUpperCase(); this.id = id; this.className = cls; this.children = []; this.parentElement = null;
    for (const k of kids) this.append(k);
  }
  append(k) { k.parentElement = this; this.children.push(k); return this; }
  getAttribute(n) { return n === 'class' ? this.className : n === 'id' ? this.id : null; }
  get all() { return [this, ...this.children.flatMap(c => c.all)]; }
}
const COMPOUND = /^([a-z0-9]+)?(?:#([\w-]+))?((?:\.[\w-]+)*)(?::nth-of-type\((\d+)\))?$/;
function matchCompound(el, c) {
  const m = c.match(COMPOUND); if (!m) throw new Error('fake DOM cannot parse ' + c);
  const [, tag, id, cls, nth] = m;
  if (tag && el.tagName.toLowerCase() !== tag) return false;
  if (id && el.id !== id) return false;
  const have = el.className.split(/\s+/);
  if (cls && cls.split('.').filter(Boolean).some(x => !have.includes(x))) return false;
  if (nth) { const same = el.parentElement ? el.parentElement.children.filter(x => x.tagName === el.tagName) : [el]; if (same.indexOf(el) + 1 !== Number(nth)) return false; }
  return true;
}
function matches(el, sel) {
  const parts = sel.split(/\s*>\s*/);
  let node = el;
  for (let i = parts.length - 1; i >= 0; i--) {
    if (!node || !matchCompound(node, parts[i])) return false;
    if (i > 0) node = node.parentElement;
  }
  return true;
}
const countIn = root => sel => root.all.filter(e => matches(e, sel)).length;
function loadPicker() {
  const ctx = vm.createContext({});
  vm.runInContext(read('../extension/picker-core.js'), ctx);
  return ctx.HallowShieldSelector;
}

test('picker: a hand-written id wins; generated ids and classes are left out', () => {
  const S = loadPicker();
  const target = new El('div', { id: 'newsletter-popup', cls: 'modal open' });
  const body = new El('body', {}, [new El('div', { cls: 'modal' }), target]);
  const html = new El('html', {}, [body]);
  assert.equal(S.selectorFor(target, countIn(html)), '#newsletter-popup');
  assert.ok(S.looksGenerated('css-1x2y3z9') && S.looksGenerated('sc-a8f3c9d21') && S.looksGenerated('jsx-123456') && S.looksGenerated('aBc12dEf9'));
  assert.ok(!S.looksGenerated('newsletter-box') && !S.looksGenerated('chat-bubble') && !S.looksGenerated('col-2'));
  const gen = new El('div', { id: 'id-83749201', cls: 'css-9f8e7d6c banner' });
  const html2 = new El('html', {}, [new El('body', {}, [gen, new El('div', { cls: 'other' })])]);
  assert.equal(S.selectorFor(gen, countIn(html2)), 'div.banner', 'the generated id and class are skipped');
});
test('picker: classes, then parents with ">", then :nth-of-type until only the element matches', () => {
  const S = loadPicker();
  const a = new El('div', { cls: 'chat-bubble' });
  const html = new El('html', {}, [new El('body', {}, [new El('main', {}, [new El('p')]), a])]);
  assert.equal(S.selectorFor(a, countIn(html)), 'div.chat-bubble');
  // two alike cards in different sections: the parent tells them apart
  const ad = new El('div', { cls: 'card' }), news = new El('div', { cls: 'card' });
  const html2 = new El('html', {}, [new El('body', {}, [new El('aside', { cls: 'sidebar' }, [ad]), new El('section', { cls: 'feed' }, [news])])]);
  const sel = S.selectorFor(ad, countIn(html2));
  assert.equal(sel, 'aside.sidebar > div.card');
  assert.equal(countIn(html2)(sel), 1);
  // siblings that look alike: :nth-of-type
  const li = [new El('li', { cls: 'item' }), new El('li', { cls: 'item' }), new El('li', { cls: 'item' })];
  const html3 = new El('html', {}, [new El('body', {}, [new El('ul', { id: 'menu' }, li)])]);
  const s3 = S.selectorFor(li[1], countIn(html3));
  assert.equal(countIn(html3)(s3), 1, s3); assert.ok(matches(li[1], s3)); assert.match(s3, /:nth-of-type\(2\)/);
  // nothing to go on but tags
  const deep = new El('span');
  const html4 = new El('html', {}, [new El('body', {}, [new El('div', {}, [new El('div', {}, [deep]), new El('div', {}, [new El('span')])])])]);
  const s4 = S.selectorFor(deep, countIn(html4));
  assert.equal(countIn(html4)(s4), 1, s4); assert.ok(matches(deep, s4));
  assert.equal(S.selectorFor(html4.children[0], countIn(html4)), null, 'body itself is never picked');
});
test('picker: selectors only use plain ASCII names, so they can be saved as filters', () => {
  const S = loadPicker();
  const el = new El('div', { id: 'größe', cls: 'bänner box' });
  const html = new El('html', {}, [new El('body', {}, [el, new El('div')])]);
  const sel = S.selectorFor(el, countIn(html));
  assert.equal(sel, 'div.box'); assert.match(sel, /^[\x20-\x7e]+$/);
  const out = compileUserFilters(zapLine('www.News.test', sel));
  assert.equal(out.errors.length, 0); assert.deepEqual(out.cosmetic.sites['news.test'].h, ['div.box']);
});

test('My filters: network filters become dynamic rules (ids from USER_BASE), with the lists\' priorities', () => {
  const out = compileUserFilters(['! my list', '||ads.mine.test^', '@@||cdn.mine.test/lib.js$script', '||x.test/track$image,third-party', '/^https?:\\/\\/re\\.test\\/a\\d+/', '0.0.0.0 hosts.mine.test', '$removeparam=ref_id,domain=shop.test'].join('\n'));
  assert.equal(out.errors.length, 0, JSON.stringify(out.errors));
  assert.equal(out.rules.length, 6);
  assert.ok(out.rules.every(validRule));
  assert.ok(out.rules.every(r => r.id > USER_BASE && r.id > PAUSE_BASE));
  assert.equal(out.rules[0].condition.urlFilter, '||ads.mine.test^'); assert.equal(out.rules[0].action.type, 'block');
  assert.equal(out.rules[1].action.type, 'allow'); assert.ok(out.rules[1].priority > out.rules[0].priority);
  assert.equal(out.rules[3].condition.regexFilter, '^https?:\\/\\/re\\.test\\/a\\d+');
  assert.equal(out.rules[4].condition.urlFilter, '||hosts.mine.test^', 'hosts-file lines');
  assert.deepEqual(out.rules[5].action.redirect.transform.queryTransform.removeParams, ['ref_id']);
  assert.deepEqual(out.notBlock, [out.rules[1].id, out.rules[5].id], 'the popup counts only blocks');
  assert.equal(out.lineOf[out.rules[0].id], 2);
});
test('My filters: hiding filters per site and everywhere, exceptions, procedural, and the $generichide family', () => {
  const out = compileUserFilters(['news.test##.newsletter', '##.chat-bubble', '~quiet.test##.promo', 'news.test#@#.ad-banner', 'news.test##.post:has-text(Sponsored)',
    'news.test##.hl:style(color: red)', '@@||plain.test^$generichide', 'google.*##.thing', '#@#.nope'].join('\n'));
  assert.equal(out.errors.length, 0, JSON.stringify(out.errors));
  assert.deepEqual(out.cosmetic.sites['news.test'].h, ['.newsletter']);
  assert.deepEqual(out.cosmetic.generic, ['.chat-bubble', '.promo']);
  assert.deepEqual(out.cosmetic.sites['quiet.test'].x, ['.promo']);
  assert.ok(out.cosmetic.sites['news.test'].x.includes('.ad-banner'));
  assert.equal(out.cosmetic.sites['news.test'].p[0][1].t[0][0], 'text');
  assert.deepEqual(out.cosmetic.sites['news.test'].s, [['.hl', 'color: red']]);
  assert.deepEqual(out.flags.generichide, ['plain.test']);
  assert.deepEqual(out.cosmetic.sites['google.*'].h, ['.thing']);
  assert.deepEqual(out.cosmetic.genericExcept, ['.nope']);
  assert.equal(out.counts.cosmetic, 8);
});
test('My filters: every refused line says why, by line number; scriptlets are refused', () => {
  const text = ['||ok.test^', 'news.test##+js(set, a, 1)', '||x.test^$replace=/a/b/', '*', '/(?=x)y/', 'example.com##^script', '||bad.test^$badfilter', '##.x:has-text(y)', 'a b c', 'news.test##div{color:red}', 'site.*##.ok', '||t.test^$domain=site.*'].join('\n');
  const out = compileUserFilters(text);
  const by = Object.fromEntries(out.errors.map(e => [e.line, e.error]));
  assert.equal(out.rules.length, 1);
  assert.match(by[2], /Scriptlet/); assert.match(by[3], /\$replace isn't supported/); assert.match(by[4], /Too broad/);
  assert.match(by[5], /regex engine/); assert.match(by[6], /HTML filters/); assert.match(by[7], /badfilter/);
  assert.match(by[8], /need a site/); assert.match(by[9], /spaces/); assert.match(by[10], /{ or }/);
  assert.equal(by[11], undefined, 'entities are fine in hiding filters'); assert.match(by[12], /name\.\*/);
  assert.equal(out.lines.length, 12); assert.equal(out.lines[1].error, by[2]);
  // the options page's selector check (the browser's) is used when given
  const v = compileUserFilters('news.test##div:bogus-thing', { validSelector: s => !s.includes('bogus') });
  assert.match(v.errors[0].error, /doesn't understand this selector/);
});
test('My filters: limits keep room for the lists\' dynamic fallback', () => {
  const many = Array.from({ length: USER_MAX + 5 }, (_, i) => `||h${i}.mine.test^`).join('\n');
  const out = compileUserFilters(many);
  assert.equal(out.rules.length, USER_MAX); assert.equal(out.errors.length, 5); assert.match(out.errors[0].error, /More than/);
});
test('zapper lines: site##selector without www, and the options page lists them', () => {
  assert.equal(zapLine('www.Example.com', '#nag'), 'example.com###nag');
  const out = compileUserFilters('example.com###nag\n');
  assert.deepEqual(out.cosmetic.sites['example.com'].h, ['#nag']);
});

test('groups: cookie banners on by default, annoyances off, Advanced can still switch single lists off', () => {
  assert.equal(GROUPS.cookies.on, true); assert.equal(GROUPS.annoyances.on, false);
  const groupOf = Object.fromEntries(LISTS.map(l => [l.id, l.cosmetic || null]));
  const ids = LISTS.map(l => l.id);
  const def = wantedRulesets({ level: 'optimal', lists: {} }, ids, groupOf);
  assert.deepEqual(def, DEFAULT_ON);
  assert.ok(def.includes('easylist-cookies') && def.includes('ublock-cookies') && !def.includes('fanboy-social') && !def.includes('ublock-annoyances'));
  const noCookies = wantedRulesets({ level: 'optimal', lists: {}, cookies: false }, ids, groupOf);
  assert.ok(!noCookies.includes('easylist-cookies') && noCookies.includes('easylist'));
  const all = wantedRulesets({ level: 'optimal', lists: { 'fanboy-social': false }, annoyances: true }, ids, groupOf);
  assert.ok(all.includes('ublock-annoyances') && all.includes('fanboy-annoyances') && !all.includes('fanboy-social'));
  assert.ok(groupOn({}, 'main') && groupOn({}, 'cookies') && !groupOn({}, 'annoyances') && groupOn({ annoyances: true }, 'annoyances'));
  for (const l of LISTS) assert.ok(['main', 'cookies', 'annoyances'].includes(cosmeticGroup(l)));
  const mf = JSON.parse(read('../extension/manifest.json'));
  for (const r of mf.declarative_net_request.rule_resources) if (r.id !== 'popups') assert.equal(r.enabled, DEFAULT_ON.includes(r.id), r.id + ' enabled at install');
  assert.equal(mf.options_ui.page, 'options.html');
  assert.ok(mf.permissions.includes('activeTab') && mf.permissions.includes('scripting'));
});
test('the version is the same in the manifest and package.json', () => {
  const mf = JSON.parse(read('../extension/manifest.json')), pkg = JSON.parse(read('../package.json'));
  assert.equal(pkg.version.replace(/\.0$/, ''), mf.version);
});
test('!#if conditions are parsed without eval (convert.js also runs in the extension)', async () => {
  const { preprocess } = await import('../extension/convert.js');
  const env = { env_mv3: true, ext_ublock: true };
  const on = c => preprocess(`!#if ${c}\nX\n!#endif`, env) === 'X';
  assert.ok(on('env_mv3') && !on('!env_mv3') && on('env_firefox || env_mv3') && on('!(env_firefox || env_safari) && ext_ublock') && !on('env_mv3 && env_firefox'));
  assert.ok(!on('(env_mv3') && !on('env_mv3 )') && !on('env_mv3; alert(1)'), 'malformed conditions are false');
  assert.doesNotMatch(read('../extension/convert.js'), /\bFunction\(|\beval\(/);
});
