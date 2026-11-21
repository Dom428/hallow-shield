// Hallow Shield 1.6 - the Hallow family bridge (no window, no network).
// A native messaging host: when "Share counts with Hallow apps on this PC" is on, Shield (in Chrome, Edge, Brave, Opera
// or Firefox) sends it a few counts about once a minute, and it keeps one file for Hallow Hub / Remote to read:
//   %APPDATA%\HallowShield\status.json
//   {"version":"1.6","updated":"<ISO>","browsers":[{"name":"Chrome","profile":"Default","version":"1.6","level":"optimal",
//     "blockedToday":123,"blockedWeek":4567,"bannersToday":3,"updated":"<ISO>","id":"<random install id>"}],
//     "blockedToday":<sum>,"blockedWeek":<sum>,"bannersToday":<sum>}
//   - one entry per browser + profile (the profile is Shield's random install id in that profile, shown as "Default",
//     "Profile 2", ...); entries not heard from for 2 days are left out of the sums (and dropped after 30)
//   - only the fields above are ever kept: anything else in a message (a URL, a site...) is thrown away
//   - written atomically (a temp file, then replaced), under a mutex so two browsers can't mix their writes
// Messages: 4-byte little-endian length + UTF-8 JSON, both ways (Chrome / Firefox native messaging).
using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32;

namespace HallowShieldBridge
{
    public class Entry
    {
        public string Name, Profile, Id, Version, Level;
        public long? BlockedToday, BlockedWeek, BannersToday;
        public DateTime Updated;   // UTC
        public string Day;         // the browser's local day of the counts (yyyy-MM-dd), or null
    }

    public static class Bridge
    {
        public const string Version = "1.6";
        public const string HostName = "com.hallow.shield";
        public const string ChromeId = "afghaliocnljjjegfnaonfghpjgpebni";        // from the "key" in Shield's manifest.json
        public const string FirefoxId = "hallow-shield@dom428.github.io";
        public const int MaxMessage = 64 * 1024;
        public static readonly TimeSpan Stale = TimeSpan.FromDays(2), Forget = TimeSpan.FromDays(30);
        public static readonly string[] Levels = { "basic", "optimal", "complete" };
        public static readonly string[] Names = { "Chrome", "Edge", "Brave", "Opera", "Vivaldi", "Chromium", "Firefox" };

        // %APPDATA%\HallowShield (HALLOW_SHIELD_STATUS_DIR for tests)
        public static string Dir
        {
            get
            {
                var t = Environment.GetEnvironmentVariable("HALLOW_SHIELD_STATUS_DIR");
                return !string.IsNullOrEmpty(t) ? t : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "HallowShield");
            }
        }
        public static string StatusPath { get { return Path.Combine(Dir, "status.json"); } }

        // ---- framing ----
        // one message, or null at the end of the input. Throws on a broken or oversized frame.
        public static string ReadMessage(Stream s)
        {
            var len = new byte[4];
            int got = ReadFull(s, len, 4);
            if (got == 0) return null;
            if (got < 4) throw new InvalidDataException("truncated length");
            int n = BitConverter.ToInt32(len, 0);
            if (n < 0 || n > MaxMessage) throw new InvalidDataException("message too big: " + n);
            var buf = new byte[n];
            if (ReadFull(s, buf, n) < n) throw new InvalidDataException("truncated message");
            return new UTF8Encoding(false, true).GetString(buf);
        }
        static int ReadFull(Stream s, byte[] b, int n)
        {
            int off = 0;
            while (off < n) { int r = s.Read(b, off, n - off); if (r <= 0) break; off += r; }
            return off;
        }
        public static void WriteMessage(Stream s, string json)
        {
            var b = Encoding.UTF8.GetBytes(json);
            s.Write(BitConverter.GetBytes(b.Length), 0, 4);
            s.Write(b, 0, b.Length);
            s.Flush();
        }

