// Hallow Shield 1.6 - HallowShieldBridge.exe
//   (started by the browser)  chrome-extension://<id>/ [--parent-window=N]   or (Firefox)  <manifest path> <add-on id>
//   --install     copy to %LOCALAPPDATA%\Hallow Shield\bridge and register for this user (HKCU, no admin)
//   --uninstall   unregister
//   --status      where it's registered and where status.json is
//   --version
using System;
using System.Reflection;

namespace HallowShieldBridge
{
    static class Program
    {
        static int Main(string[] args)
        {
            var a = args.Length > 0 ? args[0] : "";
            try
            {
                if (a == "--install") { Console.WriteLine(Bridge.Install(Assembly.GetExecutingAssembly().Location)); return 0; }
                if (a == "--uninstall") { Console.WriteLine(Bridge.Uninstall()); return 0; }
                if (a == "--status") { Console.WriteLine(Bridge.Status()); return 0; }
                if (a == "--version") { Console.WriteLine(Bridge.Version); return 0; }
                if (a == "--help" || a == "/?" || a == "-h" || a == "")
                {
                    Console.WriteLine("Hallow Shield bridge " + Bridge.Version + ": the browser starts it to pass Shield's blocked counts to Hallow apps on this PC.\n  --install | --uninstall | --status | --version");
                    return a == "" ? 2 : 0;
                }
            }
            catch (Exception e) { Console.Error.WriteLine("Hallow Shield bridge: " + e.Message); return 1; }
            // started by a browser: native messaging on stdin / stdout
            return Bridge.Serve(Console.OpenStandardInput(), Console.OpenStandardOutput());
        }
    }
}
