// Hallow Shield bridge - unit tests (built by bridge\build.ps1 -Test into bridge\out\BridgeTests.exe).
//   BridgeTests.exe [path to HallowShieldBridge.exe]   exit code 0 = all passed
// Uses a temp folder for status.json and HKCU\Software\HallowShieldBridgeTest for the registry: never the real ones.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading;
using Microsoft.Win32;

namespace HallowShieldBridge
{
    static class Tests
    {
        static int failed, passed;
        static void Ok(bool c, string what) { if (c) passed++; else { failed++; Console.WriteLine("FAIL: " + what); } }
        static void Eq(object a, object b, string what) { Ok(Equals(a, b), what + " (got " + (a ?? "null") + ", want " + (b ?? "null") + ")"); }
        static byte[] Frame(string s) { var m = new MemoryStream(); Bridge.WriteMessage(m, s); return m.ToArray(); }

        static int Main(string[] args)
        {
            var tmp = Path.Combine(Path.GetTempPath(), "hsb-test-" + Guid.NewGuid().ToString("N").Substring(0, 8));
            Directory.CreateDirectory(tmp);
            Environment.SetEnvironmentVariable("HALLOW_SHIELD_STATUS_DIR", Path.Combine(tmp, "status"));
            Environment.SetEnvironmentVariable("HALLOW_SHIELD_BRIDGE_HOME", Path.Combine(tmp, "home"));
            Environment.SetEnvironmentVariable("HALLOW_SHIELD_REGROOT", @"Software\HallowShieldBridgeTest");
            try
            {
                Framing(); Parsing(); Merging(); StaleAndToday(); Atomic(); RecordEnd();
                if (args.Length > 0) { Process(args[0]); Registering(args[0]); }
            }
            catch (Exception e) { failed++; Console.WriteLine("FAIL: crashed: " + e); }
            finally
            {
                try { Registry.CurrentUser.DeleteSubKeyTree(@"Software\HallowShieldBridgeTest", false); } catch { }
                try { Directory.Delete(tmp, true); } catch { }
            }
            Console.WriteLine((failed == 0 ? "OK" : "FAILED") + ": " + passed + " passed, " + failed + " failed");
            return failed == 0 ? 0 : 1;
        }

        static void Framing()
        {
            var b = Frame("{\"a\":\"é\"}");
            Eq(BitConverter.ToInt32(b, 0), Encoding.UTF8.GetByteCount("{\"a\":\"é\"}"), "framing: 4-byte little-endian length counts UTF-8 bytes");
            Eq(b[0], (byte)10, "framing: length byte order (little-endian)"); Eq(b[3], (byte)0, "framing: high byte last");
            var two = new MemoryStream(Frame("{\"x\":1}").Concat(Frame("{\"y\":2}")).ToArray());
            Eq(Bridge.ReadMessage(two), "{\"x\":1}", "framing: first of two");
            Eq(Bridge.ReadMessage(two), "{\"y\":2}", "framing: second of two");
            Eq(Bridge.ReadMessage(two), null, "framing: end of input");
            Eq(Bridge.ReadMessage(new MemoryStream()), null, "framing: empty input");
            Ok(Throws(() => Bridge.ReadMessage(new MemoryStream(new byte[] { 1, 0 }))), "framing: truncated length throws");
            Ok(Throws(() => Bridge.ReadMessage(new MemoryStream(new byte[] { 10, 0, 0, 0, 1, 2 }))), "framing: truncated body throws");
            Ok(Throws(() => Bridge.ReadMessage(new MemoryStream(BitConverter.GetBytes(Bridge.MaxMessage + 1)))), "framing: oversized throws");
            Ok(Throws(() => Bridge.ReadMessage(new MemoryStream(BitConverter.GetBytes(-5)))), "framing: negative throws");
            // a stream that hands out one byte at a time still gives the whole message
            Eq(Bridge.ReadMessage(new Trickle(Frame("{\"slow\":true}"))), "{\"slow\":true}", "framing: partial reads");
        }
        static bool Throws(Action a) { try { a(); return false; } catch { return true; } }

        static readonly DateTime T0 = new DateTime(2026, 11, 21, 12, 0, 0, DateTimeKind.Utc);
        static string Day(DateTime utc) { return utc.ToLocalTime().ToString("yyyy-MM-dd"); }

