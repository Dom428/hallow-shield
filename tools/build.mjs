// Hallow Shield: builds everything the extension needs from the filter lists (run in CI; the extension itself never
// downloads anything).
//   node tools/build.mjs            download the newest lists (tools/lists.mjs) - what CI does
//   node tools/build.mjs --sample   use the small test lists in test/ (unit and end-to-end tests, offline)
//   node tools/build.mjs --list easylist=path/to/file.txt ...   use local copies for some lists (the rest empty)
// Writes extension/rules/:
//   <list>.json, popups.json        declarativeNetRequest rulesets (one per list; popups = strict pop-up blocking)
//   generic.css, specific-generic.css   ad boxes hidden on every site (one CSS rule per selector)
//   cosmetic/<n>.json               per-site hiding, :style() and procedural filters, sharded by site name
//   cosmetic-meta.json              sites where the lists turn hiding off ($generichide, $elemhide, $specifichide)
//   js/<scriptlet>.js, scriptlets.json   one MAIN-world bundle per scriptlet + the sites it's registered on
//   meta.json                       list versions, counts per ruleset, what was skipped
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { convertList, validRule, preprocess, badfilters, merge } from './convert.mjs';
import { SCRIPTLETS, bundle } from './scriptlets.mjs';
import { LISTS, POPUPS, RULESET_IDS, ENV } from './lists.mjs';

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
if (sample) Object.assign(given, { easylist: 'test/sample-ads.txt', easyprivacy: 'test/sample-privacy.txt', 'ublock-filters': 'test/sample-ublock.txt', ...given });
const offline = sample || Object.keys(given).length > 0;

async function fetchText(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'HallowShield-build (+https://github.com/Dom428/hallow-shield)' } });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return await r.text();
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
const version = t => (t.match(/^! (?:Version|Last modified): (.+)$/m) || [])[1]?.trim() || (t ? 'local' : 'none');
const hash = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) % SHARDS; };
const withIds = rules => rules.map((r, i) => ({ id: i + 1, ...r }));

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'cosmetic'), { recursive: true });
fs.mkdirSync(path.join(OUT, 'js'), { recursive: true });

// 1. read and preprocess every list; $badfilter applies across lists (uBO's lists cancel EasyList filters this way)
const texts = {};
for (const list of LISTS) texts[list.id] = preprocess(await read(list), ENV);
const bad = new Set(); for (const t of Object.values(texts)) for (const k of badfilters(t)) bad.add(k);

const meta = { built: new Date().toISOString(), sample, lists: {}, rulesets: {}, cosmetic: {}, scriptlets: {}, badfilters: bad.size };
const generic = new Set(), genericExcept = new Set(), specificGeneric = new Set();
const flags = { generichide: new Set(), elemhide: new Set(), specifichide: new Set() };
const sites = {};   // key (host or "name.*") -> { h: [selectors], x: [exception selectors], s: [[selector, style]], p: [[selector, program]] }
const site = k => (sites[k] ||= { h: [], x: [], s: [], p: [] });
const sl = [];      // all scriptlet filters
let popups = [], regexLeft = REGEX_MAX;
const skippedAll = {};

