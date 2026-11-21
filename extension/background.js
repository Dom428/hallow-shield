// Hallow Shield background: turns your settings (blocking level, lists, the cookie-banner and annoyance switches,
// paused sites, My filters) into what the browser does. The blocking itself is done by the browser from the rule
// files - this script never sees your requests.
//   - rulesets: the lists you have on (static rulesets; if the browser's shared pool has no room for one, its rules are
//     loaded as dynamic rules instead, within the browser's 30,000-rule dynamic budget)
//   - paused sites: one dynamic "allow everything" rule per site, above every list rule
//   - My filters: your network filters as dynamic rules, your hiding filters next to the lists' (and the zapper's)
//   - cosmetic filtering and scriptlets (levels Optimal and Complete): registered content scripts, paused sites left out
import { cosmeticKeys, shardOf, onList, siteCosmetics, pauseRule, PAUSE_BASE, USER_BASE, USER_MAX, USER_REGEX_MAX, patternsFor, wantedRulesets, groupOn, siteOf, LEVELS, DEFAULT_LEVEL } from './shared.js';
import { compileUserFilters, zapLine } from './userfilters.js';

const ext = globalThis.browser ?? chrome;
const dnr = ext.declarativeNetRequest;
const url = p => ext.runtime.getURL(p);
const json = p => fetch(url(p)).then(r => r.json());
const once = f => { let p = null; return () => p ||= f().catch(e => { p = null; throw e; }); };
const meta = once(() => json('rules/meta.json'));
const cmeta = once(() => json('rules/cosmetic-meta.json'));
const scriptlets = once(() => json('rules/scriptlets.json'));
const dirOf = g => g === 'main' ? 'rules/' : `rules/${g}/`;
const genericSets = new Map();
const genericSet = g => {
  if (!genericSets.has(g)) genericSets.set(g, fetch(url(dirOf(g) + 'generic.css')).then(r => r.text())
    .then(t => new Set(t.split('\n').map(l => l.replace(/\{display:none!important\}$/, '')).filter(Boolean))).catch(() => new Set()));
  return genericSets.get(g);
};
const shards = new Map();
const shard = (g, n) => { const k = g + n; if (!shards.has(k)) shards.set(k, json(`${dirOf(g)}cosmetic/${n}.json`).catch(() => ({}))); return shards.get(k); };
const LIST_IDS = ['ublock-filters', 'easylist', 'easyprivacy', 'ublock-badware', 'ublock-privacy', 'ublock-unbreak', 'ublock-quick-fixes', 'plowe', 'ublock-cookies', 'easylist-cookies', 'ublock-annoyances', 'fanboy-annoyances', 'fanboy-social'];

async function settings() {
  const s = await ext.storage.local.get({ paused: [], level: null, lists: {}, cookies: true, annoyances: false, myFilters: '', ads: true, privacy: true, hide: true, debugNoRoom: [] });
  if (!LEVELS.includes(s.level)) {
    // settings from Shield 1.0: three switches
    s.level = s.hide === false ? 'basic' : DEFAULT_LEVEL;
    if (s.ads === false) s.lists = { ...s.lists, easylist: false };
    if (s.privacy === false) s.lists = { ...s.lists, easyprivacy: false };
    await ext.storage.local.set({ level: s.level, lists: s.lists });
    await ext.storage.local.remove(['ads', 'privacy', 'hide']);
  }
  return s;
}
const isPaused = (s, host) => onList(host, s.paused);
const groupsOf = m => Object.fromEntries(Object.entries(m.lists).map(([id, l]) => [id, l.group || null]));
// the cosmetic groups that apply: the ad lists' always, cookie banners / annoyances while their switch is on and at
// least one of their lists is
const activeGroups = (s, m) => ['main', ...Object.entries(m.groups || {}).filter(([g, v]) => groupOn(s, g) && v.lists.some(id => s.lists?.[id] !== false)).map(([g]) => g)];
// My filters, converted once per text
let userCache = { text: null, out: null };
const user = s => { if (userCache.text !== s.myFilters) userCache = { text: s.myFilters, out: compileUserFilters(s.myFilters) }; return userCache.out; };

