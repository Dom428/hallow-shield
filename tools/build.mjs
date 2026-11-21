// Hallow Shield: builds everything the extension needs from the filter lists (run in CI; the extension itself never
// downloads anything).
//   node tools/build.mjs            download the newest lists (tools/lists.mjs) - what CI does
//   node tools/build.mjs --sample   use the small test lists in test/ (unit and end-to-end tests, offline)
//   node tools/build.mjs --list easylist=path/to/file.txt ...   use local copies for some lists (the rest empty)
// Writes extension/rules/:
//   <list>.json, popups.json        declarativeNetRequest rulesets (one per list; popups = strict pop-up blocking)
//   generic.css, specific-generic.css   ad boxes hidden on every site (one CSS rule per selector)
//   cosmetic/<n>.json               per-site hiding, :style() and procedural filters, sharded by site name
//   cookies/..., annoyances/...     the same three kinds of files for the cookie-banner and annoyance lists (switched on
//                                   and off as groups from the popup)
//   cosmetic-meta.json              sites where the lists turn hiding off ($generichide, $elemhide, $specifichide)
//   js/<scriptlet>.js, scriptlets.json   one MAIN-world bundle per scriptlet (and group) + the sites it's registered on
//   clicks.json                     the cookie lists' trusted-click-element filters ("click Reject"), run by clicker.js
//   meta.json                       list versions, counts per ruleset, what was skipped
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { convertList, validRule, preprocess, badfilters, merge } from './convert.mjs';
import { SCRIPTLETS, bundleSites } from './scriptlets.mjs';
import { LISTS, POPUPS, RULESET_IDS, ENV, GROUPS, COSMETIC_GROUPS, DEFAULT_ON, cosmeticGroup } from './lists.mjs';
import { genericKey } from '../extension/shared.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'extension', 'rules');
const SHARDS = 32;
export const GUARANTEED = 30000, REGEX_MAX = 1000;
// one list may not take more than this on its own (Chrome guarantees 30,000 per extension; more comes from a shared pool)
const PER_LIST_MAX = 30000;

const args = process.argv.slice(2);
const sample = args.includes('--sample');
const given = {};
for (let i = 0; i < args.length; i++) if (args[i] === '--list') { const [k, v] = args[++i].split('='); given[k] = v; }
if (sample) Object.assign(given, { easylist: 'test/sample-ads.txt', easyprivacy: 'test/sample-privacy.txt', 'ublock-filters': 'test/sample-ublock.txt',
  'easylist-cookies': 'test/sample-cookies.txt', 'ublock-cookies': 'test/sample-ublock-cookies.txt', 'fanboy-annoyances': 'test/sample-annoyances.txt', ...given });
const offline = sample || Object.keys(given).length > 0;

// curl with retries (Node's fetch has crashed mid-download on CI runners)
async function fetchText(url) {
  return execFileSync('curl', ['-fsSL', '--retry', '4', '--retry-all-errors', '--max-time', '120', '-A', 'HallowShield-build (+https://github.com/Dom428/hallow-shield)', url],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}
// uBO lists pull in other files with "!#include file.txt" (relative to the list)
async function withIncludes(text, base, depth = 0) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.trim().match(/^!#include\s+(\S+)/);
    if (!m) { out.push(line); continue; }
    if (depth > 3) continue;
    const url = new URL(m[1], base).href;
    if (new URL(url).origin !== new URL(base).origin) continue;   // includes stay on the list's own site
    out.push(await withIncludes(await fetchText(url), url, depth + 1));
  }
  return out.join('\n');
}
async function read(list) {
  if (offline) return given[list.id] ? fs.readFileSync(path.join(ROOT, given[list.id]), 'utf8') : '';
  let text = '';
  for (const url of list.urls) text += await withIncludes(await fetchText(url), url) + '\n';
  fs.mkdirSync(path.join(ROOT, '.lists'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, '.lists', list.id + '.txt'), text);
  return text;
}
// the list's own version line; uBO's lists carry a "%timestamp%" placeholder, so those get the day they were fetched
const version = t => {
  for (const m of t.matchAll(/^! (?:Version|Last modified|Last updated|Updated): (.+)$/gm)) if (!m[1].includes('%')) return m[1].trim();
  return !t ? 'none' : offline ? 'local' : 'fetched ' + new Date().toISOString().slice(0, 10);
};
const hash = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) % SHARDS; };
const withIds = rules => rules.map((r, i) => ({ id: i + 1, ...r }));

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'cosmetic'), { recursive: true });
fs.mkdirSync(path.join(OUT, 'js'), { recursive: true });

