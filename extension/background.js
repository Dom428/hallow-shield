// Hallow Shield background: turns your settings (blocking level, lists, the cookie-banner and annoyance switches,
// paused sites, My filters) into what the browser does. The blocking itself is done by the browser from the rule
// files - this script never sees your requests.
//   - rulesets: the lists you have on (static rulesets; if the browser's shared pool has no room for one, its rules are
//     loaded as dynamic rules instead, within the browser's 30,000-rule dynamic budget)
//   - paused sites: one dynamic "allow everything" rule per site, above every list rule
//   - My filters: your network filters as dynamic rules, your hiding filters next to the lists' (and the zapper's)
//   - cosmetic filtering and scriptlets (levels Optimal and Complete): registered content scripts, paused sites left out
//   - sites set to Strict: Complete + annoyances there only (content scripts limited to those sites, and the pop-up and
//     annoyance lists' rules as dynamic rules limited to pages of those sites); Off is the same as Pause
//   - "Handle cookie banners": the cookie list's "click Reject" jobs for a site, handed to content.js / clicker.js
//   - stats (options page): what the browser says it blocked, per day, kept in storage.local only
//   - 1.5: sites left on "No hiding" / "Blocking only" by "Try fixing this site" (popup), the badge colour (follows the
//     level, or the site's own mode), and procedural.js / clicker.js injected only into frames that need them
import { cosmeticKeys, shardOf, onList, siteCosmetics, pauseRule, PAUSE_BASE, USER_BASE, USER_MAX, USER_REGEX_MAX, STRICT_BASE, STRICT_MAX, patternsFor, wantedRulesets, groupOn, siteOf, siteModeOf, withSiteMode, strictRule, validDomain, badgeColor, MODE_KEYS, LEVELS, DEFAULT_LEVEL } from './shared.js';
import { compileUserFilters, zapLine } from './userfilters.js';
import { emptyStats, addBlock, addClick, prune, summary, categoryOf, domainOfRule, hostOf, clicksOn } from './stats.js';
import { familyReport, browserName, newProfileId, FAMILY_HOST } from './family.js';

const ext = globalThis.browser ?? chrome;
const dnr = ext.declarativeNetRequest;
const url = p => ext.runtime.getURL(p);
const json = p => fetch(url(p)).then(r => r.json());
const once = f => { let p = null; return () => p ||= f().catch(e => { p = null; throw e; }); };
const meta = once(() => json('rules/meta.json'));
const cmeta = once(() => json('rules/cosmetic-meta.json'));
const scriptlets = once(() => json('rules/scriptlets.json'));
const clicks = once(() => json('rules/clicks.json').catch(() => ({ args: [], hosts: {}, exc: {} })));
// version.json is written into the release zips; without it (a source checkout) or with "dev": true, this is a
// development build - the only kind that uses the browser's onRuleMatchedDebug for the stats
const devBuild = once(() => json('version.json').then(v => v.dev === true).catch(() => true));
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
  const s = await ext.storage.local.get({ paused: [], strict: [], noHide: [], blockOnly: [], level: null, lists: {}, cookies: true, annoyances: false, myFilters: '', ads: true, privacy: true, hide: true, debugNoRoom: [] });
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
// what a Strict site gets: every group that's on, plus the annoyances (lists switched off in Advanced stay off)
const strictGroups = (s, m) => [...new Set([...activeGroups(s, m), ...((m.groups?.annoyances?.lists || []).some(id => s.lists?.[id] !== false) ? ['annoyances'] : [])])];
// the groups that apply on one site (none at Basic, unless the site is Strict)
const groupsFor = (s, m, host) => siteModeOf(s, host) === 'strict' ? strictGroups(s, m) : s.level !== 'basic' ? activeGroups(s, m) : [];
// 1.5: "No hiding" sites get no hiding (the lists' or yours); "Blocking only" sites nothing in their pages at all
const sitePats = list => (list || []).filter(validDomain).flatMap(d => [`*://${d}/*`, `*://*.${d}/*`]);
const strictSites = s => (s.strict || []).filter(d => validDomain(d) && !onList(d, s.paused));
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
  let safe = 30000 - 600 - USER_MAX - STRICT_MAX, unsafe = 4900 - 200, regex = 900 - USER_REGEX_MAX, id = 1;
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
  const old = (await dnr.getDynamicRules()).filter(r => r.id >= USER_BASE && r.id < STRICT_BASE);
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

