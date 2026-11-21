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
import { cosmeticKeys, shardOf, onList, siteCosmetics, pauseRule, PAUSE_BASE, USER_BASE, USER_MAX, USER_REGEX_MAX, STRICT_BASE, STRICT_MAX, patternsFor, wantedRulesets, groupOn, siteOf, siteModeOf, strictRule, validDomain, LEVELS, DEFAULT_LEVEL } from './shared.js';
import { compileUserFilters, zapLine } from './userfilters.js';
import { emptyStats, addBlock, addClick, prune, summary, categoryOf, domainOfRule, hostOf } from './stats.js';

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
  const s = await ext.storage.local.get({ paused: [], strict: [], level: null, lists: {}, cookies: true, annoyances: false, myFilters: '', ads: true, privacy: true, hide: true, debugNoRoom: [] });
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
  const exclude = s.paused.flatMap(d => [`*://${d}/*`, `*://*.${d}/*`]);
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
      scripts.push({ ...base, id: 'shield-generic' + sfx, matches, excludeMatches: [...exclude, ...patternsFor(ghide)], css: [dirOf(g) + 'generic.css'] });
      scripts.push({ ...base, id: 'shield-sg' + sfx, matches, excludeMatches: [...exclude, ...patternsFor(ehide)], css: [dirOf(g) + 'specific-generic.css'] });
    }
    // the bundles of a Strict-only group are registered on the Strict sites; each bundle checks the site itself
    for (const b of await scriptlets()) {
      const g = b.group || 'main';
      if (global.includes(g)) scripts.push({ ...base, id: 'shield-sl-' + b.id, matches: b.matches, excludeMatches: exclude, js: [b.file], world: 'MAIN' });
      else if (extra.includes(g)) scripts.push({ ...base, id: 'shield-sl-' + b.id, matches: strictPats, excludeMatches: exclude, js: [b.file], world: 'MAIN' });
    }
  }
  // the cosmetic script (and the cookie-banner clicker next to it): everywhere from Optimal up; at Basic only where
  // something still needs it - what you hid yourself (every site) or a Strict site
  const cosmeticOn = global.length || u.counts.cosmetic ? ['<all_urls>'] : strictPats;
  if (cosmeticOn.length) scripts.push({ ...base, id: 'shield-cosmetic', matches: cosmeticOn, excludeMatches: exclude, js: ['clicker.js', 'content.js'] });
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

ext.runtime.onInstalled.addListener(() => { syncAll(); try { dnr.setExtensionActionOptions({ displayActionCountAsBadgeText: true }); } catch { } startStats(); });
ext.runtime.onStartup?.addListener(() => { syncAll(); startStats(); });
ext.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  const k = Object.keys(changes);
  if (k.every(x => ['fallback', 'fallbackNotBlock', 'scriptErrors', 'userRefused', 'userNotBlock', 'userSynced', 'stats', 'strictNotBlock', 'strictRules', 'strictError'].includes(x))) return;
  if (k.includes('paused') || k.includes('strict')) serial(() => Promise.all([syncPauses(), syncScripts(), syncStrict()]));
  if (k.some(x => ['level', 'lists', 'debugNoRoom', 'cookies', 'annoyances'].includes(x))) serial(() => Promise.all([syncRulesets().then(syncStrict), syncScripts()]));
  if (k.includes('myFilters')) serial(() => Promise.all([syncUser(), syncScripts()]));
});

// the hiding for one page: the lists' per-site filters of the groups that are on (not at Basic), plus My filters
async function cosmeticsFor(s, host) {
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
    if (msg?.t === 'stats-clear') { (async () => { await statsClear(); reply(await statsView()); })().catch(e => reply({ error: String(e) })); return true; }
    return;
  }
  if (!sender.tab) return;
  // site-specific hiding: the content script asks once per page; the CSS is added by the browser (works with any page CSP)
  if (msg?.t === 'cosmetic') {
    (async () => {
      const s = await settings(), host = String(msg.host || '').toLowerCase();
      if (!host || isPaused(s, host)) return reply(null);
      const { css, proc } = await cosmeticsFor(s, host);
      if (css) await ext.scripting.insertCSS({ target: { tabId: sender.tab.id, frameIds: [sender.frameId ?? 0] }, css });
      // "Handle cookie banners": only with the cookie group on for this site (switch on; not at Basic unless Strict)
      const wantClicks = groupsFor(s, await meta(), host).includes('cookies') && s.lists?.['ublock-cookies'] !== false;
      reply({ proc, clicks: wantClicks ? await clicksFor(host) : [] });
    })().catch(() => reply(null));
    return true;
  }
  // a click the clicker made: counted (and only believed from a site Shield isn't paused on)
  if (msg?.t === 'clicked') {
    (async () => {
      const s = await settings(), host = String(msg.host || '').toLowerCase();
      if (!host || isPaused(s, host)) return;
      await statsLoad(); addClick(statsMem, Date.now()); statsSave();
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
ext.alarms?.onAlarm.addListener(a => { if (a.name === STATS_ALARM) collectMatched(false); });

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