// ---- rulesets ----
let lastFallback = null;
async function syncRulesets() {
  const s = await settings(), m = await meta();
  const want = wantedRulesets(s, LIST_IDS, groupsOf(m));
  const forced = s.debugNoRoom || [];   // the tests' way to pretend a list doesn't fit in the static pool
  const now = await dnr.getEnabledRulesets();
  const disable = now.filter(id => !want.includes(id) || forced.includes(id));
  const enable = want.filter(id => !now.includes(id) && !forced.includes(id));
  try { await dnr.updateEnabledRulesets({ enableRulesetIds: enable, disableRulesetIds: disable }); }
  catch {
    // not enough room in the browser's shared pool for everything: the lists that fit, in order of importance
    await dnr.updateEnabledRulesets({ disableRulesetIds: disable }).catch(() => { });
    let room = await dnr.getAvailableStaticRuleCount().catch(() => 0);
    const fit = [];
    for (const id of enable) { const n = m.rulesets[id]?.rules || 0; if (n <= room) { fit.push(id); room -= n; } }
    await dnr.updateEnabledRulesets({ enableRulesetIds: fit }).catch(() => { });
  }
  const on = await dnr.getEnabledRulesets();
  await syncFallback(want.filter(id => !on.includes(id)));
}
// lists that couldn't be enabled as static rulesets: their rules as dynamic rules (Chrome: 30,000 "safe" rules -
// block/allow - and 5,000 others; regex rules share 1,000 with the session rules). Room is left for paused sites and
// My filters.
async function syncFallback(ids) {
  const key = JSON.stringify(ids);
  if (key === lastFallback) return;
  const old = (await dnr.getDynamicRules()).filter(r => r.id < PAUSE_BASE);
  const add = [], info = {}, notBlock = [];
  let safe = 30000 - 600 - USER_MAX, unsafe = 4900 - 200, regex = 900 - USER_REGEX_MAX, id = 1;
  for (const set of ids) {
    let rules; try { rules = await json(`rules/${set}.json`); } catch { continue; }
    let n = 0;
    for (const r of rules) {
      const risky = r.action.type === 'redirect' || r.action.type === 'modifyHeaders';
      if ((risky ? unsafe : safe) <= 0 || (r.condition.regexFilter && regex <= 0)) continue;
      if (r.condition.regexFilter) regex--;
      if (risky) unsafe--; else safe--;
      if (!(r.action.type === 'block' || (r.action.type === 'redirect' && r.action.redirect.extensionPath))) notBlock.push(id);
      add.push({ ...r, id: id++ }); n++;
    }
    info[set] = { loaded: n, of: rules.length };
  }
  try { await dnr.updateDynamicRules({ removeRuleIds: old.map(r => r.id), addRules: add }); }
  catch (e) { console.warn('Hallow Shield: dynamic rules', e); for (const k of Object.keys(info)) info[k].loaded = 0; await dnr.updateDynamicRules({ removeRuleIds: old.map(r => r.id) }).catch(() => { }); }
  lastFallback = key;
  await ext.storage.local.set({ fallback: info, fallbackNotBlock: notBlock });
}
// a paused site: one dynamic "allow everything" rule per site
async function syncPauses() {
  const s = await settings();
  const old = (await dnr.getDynamicRules()).filter(r => r.id >= PAUSE_BASE && r.id < USER_BASE);
  await dnr.updateDynamicRules({ removeRuleIds: old.map(r => r.id), addRules: s.paused.map((d, i) => pauseRule(d, PAUSE_BASE + i)) });
}
// My filters: the network filters as dynamic rules. If the browser refuses the batch, one at a time, so one bad rule
// doesn't take the others with it; the refused ones are shown on the options page.
async function syncUser() {
  const s = await settings(), u = user(s);
  const old = (await dnr.getDynamicRules()).filter(r => r.id >= USER_BASE);
  await dnr.updateDynamicRules({ removeRuleIds: old.map(r => r.id) });
  const refused = [];
  try { if (u.rules.length) await dnr.updateDynamicRules({ addRules: u.rules }); }
  catch {
    for (const r of u.rules) {
      try { await dnr.updateDynamicRules({ addRules: [r] }); }
      catch (e) { refused.push({ line: u.lineOf[r.id], error: 'The browser refused this rule: ' + String(e && e.message || e) }); }
    }
  }
  await ext.storage.local.set({ userRefused: refused, userNotBlock: u.notBlock, userSynced: s.myFilters });
}