// Strict sites: the pop-up list and the annoyance lists that aren't on for everyone, as dynamic rules that only apply to
// requests from pages of those sites (regex, redirect and header rules left out, at most STRICT_MAX rules)
async function syncStrict() {
  const s = await settings(), sites = strictSites(s), m = await meta();
  const old = (await dnr.getDynamicRules()).filter(r => r.id >= STRICT_BASE);
  const add = [], notBlock = [];
  if (sites.length) {
    const on = await dnr.getEnabledRulesets();
    const sets = ['popups', ...(m.groups?.annoyances?.lists || []).filter(id => s.lists?.[id] !== false)].filter(id => !on.includes(id));
    for (const set of sets) {
      let rules; try { rules = await json(`rules/${set}.json`); } catch { continue; }
      for (const r of rules) {
        if (add.length >= STRICT_MAX) break;
        const nr = strictRule(r, sites, STRICT_BASE + add.length + 1);
        if (!nr) continue;
        if (nr.action.type !== 'block') notBlock.push(nr.id);
        add.push(nr);
      }
    }
  }
  let error = '';
  try { await dnr.updateDynamicRules({ removeRuleIds: old.map(r => r.id), addRules: add }); }
  catch (e) { error = String(e && e.message || e); await dnr.updateDynamicRules({ removeRuleIds: old.map(r => r.id) }).catch(() => { }); }
  await ext.storage.local.set({ strictNotBlock: notBlock, strictRules: error ? 0 : add.length, strictError: error });
}