        static void Parsing()
        {
            var e = Bridge.Parse("{\"blockedToday\":12,\"blockedWeek\":340,\"bannersToday\":2,\"level\":\"optimal\",\"version\":\"1.6\",\"browser\":\"Edge\",\"profile\":\"Ab12cd34\",\"url\":\"https://secret.example/\",\"sites\":[\"a.com\"]}", T0);
            Ok(e != null, "parse: a report");
            Eq(e.Name, "Edge", "parse: browser"); Eq(e.Level, "optimal", "parse: level"); Eq(e.Version, "1.6", "parse: version"); Eq(e.Id, "ab12cd34", "parse: profile id");
            Eq(e.BlockedToday, (long?)12, "parse: blockedToday"); Eq(e.BlockedWeek, (long?)340, "parse: blockedWeek"); Eq(e.BannersToday, (long?)2, "parse: bannersToday");
            var n = Bridge.Parse("{\"blockedToday\":null,\"blockedWeek\":null,\"bannersToday\":null,\"level\":\"basic\",\"version\":\"1.6\",\"browser\":\"Firefox\"}", T0);
            Ok(n.BlockedToday == null && n.BlockedWeek == null && n.BannersToday == null, "parse: null counts stay null (stats off)");
            var bad = Bridge.Parse("{\"blockedToday\":-4,\"blockedWeek\":\"9\",\"level\":\"evil\",\"version\":\"<script>\",\"browser\":\"https://x\",\"profile\":\"../../x\"}", T0);
            Ok(bad == null, "parse: no valid level or version -> not a report");
            var bad2 = Bridge.Parse("{\"blockedToday\":-4,\"blockedWeek\":\"9\",\"level\":\"complete\",\"version\":\"<script>\",\"browser\":\"https://x\",\"profile\":\"../../x\"}", T0);
            Ok(bad2.BlockedToday == null && bad2.BlockedWeek == null && bad2.Version == null && bad2.Name == "Chrome" && bad2.Id == "", "parse: bad values dropped");
            Ok(Bridge.Parse("not json", T0) == null && Bridge.Parse("[1,2]", T0) == null && Bridge.Parse("{}", T0) == null, "parse: garbage refused");
        }

        static Entry E(string name, string id, long? today, long? week, long? banners, DateTime updated)
        {
            return new Entry { Name = name, Id = id, Version = "1.6", Level = "optimal", BlockedToday = today, BlockedWeek = week, BannersToday = banners, Updated = updated, Day = Day(updated) };
        }
        static void Merging()
        {
            var l = new List<Entry>();
            l = Bridge.Merge(l, E("Chrome", "aaa", 10, 100, 1, T0), T0);
            l = Bridge.Merge(l, E("Edge", "bbb", 5, 50, 0, T0), T0);
            l = Bridge.Merge(l, E("Chrome", "ccc", 7, 70, 2, T0), T0);
            Eq(l.Count, 3, "merge: three browser profiles");
            Eq(l.First(x => x.Id == "aaa").Profile, "Default", "merge: first Chrome profile is Default");
            Eq(l.First(x => x.Id == "ccc").Profile, "Profile 2", "merge: second Chrome profile");
            Eq(l.First(x => x.Id == "bbb").Profile, "Default", "merge: Edge has its own Default");
            l = Bridge.Merge(l, E("Chrome", "aaa", 20, 110, 3, T0.AddMinutes(1)), T0.AddMinutes(1));
            Eq(l.Count, 3, "merge: same profile replaced, not added");
            Eq(l.First(x => x.Id == "aaa").BlockedToday, (long?)20, "merge: newest counts kept");
            Eq(l.First(x => x.Id == "aaa").Profile, "Default", "merge: profile name kept");
            var json = Bridge.Render(l, T0.AddMinutes(1));
            Ok(json.Contains("\"blockedToday\":32,") && json.Contains("\"blockedWeek\":230,") && json.EndsWith("\"bannersToday\":5}"), "merge: sums " + json);
            Ok(json.StartsWith("{\"version\":\"" + Bridge.Version + "\",\"updated\":\""), "render: starts like the spec");
            // round trip through the file format
            var p = Path.Combine(Path.GetTempPath(), "hsb-rt-" + Guid.NewGuid().ToString("N") + ".json");
            try { File.WriteAllText(p, json); var back = Bridge.Load(p); Eq(back.Count, 3, "load: entries back"); Eq(Bridge.Render(back, T0.AddMinutes(1)), json, "load: round trip"); }
            finally { File.Delete(p); }
            // forgotten after 30 days
            var old = Bridge.Merge(new List<Entry> { E("Brave", "old", 1, 1, 1, T0.AddDays(-31)) }, E("Chrome", "new", 1, 1, 1, T0), T0);
            Ok(old.Count == 1 && old[0].Id == "new", "merge: 31-day-old entry forgotten");
        }

