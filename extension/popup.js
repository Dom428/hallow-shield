// Hallow Shield popup: this site (Strict / Normal / Off - Off is the same as Pause) and what was blocked on it, the blocking level, the cookie-banner and
// annoyance switches, the element zapper and My filters, the lists (Advanced), and "Report a broken site" (copies the details to your clipboard - Shield sends nothing anywhere).
import { siteOf, validDomain, siteModeOf, withSiteMode, LEVELS, DEFAULT_LEVEL, PAUSE_BASE, USER_BASE, STRICT_BASE } from './shared.js';
const ext = globalThis.browser ?? chrome;
const $ = id => document.getElementById(id);

// the tab you opened the popup on (tests open popup.html?tab=<id> as a page for a given tab)
const forTab = Number(new URLSearchParams(location.search).get('tab'));
const tab = forTab ? await ext.tabs.get(forTab) : (await ext.tabs.query({ active: true, currentWindow: true }))[0];
const site = tab && siteOf(tab.url);
const s = await ext.storage.local.get({ paused: [], strict: [], strictNotBlock: [], level: DEFAULT_LEVEL, lists: {}, cookies: true, annoyances: false, myFilters: '', fallback: {}, fallbackNotBlock: [], userNotBlock: [] });
if (!LEVELS.includes(s.level)) s.level = DEFAULT_LEVEL;
const meta = await (await fetch(ext.runtime.getURL('rules/meta.json'))).json();
const version = ext.runtime.getManifest().version;

$('site').textContent = site || 'This page';
// this site: Strict (Complete + annoyances here only), Normal (the settings below) or Off (= Pause)
const mode = () => siteModeOf(s, site);
const MODE_NOTE = {
  strict: site => 'Strict on ' + site + ': Complete blocking plus annoyances, on this site only.',
  off: site => 'Shield is off on ' + site + ' (the same as Pause): ads and trackers are allowed here.',
  normal: () => '',
};
function showMode() {
  for (const b of document.querySelectorAll('#mode button')) { const on = b.dataset.mode === mode(); b.classList.toggle('on', on); b.setAttribute('aria-checked', on); }
  $('note').textContent = site && validDomain(site) ? MODE_NOTE[mode()](site) : 'Hallow Shield works on web pages (http and https).';
}
if (!site || !validDomain(site)) for (const b of document.querySelectorAll('#mode button')) b.disabled = true;
for (const b of document.querySelectorAll('#mode button')) b.onclick = async () => {
  if (b.dataset.mode === mode()) return;
  // a site that's on because of a parent domain's setting (sub.example.com under example.com) gets its own entry
  const next = withSiteMode(s, site, b.dataset.mode);
  if (b.dataset.mode === 'normal') { next.paused = next.paused.filter(d => !(site === d || site.endsWith('.' + d))); next.strict = next.strict.filter(d => !(site === d || site.endsWith('.' + d))); }
  Object.assign(s, next);
  await ext.storage.local.set(next);
  showMode();
  if (tab) ext.tabs.reload(tab.id);
};
showMode();

// blocking level
const LEVEL_TEXT = {
  basic: 'Blocks ad and tracker requests only. Nothing runs in the pages you visit.',
  optimal: 'Also hides ad boxes and runs the lists\' small page fixes (YouTube ads included) on sites Shield may access.',
  complete: 'Optimal, plus strict blocking of pop-up and pop-under ad sites. May break a few sites.',
};
let access = true;
try { access = await ext.permissions.contains({ origins: ['<all_urls>'] }); } catch { }
function showLevel() {
  for (const b of document.querySelectorAll('.seg button[data-level]')) { const on = b.dataset.level === s.level; b.classList.toggle('on', on); b.setAttribute('aria-checked', on); }
  $('levelText').textContent = LEVEL_TEXT[s.level] + (s.level !== 'basic' && !access ? ' Shield can\'t access sites yet:' : '');
  $('grant').hidden = s.level === 'basic' || access;
}
for (const b of document.querySelectorAll('.seg button[data-level]')) b.onclick = async () => { s.level = b.dataset.level; await ext.storage.local.set({ level: s.level }); showLevel(); showGroups(); };
$('grant').onclick = async () => { try { access = await ext.permissions.request({ origins: ['<all_urls>'] }); } catch { } showLevel(); };
showLevel();

// cookie banners (on by default) and other annoyances (off by default): each switch turns a group of lists on or off
const GROUPS = ['cookies', 'annoyances'];
const groupIsOn = g => g === 'cookies' ? s.cookies !== false : g === 'annoyances' ? s.annoyances === true : true;
function showGroups() {
  for (const g of GROUPS) for (const box of document.querySelectorAll(`input[data-group="${g}"]`)) box.checked = groupIsOn(g);
  for (const lab of document.querySelectorAll('#lists label[data-in]')) lab.classList.toggle('off', !groupIsOn(lab.dataset.in));
  $('hideNote').textContent = s.level === 'basic' && (s.cookies !== false || s.annoyances) ? 'At Basic only their blocking rules apply: choose Optimal to hide banners and click "Reject" too.' : '';
}
async function setGroup(g, on) { s[g] = on; await ext.storage.local.set({ [g]: on }); showGroups(); }
$('cookies').dataset.group = 'cookies'; $('annoyances').dataset.group = 'annoyances';
$('cookies').onchange = () => setGroup('cookies', $('cookies').checked);
$('annoyances').onchange = () => setGroup('annoyances', $('annoyances').checked);