// ---- content scripts: CSS, the cosmetic script and the scriptlets ----
async function syncScripts() {
  const s = await settings(), m = await meta(), u = user(s);
  const exclude = s.paused.flatMap(d => [`*://${d}/*`, `*://*.${d}/*`]);
  const scripts = [];
  const base = { allFrames: true, runAt: 'document_start' };
  if (s.level !== 'basic') {
    const cm = await cmeta(), groups = activeGroups(s, m);
    const ghide = [...cm.generichide, ...cm.elemhide, ...u.flags.generichide, ...u.flags.elemhide], ehide = [...cm.elemhide, ...u.flags.elemhide];
    for (const g of groups) {
      const sfx = g === 'main' ? '' : '-' + g;
      scripts.push({ ...base, id: 'shield-generic' + sfx, matches: ['<all_urls>'], excludeMatches: [...exclude, ...patternsFor(ghide)], css: [dirOf(g) + 'generic.css'] });
      scripts.push({ ...base, id: 'shield-sg' + sfx, matches: ['<all_urls>'], excludeMatches: [...exclude, ...patternsFor(ehide)], css: [dirOf(g) + 'specific-generic.css'] });
    }
    scripts.push({ ...base, id: 'shield-cosmetic', matches: ['<all_urls>'], excludeMatches: exclude, js: ['content.js'] });
    for (const b of await scriptlets()) if (groups.includes(b.group || 'main')) scripts.push({ ...base, id: 'shield-sl-' + b.id, matches: b.matches, excludeMatches: exclude, js: [b.file], world: 'MAIN' });
  } else if (u.counts.cosmetic) {
    // Basic runs nothing of the lists' in pages, but what you hid yourself stays hidden
    scripts.push({ ...base, id: 'shield-cosmetic', matches: ['<all_urls>'], excludeMatches: exclude, js: ['content.js'] });
  }
  const old = (await ext.scripting.getRegisteredContentScripts()).map(c => c.id);
  if (old.length) await ext.scripting.unregisterContentScripts({ ids: old }).catch(() => { });
  const errors = [];
  if (scripts.length) {
    try { await ext.scripting.registerContentScripts(scripts.map(c => ({ ...c, persistAcrossSessions: true }))); }
    catch {
      // one at a time, so one the browser refuses doesn't take the others with it (older browsers: without
      // persistAcrossSessions - re-registered at startup - or without the MAIN world)
      for (const c of scripts) {
        const tries = [{ ...c, persistAcrossSessions: true }, c];
        let ok = false, last = null;
        for (const t of tries) { try { await ext.scripting.registerContentScripts([t]); ok = true; break; } catch (e) { last = e; } }
        if (!ok) errors.push(`${c.id}: ${last && last.message}`);
      }
    }
  }
  await ext.storage.local.set({ scriptErrors: errors });
}

let queue = Promise.resolve();
const serial = f => (queue = queue.then(f, f).catch(e => console.warn('Hallow Shield:', e)));
const syncAll = () => serial(() => Promise.all([syncRulesets(), syncPauses(), syncUser(), syncScripts()]));