// ---- content scripts: CSS, the cosmetic script and the scriptlets ----
async function syncScripts() {
  const s = await settings(), m = await meta(), u = user(s);
  const exclude = [...s.paused.flatMap(d => [`*://${d}/*`, `*://*.${d}/*`]), ...sitePats(s.blockOnly)];
  const noHide = sitePats(s.noHide);
  const scripts = [];
  const base = { allFrames: true, runAt: 'document_start' };
  // groups on for every site, and the extra ones that only run on Strict sites
  const global = s.level !== 'basic' ? activeGroups(s, m) : [];
  const strictPats = patternsFor(strictSites(s));
  const extra = strictPats.length ? strictGroups(s, m).filter(g => !global.includes(g)) : [];
  if (global.length || extra.length) {
    const cm = await cmeta();
    const ghide = [...cm.generichide, ...cm.elemhide, ...u.flags.generichide, ...u.flags.elemhide], ehide = [...cm.elemhide, ...u.flags.elemhide];
    for (const g of [...global, ...extra]) {
      const sfx = g === 'main' ? '' : '-' + g, matches = global.includes(g) ? ['<all_urls>'] : strictPats;
      // 1.5: only stylesheets with rules in them (each one is added to every frame); most generic rules are looked up
      // by class / id instead (content.js -> "generic")
      const c = (g === 'main' ? m.cosmetic : m.groups?.[g]?.cosmetic) || {};
      if (c.genericCss !== 0) scripts.push({ ...base, id: 'shield-generic' + sfx, matches, excludeMatches: [...exclude, ...noHide, ...patternsFor(ghide)], css: [dirOf(g) + 'generic.css'] });
      if (c.specificGeneric !== 0) scripts.push({ ...base, id: 'shield-sg' + sfx, matches, excludeMatches: [...exclude, ...noHide, ...patternsFor(ehide)], css: [dirOf(g) + 'specific-generic.css'] });
    }
    // the bundles of a Strict-only group are registered on the Strict sites; each bundle checks the site itself
    // 1.8: "core" (group "*", MAIN world) is the scriptlets' code, wherever any group's page fixes run; the bundles are small
    // loaders (ISOLATED world) that read only their own site's filters (rules/sl/) and hand them to the core
    for (const b of await scriptlets()) {
      const g = b.group || 'main', world = b.world || 'MAIN';
      if (g === '*') scripts.push({ ...base, id: 'shield-sl-' + b.id, matches: global.length ? b.matches : strictPats, excludeMatches: exclude, js: [b.file], world });
      else if (global.includes(g)) scripts.push({ ...base, id: 'shield-sl-' + b.id, matches: b.matches, excludeMatches: exclude, js: [b.file], world });
      else if (extra.includes(g)) scripts.push({ ...base, id: 'shield-sl-' + b.id, matches: strictPats, excludeMatches: exclude, js: [b.file], world });
    }
  }
  // the cosmetic script (it gets procedural.js / clicker.js only when the site needs them): everywhere from Optimal up; at Basic only where
  // something still needs it - what you hid yourself (every site) or a Strict site
  const cosmeticOn = global.length || u.counts.cosmetic ? ['<all_urls>'] : strictPats;
  if (cosmeticOn.length) scripts.push({ ...base, id: 'shield-cosmetic', matches: cosmeticOn, excludeMatches: exclude, js: ['content.js'] });
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
const syncAll = () => serial(() => Promise.all([syncRulesets().then(syncStrict), syncPauses(), syncUser(), syncScripts()]));

// the badge colour follows the blocking level (and a site's own mode, on that site's tabs)
async function badgeFor(tabId, url) {
  const s = await settings(), color = badgeColor(s.level, siteModeOf(s, siteOf(url || '') || ''));
  const o = tabId === undefined ? {} : { tabId };
  try { await ext.action.setBadgeBackgroundColor({ ...o, color }); } catch { }
  try { if (ext.action.setBadgeTextColor) await ext.action.setBadgeTextColor({ ...o, color: '#ffffff' }); } catch { }
}
async function badgeAll() {
  await badgeFor(undefined, '');
  try { for (const t of await ext.tabs.query({})) if (t.url) await badgeFor(t.id, t.url); } catch { }
}
ext.tabs?.onUpdated.addListener((tabId, info, tab) => { if (info.url || info.status === 'loading') badgeFor(tabId, info.url || tab?.url).catch(() => { }); });
badgeAll().catch(() => { });

ext.runtime.onInstalled.addListener(() => { syncAll(); try { dnr.setExtensionActionOptions({ displayActionCountAsBadgeText: true }); } catch { } startStats(); });
ext.runtime.onStartup?.addListener(() => { syncAll(); startStats(); });
ext.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  const k = Object.keys(changes);
  if (k.every(x => ['fallback', 'fallbackNotBlock', 'scriptErrors', 'userRefused', 'userNotBlock', 'userSynced', 'stats', 'strictNotBlock', 'strictRules', 'strictError', 'fixFlow', 'family', 'familyProfile', 'familyLast'].includes(x))) return;
  cosmeticCache.clear();
  if (k.some(x => Object.values(MODE_KEYS).includes(x))) serial(() => Promise.all([syncPauses(), syncScripts(), syncStrict()]));
  if (k.some(x => ['level', ...Object.values(MODE_KEYS)].includes(x))) badgeAll().catch(() => { });
  if (k.some(x => ['level', 'lists', 'debugNoRoom', 'cookies', 'annoyances'].includes(x))) serial(() => Promise.all([syncRulesets().then(syncStrict), syncScripts()]));
  if (k.includes('myFilters')) serial(() => Promise.all([syncUser(), syncScripts()]));
});