// 1. read and preprocess every list; $badfilter applies across lists (uBO's lists cancel EasyList filters this way)
const texts = {};
for (const list of LISTS) texts[list.id] = preprocess(await read(list), ENV);
const bad = new Set(); for (const t of Object.values(texts)) for (const k of badfilters(t)) bad.add(k);

const meta = { built: new Date().toISOString(), sample, lists: {}, rulesets: {}, cosmetic: {}, groups: {}, scriptlets: {}, badfilters: bad.size };
// cosmetic filters are kept per group ("main" = the ad and privacy lists; "cookies", "annoyances"), so the popup's
// switches can turn a group's hiding on and off; exceptions and the $generichide-style flags apply to every group
const G = Object.fromEntries(COSMETIC_GROUPS.map(g => [g, { generic: new Set(), specificGeneric: new Set(), sites: {} }]));
const genericExcept = new Set();
const flags = { generichide: new Set(), elemhide: new Set(), specifichide: new Set() };
// per group: key (host or "name.*") -> { h: [selectors], x: [exception selectors], s: [[selector, style]], p: [[selector, program]] }
const siteIn = g => k => (G[g].sites[k] ||= { h: [], x: [], s: [], p: [] });
const sl = [];      // all scriptlet filters
let popups = [], regexLeft = REGEX_MAX;
const skippedAll = {};

for (const list of LISTS) {
  const text = texts[list.id];
  const { rules, popups: pop, cosmetic, scriptlets, stats } = convertList(text, { maxRules: PER_LIST_MAX, trusted: !!list.trusted, bad, maxRegex: regexLeft });
  regexLeft -= stats.regex;
  const g = cosmeticGroup(list), site = siteIn(g), generic = G[g].generic, specificGeneric = G[g].specificGeneric;
  const ruled = withIds(rules);
  const broken = ruled.filter(r => !validRule(r));
  if (broken.length) throw new Error(`${list.id}: ${broken.length} rules Chrome would refuse, e.g. ${JSON.stringify(broken[0])}`);
  fs.writeFileSync(path.join(OUT, list.id + '.json'), JSON.stringify(ruled));
  popups.push(...pop);
  for (const s of cosmetic.generic) generic.add(s);
  for (const s of cosmetic.genericExcept) genericExcept.add(s);
  for (const s of cosmetic.specificGeneric) specificGeneric.add(s);
  for (const k of Object.keys(flags)) for (const d of cosmetic[k]) flags[k].add(d);
  for (const c of cosmetic.hide) {
    for (const d of c.inc) (c.exception ? site(d).x : site(d).h).push(c.selector);
    if (!c.exception) for (const d of c.exc) site(d).x.push(c.selector);
  }
  for (const c of cosmetic.style) for (const d of c.inc) (c.exception ? site(d).x.push(c.selector + ':style(' + c.style + ')') : site(d).s.push([c.selector, c.style]));
  for (const c of cosmetic.procedural) {
    for (const d of c.inc) c.exception ? site(d).x.push(c.selector) : site(d).p.push([c.selector, c.prog]);
    if (!c.exception) for (const d of c.exc) site(d).x.push(c.selector);
  }
  for (const s of scriptlets) sl.push({ ...s, list: list.id, group: g });
  for (const [k, v] of Object.entries(stats.skipped)) skippedAll[k] = (skippedAll[k] || 0) + v;
  meta.lists[list.id] = { name: list.name, group: list.cosmetic || null, defaultOn: DEFAULT_ON.includes(list.id), source: offline ? (given[list.id] || 'none') : list.urls[0], version: version(text), lines: stats.lines,
    network: stats.network, cosmetic: stats.cosmetic, scriptlets: stats.scriptlets, procedural: stats.procedural, badfiltered: stats.badfiltered, merged: stats.merged, dropped: stats.dropped };
  meta.rulesets[list.id] = { rules: ruled.length, allow: stats.allow, modify: stats.modify, regex: ruled.filter(r => r.condition.regexFilter).length };
  console.log(`${list.id}: ${ruled.length} rules (${stats.allow} exceptions, ${stats.modify} header/parameter, ${meta.rulesets[list.id].regex} regex), ` +
    `${stats.merged} merged, ${stats.dropped} over budget, ${stats.badfiltered} cancelled by $badfilter, ${stats.cosmetic} cosmetic, ${stats.scriptlets} scriptlets`);
}
popups = withIds(merge(popups));
fs.writeFileSync(path.join(OUT, POPUPS.id + '.json'), JSON.stringify(popups));
meta.rulesets[POPUPS.id] = { rules: popups.length, allow: 0, modify: 0, regex: 0 };
console.log(`${POPUPS.id}: ${popups.length} rules`);

