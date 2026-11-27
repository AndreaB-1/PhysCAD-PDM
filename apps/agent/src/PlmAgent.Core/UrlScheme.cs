using System.Diagnostics;

namespace PlmAgent.Core;

/// <summary>
/// Registers the plmlite:// link handler for the current user, so the web app's "Open in PhysCAD" reaches the agent.
/// Windows: HKCU\Software\Classes\plmlite. Linux: a .desktop file + xdg-mime. macOS: declared in the .app's Info.plist
/// (CFBundleURLTypes), so nothing to do at run time beyond launching the app once.
/// </summary>
public static class UrlScheme
{
    public const string Scheme = "plmlite";

    public static string? ExecutablePath => Environment.ProcessPath;

    public static string Register()
    {
        var exe = ExecutablePath ?? throw new InvalidOperationException("Can't find the agent's executable path.");
        if (OperatingSystem.IsWindows()) return RegisterWindows(exe);
        if (OperatingSystem.IsLinux()) return RegisterLinux(exe);
        if (OperatingSystem.IsMacOS()) return "On macOS the link handler comes with PLM Lite Agent.app (keep it in Applications and open it once).";
        return "This system has no known link-handler registry.";
    }

    [System.Runtime.Versioning.SupportedOSPlatform("windows")]
    static string RegisterWindows(string exe)
    {
        using var key = Microsoft.Win32.Registry.CurrentUser.CreateSubKey($@"Software\Classes\{Scheme}");
        key.SetValue("", "URL:PLM Lite");
        key.SetValue("URL Protocol", "");
        using (var icon = key.CreateSubKey("DefaultIcon")) icon.SetValue("", $"\"{exe}\",0");
        using (var cmd = key.CreateSubKey(@"shell\open\command")) cmd.SetValue("", $"\"{exe}\" \"%1\"");
        return "plmlite:// links now open the agent.";
    }

    static string RegisterLinux(string exe)
    {
        var dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".local", "share", "applications");
        Directory.CreateDirectory(dir);
        var desktop = Path.Combine(dir, "plmlite-agent.desktop");
        File.WriteAllText(desktop, $"""
            [Desktop Entry]
            Type=Application
            Name=PLM Lite Agent
            Exec="{exe}" %u
            Terminal=false
            NoDisplay=true
            MimeType=x-scheme-handler/{Scheme};
            Categories=Utility;
            """.Replace("            ", "") + "\n");
        TryRun("xdg-mime", $"default plmlite-agent.desktop x-scheme-handler/{Scheme}");
        TryRun("update-desktop-database", dir);
        return "plmlite:// links now open the agent.";
    }

    /// <summary>Start the agent when the person signs in to the computer.</summary>
    public static string EnableAutostart(bool on)
    {
        var exe = ExecutablePath ?? throw new InvalidOperationException("Can't find the agent's executable path.");
        if (OperatingSystem.IsWindows())
        {
            using var run = Microsoft.Win32.Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run");
            if (on) run.SetValue("PLMLiteAgent", $"\"{exe}\" --tray"); else run.DeleteValue("PLMLiteAgent", false);
            return on ? "The agent starts when you sign in." : "Autostart off.";
        }
        if (OperatingSystem.IsLinux())
        {
            var dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".config", "autostart");
            var f = Path.Combine(dir, "plmlite-agent.desktop");
            if (!on) { if (File.Exists(f)) File.Delete(f); return "Autostart off."; }
            Directory.CreateDirectory(dir);
            File.WriteAllText(f, $"[Desktop Entry]\nType=Application\nName=PLM Lite Agent\nExec=\"{exe}\" --tray\nX-GNOME-Autostart-enabled=true\n");
            return "The agent starts when you sign in.";
        }
        if (OperatingSystem.IsMacOS())
        {
            var dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Library", "LaunchAgents");
            var f = Path.Combine(dir, "com.plmlite.agent.plist");
            if (!on) { if (File.Exists(f)) File.Delete(f); return "Autostart off."; }
            Directory.CreateDirectory(dir);
            File.WriteAllText(f, $"""
                <?xml version="1.0" encoding="UTF-8"?>
                <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
                <plist version="1.0"><dict>
                  <key>Label</key><string>com.plmlite.agent</string>
                  <key>ProgramArguments</key><array><string>{exe}</string><string>--tray</string></array>
                  <key>RunAtLoad</key><true/>
                </dict></plist>
                """);
            return "The agent starts when you sign in.";
        }
        return "Autostart isn't supported here.";
    }

    static void TryRun(string file, string args)
    {
        try { using var p = Process.Start(new ProcessStartInfo(file, args) { UseShellExecute = false, RedirectStandardError = true, RedirectStandardOutput = true }); p?.WaitForExit(5000); }
        catch { /* tool not installed */ }
    }
}