ext.runtime.onInstalled.addListener(() => { syncAll(); try { dnr.setExtensionActionOptions({ displayActionCountAsBadgeText: true }); } catch { } });
ext.runtime.onStartup?.addListener(() => syncAll());
ext.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  const k = Object.keys(changes);
  if (k.every(x => ['fallback', 'fallbackNotBlock', 'scriptErrors', 'userRefused', 'userNotBlock', 'userSynced'].includes(x))) return;
  if (k.includes('paused')) serial(() => Promise.all([syncPauses(), syncScripts()]));
  if (k.some(x => ['level', 'lists', 'debugNoRoom', 'cookies', 'annoyances'].includes(x))) serial(() => Promise.all([syncRulesets(), syncScripts()]));
  if (k.includes('myFilters')) serial(() => Promise.all([syncUser(), syncScripts()]));
});

// the hiding for one page: the lists' per-site filters of the groups that are on (not at Basic), plus My filters
async function cosmeticsFor(s, host) {
  const m = await meta(), cm = await cmeta(), u = user(s);
  const keys = cosmeticKeys(host);
  const listsEhide = onList(host, cm.elemhide), userEhide = onList(host, u.flags.elemhide);
  const groups = s.level !== 'basic' && !listsEhide && !userEhide ? activeGroups(s, m) : [];
  const entries = [];
  for (const g of groups) for (const k of keys) entries.push((await shard(g, shardOf(k, cm.shards)))[k]);
  if (!userEhide) {
    for (const k of keys) entries.push(u.cosmetic.sites[k]);
    // generic selectors of My filters: on every site, unless $generichide says otherwise
    if (!onList(host, u.flags.generichide)) { const g = u.cosmetic.generic.filter(x => !u.cosmetic.genericExcept.includes(x)); if (g.length) entries.push({ h: g }); }
  }
  const needGeneric = entries.some(e => e && e.x) && !onList(host, cm.generichide);
  const gen = needGeneric ? await Promise.all(groups.map(genericSet)) : [];
  const userGen = new Set(u.cosmetic.generic);
  return siteCosmetics(entries, { specifichide: onList(host, cm.specifichide) || onList(host, u.flags.specifichide), isGeneric: x => userGen.has(x) || gen.some(g => g.has(x)) });
}

ext.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!sender.tab || sender.id !== ext.runtime.id) return;
  // site-specific hiding: the content script asks once per page; the CSS is added by the browser (works with any page CSP)
  if (msg?.t === 'cosmetic') {
    (async () => {
      const s = await settings(), host = String(msg.host || '').toLowerCase();
      if (!host || isPaused(s, host)) return reply(null);
      const { css, proc } = await cosmeticsFor(s, host);
      if (css) await ext.scripting.insertCSS({ target: { tabId: sender.tab.id, frameIds: [sender.frameId ?? 0] }, css });
      reply({ proc });
    })().catch(() => reply(null));
    return true;
  }
  // the zapper: "Hide" saves site##selector to My filters (sent by the picker Shield injected into this tab)
  if (msg?.t === 'zap-save') {
    (async () => {
      const host = String(msg.host || '').toLowerCase(), sel = String(msg.selector || '').trim();
      const pageSite = siteOf(sender.url || sender.tab.url || '');
      if (!host || !sel || sel.length > 1000 || !pageSite || host.replace(/^www\./, '') !== pageSite) return reply({ ok: false });
      const line = zapLine(host, sel);
      const check = compileUserFilters(line);
      if (check.errors.length) return reply({ ok: false, error: check.errors[0].error });
      const { myFilters = '' } = await ext.storage.local.get('myFilters');
      if (!myFilters.split(/\r?\n/).includes(line)) await ext.storage.local.set({ myFilters: (myFilters && !myFilters.endsWith('\n') ? myFilters + '\n' : myFilters) + line + '\n' });
      await ext.scripting.insertCSS({ target: { tabId: sender.tab.id, allFrames: true }, css: `${sel}{display:none!important}` }).catch(() => { });
      reply({ ok: true, line });
    })().catch(() => reply({ ok: false }));
    return true;
  }
});
