// Hallow Shield: asks the browser itself (chrome.declarativeNetRequest.isRegexSupported) about every regex rule the
// build made, and takes out the ones it refuses (RE2 syntax it lacks, or over its memory limit). Run after
// tools/build.mjs, in CI. Updates the rule files and rules/meta.json in place.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const { chromium } = await import('playwright').catch(() => createRequire(import.meta.url)('playwright'));

const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'extension');
const RULES = path.join(EXT, 'rules');
const meta = JSON.parse(fs.readFileSync(path.join(RULES, 'meta.json'), 'utf8'));
const sets = Object.keys(meta.rulesets);
const regexes = [];
for (const id of sets) for (const r of JSON.parse(fs.readFileSync(path.join(RULES, id + '.json'), 'utf8'))) if (r.condition.regexFilter) regexes.push({ id, rule: r.id, regex: r.condition.regexFilter, cs: !!r.condition.isUrlFilterCaseSensitive });

// a tiny probe extension asks the browser (Chrome refuses to load an extension whose static rules hold a regex RE2
// can't parse, so Shield itself can't be the one to ask)
const PROBE = fs.mkdtempSync(path.join(os.tmpdir(), 'shield-re-probe-'));
fs.writeFileSync(path.join(PROBE, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'regex probe', version: '1', permissions: ['declarativeNetRequest'], background: { service_worker: 'sw.js' } }));
fs.writeFileSync(path.join(PROBE, 'sw.js'), '// probe\n');
const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'shield-re-')), {
  headless: true, channel: 'chromium', args: [`--disable-extensions-except=${PROBE}`, `--load-extension=${PROBE}`],
});
const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 60000 });
const answers = await sw.evaluate(async list => {
  const out = [];
  for (const r of list) out.push(await chrome.declarativeNetRequest.isRegexSupported({ regex: r.regex, isCaseSensitive: r.cs }));
  return out;
}, regexes);
await ctx.close();

const bad = regexes.map((r, i) => ({ ...r, ok: answers[i].isSupported, reason: answers[i].reason })).filter(r => !r.ok);
for (const id of sets) {
  const drop = new Set(bad.filter(b => b.id === id).map(b => b.rule));
  if (!drop.size) continue;
  const rules = JSON.parse(fs.readFileSync(path.join(RULES, id + '.json'), 'utf8')).filter(r => !drop.has(r.id));
  fs.writeFileSync(path.join(RULES, id + '.json'), JSON.stringify(rules));
  meta.rulesets[id].rules = rules.length;
  meta.rulesets[id].regex = rules.filter(r => r.condition.regexFilter).length;
}
meta.regex = regexes.length - bad.length;
meta.regexRefused = bad.length;
meta.total = Object.values(meta.rulesets).reduce((n, r) => n + r.rules, 0);
fs.writeFileSync(path.join(RULES, 'meta.json'), JSON.stringify(meta, null, 1));
console.log(`regex rules: ${regexes.length} checked by the browser, ${bad.length} refused and taken out, ${meta.regex} kept (limit 1000)`);
for (const b of bad.slice(0, 20)) console.log(`  refused (${b.reason}) [${b.id}] ${b.regex.slice(0, 120)}`);
