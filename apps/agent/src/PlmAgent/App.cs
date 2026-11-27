using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Media.Imaging;
using Avalonia.Platform;
using Avalonia.Styling;
using Avalonia.Themes.Fluent;
using Avalonia.Threading;
using PlmAgent.Core;

namespace PlmAgent;

/// <summary>The tray app: an icon with a menu, plus small dialogs. All the work is in AgentService.</summary>
public sealed class App : Application
{
    public static string? StartupUrl;
    AgentService agent = null!;
    LocalServer? server;
    TrayIcon tray = null!;
    int busy;

    public override void Initialize()
    {
        Styles.Add(new FluentTheme());
        RequestedThemeVariant = ThemeVariant.Default;
        Name = "PLM Lite Agent";
    }

    public override void OnFrameworkInitializationCompleted()
    {
        agent = new AgentService(AgentConfig.Load());
        agent.Notice += (text, level) => Dispatcher.UIThread.Post(() => Toast.Show(text, level));
        agent.Changed += () => Dispatcher.UIThread.Post(RebuildMenu);
        server = LocalServer.TryStart(agent);
        agent.StartWatching();

        tray = new TrayIcon { ToolTipText = "PLM Lite Agent", Icon = Icon("tray"), IsVisible = true };
        tray.Clicked += (_, _) => OpenWeb();
        TrayIcon.SetIcons(this, new TrayIcons { tray });
        RebuildMenu();

        // macOS delivers plmlite:// links as an activation, not as a command-line argument.
        if (TryGetFeature(typeof(IActivatableLifetime)) is IActivatableLifetime act)
            act.Activated += (_, e) => { if (e is ProtocolActivatedEventArgs p && p.Kind == ActivationKind.OpenUri) Run(() => agent.HandleUrl(p.Uri.ToString())); };

        if (!agent.Config.SignedIn) Dispatcher.UIThread.Post(() => ShowSettings(firstRun: true));
        else _ = Task.Run(async () => { try { await agent.Reconcile(); } catch { /* offline */ } });
        if (StartupUrl is not null) Run(() => agent.HandleUrl(StartupUrl));

        if (ApplicationLifetime is IClassicDesktopStyleApplicationLifetime desktop)
            desktop.Exit += (_, _) => { server?.Dispose(); agent.Dispose(); };
        base.OnFrameworkInitializationCompleted();
    }

    static WindowIcon Icon(string name) => new(AssetLoader.Open(new Uri($"avares://plm-agent/Assets/{name}.png")));
    public static Bitmap AppBitmap() => new(AssetLoader.Open(new Uri("avares://plm-agent/Assets/app.png")));

    /// <summary>Run agent work off the UI thread; errors become toasts, and the icon shows it's busy.</summary>
    void Run(Func<Task> work)
    {
        Interlocked.Increment(ref busy);
        UpdateIcon();
        _ = Task.Run(async () =>
        {
            try { await work(); }
            catch (Exception e) { Dispatcher.UIThread.Post(() => Toast.Show(e.Message, NoticeLevel.Error)); }
            finally { Interlocked.Decrement(ref busy); Dispatcher.UIThread.Post(UpdateIcon); }
        });
    }

    void UpdateIcon()
    {
        tray.Icon = Icon(busy > 0 ? "tray-busy" : agent.Config.SignedIn ? "tray" : "tray-off");
        tray.ToolTipText = agent.Config.SignedIn ? $"PLM Lite Agent: {agent.Config.UserName} @ {agent.Config.ServerUrl}" : "PLM Lite Agent: not signed in";
    }

    void RebuildMenu()
    {
        var m = new NativeMenu();
        var cfg = agent.Config;
        m.Add(new NativeMenuItem(cfg.SignedIn ? $"{cfg.UserName} · {new Uri(cfg.ServerUrl).Authority}" : "Not signed in") { IsEnabled = false });
        m.Add(new NativeMenuItemSeparator());

        if (cfg.SignedIn)
        {
            var copies = agent.Workspace.Copies().OrderBy(c => c.Number).ToList();
            var co = new NativeMenuItem($"Checked out here ({copies.Count})") { Menu = new NativeMenu() };
            if (copies.Count == 0) co.Menu.Add(new NativeMenuItem("Nothing checked out") { IsEnabled = false });
            foreach (var c in copies)
            {
                var sub = new NativeMenuItem($"{c.Number} - {c.Description}{(c.LastBaselineLabel is null ? "" : $"  ({c.LastBaselineLabel})")}") { Menu = new NativeMenu() };
                sub.Menu.Add(Item("Open in PhysCAD", () => Run(() => agent.Open(c.ItemId))));
                sub.Menu.Add(Item("Check in…", () => CheckinDialog(c)));
                sub.Menu.Add(Item("Open in browser", () => AgentService.OpenUrl($"{cfg.ServerUrl}/items/{c.ItemId}")));
                sub.Menu.Add(new NativeMenuItemSeparator());
                sub.Menu.Add(Item("Cancel check-out…", () => CancelDialog(c)));
                co.Menu.Add(sub);
            }
            m.Add(co);
            m.Add(Item("New part…", NewPartDialog));
            m.Add(Item("Open web app", OpenWeb));
            m.Add(Item("Open workspace folder", () => AgentService.OpenUrl(new Uri(agent.Workspace.Root).AbsoluteUri)));
            m.Add(new NativeMenuItemSeparator());
        }
        m.Add(Item(cfg.SignedIn ? "Settings…" : "Sign in…", () => ShowSettings(false)));
        m.Add(Item("Quit", () => (ApplicationLifetime as IClassicDesktopStyleApplicationLifetime)?.Shutdown()));
        tray.Menu = m;
        UpdateIcon();
    }

    static NativeMenuItem Item(string text, Action click)
    {
        var i = new NativeMenuItem(text);
        i.Click += (_, _) => click();
        return i;
    }

    void OpenWeb()
    {
        if (agent.Config.SignedIn) AgentService.OpenUrl(agent.Config.ServerUrl);
        else ShowSettings(false);
    }

    void ShowSettings(bool firstRun) => new SettingsWindow(agent, firstRun, Run).Show();

    async void CheckinDialog(WorkingCopy c)
    {
        var comment = await Prompt.Text($"Check in {c.Number}", $"{c.Number} - {c.Description}\nWhat changed?", "", "Check in", multiline: true);
        if (!string.IsNullOrWhiteSpace(comment)) Run(() => agent.Checkin(c.ItemId, comment!));
    }

    async void CancelDialog(WorkingCopy c)
    {
        var ok = await Prompt.Confirm($"Cancel check-out of {c.Number}?",
            "The saves you made while it was checked out are discarded on the server, and the local file is moved to the workspace's .plm/trash folder.",
            "Cancel check-out");
        if (ok) Run(() => agent.CancelCheckout(c.ItemId));
    }

    async void NewPartDialog()
    {
        List<VaultInfo> vaults;
        try { vaults = (await agent.Api!.Vaults()).Where(v => v.Role is "editor" or "admin").ToList(); }
        catch (Exception e) { Toast.Show(e.Message, NoticeLevel.Error); return; }
        if (vaults.Count == 0) { Toast.Show("You can't create parts in any vault.", NoticeLevel.Error); return; }
        var r = await Prompt.NewPart(vaults);
        if (r is not null) Run(() => agent.NewPart(r.Value.vaultId, r.Value.description));
    }
}
