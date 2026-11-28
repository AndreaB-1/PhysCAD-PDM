using Avalonia;
using PlmAgent.Core;

namespace PlmAgent;

/// <summary>
/// plm-agent                      start the tray app (or hand over to the running one)
/// plm-agent plmlite://open?...   open a link (hands it to the running agent, else starts it)
/// plm-agent --tray               start the tray app (used by autostart)
/// plm-agent cli &lt;command&gt;       headless use, e.g. on a server or in tests (see Cli.cs)
/// </summary>
public static class Program
{
    [STAThread]
    public static int Main(string[] args)
    {
        if (args.Length > 0 && args[0] == "cli")
        {
            // The Windows build is a GUI app: borrow the parent terminal so the CLI can print.
            if (OperatingSystem.IsWindows()) AttachConsole(-1);
            return Cli.Run(args[1..]).GetAwaiter().GetResult();
        }

        var url = args.FirstOrDefault(a => a.StartsWith(UrlScheme.Scheme + ":", StringComparison.OrdinalIgnoreCase));
        // Already running? Hand over the link (or just exit) instead of starting a second tray icon.
        if (LocalServer.IsRunning().GetAwaiter().GetResult())
        {
            if (url is not null) LocalServer.SendToRunning(url).GetAwaiter().GetResult();
            else if (!args.Contains("--tray")) LocalServer.ShowRunning().GetAwaiter().GetResult();
            return 0;
        }
        App.StartupUrl = url;
        BuildAvaloniaApp().StartWithClassicDesktopLifetime(args, Avalonia.Controls.ShutdownMode.OnExplicitShutdown);
        return 0;
    }

    [System.Runtime.InteropServices.DllImport("kernel32.dll")]
    static extern bool AttachConsole(int processId);

    public static AppBuilder BuildAvaloniaApp() =>
        AppBuilder.Configure<App>()
            .UsePlatformDetect()
            .With(new MacOSPlatformOptions { ShowInDock = false })
            .LogToTrace();
}
