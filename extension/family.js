// Hallow Shield 1.6 - the Hallow family bridge, the extension's side (pure functions: background, options and tests).
// With "Share counts with Hallow apps on this PC" on (the optional "nativeMessaging" access + family: true), the
// background sends the bridge (the native messaging host com.hallow.shield, HallowShieldBridge.exe) about once a minute,
// and when the popup opens, only this:
//   { blockedToday, blockedWeek, bannersToday, level, version, browser, profile, day }
// - counts from Shield's own stats; all three null while blocked counts (the stats permission) are off
// - profile: a random id made once in this browser profile, so two profiles don't overwrite each other
// - day: this PC's local day of the counts ("YYYY-MM-DD"), so a count from yesterday isn't added to today's
// Never a URL, a site, a host or any history.
import { lastDays, dayOf } from './stats.js';
import { LEVELS } from './shared.js';

export const FAMILY_HOST = 'com.hallow.shield';
export const FAMILY_KEYS = ['blockedToday', 'blockedWeek', 'bannersToday', 'level', 'version', 'browser', 'profile', 'day'];

// the browser Shield runs in, by name: Firefox, Edge, Opera, Brave, Vivaldi, Chrome or Chromium
export function browserName({ brands = [], ua = '', brave = false, firefox = false } = {}) {
  if (firefox || /Firefox\//.test(ua)) return 'Firefox';
  const b = brands.map(x => x.brand || '');
  if (brave || b.includes('Brave')) return 'Brave';
  if (b.includes('Microsoft Edge') || /Edg\//.test(ua)) return 'Edge';
  if (b.includes('Opera') || b.includes('Opera GX') || /OPR\//.test(ua)) return 'Opera';
  if (/Vivaldi/.test(ua)) return 'Vivaldi';
  if (b.includes('Google Chrome')) return 'Chrome';
  if (b.includes('Chromium')) return 'Chromium';
  return 'Chrome';
}
export const newProfileId = (rand = crypto.getRandomValues(new Uint8Array(8))) => Array.from(rand, x => x.toString(16).padStart(2, '0')).join('');

// the message for the bridge. stats: Shield's stats object (or null); counted: blocked counts are on.
export function familyReport({ stats, counted, level, version, browser, profile, now = Date.now() }) {
  const days = lastDays(now, 7).map(d => (stats && stats.days && stats.days[d.day]) || {});
  const blocked = b => (b.ads || 0) + (b.trackers || 0) + (b.other || 0);
  const today = days[days.length - 1];
  const on = !!(counted && stats);
  return {
    blockedToday: on ? blocked(today) : null,
    blockedWeek: on ? days.reduce((n, b) => n + blocked(b), 0) : null,
    bannersToday: on ? (today.clicks || 0) : null,
    level: LEVELS.includes(level) ? level : null,
    version: String(version || ''),
    browser: String(browser || 'Chrome'),
    profile: /^[a-z0-9]{1,32}$/.test(profile || '') ? profile : '',
    day: dayOf(now),
  };
}
