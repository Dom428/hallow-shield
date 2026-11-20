// Hallow Shield: which filters touch one request, what each became, and whether it made it into the shipped rules.
//   node tools/explain.mjs <request url> <page url> [type=script]
// Reads the raw lists cached by tools/build.mjs in .lists/ and the built rules in extension/rules/.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkRule } from './convert.mjs';
import { ruleMatches, decide } from './match.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [url, page, type = 'script'] = process.argv.slice(2);
const req = { url, initiator: page, type };
const rulesDir = path.join(ROOT, 'extension', 'rules');
const shipped = [];
for (const f of fs.existsSync(rulesDir) ? fs.readdirSync(rulesDir) : []) {
  if (!f.endsWith('.json') || ['meta.json', 'sites.json', 'cosmetic.json', 'scriptlets.json'].includes(f)) continue;
  const rs = JSON.parse(fs.readFileSync(path.join(rulesDir, f), 'utf8'));
  if (Array.isArray(rs)) for (const r of rs) shipped.push({ ...r, set: f.replace('.json', '') });
}
const sig = r => JSON.stringify([r.action, r.condition, r.priority]);
const shippedSigs = new Set(shipped.map(sig));
console.log(`request ${url} (${type}) from ${page}`);
for (const f of fs.readdirSync(path.join(ROOT, '.lists'))) {
  for (const raw of fs.readFileSync(path.join(ROOT, '.lists', f), 'utf8').split(/\r?\n/)) {
    const line = raw.trim(); if (!line || line.startsWith('!') || /#[@?$%]?#/.test(line)) continue;
    const n = networkRule(line);
    const lit = line.replace(/^@@/, '').split('$')[0].replace(/^\|\|/, '').replace(/[*^|]/g, ' ').trim().split(' ')[0].toLowerCase();
    if (n?.skip) { if (lit.length > 5 && url.toLowerCase().includes(lit)) console.log(`  [${f}] SKIPPED (${n.skip}): ${line.slice(0, 200)}`); continue; }
    const rules = n?.rules || (n?.rule ? [n.rule] : []);
    for (const r of rules) if (ruleMatches(r, req)) console.log(`  [${f}] ${shippedSigs.has(sig(r)) ? 'SHIPPED' : 'NOT SHIPPED'} ${r.action.type} p${r.priority}: ${line.slice(0, 200)}`);
  }
}
const d = decide(shipped, req);
console.log('browser decision with the shipped rules:', d ? `${d.action.type} by ${d.set}#${d.id} ${JSON.stringify(d.condition).slice(0, 300)}` : 'no rule matches (request goes through)');
