// Hallow Shield "My filters": your own filters in Adblock Plus / uBlock Origin syntax, converted in the extension with
// the same converter the build uses for the lists (convert.js). Used by the options page (to show what each line
// became, or why it was refused) and by the background (network filters -> dynamic rules, hiding filters -> the same
// per-site CSS as the lists'). The element zapper saves what you pick here as "site##selector".
import { networkRule, cosmeticRule } from './convert.js';
import { USER_BASE, USER_MAX, USER_REGEX_MAX } from './shared.js';

const HOSTS_LINE = /^(?:0\.0\.0\.0|127\.0\.0\.1|::1?)\s+([a-z0-9.-]+\.[a-z0-9-]+)\s*(?:#.*)?$/i;
const FLAGS = ['generichide', 'elemhide', 'specifichide'];

// text -> { lines, rules, lineOf, notBlock, cosmetic, flags, errors, counts }
//   lines: one entry per line { n (1-based), text, kind: 'empty'|'comment'|'network'|'cosmetic', error? }
//   rules: dynamic rules (ids from USER_BASE), lineOf: rule id -> line number, notBlock: ids that aren't "block" rules
//   cosmetic: { generic: [selectors], genericExcept: [selectors], sites: { key: { h, x, s, p } } } (as the list shards)
//   validSelector(css): optional check (the options page passes one that asks the browser)
export function compileUserFilters(text, { validSelector = null } = {}) {
  const lines = [], rules = [], lineOf = {}, notBlock = [], errors = [];
  const cosmetic = { generic: [], genericExcept: [], sites: {} };
  const flags = Object.fromEntries(FLAGS.map(k => [k, []]));
  const site = k => (cosmetic.sites[k] ||= { h: [], x: [], s: [], p: [] });
  let regex = 0;
  String(text || '').split(/\r?\n/).forEach((raw, i) => {
    const n = i + 1, line = raw.trim(), entry = { n, text: raw };
    lines.push(entry);
    const fail = msg => { entry.error = msg; errors.push({ line: n, text: line, error: msg }); };
    if (!line) { entry.kind = 'empty'; return; }
    if (line.startsWith('!') || (line.startsWith('[') && line.endsWith(']')) || line.startsWith('# ')) { entry.kind = 'comment'; return; }
    const c = cosmeticRule(line);
    if (c) {
      entry.kind = 'cosmetic';
      if (c.skip) return fail(explain(c.skip));
      if (c.kind === 'scriptlet') return fail('Scriptlet filters (##+js) aren\'t supported here: Shield only runs the page fixes that ship with it.');
      const generic = !c.inc.length;
      const base = c.kind === 'procedural' ? c.prog.s : c.selector;
      if (validSelector && base && !validSelector(base)) return fail('The browser doesn\'t understand this selector: ' + base);
      if (c.kind === 'hide') {
        if (c.exception) { if (generic) cosmetic.genericExcept.push(c.selector); else for (const d of c.inc) site(d).x.push(c.selector); return; }
        if (generic) { cosmetic.generic.push(c.selector); for (const d of c.exc) site(d).x.push(c.selector); return; }
        for (const d of c.inc) site(d).h.push(c.selector);
        for (const d of c.exc) site(d).x.push(c.selector);
        return;
      }
      if (generic && !c.exception) return fail('Procedural and :style() filters need a site in front (site.com##...).');
      if (c.kind === 'style') { for (const d of c.inc) c.exception ? site(d).x.push(`${c.selector}:style(${c.style})`) : site(d).s.push([c.selector, c.style]); return; }
      for (const d of c.inc) c.exception ? site(d).x.push(c.selector) : site(d).p.push([c.selector, c.prog]);
      if (!c.exception) for (const d of c.exc) site(d).x.push(c.selector);
      return;
    }
    entry.kind = 'network';
    const hosts = line.match(HOSTS_LINE);
    const filter = hosts ? '||' + hosts[1].toLowerCase() + '^' : line;
    if (/\s/.test(filter.split('$')[0])) return fail('A network filter can\'t contain spaces.');
    const r = networkRule(filter);
    if (r.badfilter) return fail('$badfilter can\'t cancel the lists\' filters in Shield - use an @@ exception instead.');
    if (r.skip) return fail(explain(r.skip));
    if (r.cosmeticException) { for (const d of r.cosmeticException.domains) flags[r.cosmeticException.type].includes(d) || flags[r.cosmeticException.type].push(d); return; }
    if (rules.length >= USER_MAX) return fail(`More than ${USER_MAX} network filters: this one was left out.`);
    if (r.rule.condition.regexFilter && ++regex > USER_REGEX_MAX) return fail(`More than ${USER_REGEX_MAX} regex filters: this one was left out.`);
    if (r.elemhide) for (const d of r.elemhide) flags.elemhide.includes(d) || flags.elemhide.push(d);
    const id = USER_BASE + rules.length + 1;
    rules.push({ id, ...r.rule });
    lineOf[id] = n;
    if (r.rule.action.type !== 'block' && !(r.rule.action.type === 'redirect' && r.rule.action.redirect.extensionPath)) notBlock.push(id);
  });
  const counts = { network: rules.length, cosmetic: lines.filter(l => l.kind === 'cosmetic' && !l.error).length, errors: errors.length,
    flags: FLAGS.reduce((n, k) => n + flags[k].length, 0) };
  return { lines, rules, lineOf, notBlock, cosmetic, flags, errors, counts };
}

// the converter's skip reasons in words
function explain(reason) {
  const words = {
    'too broad': 'Too broad: it would match almost every request.',
    'html filter': 'HTML filters (##^) aren\'t possible in Manifest V3.',
    'domain wildcard': 'Sites written as name.* aren\'t possible in network filters (they are in hiding filters).',
    'regex unsupported': 'The browser\'s regex engine can\'t do this regex (no look-ahead / look-behind / back-references).',
    'pipe inside': 'A "|" can only be at the start or the end of the address part.',
    'cosmetic domain': 'One of the sites in front of ## isn\'t a valid site name.',
    'selector with braces': 'A selector can\'t contain { or }.',
    'non-ascii': 'Only plain ASCII characters are possible in the address part.',
    'non-ascii selector': 'Only plain ASCII characters are possible in a selector.',
    'style unsafe': ':style() can\'t use url(), expression, @import, backslashes or braces.',
    'adguard css': 'AdGuard #$# filters aren\'t supported.',
    'adguard js': 'AdGuard #%# filters aren\'t supported.',
  };
  if (words[reason]) return words[reason];
  if (reason.startsWith('option ')) return `The option $${reason.slice(7)} isn't supported.`;
  if (reason.startsWith('redirect ')) return `There's no stand-in called "${reason.slice(9)}" for $redirect.`;
  if (reason.startsWith('procedural')) return 'This procedural filter isn\'t supported (' + reason + ').';
  return 'Not supported: ' + reason + '.';
}

// one line for the zapper: "site##selector" (www. left out, so it also applies on the bare domain)
export const zapLine = (host, selector) => `${String(host).toLowerCase().replace(/^www\./, '')}##${selector}`;
