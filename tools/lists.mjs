// Hallow Shield: the filter lists, in the order they get room when space is short.
// Each list becomes one static ruleset (rules/<id>.json); "popups" is built from the $popup filters of every list and is
// only switched on at the "Complete" level. The manifest's rule_resources must list exactly these ids (a test checks it).
const UA = 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/';
export const LISTS = [
  { id: 'ublock-filters', name: 'uBlock filters', urls: [UA + 'filters.txt'], trusted: true, group: 'Ads', license: 'GPLv3', home: 'https://github.com/uBlockOrigin/uAssets' },
  { id: 'easylist', name: 'EasyList', urls: ['https://easylist.to/easylist/easylist.txt'], group: 'Ads', license: 'GPLv3 / CC BY-SA 3.0', home: 'https://easylist.to/' },
  { id: 'easyprivacy', name: 'EasyPrivacy', urls: ['https://easylist.to/easylist/easyprivacy.txt'], group: 'Privacy', license: 'GPLv3 / CC BY-SA 3.0', home: 'https://easylist.to/' },
  { id: 'ublock-badware', name: 'uBlock filters - Badware risks', urls: [UA + 'badware.txt'], trusted: true, group: 'Security', license: 'GPLv3', home: 'https://github.com/uBlockOrigin/uAssets' },
  { id: 'ublock-privacy', name: 'uBlock filters - Privacy', urls: [UA + 'privacy.txt'], trusted: true, group: 'Privacy', license: 'GPLv3', home: 'https://github.com/uBlockOrigin/uAssets' },
  { id: 'ublock-unbreak', name: 'uBlock filters - Unbreak', urls: [UA + 'unbreak.txt'], trusted: true, group: 'Fixes', license: 'GPLv3', home: 'https://github.com/uBlockOrigin/uAssets' },
  { id: 'ublock-quick-fixes', name: 'uBlock filters - Quick fixes', urls: [UA + 'quick-fixes.txt'], trusted: true, group: 'Fixes', license: 'GPLv3', home: 'https://github.com/uBlockOrigin/uAssets' },
  { id: 'plowe', name: "Peter Lowe's ad and tracking server list", urls: ['https://pgl.yoyo.org/adservers/serverlist.php?hostformat=adblockplus&showintro=1&mimetype=plaintext'], group: 'Ads', license: 'McRae GPL (see the list)', home: 'https://pgl.yoyo.org/adservers/' },
];
export const POPUPS = { id: 'popups', name: 'Pop-up and pop-under ads (strict)', group: 'Complete' };
export const RULESET_IDS = [...LISTS.map(l => l.id), POPUPS.id];
// every list is on unless you switch it off in Advanced
export const DEFAULT_ON = LISTS.map(l => l.id);
// the preprocessor flags Shield answers "yes" to in !#if blocks (what uBO Lite says for a Chromium MV3 extension)
export const ENV = { ext_ublock: true, env_chromium: true, env_mv3: true, cap_user_stylesheet: true, false: false };