        static void StaleAndToday()
        {
            var now = T0;
            var l = new List<Entry> {
                E("Chrome", "fresh", 10, 100, 1, now.AddMinutes(-2)),
                E("Edge", "stale", 1000, 9000, 50, now.AddDays(-3)),         // older than 2 days: not in any sum
                E("Brave", "yday", 300, 600, 9, now.AddHours(-30)),          // a day ago: in the week, not in today
                E("Firefox", "off", null, null, null, now.AddMinutes(-1)),   // stats off there
            };
            var json = Bridge.Render(l, now);
            Ok(json.Contains("],\"blockedToday\":10,\"blockedWeek\":700,\"bannersToday\":1}"), "stale: sums skip >2-day entries, today skips yesterday " + json);
            Ok(json.Contains("\"name\":\"Edge\""), "stale: the stale entry is still listed");
            var allOff = Bridge.Render(new List<Entry> { E("Firefox", "off", null, null, null, now) }, now);
            Ok(allOff.EndsWith("\"blockedToday\":null,\"blockedWeek\":null,\"bannersToday\":null}"), "stale: no counts anywhere -> null sums");
            var none = Bridge.Render(new List<Entry>(), now);
            Eq(none, "{\"version\":\"" + Bridge.Version + "\",\"updated\":\"" + Bridge.Iso(now) + "\",\"browsers\":[],\"blockedToday\":null,\"blockedWeek\":null,\"bannersToday\":null}", "render: empty");
        }

        static void Atomic()
        {
            var dir = Path.Combine(Path.GetTempPath(), "hsb-atomic-" + Guid.NewGuid().ToString("N").Substring(0, 8)); var p = Path.Combine(dir, "status.json");
            try
            {
                Bridge.WriteAtomic(p, "{\"n\":0}");
                Eq(File.ReadAllText(p), "{\"n\":0}", "atomic: first write");
                bool stop = false; int bad = 0, reads = 0;
                var reader = new Thread(() => { while (!stop) { try { var t = File.ReadAllText(p); reads++; if (!t.StartsWith("{\"n\":") || !t.EndsWith("}")) bad++; } catch (IOException) { } catch (UnauthorizedAccessException) { } } });
                reader.Start();
                var big = new string('x', 20000);
                for (int i = 1; i <= 200; i++) Bridge.WriteAtomic(p, "{\"n\":" + i + ",\"pad\":\"" + big + "\"}");
                stop = true; reader.Join();
                Eq(bad, 0, "atomic: a reader never sees half a file (" + reads + " reads)");
                Ok(File.ReadAllText(p).StartsWith("{\"n\":200,"), "atomic: last write wins");
                Eq(Directory.GetFiles(dir).Length, 1, "atomic: no temp files left");
            }
            finally { try { Directory.Delete(dir, true); } catch { } }
        }

        static void RecordEnd()
        {
            // two "browsers" at once through Serve, as the browser would talk to it
            var ins = new[] {
                "{\"blockedToday\":4,\"blockedWeek\":40,\"bannersToday\":1,\"level\":\"optimal\",\"version\":\"1.6\",\"browser\":\"Chrome\",\"profile\":\"p1\",\"url\":\"https://bank.example/login\",\"history\":[\"https://a\"]}",
                "{\"blockedToday\":6,\"blockedWeek\":60,\"bannersToday\":2,\"level\":\"complete\",\"version\":\"1.6\",\"browser\":\"Brave\",\"profile\":\"p2\"}",
            };
            var ts = ins.Select(m => new Thread(() => { var o = new MemoryStream(); Bridge.Serve(new MemoryStream(Frame(m)), o); })).ToList();
            ts.ForEach(t => t.Start()); ts.ForEach(t => t.Join());
            var s = File.ReadAllText(Bridge.StatusPath);
            Ok(s.Contains("\"name\":\"Chrome\"") && s.Contains("\"name\":\"Brave\""), "record: both browsers merged");
            Ok(s.Contains("],\"blockedToday\":10,\"blockedWeek\":100,\"bannersToday\":3}"), "record: sums " + s);
            Ok(!s.Contains("http") && !s.Contains("bank") && !s.Contains("history"), "record: no URLs or history kept");
            var o2 = new MemoryStream(); Bridge.Serve(new MemoryStream(Frame("{\"hello\":1}")), o2); o2.Position = 0;
            Ok(Bridge.ReadMessage(o2).Contains("\"ok\":false"), "record: a non-report is refused");
            Eq(Directory.GetFiles(Bridge.Dir).Length, 1, "record: only status.json in the folder");
        }