// the element zapper: injected into this tab only when you click (activeTab + scripting)
async function pick(mode) {
  if (!tab || !site) { $('pickNote').textContent = 'The zapper works on web pages (http and https).'; return; }
  try {
    await ext.scripting.executeScript({ target: { tabId: tab.id }, func: m => { globalThis.__hallowShieldPickMode = m; }, args: [mode] });
    await ext.scripting.executeScript({ target: { tabId: tab.id }, files: ['picker-core.js', 'picker.js'] });
    $('pickNote').textContent = mode === 'zap' ? 'Click what you want gone from this page.' : 'Point at it on the page, then click. Esc cancels.';
    if (!forTab) window.close();
  } catch { $('pickNote').textContent = 'Shield can\'t run on this page (browser pages and extension stores are off limits).'; }
}
$('pick').onclick = () => pick('hide');
$('zap').onclick = () => pick('zap');
$('myfilters').onclick = () => { ext.runtime.openOptionsPage(); if (!forTab) window.close(); };
$('stats').onclick = () => { ext.tabs.create({ url: ext.runtime.getURL('options.html#stats') }); if (!forTab) window.close(); };

// Advanced: the lists, by group (a group's box is the same switch as above)
const fmt = n => n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(n);
const GROUP_TITLE = { main: 'Ads, privacy and security', cookies: 'Cookie banners: hide + reject (on by default)', annoyances: 'Annoyances (off by default)' };
let lastGroup = '';
for (const [id, l] of Object.entries(meta.lists)) {
  const g = l.group || 'main';
  if (g !== lastGroup) {
    lastGroup = g;
    const h = document.createElement(g === 'main' ? 'div' : 'label'); h.className = 'group';
    if (g !== 'main') {
      const gb = document.createElement('input'); gb.type = 'checkbox'; gb.dataset.group = g;
      gb.onchange = () => setGroup(g, gb.checked);
      h.append(gb);
    }
    h.append(document.createTextNode(GROUP_TITLE[g] || g));
    $('lists').append(h);
  }
  const lab = document.createElement('label');
  if (g !== 'main') lab.dataset.in = g;
  const box = document.createElement('input'); box.type = 'checkbox'; box.checked = s.lists[id] !== false; box.dataset.list = id;
  box.onchange = async () => { s.lists = { ...s.lists, [id]: box.checked }; await ext.storage.local.set({ lists: s.lists }); };
  const name = document.createElement('span'); name.textContent = l.name;
  const n = document.createElement('span'); n.className = 'n'; n.textContent = fmt(meta.rulesets[id]?.rules || 0) + ' rules';
  n.title = `${l.network} network filters, ${l.cosmetic} cosmetic, ${l.scriptlets} scriptlets - version ${l.version}`;
  lab.append(box, name, n); $('lists').append(lab);
}
showGroups();
const fb = Object.entries(s.fallback || {});
$('room').textContent = fb.length ? 'Not enough room in the browser\'s shared rule pool for ' + fb.map(([id, f]) => `${meta.lists[id]?.name || id} (${f.loaded} of ${f.of} rules loaded as dynamic rules)`).join(', ') + '.'
  : `Lists built ${meta.built.slice(0, 10)}. They update with new Shield versions.`;

// what the browser blocked on this tab (allowed because you opened this popup on it)
let blocked = null;
try {
  const m = await ext.declarativeNetRequest.getMatchedRules({ tabId: tab.id });
  const notBlock = new Set(s.fallbackNotBlock), userNotBlock = new Set(s.userNotBlock), strictNotBlock = new Set(s.strictNotBlock);
  blocked = m.rulesMatchedInfo.filter(({ rule: r }) => {
    if (r.rulesetId === '_dynamic') return r.ruleId < PAUSE_BASE ? !notBlock.has(r.ruleId) : r.ruleId >= STRICT_BASE ? !strictNotBlock.has(r.ruleId) : r.ruleId >= USER_BASE && !userNotBlock.has(r.ruleId);
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
  const on = Object.keys(meta.lists).filter(id => s.lists[id] !== false && groupIsOn(meta.lists[id].group));
  const text = [
    'Hallow Shield broken-site report',
    `Page: ${page}`,
    `Shield: ${version} (lists built ${meta.built.slice(0, 10)})`,
    `Browser: ${navigator.userAgent}`,
    `Blocking: ${s.level}; this site: ${mode()}${access ? '' : ' (no site access)'}`,
    `Handle cookie banners: ${s.cookies !== false ? 'on' : 'off'}; hide annoyances: ${s.annoyances ? 'on' : 'off'}; my filters: ${s.myFilters.split('\n').filter(l => l.trim() && !l.trim().startsWith('!')).length}`,
    `Lists: ${on.map(id => `${meta.lists[id].name} ${meta.lists[id].version}`).join('; ')}`,
    `Blocked on this page: ${blocked ?? '-'}`,
    fb.length ? `Dynamic fallback: ${fb.map(([id, f]) => `${id} ${f.loaded}/${f.of}`).join(', ')}` : '',
    'What is broken: ',
  ].filter(Boolean).join('\n');
  window.shieldReport = text;
  try { await navigator.clipboard.writeText(text); $('reportNote').textContent = 'Copied. Paste it into your report (for example a uBlock Origin or EasyList issue) - Shield sent nothing.'; }
  catch { $('reportNote').textContent = 'Couldn\'t copy to the clipboard.'; }
};