// 2. cosmetic files
// main group: rules/generic.css, rules/cosmetic/...; the other groups: rules/<group>/generic.css, rules/<group>/cosmetic/...
const css = set => [...set].filter(s => !genericExcept.has(s)).map(s => `${s}{display:none!important}`).join('\n') + '\n';
for (const g of COSMETIC_GROUPS) {
  const dir = g === 'main' ? OUT : path.join(OUT, g), { generic, specificGeneric, sites } = G[g];
  fs.mkdirSync(path.join(dir, 'cosmetic'), { recursive: true });
  // 1.5: generic selectors that start with a class or id go to generic-keys.json (looked up for the classes / ids a
  // page really has); only the rest is a stylesheet in every frame - 14,000 selectors in every frame cost page loads a lot
  const keyed = {}, rest = new Set();
  for (const s of generic) { if (genericExcept.has(s)) continue; const k = genericKey(s); if (k) (keyed[k] ||= []).push(s); else rest.add(s); }
  fs.writeFileSync(path.join(dir, 'generic.css'), css(rest));
  fs.writeFileSync(path.join(dir, 'generic-keys.json'), JSON.stringify(keyed));
  fs.writeFileSync(path.join(dir, 'specific-generic.css'), css(specificGeneric));
  const shards = Array.from({ length: SHARDS }, () => ({}));
  for (const [k, v] of Object.entries(sites)) {
    const o = {};
    if (v.h.length) o.h = [...new Set(v.h)];
    if (v.x.length) o.x = [...new Set(v.x)];
    if (v.s.length) o.s = v.s;
    if (v.p.length) o.p = v.p;
    shards[hash(k)][k] = o;
  }
  shards.forEach((s, i) => fs.writeFileSync(path.join(dir, 'cosmetic', i + '.json'), JSON.stringify(s)));
  const c = { generic: [...generic].filter(s => !genericExcept.has(s)).length, genericKeyed: Object.values(keyed).reduce((n, l) => n + l.length, 0), genericCss: rest.size, specificGeneric: specificGeneric.size, sites: Object.keys(sites).length,
    procedural: Object.values(sites).reduce((n, v) => n + v.p.length, 0), style: Object.values(sites).reduce((n, v) => n + v.s.length, 0) };
  if (g === 'main') meta.cosmetic = { ...c, generichide: flags.generichide.size, elemhide: flags.elemhide.size, specifichide: flags.specifichide.size };
  else meta.groups[g] = { name: GROUPS[g].name, on: GROUPS[g].on, lists: LISTS.filter(l => cosmeticGroup(l) === g).map(l => l.id), cosmetic: c };
}
fs.writeFileSync(path.join(OUT, 'cosmetic-meta.json'), JSON.stringify({ shards: SHARDS, groups: Object.keys(GROUPS), ...Object.fromEntries(Object.entries(flags).map(([k, v]) => [k, [...v].sort()])) }));