        // ---- one report from the extension -> an entry (only the known fields, checked), or null if it isn't one ----
        static readonly JavaScriptSerializer js = new JavaScriptSerializer { MaxJsonLength = MaxMessage * 4 };
        public static Entry Parse(string json, DateTime nowUtc)
        {
            Dictionary<string, object> d;
            try { d = js.Deserialize<Dictionary<string, object>>(json); } catch { return null; }
            if (d == null) return null;
            var e = new Entry { Updated = nowUtc };
            e.Name = Pick(Str(d, "browser"), Names) ?? "Chrome";
            e.Level = Pick(Str(d, "level"), Levels);
            var v = Str(d, "version"); e.Version = v != null && Regex.IsMatch(v, @"^\d{1,4}(\.\d{1,4}){0,3}$") ? v : null;
            var id = Str(d, "profile"); e.Id = id != null && Regex.IsMatch(id, "^[A-Za-z0-9]{1,32}$") ? id.ToLowerInvariant() : "";
            var day = Str(d, "day"); e.Day = day != null && Regex.IsMatch(day, @"^\d{4}-\d{2}-\d{2}$") ? day : null;
            e.BlockedToday = Count(d, "blockedToday"); e.BlockedWeek = Count(d, "blockedWeek"); e.BannersToday = Count(d, "bannersToday");
            if (e.Level == null && e.Version == null) return null;   // not a Shield report
            return e;
        }
        static string Str(Dictionary<string, object> d, string k) { object o; return d.TryGetValue(k, out o) ? o as string : null; }
        static string Pick(string s, string[] from) { return s == null ? null : from.FirstOrDefault(x => string.Equals(x, s, StringComparison.OrdinalIgnoreCase)); }
        static long? Count(Dictionary<string, object> d, string k)
        {
            object o; if (!d.TryGetValue(k, out o) || o == null) return null;
            long n;
            if (o is int) n = (int)o; else if (o is long) n = (long)o; else if (o is decimal) n = (long)(decimal)o; else if (o is double) n = (long)(double)o; else return null;
            return n < 0 ? (long?)null : Math.Min(n, 1000000000000L);
        }

        // ---- status.json ----
        public static List<Entry> Load(string path)
        {
            var list = new List<Entry>();
            try
            {
                if (!File.Exists(path)) return list;
                var d = js.Deserialize<Dictionary<string, object>>(File.ReadAllText(path, Encoding.UTF8));
                object o; var arr = d != null && d.TryGetValue("browsers", out o) ? o as ArrayList : null;
                if (arr == null) return list;
                foreach (var x in arr.OfType<Dictionary<string, object>>())
                {
                    DateTime t;
                    if (!DateTime.TryParse(Str(x, "updated") ?? "", CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out t)) continue;
                    list.Add(new Entry
                    {
                        Name = Pick(Str(x, "name"), Names) ?? "Chrome", Profile = Str(x, "profile") ?? "Default", Id = Str(x, "id") ?? "",
                        Version = Str(x, "version"), Level = Pick(Str(x, "level"), Levels), Day = Str(x, "day"),
                        BlockedToday = Count(x, "blockedToday"), BlockedWeek = Count(x, "blockedWeek"), BannersToday = Count(x, "bannersToday"), Updated = t
                    });
                }
            }
            catch { }
            return list;
        }

        // the new entry in place of the old one for the same browser + profile; entries not heard from in 30 days forgotten
        public static List<Entry> Merge(List<Entry> list, Entry e, DateTime nowUtc)
        {
            var o = list.Where(x => nowUtc - x.Updated < Forget).ToList();
            var same = o.FirstOrDefault(x => x.Name == e.Name && x.Id == e.Id);
            if (same != null) { e.Profile = same.Profile; o[o.IndexOf(same)] = e; }
            else
            {
                var taken = new HashSet<string>(o.Where(x => x.Name == e.Name).Select(x => x.Profile));
                e.Profile = "Default"; for (int i = 2; taken.Contains(e.Profile); i++) e.Profile = "Profile " + i;
                o.Add(e);
            }
            return o.OrderBy(x => Array.IndexOf(Names, x.Name)).ThenBy(x => x.Profile == "Default" ? "" : x.Profile).ToList();
        }

        // which entries count: heard from in the last 2 days; "today" counts only from entries sent today
        public static bool Fresh(Entry x, DateTime nowUtc) { return nowUtc - x.Updated < Stale && x.Updated <= nowUtc.AddMinutes(5); }
        public static bool Today(Entry x, DateTime nowUtc)
        {
            if (!Fresh(x, nowUtc)) return false;
            var today = nowUtc.ToLocalTime().ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
            return x.Day != null ? x.Day == today : x.Updated.ToLocalTime().ToString("yyyy-MM-dd", CultureInfo.InvariantCulture) == today;
        }
        // the sum, or null when no counted entry has a number (stats off everywhere)
        public static long? Sum(IEnumerable<Entry> xs, Func<Entry, long?> f) { long? s = null; foreach (var x in xs) { var n = f(x); if (n.HasValue) s = (s ?? 0) + n.Value; } return s; }