// the hiding for one page: the lists' per-site filters of the groups that are on (not at Basic), plus My filters.
// 1.5: kept per site until a setting changes (every frame and page of a site asks again)
const cosmeticCache = new Map();
function cosmeticsFor(s, host) {
  let p = cosmeticCache.get(host);
  if (!p) {
    if (cosmeticCache.size > 300) cosmeticCache.clear();
    p = cosmeticsCompute(s, host).catch(e => { cosmeticCache.delete(host); throw e; });
    cosmeticCache.set(host, p);
  }
  return p;
}
async function cosmeticsCompute(s, host) {
  const m = await meta(), cm = await cmeta(), u = user(s);
  const keys = cosmeticKeys(host);
  const listsEhide = onList(host, cm.elemhide), userEhide = onList(host, u.flags.elemhide);
  const groups = !listsEhide && !userEhide ? groupsFor(s, m, host) : [];
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

// 1.5: generic hiding by class / id: which groups' keyed generic selectors apply on a site, minus its exceptions
// (null: none - Basic, $generichide / $elemhide, No hiding / Blocking only, or a group switched off)
const genericKeysCache = new Map();
const genericKeys = g => { if (!genericKeysCache.has(g)) genericKeysCache.set(g, json(dirOf(g) + 'generic-keys.json').catch(() => ({}))); return genericKeysCache.get(g); };
function genericInfo(s, host) {
  const k = 'generic ' + host;
  let p = cosmeticCache.get(k);
  if (!p) {
    p = (async () => {
      const m = await meta(), cm = await cmeta(), u = user(s), mode = siteModeOf(s, host);
      if (mode === 'nohide' || mode === 'blockonly' || mode === 'off') return null;
      if ([cm.generichide, cm.elemhide, u.flags.generichide, u.flags.elemhide].some(l => onList(host, l))) return null;
      const groups = groupsFor(s, m, host);
      if (!groups.length) return null;
      const except = new Set();
      for (const key of cosmeticKeys(host)) {
        for (const g of groups) { const e = (await shard(g, shardOf(key, cm.shards)))[key]; if (e && e.x) for (const x of e.x) except.add(x); }
        const ue = u.cosmetic.sites[key]; if (ue && ue.x) for (const x of ue.x) except.add(x);
      }
      return { maps: await Promise.all(groups.map(genericKeys)), except };
    })().catch(e => { cosmeticCache.delete(k); throw e; });
    cosmeticCache.set(k, p);
  }
  return p;
}
async function genericCss(s, host, tokens) {
  const info = await genericInfo(s, host);
  if (!info) return '';
  const out = new Set();
  for (const t of tokens) { if (typeof t !== 'string') continue; for (const map of info.maps) { const l = map[t]; if (l) for (const sel of l) if (!info.except.has(sel)) out.add(sel); } }
  return [...out].map(x => x + '{display:none!important}').join('\n');
}

// the cookie list's "click Reject" jobs for one site: [[selectors, extraMatch, delay]] (exceptions applied)
async function clicksFor(host) {
  const c = await clicks(), keys = cosmeticKeys(host), use = new Set();
  for (const k of keys) for (const i of c.hosts[k] || []) use.add(i);
  for (const k of keys) for (const i of c.exc[k] || []) { if (i < 0) use.clear(); else use.delete(i); }
  return [...use].map(i => c.args[i]);
}

ext.runtime.onMessage.addListener((msg, sender, reply) => {
  if (sender.id !== ext.runtime.id) return;
  // Shield's own pages (the options page), not web pages: stats
  if ((sender.url || '').startsWith(url(''))) {
    if (msg?.t === 'stats-get') { (async () => { await collectMatched(true); reply(await statsView()); })().catch(e => reply({ error: String(e) })); return true; }
    // 1.6: the Hallow family bridge - send the counts now (the popup when it opens, the options switch)
    if (msg?.t === 'family-send') { sendFamily(msg.fresh !== false).then(r => reply(r), e => reply({ ok: false, error: String(e) })); return true; }
    if (msg?.t === 'stats-clear') { (async () => { await statsClear(); reply(await statsView()); })().catch(e => reply({ error: String(e) })); return true; }
    // the popup: cookie banners answered on this site (last 30 days)
    if (msg?.t === 'site-clicks') { (async () => { await statsLoad(); reply({ n: clicksOn(statsMem, String(msg.site || '')) }); })().catch(() => reply({ n: 0 })); return true; }
    // the popup ("Try fixing this site"): one site's mode, applied (rules and page scripts) before the tab is reloaded
    if (msg?.t === 'site-mode') {
      (async () => {
        const site = String(msg.site || '').toLowerCase(), mode = String(msg.mode || '');
        if (!validDomain(site) || !['normal', ...Object.keys(MODE_KEYS)].includes(mode)) return reply({ ok: false });
        const cur = await ext.storage.local.get(Object.fromEntries(Object.values(MODE_KEYS).map(k => [k, []])));
        const next = withSiteMode(cur, site, mode);
        // back to Normal: a parent domain's entry (example.com for shop.example.com) would still apply, so it goes too
        if (mode === 'normal') for (const k of Object.values(MODE_KEYS)) next[k] = next[k].filter(d => !site.endsWith('.' + d));
        await ext.storage.local.set(next);
        cosmeticCache.clear();
        await serial(() => Promise.all([syncPauses(), syncScripts(), syncStrict()]));
        if (Number.isInteger(msg.tabId)) await ext.tabs.reload(msg.tabId).catch(() => { });
        reply({ ok: true, mode: siteModeOf(next, site) });
      })().catch(e => reply({ ok: false, error: String(e) }));
      return true;
    }
    return;
  }
  if (!sender.tab) return;
  // site-specific hiding: the content script asks once per page; the CSS is added by the browser (works with any page CSP)
  if (msg?.t === 'cosmetic') {
    (async () => {
      const s = await settings(), host = String(msg.host || '').toLowerCase();
      if (!host || isPaused(s, host)) return reply(null);
      const mode = siteModeOf(s, host);
      if (mode === 'blockonly') return reply(null);
      const { css, proc } = mode === 'nohide' ? { css: '', proc: [] } : await cosmeticsFor(s, host);
      const frame = sender.documentId ? { tabId: sender.tab.id, documentIds: [sender.documentId] } : { tabId: sender.tab.id, frameIds: [sender.frameId ?? 0] };
      if (css) await ext.scripting.insertCSS({ target: frame, css });
      // "Handle cookie banners": only with the cookie group on for this site (switch on; not at Basic unless Strict)
      const wantClicks = groupsFor(s, await meta(), host).includes('cookies') && s.lists?.['ublock-cookies'] !== false;
      const clickJobs = wantClicks ? await clicksFor(host) : [];
      // the engines this frame needs, injected only now (most frames need neither)
      const files = [...(proc.length ? ['procedural.js'] : []), ...(clickJobs.length ? ['clicker.js'] : [])];
      if (files.length) await ext.scripting.executeScript({ target: frame, files }).catch(() => ext.scripting.executeScript({ target: { tabId: sender.tab.id, frameIds: [sender.frameId ?? 0] }, files }));
      reply({ proc, clicks: clickJobs, generic: !!(await genericInfo(s, host)) });
    })().catch(() => reply(null));
    return true;
  }
  // 1.5: the class / id names a page uses -> the generic hiding rules for them, added to that frame
  if (msg?.t === 'generic') {
    (async () => {
      const s = await settings(), host = String(msg.host || '').toLowerCase();
      if (!host || isPaused(s, host) || !Array.isArray(msg.tokens)) return;
      const css = await genericCss(s, host, msg.tokens.slice(0, 5000));
      const frame = sender.documentId ? { tabId: sender.tab.id, documentIds: [sender.documentId] } : { tabId: sender.tab.id, frameIds: [sender.frameId ?? 0] };
      if (css) await ext.scripting.insertCSS({ target: frame, css });
    })().catch(() => { });
    return;
  }
  // a click the clicker made: counted (and only believed from a site Shield isn't paused on)
  if (msg?.t === 'clicked') {
    (async () => {
      const s = await settings(), host = String(msg.host || '').toLowerCase();
      if (!host || isPaused(s, host)) return;
      await statsLoad(); addClick(statsMem, Date.now(), siteOf(sender.tab.url || '') || host.replace(/^www\./, '')); statsSave();
    })().catch(() => { });
    return;
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

// ---- stats: what the browser blocked, per day (options page "Stats"), kept in storage.local only ----
// Where the numbers come from (the browser never tells an extension about requests without asking):
//   - with the optional "declarativeNetRequestFeedback" access (you switch stats on, on the options page): the browser's
//     own list of the rules it applied (getMatchedRules) - which list, which tab, when - read once a minute and when a
//     tab closes, within the browser's limit of 20 reads per 10 minutes. The blocked host is known when the rule names
//     one host; the page's site comes from the tab.
//   - development builds only (no version.json, or "dev": true): onRuleMatchedDebug, which also gives the address.
//   - the cookie-banner clicks: counted by Shield itself, with or without that access.
let statsMem = null, statsTimer = 0;
const STATS_ALARM = 'shield-stats';
async function statsLoad() { if (!statsMem) statsMem = (await ext.storage.local.get({ stats: null })).stats || emptyStats(); return statsMem; }
function statsSave() { clearTimeout(statsTimer); statsTimer = setTimeout(() => { prune(statsMem); ext.storage.local.set({ stats: statsMem }).catch(() => { }); }, 500); }
async function statsClear() { clearTimeout(statsTimer); statsMem = emptyStats(); statsMem.last = Date.now(); await ext.storage.local.set({ stats: statsMem }); }
const hasFeedback = () => ext.permissions.contains({ permissions: ['declarativeNetRequestFeedback'] }).catch(() => false);
async function statsView() {
  await statsLoad();
  const feedback = await hasFeedback(), dev = await devBuild();
  return { ...summary(prune(statsMem)), feedback, source: feedback ? (dev && dnr.onRuleMatchedDebug ? 'debug' : 'matched') : 'clicks-only' };
}
function startStats() { try { ext.alarms?.create(STATS_ALARM, { periodInMinutes: 1 }); } catch { } }
ext.alarms?.onAlarm.addListener(a => { if (a.name === STATS_ALARM) collectMatched(false).finally(() => sendFamily(false)); });

// ---- 1.6: the Hallow family bridge (family.js): with "Share counts with Hallow apps on this PC" on (the optional
// "nativeMessaging" access + family: true), the counts go to the native host com.hallow.shield (HallowShieldBridge.exe)
// about once a minute (with the stats alarm) and when the popup opens. Only counts, the level, the version, the browser's
// name and a random profile id - never a URL, a site or history. Off: nothing is sent and the host isn't started.
const hasNative = () => ext.permissions.contains({ permissions: ['nativeMessaging'] }).catch(() => false);
function thisBrowser() {
  const n = globalThis.navigator || {};
  return browserName({ brands: n.userAgentData?.brands || [], ua: n.userAgent || '', brave: !!n.brave, firefox: url('').startsWith('moz-extension:') });
}
let familyBusy = null;
function sendFamily(fresh) {
  if (familyBusy) return familyBusy;
  familyBusy = (async () => {
    const { family } = await ext.storage.local.get({ family: false });
    if (family !== true || !(await hasNative()) || !ext.runtime.sendNativeMessage) return { ok: false, off: true };
    if (fresh) await collectMatched(true).catch(() => { });
    let { familyProfile } = await ext.storage.local.get({ familyProfile: '' });
    if (!familyProfile) { familyProfile = newProfileId(); await ext.storage.local.set({ familyProfile }); }
    const s = await settings(), counted = await hasFeedback();
    await statsLoad();
    const msg = familyReport({ stats: statsMem, counted, level: s.level, version: ext.runtime.getManifest().version, browser: thisBrowser(), profile: familyProfile });
    let r;
    try { r = await ext.runtime.sendNativeMessage(FAMILY_HOST, msg); r = r && r.ok ? { ok: true } : { ok: false, error: (r && r.error) || 'no answer' }; }
    catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
    await ext.storage.local.set({ familyLast: { t: Date.now(), ...r } });
    return r;
  })().finally(() => { familyBusy = null; });
  return familyBusy;
}

// the site of a tab at a given time (tabs remember their last few addresses)
const tabSites = new Map();
function noteTab(tabId, u) {
  const site = siteOf(u || ''); if (tabId < 0) return;
  const h = tabSites.get(tabId) || [];
  if (!h.length || h[h.length - 1].site !== site) { h.push({ t: Date.now(), site }); if (h.length > 8) h.shift(); tabSites.set(tabId, h); }
}
async function siteAt(tabId, t) {
  if (tabId < 0) return null;
  const h = tabSites.get(tabId);
  if (h && h.length) { let s = h[0].site; for (const e of h) if (e.t <= t) s = e.site; return s; }
  try { const tab = await ext.tabs.get(tabId); noteTab(tabId, tab.url); return siteOf(tab.url); } catch { tabSites.set(tabId, [{ t: 0, site: null }]); return null; }
}
ext.tabs?.onUpdated.addListener((tabId, info, tab) => {
  if (info.url) { noteTab(tabId, info.url); }
  else if (tab && tab.url) noteTab(tabId, tab.url);
});
ext.tabs?.onRemoved.addListener(tabId => { collectMatched(false, true).finally(() => tabSites.delete(tabId)); });

// rule id -> the host it blocks (from the rule files, loaded once; the dynamic rules once per read)
const ruleHosts = new Map();
const hostMap = rules => new Map(rules.map(r => [r.id, domainOfRule(r)]));
async function hostOfRule(rulesetId, ruleId, dynamic) {
  if (rulesetId === '_session') return null;
  if (rulesetId === '_dynamic') return dynamic ? (await dynamic()).get(ruleId) || null : null;
  if (!ruleHosts.has(rulesetId)) ruleHosts.set(rulesetId, json(`rules/${rulesetId}.json`).then(hostMap).catch(() => new Map()));
  return (await ruleHosts.get(rulesetId)).get(ruleId) || null;
}
const notBlockSets = async () => { const r = await ext.storage.local.get({ fallbackNotBlock: [], userNotBlock: [], strictNotBlock: [] }); return { fallback: new Set(r.fallbackNotBlock), user: new Set(r.userNotBlock), strict: new Set(r.strictNotBlock) }; };

// getMatchedRules, within the browser's quota (20 calls per 10 minutes): on its own (the minute alarm, a tab closing -
// never while a page is navigating: the browser's tests showed that can delay its own allow-rule bookkeeping) at most
// 12 per 10 minutes and one per 45 s; when the stats page asks, up to 19
const calls = [];
let collecting = null;
function collectMatched(force, soon = false) {
  if (collecting) return collecting;
  collecting = (async () => {
    if (!dnr.getMatchedRules || !(await hasFeedback())) return;
    if ((await devBuild()) && dnr.onRuleMatchedDebug) return;   // development builds count every match as it happens
    const now = Date.now();
    while (calls.length && calls[0] < now - 600000) calls.shift();
    if (calls.length >= (force ? 19 : 12) || (!force && calls.length && now - calls[calls.length - 1] < 45000)) return;
    calls.push(now);
    await statsLoad();
    const m = await dnr.getMatchedRules({ minTimeStamp: (statsMem.last || 0) + 1 });
    const mt = await meta(), nb = await notBlockSets();
    let last = statsMem.last || 0, dyn = null;
    const dynamic = () => (dyn ||= dnr.getDynamicRules().then(hostMap).catch(() => new Map()));
    for (const info of m.rulesMatchedInfo || []) {
      if (info.timeStamp <= (statsMem.last || 0)) continue;
      last = Math.max(last, info.timeStamp);
      const cat = categoryOf(info.rule, mt, nb);
      if (!cat) continue;
      addBlock(statsMem, { t: info.timeStamp, cat, site: await siteAt(info.tabId, info.timeStamp), domain: await hostOfRule(info.rule.rulesetId, info.rule.ruleId, dynamic) });
    }
    statsMem.last = last;
    statsSave();
  })().catch(e => console.warn('Hallow Shield stats:', e)).finally(() => { collecting = null; });
  return collecting;
}
// development builds: every match as it happens, with the address
try {
  dnr.onRuleMatchedDebug?.addListener(info => {
    devBuild().then(async dev => {
      if (!dev) return;
      const cat = categoryOf(info.rule, await meta(), await notBlockSets());
      if (!cat) return;
      await statsLoad();
      const t = Date.now();
      addBlock(statsMem, { t, cat, site: (await siteAt(info.request.tabId, t)) || hostOf(info.request.initiator || ''), domain: hostOf(info.request.url) });
      statsMem.last = t;
      statsSave();
    }).catch(() => { });
  });
} catch { }