// 3. scriptlets: one bundle per scriptlet with the sites and arguments it runs with
const validHost = d => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(d);
const used = {}, skipped = {}, registered = [];
// the cookie lists' trusted-click-element filters -> rules/clicks.json { args: [[selectors, extraMatch, delay]], hosts: { key: [i] }, exc: { key: [i] (-1 = all) } }
const CLICK = 'trusted-click-element';
const clicks = { args: [], index: new Map(), hosts: {}, exc: {} };
// one group's scriptlet filters -> bundles; the exceptions of every list apply (as in uBO)
function scriptletGroup(group) {
  const per = {};   // canonical -> { args: [], key->index, hosts: {}, exc: {} }
  const globalOff = new Set();   // "#@#+js(name, args)" with no site: off everywhere
  const prefix = group === 'main' ? '' : group + '-';
  for (const s of sl) {
    if (s.group !== group) continue;
    if (s.unsupported) { skipped[s.name] = (skipped[s.name] || 0) + 1; continue; }
    if (s.exception) continue;
    if (s.canonical === CLICK) {
      // "click Reject": only the cookie lists' filters, run by Shield's clicker (not a page script)
      if (group !== 'cookies') { skipped[CLICK + ' (outside the cookie lists)'] = (skipped[CLICK + ' (outside the cookie lists)'] || 0) + 1; continue; }
      const key = JSON.stringify(s.args.slice(0, 3));
      if (!clicks.index.has(key)) { clicks.index.set(key, clicks.args.length); clicks.args.push(s.args.slice(0, 3)); }
      const i = clicks.index.get(key);
      let any = false;
      for (const d of s.inc) { if (!validHost(d) && !/^[a-z0-9-]+(.[a-z0-9-]+)*.*$/.test(d)) continue; (clicks.hosts[d] ||= []).includes(i) || clicks.hosts[d].push(i); any = true; }
      for (const d of s.exc) (clicks.exc[d] ||= []).push(i);
      if (any) used[CLICK] = (used[CLICK] || 0) + 1; else skipped['(site not expressible) ' + CLICK] = (skipped['(site not expressible) ' + CLICK] || 0) + 1;
      continue;
    }
    if (!SCRIPTLETS[s.canonical]) { skipped[s.name] = (skipped[s.name] || 0) + 1; continue; }
    const b = (per[s.canonical] ||= { args: [], index: new Map(), hosts: {}, exc: {} });
    const key = JSON.stringify(s.args);
    if (!b.index.has(key)) { b.index.set(key, b.args.length); b.args.push(s.args); }
    const i = b.index.get(key);
    let any = false;
    for (const d of s.inc) { if (!validHost(d) && !/^[a-z0-9-]+(\.[a-z0-9-]+)*\.\*$/.test(d)) continue; (b.hosts[d] ||= []).includes(i) || b.hosts[d].push(i); any = true; }
    for (const d of s.exc) (b.exc[d] ||= []).push(i);
    if (any) used[s.canonical] = (used[s.canonical] || 0) + 1;
    else skipped['(site not expressible) ' + s.canonical] = (skipped['(site not expressible) ' + s.canonical] || 0) + 1;
  }
  for (const s of sl) {
    if (!s.exception) continue;
    if (group === 'cookies' && (!s.name || s.canonical === CLICK)) {
      // exceptions for the clicker: "#@#+js(trusted-click-element, ...)", or "#@#+js()" (every scriptlet off there)
      const i = s.name ? clicks.index.get(JSON.stringify(s.args.slice(0, 3))) : -1;
      if (i !== undefined) for (const d of s.inc) (clicks.exc[d] ||= []).push(i);
      if (s.name) continue;
    }
    const targets = s.name ? (per[s.canonical] ? [[s.canonical, per[s.canonical]]] : []) : Object.entries(per);
    for (const [canon, b] of targets) {
      const i = s.name ? b.index.get(JSON.stringify(s.args)) : -1;
      if (i === undefined) continue;
      if (!s.inc.length) { if (i >= 0) globalOff.add(canon + ' ' + i); continue; }
      for (const d of s.inc) (b.exc[d] ||= []).push(i);
    }
  }
  // only the entries for some host keys, with the argument list re-numbered
  const subset = (b, keys) => {
    const map = new Map(), args = [], hosts = {}, exc = {};
    const idx = i => { if (i < 0) return -1; if (!map.has(i)) { map.set(i, args.length); args.push(b.args[i]); } return map.get(i); };
    for (const k of keys) hosts[k] = b.hosts[k].map(idx);
    for (const [k, list] of Object.entries(b.exc)) { const l = list.filter(i => i < 0 || map.has(i)).map(i => i < 0 ? -1 : map.get(i)); if (l.length) exc[k] = l; }
    return { args, hosts, exc };
  };
  // 1.5: one bundle per top-level domain (".com", ".de", ...; the small ones share one), registered with one match
  // pattern per TLD instead of one per site: the browser checks every pattern of every registered script for every frame,
  // and 1.4's 36,000 site patterns cost a heavy page with frames about 100 ms. Each bundle finds the page's site in its
  // own table. Filters for "name.*" sites (entities) go into one bundle for every page, as before.
  const byTld = {}, entityHosts = {};
  for (const [canon, b] of Object.entries(per)) {
    for (const g of globalOff) { const [c, i] = g.split(' '); if (c === canon) for (const k of Object.keys(b.hosts)) b.hosts[k] = b.hosts[k].filter(x => x !== Number(i)); }
    for (const h of Object.keys(b.hosts).filter(h => b.hosts[h].length)) {
      if (h.endsWith('.*')) { (entityHosts[canon] ||= []).push(h); continue; }
      if (!validHost(h)) continue;
      const tld = h.slice(h.lastIndexOf('.') + 1);
      if (/^\d+$/.test(tld)) continue;   // an IP address: not a site a pattern can name this way
      ((byTld[tld] ||= {})[canon] ||= []).push(h);
    }
  }
  const partsOf = m => Object.fromEntries(Object.entries(m).map(([c, hs]) => [c, subset(per[c], hs)]));
  const write = (id, parts, matches, title) => {
    const file = `rules/js/${prefix}${id}.js`, code = bundleSites(parts, title);
    fs.writeFileSync(path.join(ROOT, 'extension', file), code);
    registered.push({ id: prefix + id, group, file, matches, kb: Math.round(code.length / 1024) });
  };
  const size = m => Object.values(m).reduce((n, l) => n + l.length, 0);
  const big = Object.keys(byTld).filter(t => size(byTld[t]) >= 200).sort(), small = Object.keys(byTld).filter(t => !big.includes(t)).sort();
  for (const tld of big) write('tld-' + tld, partsOf(byTld[tld]), [`*://*.${tld}/*`], 'sites under .' + tld);
  if (small.length) {
    const merged = {};
    for (const t of small) for (const [c, hs] of Object.entries(byTld[t])) (merged[c] ||= []).push(...hs);
    write('tld-other', partsOf(merged), small.map(t => `*://*.${t}/*`), `sites under ${small.length} other top-level domains`);
  }
  if (Object.keys(entityHosts).length) write('_entities', partsOf(entityHosts), ['*://*/*'], 'sites named as name.*');
}
for (const g of COSMETIC_GROUPS) scriptletGroup(g);
fs.writeFileSync(path.join(OUT, 'scriptlets.json'), JSON.stringify(registered));
fs.writeFileSync(path.join(OUT, 'clicks.json'), JSON.stringify({ args: clicks.args, hosts: clicks.hosts, exc: clicks.exc }));
meta.scriptlets = { implemented: Object.keys(SCRIPTLETS).length + 1, used, skipped, bundles: registered.length, clicks: { filters: used[CLICK] || 0, sites: Object.keys(clicks.hosts).length, distinct: clicks.args.length },
  filtersUsed: Object.values(used).reduce((a, b) => a + b, 0), filtersSkipped: Object.values(skipped).reduce((a, b) => a + b, 0) };

