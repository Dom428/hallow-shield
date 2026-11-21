// Hallow Shield background: turns your settings (blocking level, lists, paused sites) into what the browser does.
// The blocking itself is done by the browser from the rule files - this script never sees your requests.
//   - rulesets: the lists you have on (static rulesets; if the browser's shared pool has no room for one, its rules are
//     loaded as dynamic rules instead, within the browser's 30,000-rule dynamic budget)
//   - paused sites: one dynamic "allow everything" rule per site, above every list rule
//   - cosmetic filtering and scriptlets (levels Optimal and Complete): registered content scripts, paused sites left out
import { cosmeticKeys, shardOf, onList, siteCosmetics, pauseRule, PAUSE_BASE, patternsFor, wantedRulesets, LEVELS, DEFAULT_LEVEL } from './shared.js';

const ext = globalThis.browser ?? chrome;
const dnr = ext.declarativeNetRequest;
const url = p => ext.runtime.getURL(p);
const json = p => fetch(url(p)).then(r => r.json());
const once = f => { let p = null; return () => p ||= f().catch(e => { p = null; throw e; }); };
const meta = once(() => json('rules/meta.json'));
const cmeta = once(() => json('rules/cosmetic-meta.json'));
const scriptlets = once(() => json('rules/scriptlets.json'));
const genericSet = once(async () => new Set((await (await fetch(url('rules/generic.css'))).text()).split('\n').map(l => l.replace(/\{display:none!important\}$/, '')).filter(Boolean)));
const shards = new Map();
const shard = n => { if (!shards.has(n)) shards.set(n, json(`rules/cosmetic/${n}.json`).catch(() => ({}))); return shards.get(n); };
const LIST_IDS = ['ublock-filters', 'easylist', 'easyprivacy', 'ublock-badware', 'ublock-privacy', 'ublock-unbreak', 'ublock-quick-fixes', 'plowe'];

async function settings() {
  const s = await ext.storage.local.get({ paused: [], level: null, lists: {}, ads: true, privacy: true, hide: true, debugNoRoom: [] });
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

// ---- rulesets ----
let lastFallback = null;
async function syncRulesets() {
  const s = await settings(), m = await meta();
  const want = wantedRulesets(s, LIST_IDS);
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
// block/allow - and 5,000 others; regex rules share 1,000 with the session rules)
async function syncFallback(ids) {
  const key = JSON.stringify(ids);
  if (key === lastFallback) return;
  const old = (await dnr.getDynamicRules()).filter(r => r.id < PAUSE_BASE);
  const add = [], info = {}, notBlock = [];
  let safe = 30000 - 600, unsafe = 4900, regex = 900, id = 1;
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
  const old = (await dnr.getDynamicRules()).filter(r => r.id >= PAUSE_BASE);
  await dnr.updateDynamicRules({ removeRuleIds: old.map(r => r.id), addRules: s.paused.map((d, i) => pauseRule(d, PAUSE_BASE + i)) });
}

// ---- content scripts: CSS, the cosmetic script and the scriptlets ----
async function syncScripts() {
  const s = await settings();
  const exclude = s.paused.flatMap(d => [`*://${d}/*`, `*://*.${d}/*`]);
  const scripts = [];
  if (s.level !== 'basic') {
    const cm = await cmeta();
    const base = { allFrames: true, runAt: 'document_start' };
    scripts.push({ ...base, id: 'shield-generic', matches: ['<all_urls>'], excludeMatches: [...exclude, ...patternsFor([...cm.generichide, ...cm.elemhide])], css: ['rules/generic.css'] });
    scripts.push({ ...base, id: 'shield-sg', matches: ['<all_urls>'], excludeMatches: [...exclude, ...patternsFor(cm.elemhide)], css: ['rules/specific-generic.css'] });
    scripts.push({ ...base, id: 'shield-cosmetic', matches: ['<all_urls>'], excludeMatches: exclude, js: ['content.js'] });
    for (const b of await scriptlets()) scripts.push({ ...base, id: 'shield-sl-' + b.id, matches: b.matches, excludeMatches: exclude, js: [b.file], world: 'MAIN' });
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
const syncAll = () => serial(() => Promise.all([syncRulesets(), syncPauses(), syncScripts()]));

ext.runtime.onInstalled.addListener(() => { syncAll(); try { dnr.setExtensionActionOptions({ displayActionCountAsBadgeText: true }); } catch { } });
ext.runtime.onStartup?.addListener(() => syncAll());
ext.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  const k = Object.keys(changes);
  if (k.every(x => x === 'fallback' || x === 'fallbackNotBlock' || x === 'scriptErrors')) return;
  if (k.includes('paused')) serial(() => Promise.all([syncPauses(), syncScripts()]));
  if (k.some(x => x === 'level' || x === 'lists' || x === 'debugNoRoom')) serial(() => Promise.all([syncRulesets(), syncScripts()]));
});

// site-specific ad boxes: the content script asks once per page; the CSS is added by the browser (works with any page CSP)
ext.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.t !== 'cosmetic' || !sender.tab) return;
  (async () => {
    const s = await settings(), host = String(msg.host || '').toLowerCase();
    if (s.level === 'basic' || !host || isPaused(s, host)) return reply(null);
    const cm = await cmeta();
    if (onList(host, cm.elemhide)) return reply(null);
    const keys = cosmeticKeys(host);
    const entries = await Promise.all(keys.map(async k => (await shard(shardOf(k, cm.shards)))[k]));
    const needGeneric = entries.some(e => e && e.x) && !onList(host, cm.generichide);
    const gen = needGeneric ? await genericSet() : null;
    const { css, proc } = siteCosmetics(entries, { specifichide: onList(host, cm.specifichide), isGeneric: x => !!gen && gen.has(x) });
    if (css) await ext.scripting.insertCSS({ target: { tabId: sender.tab.id, frameIds: [sender.frameId ?? 0] }, css });
    reply({ proc });
  })().catch(() => reply(null));
  return true;
});