        public static string Iso(DateTime utc) { return utc.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", CultureInfo.InvariantCulture); }
        static string J(string s)
        {
            if (s == null) return "null";
            var b = new StringBuilder("\"");
            foreach (var c in s) { if (c == '"' || c == '\\') b.Append('\\').Append(c); else if (c < 0x20 || c > 0x7e) b.Append("\\u").Append(((int)c).ToString("x4")); else b.Append(c); }
            return b.Append('"').ToString();
        }
        static string N(long? n) { return n.HasValue ? n.Value.ToString(CultureInfo.InvariantCulture) : "null"; }

        public static string Render(List<Entry> list, DateTime nowUtc)
        {
            var b = new StringBuilder();
            b.Append("{\"version\":").Append(J(Version)).Append(",\"updated\":").Append(J(Iso(nowUtc))).Append(",\"browsers\":[");
            for (int i = 0; i < list.Count; i++)
            {
                var x = list[i]; if (i > 0) b.Append(',');
                b.Append("{\"name\":").Append(J(x.Name)).Append(",\"profile\":").Append(J(x.Profile)).Append(",\"version\":").Append(J(x.Version))
                 .Append(",\"level\":").Append(J(x.Level)).Append(",\"blockedToday\":").Append(N(x.BlockedToday)).Append(",\"blockedWeek\":").Append(N(x.BlockedWeek))
                 .Append(",\"bannersToday\":").Append(N(x.BannersToday)).Append(",\"updated\":").Append(J(Iso(x.Updated)))
                 .Append(",\"day\":").Append(J(x.Day)).Append(",\"id\":").Append(J(x.Id)).Append('}');
            }
            var fresh = list.Where(x => Fresh(x, nowUtc)).ToList(); var today = list.Where(x => Today(x, nowUtc)).ToList();
            b.Append("],\"blockedToday\":").Append(N(Sum(today, x => x.BlockedToday))).Append(",\"blockedWeek\":").Append(N(Sum(fresh, x => x.BlockedWeek)))
             .Append(",\"bannersToday\":").Append(N(Sum(today, x => x.BannersToday))).Append('}');
            return b.ToString();
        }

        // a temp file next to it, then swapped in: readers see the old file or the new one, never half of one
        public static void WriteAtomic(string path, string text)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(path));
            var tmp = path + "." + Guid.NewGuid().ToString("N").Substring(0, 8) + ".tmp";
            File.WriteAllText(tmp, text, new UTF8Encoding(false));
            try
            {
                for (int i = 0; ; i++)
                {
                    try { if (File.Exists(path)) File.Replace(tmp, path, null, true); else File.Move(tmp, path); return; }
                    catch (IOException) { if (i >= 20) throw; Thread.Sleep(50); }        // a reader has it open for a moment
                    catch (UnauthorizedAccessException) { if (i >= 20) throw; Thread.Sleep(50); }
                }
            }
            finally { try { if (File.Exists(tmp)) File.Delete(tmp); } catch { } }
        }

        // one report: merged into status.json under the mutex. Returns the entry kept, or null if it wasn't a report.
        public static Entry Record(string json, DateTime nowUtc)
        {
            var e = Parse(json, nowUtc); if (e == null) return null;
            using (var m = new Mutex(false, @"Local\HallowShieldBridge." + Environment.UserName))
            {
                bool own = false;
                try { try { own = m.WaitOne(5000); } catch (AbandonedMutexException) { own = true; } WriteAtomic(StatusPath, Render(Merge(Load(StatusPath), e, nowUtc), nowUtc)); }
                finally { if (own) m.ReleaseMutex(); }
            }
            return e;
        }

        // the host's loop: every message answered with {"ok":true} or {"ok":false,"error":...}
        public static int Serve(Stream input, Stream output)
        {
            while (true)
            {
                string msg;
                try { msg = ReadMessage(input); } catch (Exception ex) { try { WriteMessage(output, "{\"ok\":false,\"error\":" + J(ex.Message) + "}"); } catch { } return 1; }
                if (msg == null) return 0;
                try
                {
                    var e = Record(msg, DateTime.UtcNow);
                    WriteMessage(output, e == null ? "{\"ok\":false,\"error\":\"not a Shield report\"}" : "{\"ok\":true,\"version\":" + J(Version) + "}");
                }
                catch (Exception ex) { WriteMessage(output, "{\"ok\":false,\"error\":" + J(ex.Message) + "}"); }
            }
        }

        // ---- registering with the browsers (HKCU only; HALLOW_SHIELD_REGROOT for tests uses another key) ----
        public static readonly string[] ChromiumKeys = { @"Software\Google\Chrome", @"Software\Microsoft\Edge", @"Software\BraveSoftware\Brave-Browser", @"Software\Chromium" };
        public const string FirefoxKey = @"Software\Mozilla";
        static string RegPath(string browserKey)
        {
            var t = Environment.GetEnvironmentVariable("HALLOW_SHIELD_REGROOT");
            return (!string.IsNullOrEmpty(t) ? t + "\\" + browserKey.Substring("Software\\".Length) : browserKey) + @"\NativeMessagingHosts\" + HostName;
        }
        // %LOCALAPPDATA%\Hallow Shield\bridge (HALLOW_SHIELD_BRIDGE_HOME for tests)
        public static string Home
        {
            get
            {
                var t = Environment.GetEnvironmentVariable("HALLOW_SHIELD_BRIDGE_HOME");
                return !string.IsNullOrEmpty(t) ? t : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Hallow Shield", "bridge");
            }
        }
        public static string Manifest(string exe, bool firefox)
        {
            return "{\n  \"name\": " + J(HostName) + ",\n  \"description\": \"Hallow Shield family bridge - writes blocked counts to %APPDATA%\\\\HallowShield\\\\status.json\",\n  \"path\": " + J(exe) +
                ",\n  \"type\": \"stdio\",\n  " + (firefox ? "\"allowed_extensions\": [" + J(FirefoxId) + "]" : "\"allowed_origins\": [" + J("chrome-extension://" + ChromeId + "/") + "]") + "\n}\n";
        }
        // copies this exe to Home (unless it runs from there), writes the two host manifests and points the browsers at them
        public static string Install(string selfExe)
        {
            var home = Home; Directory.CreateDirectory(home);
            var exe = Path.Combine(home, "HallowShieldBridge.exe");
            if (!string.Equals(Path.GetFullPath(selfExe), Path.GetFullPath(exe), StringComparison.OrdinalIgnoreCase))
            {
                var tmp = exe + ".new";
                File.Copy(selfExe, tmp, true);
                try { if (File.Exists(exe)) File.Replace(tmp, exe, null, true); else File.Move(tmp, exe); }
                catch (IOException) { try { File.Delete(tmp); } catch { } if (!File.Exists(exe)) throw; }   // the old copy is running right now: keep it
            }
            var cm = Path.Combine(home, "com.hallow.shield.json"); var fm = Path.Combine(home, "com.hallow.shield.firefox.json");
            File.WriteAllText(cm, Manifest(exe, false), new UTF8Encoding(false));
            File.WriteAllText(fm, Manifest(exe, true), new UTF8Encoding(false));
            foreach (var k in ChromiumKeys) using (var r = Registry.CurrentUser.CreateSubKey(RegPath(k))) r.SetValue("", cm);
            using (var r = Registry.CurrentUser.CreateSubKey(RegPath(FirefoxKey))) r.SetValue("", fm);
            return "Hallow Shield bridge " + Version + " registered for Chrome, Edge, Brave, Opera, Chromium and Firefox (this user only): " + exe;
        }
        public static string Uninstall()
        {
            foreach (var k in ChromiumKeys.Concat(new[] { FirefoxKey })) try { Registry.CurrentUser.DeleteSubKeyTree(RegPath(k), false); } catch { }
            foreach (var f in new[] { "com.hallow.shield.json", "com.hallow.shield.firefox.json" }) try { File.Delete(Path.Combine(Home, f)); } catch { }
            return "Hallow Shield bridge unregistered (the browsers can't start it any more). status.json is left in " + Dir + ".";
        }
        public static string Status()
        {
            var b = new StringBuilder("Hallow Shield bridge " + Version + "\n");
            foreach (var k in ChromiumKeys.Concat(new[] { FirefoxKey }))
            {
                string v = null; try { using (var r = Registry.CurrentUser.OpenSubKey(RegPath(k))) v = r == null ? null : r.GetValue("") as string; } catch { }
                b.Append("  ").Append(k.Substring(9)).Append(": ").Append(v == null ? "not registered" : File.Exists(v) ? v : v + " (missing)").Append('\n');
            }
            b.Append("  status: ").Append(StatusPath).Append(File.Exists(StatusPath) ? "" : " (not written yet)");
            return b.ToString();
        }
    }
}
