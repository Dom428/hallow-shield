// Hallow Shield: builds the rule files from the filter lists.
//   node tools/build.mjs                      download the newest EasyList and EasyPrivacy (what CI does)
//   node tools/build.mjs --ads a.txt --privacy b.txt   use local copies (tests, offline)
// Writes extension/rules/{ads,privacy}.json (blocking rules), generic.css (ad boxes hidden on every site),
// sites.json (ad boxes per site + exceptions), meta.json (versions and counts) and prints what was skipped.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { convertList, validRule } from './convert.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'extension', 'rules');
const LISTS = { ads: 'https://easylist.to/easylist/easylist.txt', privacy: 'https://easylist.to/easylist/easyprivacy.txt' };
const TOTAL = 30000;   // Chrome guarantees every extension 30,000 static rules; plain domains share one rule per 1,000
let used = 0;          // ads first, privacy gets whatever ads didn't need

const arg = k => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : null; };
async function read(key) {
  const f = arg(key);
  if (f) return fs.readFileSync(f, 'utf8');
  const r = await fetch(LISTS[key]); if (!r.ok) throw new Error(`${LISTS[key]}: HTTP ${r.status}`);
  return await r.text();
}
const version = t => (t.match(/^! Version: (.+)$/m) || [])[1] || 'local';

fs.mkdirSync(OUT, { recursive: true });
const meta = { built: new Date().toISOString(), lists: {}, allow: {}, rules: {}, cosmetic: {} };
const generic = new Set(), sites = {}, except = {};
for (const key of ['ads', 'privacy']) {
  const text = await read(key);
  const { rules, cosmetic, stats } = convertList(text, { maxRules: key === 'ads' ? 22000 : TOTAL - used });
  used += rules.length;
  const bad = rules.filter(r => !validRule(r));
  if (bad.length) throw new Error(`${key}: ${bad.length} rules Chrome would refuse, e.g. ${JSON.stringify(bad[0])}`);
  fs.writeFileSync(path.join(OUT, key + '.json'), JSON.stringify(rules));
  meta.lists[key] = { source: arg(key) ? 'local file' : LISTS[key], version: version(text), lines: stats.lines };
  meta.allow[key] = rules.filter(r => r.action.type !== 'block').length;
  meta.rules[key] = rules.length;
  meta.domains = meta.domains || {}; meta.domains[key] = stats.domainsMerged; meta.dropped = meta.dropped || {}; meta.dropped[key] = stats.dropped;
  for (const sel of cosmetic.generic) generic.add(sel);
  for (const [d, list] of Object.entries(cosmetic.sites)) (sites[d] ||= []).push(...list);
  for (const [d, list] of Object.entries(cosmetic.except)) (except[d] ||= []).push(...list);
  console.log(`${key}: ${rules.length} rules (${meta.allow[key]} exceptions, ${stats.domainsMerged} domains in domain-list rules), ${stats.dropped} over budget, ${cosmetic.generic.length} generic + ${Object.keys(cosmetic.sites).length} sites cosmetic; skipped:`, stats.skipped);
}
// one rule per selector: a selector one browser doesn't understand then only loses itself
fs.writeFileSync(path.join(OUT, 'generic.css'), [...generic].map(s => `${s}{display:none!important}`).join('\n') + '\n');
fs.writeFileSync(path.join(OUT, 'sites.json'), JSON.stringify({ sites, except }));
meta.cosmetic = { generic: generic.size, sites: Object.keys(sites).length };
fs.writeFileSync(path.join(OUT, 'meta.json'), JSON.stringify(meta, null, 1));
console.log('total rules', meta.rules.ads + meta.rules.privacy, '- written to', OUT);