for (const list of LISTS) {
  const text = texts[list.id];
  const { rules, popups: pop, cosmetic, scriptlets, stats } = convertList(text, { maxRules: PER_LIST_MAX, trusted: !!list.trusted, bad, maxRegex: regexLeft });
  regexLeft -= stats.regex;
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
  for (const s of scriptlets) sl.push({ ...s, list: list.id });
  for (const [k, v] of Object.entries(stats.skipped)) skippedAll[k] = (skippedAll[k] || 0) + v;
  meta.lists[list.id] = { name: list.name, source: offline ? (given[list.id] || 'none') : list.urls[0], version: version(text), lines: stats.lines,
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
const genericFinal = [...generic].filter(s => !genericExcept.has(s));
fs.writeFileSync(path.join(OUT, 'generic.css'), genericFinal.map(s => `${s}{display:none!important}`).join('\n') + '\n');
fs.writeFileSync(path.join(OUT, 'specific-generic.css'), [...specificGeneric].filter(s => !genericExcept.has(s)).map(s => `${s}{display:none!important}`).join('\n') + '\n');
const shards = Array.from({ length: SHARDS }, () => ({}));
for (const [k, v] of Object.entries(sites)) {
  const o = {};
  if (v.h.length) o.h = [...new Set(v.h)];
  if (v.x.length) o.x = [...new Set(v.x)];
  if (v.s.length) o.s = v.s;
  if (v.p.length) o.p = v.p;
  shards[hash(k)][k] = o;
}
shards.forEach((s, i) => fs.writeFileSync(path.join(OUT, 'cosmetic', i + '.json'), JSON.stringify(s)));
fs.writeFileSync(path.join(OUT, 'cosmetic-meta.json'), JSON.stringify({ shards: SHARDS, ...Object.fromEntries(Object.entries(flags).map(([k, v]) => [k, [...v].sort()])) }));
meta.cosmetic = { generic: genericFinal.length, specificGeneric: specificGeneric.size, sites: Object.keys(sites).length,
  procedural: Object.values(sites).reduce((n, v) => n + v.p.length, 0), style: Object.values(sites).reduce((n, v) => n + v.s.length, 0),
  generichide: flags.generichide.size, elemhide: flags.elemhide.size, specifichide: flags.specifichide.size };

// 3. scriptlets: one bundle per scriptlet with the sites and arguments it runs with
const validHost = d => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(d);
const per = {};   // canonical -> { args: [], key->index, hosts: {}, exc: {} }
const used = {}, skipped = {};
const globalOff = new Set();   // "#@#+js(name, args)" with no site: off everywhere
for (const s of sl) {
  if (s.unsupported) { skipped[s.name] = (skipped[s.name] || 0) + 1; continue; }
  if (s.exception) continue;
  if (!SCRIPTLETS[s.canonical]) { skipped[s.name] = (skipped[s.name] || 0) + 1; continue; }
  const b = (per[s.canonical] ||= { args: [], index: new Map(), hosts: {}, exc: {} });
  const key = JSON.stringify(s.args);
  if (!b.index.has(key)) { b.index.set(key, b.args.length); b.args.push(s.args); }
  const i = b.index.get(key);
  let any = false;
  for (const d of s.inc) { if (!validHost(d) && !d.endsWith('.*')) continue; (b.hosts[d] ||= []).includes(i) || b.hosts[d].push(i); if (validHost(d)) any = true; }
  for (const d of s.exc) (b.exc[d] ||= []).push(i);
  if (any) used[s.canonical] = (used[s.canonical] || 0) + 1;
  else skipped['(site not expressible) ' + s.canonical] = (skipped['(site not expressible) ' + s.canonical] || 0) + 1;
}
for (const s of sl) {
  if (!s.exception) continue;
  const targets = s.name ? (per[s.canonical] ? [[s.canonical, per[s.canonical]]] : []) : Object.entries(per);
  for (const [canon, b] of targets) {
    const i = s.name ? b.index.get(JSON.stringify(s.args)) : -1;
    if (i === undefined) continue;
    if (!s.inc.length) { if (i >= 0) globalOff.add(canon + ' ' + i); continue; }
    for (const d of s.inc) (b.exc[d] ||= []).push(i);
  }
}
const registered = [];
for (const [canon, b] of Object.entries(per)) {
  for (const g of globalOff) { const [c, i] = g.split(' '); if (c === canon) for (const k of Object.keys(b.hosts)) b.hosts[k] = b.hosts[k].filter(x => x !== Number(i)); }
  const hosts = Object.keys(b.hosts).filter(h => b.hosts[h].length && validHost(h)).sort();
  if (!hosts.length) continue;
  const set = new Set(hosts);
  const top = hosts.filter(h => { const p = h.split('.'); for (let i = 1; i < p.length - 1; i++) if (set.has(p.slice(i).join('.'))) return false; return true; });
  const file = `rules/js/${canon}.js`;
  fs.writeFileSync(path.join(ROOT, 'extension', file), bundle(canon, { args: b.args, hosts: b.hosts, exc: b.exc }));
  registered.push({ id: canon, file, matches: top.map(h => `*://*.${h}/*`) });
}
fs.writeFileSync(path.join(OUT, 'scriptlets.json'), JSON.stringify(registered));
meta.scriptlets = { implemented: Object.keys(SCRIPTLETS).length, used, skipped, bundles: registered.length,
  filtersUsed: Object.values(used).reduce((a, b) => a + b, 0), filtersSkipped: Object.values(skipped).reduce((a, b) => a + b, 0) };

// 4. checks and the summary
const regexTotal = Object.values(meta.rulesets).reduce((n, r) => n + r.regex, 0);
if (regexTotal > REGEX_MAX) throw new Error(`${regexTotal} regex rules: the browser allows ${REGEX_MAX}`);
const mf = JSON.parse(fs.readFileSync(path.join(ROOT, 'extension', 'manifest.json'), 'utf8'));
const declared = mf.declarative_net_request.rule_resources.map(r => r.id);
if (JSON.stringify(declared) !== JSON.stringify(RULESET_IDS)) throw new Error('manifest rule_resources must be ' + RULESET_IDS.join(', '));
meta.total = Object.values(meta.rulesets).reduce((n, r) => n + r.rules, 0);
meta.enabledAtInstall = mf.declarative_net_request.rule_resources.filter(r => r.enabled).reduce((n, r) => n + meta.rulesets[r.id].rules, 0);
meta.defaultOn = LISTS.reduce((n, l) => n + meta.rulesets[l.id].rules, 0);
meta.regex = regexTotal;
meta.skipped = skippedAll;
fs.writeFileSync(path.join(OUT, 'meta.json'), JSON.stringify(meta, null, 1));
console.log(`\ncosmetic: ${JSON.stringify(meta.cosmetic)}`);
console.log(`scriptlets: ${meta.scriptlets.filtersUsed} filters in ${registered.length} bundles; skipped ${meta.scriptlets.filtersSkipped}:`, skipped);
console.log(`total ${meta.total} rules (${regexTotal} regex); default lists ${meta.defaultOn}; enabled at install ${meta.enabledAtInstall} (guaranteed ${GUARANTEED})`);
console.log('skipped filters:', Object.entries(skippedAll).sort((a, b) => b[1] - a[1]).slice(0, 40).map(([k, v]) => `${k}: ${v}`).join(', '));
if (!sample) {
  // what the YouTube filters became (CI log)
  console.log('\nYouTube scriptlet filters:');
  for (const s of sl) if ([...s.inc, ...s.exc].some(d => /(^|\.)youtube(-nocookie|kids)?\.com$/.test(d)))
    console.log(`  ${s.unsupported || !SCRIPTLETS[s.canonical] ? 'SKIPPED' : s.exception ? 'EXCEPT ' : 'ok     '} [${s.list}] ${s.inc.join(',')}##+js(${[s.name, ...s.args].join(', ')})`.slice(0, 400));
}
