// Hallow Shield popup: this site (pause / resume) and what was blocked on it, the blocking level, the lists (Advanced),
// and "Report a broken site" (copies the details to your clipboard - Shield sends nothing anywhere).
import { siteOf, validDomain, LEVELS, DEFAULT_LEVEL, PAUSE_BASE } from './shared.js';
const ext = globalThis.browser ?? chrome;
const $ = id => document.getElementById(id);

// the tab you opened the popup on (tests open popup.html?tab=<id> as a page for a given tab)
const forTab = Number(new URLSearchParams(location.search).get('tab'));
const tab = forTab ? await ext.tabs.get(forTab) : (await ext.tabs.query({ active: true, currentWindow: true }))[0];
const site = tab && siteOf(tab.url);
const s = await ext.storage.local.get({ paused: [], level: DEFAULT_LEVEL, lists: {}, fallback: {}, fallbackNotBlock: [] });
if (!LEVELS.includes(s.level)) s.level = DEFAULT_LEVEL;
const meta = await (await fetch(ext.runtime.getURL('rules/meta.json'))).json();
const version = ext.runtime.getManifest().version;

$('site').textContent = site || 'This page';
const paused = () => site && s.paused.includes(site);
function showPause() {
  $('pause').textContent = paused() ? 'Resume on this site' : 'Pause on this site';
  $('pause').classList.toggle('paused', paused());
  $('note').textContent = paused() ? 'Ads and trackers are allowed on ' + site + '. Reload the page to see the change.' : '';
}
if (!site || !validDomain(site)) { $('pause').disabled = true; $('note').textContent = 'Hallow Shield works on web pages (http and https).'; }
$('pause').onclick = async () => {
  s.paused = paused() ? s.paused.filter(d => d !== site) : [...s.paused, site].slice(-500);
  await ext.storage.local.set({ paused: s.paused });
  showPause();
  if (tab) ext.tabs.reload(tab.id);
};
showPause();

// blocking level
const LEVEL_TEXT = {
  basic: 'Blocks ad and tracker requests only. Nothing runs in the pages you visit.',
  optimal: 'Also hides ad boxes and runs the lists\' small page fixes (YouTube ads included) on sites Shield may access.',
  complete: 'Optimal, plus strict blocking of pop-up and pop-under ad sites. May break a few sites.',
};
let access = true;
try { access = await ext.permissions.contains({ origins: ['<all_urls>'] }); } catch { }
function showLevel() {
  for (const b of document.querySelectorAll('.seg button')) { const on = b.dataset.level === s.level; b.classList.toggle('on', on); b.setAttribute('aria-checked', on); }
  $('levelText').textContent = LEVEL_TEXT[s.level] + (s.level !== 'basic' && !access ? ' Shield can\'t access sites yet:' : '');
  $('grant').hidden = s.level === 'basic' || access;
}
for (const b of document.querySelectorAll('.seg button')) b.onclick = async () => { s.level = b.dataset.level; await ext.storage.local.set({ level: s.level }); showLevel(); };
$('grant').onclick = async () => { try { access = await ext.permissions.request({ origins: ['<all_urls>'] }); } catch { } showLevel(); };
showLevel();

// Advanced: the lists
const fmt = n => n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(n);
for (const [id, l] of Object.entries(meta.lists)) {
  const lab = document.createElement('label');
  const box = document.createElement('input'); box.type = 'checkbox'; box.checked = s.lists[id] !== false; box.dataset.list = id;
  box.onchange = async () => { s.lists = { ...s.lists, [id]: box.checked }; await ext.storage.local.set({ lists: s.lists }); };
  const name = document.createElement('span'); name.textContent = l.name;
  const n = document.createElement('span'); n.className = 'n'; n.textContent = fmt(meta.rulesets[id]?.rules || 0) + ' rules';
  n.title = `${l.network} network filters, ${l.cosmetic} cosmetic, ${l.scriptlets} scriptlets - version ${l.version}`;
  lab.append(box, name, n); $('lists').append(lab);
}
const fb = Object.entries(s.fallback || {});
$('room').textContent = fb.length ? 'Not enough room in the browser\'s shared rule pool for ' + fb.map(([id, f]) => `${meta.lists[id]?.name || id} (${f.loaded} of ${f.of} rules loaded as dynamic rules)`).join(', ') + '.'
  : `Lists built ${meta.built.slice(0, 10)}. They update with new Shield versions.`;

// what the browser blocked on this tab (allowed because you opened this popup on it)
let blocked = null;
try {
  const m = await ext.declarativeNetRequest.getMatchedRules({ tabId: tab.id });
  const notBlock = new Set(s.fallbackNotBlock);
  blocked = m.rulesMatchedInfo.filter(({ rule: r }) => {
    if (r.rulesetId === '_dynamic') return r.ruleId < PAUSE_BASE && !notBlock.has(r.ruleId);
    const rs = meta.rulesets[r.rulesetId];   // in each ruleset: exceptions first, then header/parameter rules, then blocks
    return rs && r.ruleId > rs.allow + rs.modify;
  }).length;
  $('count').textContent = String(blocked);
  $('countText').textContent = blocked === 1 ? 'ad or tracker blocked on this page' : 'ads and trackers blocked on this page';
} catch { $('count').textContent = '-'; }

// Report a broken site: the details go to your clipboard, you paste them wherever you report the problem
$('report').onclick = async () => {
  let page = '-';
  try { const u = new URL(tab.url); page = u.origin + u.pathname; } catch { }
  const on = Object.keys(meta.lists).filter(id => s.lists[id] !== false);
  const text = [
    'Hallow Shield broken-site report',
    `Page: ${page}`,
    `Shield: ${version} (lists built ${meta.built.slice(0, 10)})`,
    `Browser: ${navigator.userAgent}`,
    `Blocking: ${s.level}${paused() ? ' (paused on this site)' : ''}${access ? '' : ' (no site access)'}`,
    `Lists: ${on.map(id => `${meta.lists[id].name} ${meta.lists[id].version}`).join('; ')}`,
    `Blocked on this page: ${blocked ?? '-'}`,
    fb.length ? `Dynamic fallback: ${fb.map(([id, f]) => `${id} ${f.loaded}/${f.of}`).join(', ')}` : '',
    'What is broken: ',
  ].filter(Boolean).join('\n');
  window.shieldReport = text;
  try { await navigator.clipboard.writeText(text); $('reportNote').textContent = 'Copied. Paste it into your report (for example a uBlock Origin or EasyList issue) - Shield sent nothing.'; }
  catch { $('reportNote').textContent = 'Couldn\'t copy to the clipboard.'; }
};