// 4. checks and the summary
const regexTotal = Object.values(meta.rulesets).reduce((n, r) => n + r.regex, 0);
if (regexTotal > REGEX_MAX) throw new Error(`${regexTotal} regex rules: the browser allows ${REGEX_MAX}`);
const mf = JSON.parse(fs.readFileSync(path.join(ROOT, 'extension', 'manifest.json'), 'utf8'));
const declared = mf.declarative_net_request.rule_resources.map(r => r.id);
if (JSON.stringify(declared) !== JSON.stringify(RULESET_IDS)) throw new Error('manifest rule_resources must be ' + RULESET_IDS.join(', '));
meta.total = Object.values(meta.rulesets).reduce((n, r) => n + r.rules, 0);
meta.enabledAtInstall = mf.declarative_net_request.rule_resources.filter(r => r.enabled).reduce((n, r) => n + meta.rulesets[r.id].rules, 0);
meta.defaultOn = DEFAULT_ON.reduce((n, id) => n + meta.rulesets[id].rules, 0);
meta.allLists = LISTS.reduce((n, l) => n + meta.rulesets[l.id].rules, 0);
for (const [g, v] of Object.entries(meta.groups)) { v.rules = v.lists.reduce((n, id) => n + meta.rulesets[id].rules, 0); v.bundles = registered.filter(b => b.group === g).length; }
meta.regex = regexTotal;
meta.skipped = skippedAll;
fs.writeFileSync(path.join(OUT, 'meta.json'), JSON.stringify(meta, null, 1));
console.log(`\ncosmetic: ${JSON.stringify(meta.cosmetic)}`);
for (const [g, v] of Object.entries(meta.groups)) console.log(`group ${g} (${v.on ? 'on' : 'off'} by default): ${v.rules} rules, ${v.bundles} scriptlet bundles, cosmetic ${JSON.stringify(v.cosmetic)}`);
console.log('scriptlet bundles (KB, match patterns): ' + registered.map(r => `${r.id} ${r.kb} KB/${r.matches.length}`).join(', '));
console.log(`scriptlets: ${meta.scriptlets.filtersUsed} filters in ${registered.length} bundles (+ ${meta.scriptlets.clicks.filters} cookie-banner click filters for ${meta.scriptlets.clicks.sites} sites); skipped ${meta.scriptlets.filtersSkipped}:`, skipped);
console.log(`total ${meta.total} rules (${regexTotal} regex); default lists ${meta.defaultOn}; every list ${meta.allLists}; enabled at install ${meta.enabledAtInstall} (guaranteed ${GUARANTEED})`);
console.log('skipped filters:', Object.entries(skippedAll).sort((a, b) => b[1] - a[1]).slice(0, 40).map(([k, v]) => `${k}: ${v}`).join(', '));
if (!sample) {
  // what the YouTube filters became (CI log)
  console.log('\nYouTube scriptlet filters:');
  for (const s of sl) if ([...s.inc, ...s.exc].some(d => /(^|\.)youtube(-nocookie|kids)?\.com$/.test(d)))
    console.log(`  ${s.unsupported || !SCRIPTLETS[s.canonical] ? 'SKIPPED' : s.exception ? 'EXCEPT ' : 'ok     '} [${s.list}] ${s.inc.join(',')}##+js(${[s.name, ...s.args].join(', ')})`.slice(0, 400));
  // 1.5: a sample of the real filters the new scriptlets run, to check them against (CI log)
  const NEW = /^(trusted-)?(json-edit|jsonl-edit|edit-(in|out)bound-object)|^trusted-replace-argument$|^href-sanitizer$|^trusted-prevent-dom-bypass$/;
  const count = {};
  console.log('\n1.5 scriptlet filters (up to 8 of each):');
  for (const s of sl) if (s.canonical && NEW.test(s.canonical) && !s.exception && (count[s.canonical] = (count[s.canonical] || 0) + 1) <= 8)
    console.log(`  [${s.list}] ${s.inc.slice(0, 3).join(',')}##+js(${[s.name, ...s.args].join(', ')})`.slice(0, 300));
}