        static void Process(string exe)
        {
            try { Console.InputEncoding = new UTF8Encoding(false); } catch { }   // no BOM on the child's stdin (a browser never sends one)
            var psi = new ProcessStartInfo(exe, "chrome-extension://" + Bridge.ChromeId + "/ --parent-window=0") { UseShellExecute = false, RedirectStandardInput = true, RedirectStandardOutput = true, CreateNoWindow = true };
            using (var p = System.Diagnostics.Process.Start(psi))
            {
                var inp = p.StandardInput.BaseStream;
                Bridge.WriteMessage(inp, "{\"blockedToday\":1,\"blockedWeek\":2,\"bannersToday\":0,\"level\":\"basic\",\"version\":\"1.6\",\"browser\":\"Opera\",\"profile\":\"z9\"}");
                var reply = Bridge.ReadMessage(p.StandardOutput.BaseStream);
                Ok(reply != null && reply.Contains("\"ok\":true"), "exe: answers a framed message (" + reply + ")");
                inp.Close();
                Ok(p.WaitForExit(5000) && p.ExitCode == 0, "exe: exits when the browser closes the pipe");
            }
            Ok(File.ReadAllText(Bridge.StatusPath).Contains("\"name\":\"Opera\""), "exe: wrote status.json");
        }

        static void Registering(string exe)
        {
            var copy = Path.Combine(Path.GetTempPath(), "hsb-reg-" + Guid.NewGuid().ToString("N").Substring(0, 8) + ".exe");
            File.Copy(exe, copy);
            try
            {
                var psi = new ProcessStartInfo(copy, "--install") { UseShellExecute = false, RedirectStandardOutput = true, CreateNoWindow = true };
                using (var p = System.Diagnostics.Process.Start(psi)) { p.StandardOutput.ReadToEnd(); p.WaitForExit(); Eq(p.ExitCode, 0, "install: exit code"); }
                var home = Bridge.Home; var installed = Path.Combine(home, "HallowShieldBridge.exe");
                Ok(File.Exists(installed), "install: exe copied to its home");
                foreach (var k in new[] { @"Google\Chrome", @"Microsoft\Edge", @"BraveSoftware\Brave-Browser", @"Mozilla" })
                    using (var r = Registry.CurrentUser.OpenSubKey(@"Software\HallowShieldBridgeTest\" + k + @"\NativeMessagingHosts\com.hallow.shield"))
                        Ok(r != null && File.Exists(r.GetValue("") as string), "install: registered for " + k);
                var cm = File.ReadAllText(Path.Combine(home, "com.hallow.shield.json"));
                Ok(cm.Contains("\"chrome-extension://" + Bridge.ChromeId + "/\"") && cm.Contains("\"name\": \"com.hallow.shield\"") && cm.Contains(installed.Replace("\\", "\\\\")), "install: Chromium manifest " + cm);
                Ok(File.ReadAllText(Path.Combine(home, "com.hallow.shield.firefox.json")).Contains("\"allowed_extensions\": [\"hallow-shield@dom428.github.io\"]"), "install: Firefox manifest");
                var js = new System.Web.Script.Serialization.JavaScriptSerializer();
                Ok(js.DeserializeObject(cm) != null, "install: manifest is valid JSON");
                using (var p = System.Diagnostics.Process.Start(new ProcessStartInfo(installed, "--uninstall") { UseShellExecute = false, RedirectStandardOutput = true, CreateNoWindow = true })) { p.StandardOutput.ReadToEnd(); p.WaitForExit(); }
                using (var r = Registry.CurrentUser.OpenSubKey(@"Software\HallowShieldBridgeTest\Google\Chrome\NativeMessagingHosts\com.hallow.shield")) Ok(r == null, "uninstall: key removed");
                Ok(!File.Exists(Path.Combine(home, "com.hallow.shield.json")), "uninstall: manifest removed");
            }
            finally { try { File.Delete(copy); } catch { } }
        }

        class Trickle : Stream
        {
            readonly byte[] b; int pos;
            public Trickle(byte[] b) { this.b = b; }
            public override int Read(byte[] buf, int off, int n) { if (pos >= b.Length || n == 0) return 0; buf[off] = b[pos++]; return 1; }
            public override bool CanRead { get { return true; } }
            public override bool CanSeek { get { return false; } }
            public override bool CanWrite { get { return false; } }
            public override long Length { get { throw new NotSupportedException(); } }
            public override long Position { get { throw new NotSupportedException(); } set { throw new NotSupportedException(); } }
            public override void Flush() { }
            public override long Seek(long o, SeekOrigin s) { throw new NotSupportedException(); }
            public override void SetLength(long v) { throw new NotSupportedException(); }
            public override void Write(byte[] buf, int off, int n) { throw new NotSupportedException(); }
        }
    }
}
