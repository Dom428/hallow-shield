// Hallow Shield: the filter lists, in the order they get room when space is short.
// Each list becomes one static ruleset (rules/<id>.json); "popups" is built from the $popup filters of every list and is
// only switched on at the "Complete" level. The manifest's rule_resources must list exactly these ids (a test checks it).
const UA = 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/';
// uAssets keeps copies of EasyList's annoyance lists split by kind (the same files uBlock Origin offers)
const EA = 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/thirdparties/easylist/';
export const LISTS = [
  { id: 'ublock-filters', name: 'uBlock filters', urls: [UA + 'filters.txt'], trusted: true, group: 'Ads', license: 'GPLv3', home: 'https://github.com/uBlockOrigin/uAssets' },
  { id: 'easylist', name: 'EasyList', urls: ['https://easylist.to/easylist/easylist.txt'], group: 'Ads', license: 'GPLv3 / CC BY-SA 3.0', home: 'https://easylist.to/' },
  { id: 'easyprivacy', name: 'EasyPrivacy', urls: ['https://easylist.to/easylist/easyprivacy.txt'], group: 'Privacy', license: 'GPLv3 / CC BY-SA 3.0', home: 'https://easylist.to/' },
  { id: 'ublock-badware', name: 'uBlock filters - Badware risks', urls: [UA + 'badware.txt'], trusted: true, group: 'Security', license: 'GPLv3', home: 'https://github.com/uBlockOrigin/uAssets' },
  { id: 'ublock-privacy', name: 'uBlock filters - Privacy', urls: [UA + 'privacy.txt'], trusted: true, group: 'Privacy', license: 'GPLv3', home: 'https://github.com/uBlockOrigin/uAssets' },
  { id: 'ublock-unbreak', name: 'uBlock filters - Unbreak', urls: [UA + 'unbreak.txt'], trusted: true, group: 'Fixes', license: 'GPLv3', home: 'https://github.com/uBlockOrigin/uAssets' },
  { id: 'ublock-quick-fixes', name: 'uBlock filters - Quick fixes', urls: [UA + 'quick-fixes.txt'], trusted: true, group: 'Fixes', license: 'GPLv3', home: 'https://github.com/uBlockOrigin/uAssets' },
  { id: 'plowe', name: "Peter Lowe's ad and tracking server list", urls: ['https://pgl.yoyo.org/adservers/serverlist.php?hostformat=adblockplus&showintro=1&mimetype=plaintext'], group: 'Ads', license: 'McRae GPL (see the list)', home: 'https://pgl.yoyo.org/adservers/' },
  // cookie banners: on by default (popup switch "Hide cookie banners")
  { id: 'ublock-cookies', name: 'uBlock filters - Cookie notices', urls: [UA + 'annoyances-cookies.txt'], trusted: true, group: 'Cookies', cosmetic: 'cookies', license: 'GPLv3', home: 'https://github.com/uBlockOrigin/uAssets' },
  { id: 'easylist-cookies', name: 'EasyList Cookie List', urls: [EA + 'easylist-cookies.txt'], group: 'Cookies', cosmetic: 'cookies', license: 'GPLv3 / CC BY-SA 3.0', home: 'https://easylist.to/' },
  // other annoyances: off by default (popup switch "Hide annoyances": newsletter nags, chat bubbles, social widgets)
  { id: 'ublock-annoyances', name: 'uBlock filters - Annoyances', urls: [UA + 'annoyances-others.txt'], trusted: true, group: 'Annoyances', cosmetic: 'annoyances', license: 'GPLv3', home: 'https://github.com/uBlockOrigin/uAssets' },
  { id: 'fanboy-annoyances', name: "Fanboy's Annoyances (newsletters, notifications, chat, other)", urls: [EA + 'easylist-newsletters.txt', EA + 'easylist-notifications.txt', EA + 'easylist-chat.txt', EA + 'easylist-annoyances.txt'], group: 'Annoyances', cosmetic: 'annoyances', license: 'GPLv3 / CC BY-SA 3.0', home: 'https://easylist.to/' },
  { id: 'fanboy-social', name: "Fanboy's Social (social widgets)", urls: [EA + 'easylist-social.txt'], group: 'Annoyances', cosmetic: 'annoyances', license: 'GPLv3 / CC BY-SA 3.0', home: 'https://easylist.to/' },
];
export const POPUPS = { id: 'popups', name: 'Pop-up and pop-under ads (strict)', group: 'Complete' };
export const RULESET_IDS = [...LISTS.map(l => l.id), POPUPS.id];
// the switchable groups: a list in a group is on when its group's popup switch is on (and you didn't switch the list
// off in Advanced). Lists without a group are always on unless switched off in Advanced.
export const GROUPS = { cookies: { name: 'Hide cookie banners', on: true }, annoyances: { name: 'Hide annoyances', on: false } };
// the cosmetic group a list's hiding filters go into ('main' unless the list says otherwise)
export const cosmeticGroup = l => l.cosmetic || 'main';
export const COSMETIC_GROUPS = ['main', ...Object.keys(GROUPS)];
export const DEFAULT_ON = LISTS.filter(l => !l.cosmetic || GROUPS[l.cosmetic].on).map(l => l.id);
// the preprocessor flags Shield answers "yes" to in !#if blocks (what uBO Lite says for a Chromium MV3 extension)
export const ENV = { ext_ublock: true, env_chromium: true, env_mv3: true, cap_user_stylesheet: true, false: false };
