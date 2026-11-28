using Avalonia;
using Avalonia.Controls;
using Avalonia.Layout;
using Avalonia.Media;
using Avalonia.Platform.Storage;
using Avalonia.Threading;
using PlmAgent.Core;

namespace PlmAgent;

static class Ui
{
    public static Window Window(string title, Control content, double width = 420) => new()
    {
        Title = title,
        Width = width,
        SizeToContent = SizeToContent.Height,
        CanResize = false,
        WindowStartupLocation = WindowStartupLocation.CenterScreen,
        Icon = new WindowIcon(App.AppBitmap()),
        Content = new Border { Padding = new Thickness(20), Child = content },
        Topmost = true,
    };

    public static TextBlock Label(string text, bool muted = false) => new()
    {
        Text = text, TextWrapping = TextWrapping.Wrap, Opacity = muted ? 0.7 : 1, FontSize = muted ? 12 : 14,
    };

    public static StackPanel Buttons(params Button[] buttons)
    {
        var p = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, HorizontalAlignment = HorizontalAlignment.Right, Margin = new Thickness(0, 8, 0, 0) };
        foreach (var b in buttons) p.Children.Add(b);
        return p;
    }

    public static Button Button(string text, bool primary = false)
    {
        var b = new Button { Content = text, MinWidth = 90, HorizontalContentAlignment = HorizontalAlignment.Center };
        if (primary) b.Classes.Add("accent");
        return b;
    }
}

static class Prompt
{
    public static Task<string?> Text(string title, string message, string initial, string okText, bool multiline = false)
    {
        var tcs = new TaskCompletionSource<string?>();
        var box = new TextBox { Text = initial, AcceptsReturn = multiline, TextWrapping = TextWrapping.Wrap, MinHeight = multiline ? 80 : 0 };
        var ok = Ui.Button(okText, true);
        var cancel = Ui.Button("Cancel");
        var w = Ui.Window(title, new StackPanel { Spacing = 10, Children = { Ui.Label(message), box, Ui.Buttons(cancel, ok) } });
        ok.Click += (_, _) => { tcs.TrySetResult(box.Text); w.Close(); };
        cancel.Click += (_, _) => w.Close();
        w.Closed += (_, _) => tcs.TrySetResult(null);
        w.Opened += (_, _) => box.Focus();
        w.Show();
        return tcs.Task;
    }

    public static Task<bool> Confirm(string title, string message, string okText)
    {
        var tcs = new TaskCompletionSource<bool>();
        var ok = Ui.Button(okText, true);
        var cancel = Ui.Button("Keep");
        var w = Ui.Window(title, new StackPanel { Spacing = 10, Children = { Ui.Label(message), Ui.Buttons(cancel, ok) } });
        ok.Click += (_, _) => { tcs.TrySetResult(true); w.Close(); };
        cancel.Click += (_, _) => w.Close();
        w.Closed += (_, _) => tcs.TrySetResult(false);
        w.Show();
        return tcs.Task;
    }

    public static Task<(string vaultId, string description)?> NewPart(List<VaultInfo> vaults)
    {
        var tcs = new TaskCompletionSource<(string, string)?>();
        var vault = new ComboBox { ItemsSource = vaults.Select(v => v.Name).ToList(), SelectedIndex = 0, HorizontalAlignment = HorizontalAlignment.Stretch };
        var desc = new TextBox { Watermark = "e.g. MOUNTING BRACKET" };
        var ok = Ui.Button("Create", true);
        var cancel = Ui.Button("Cancel");
        var panel = new StackPanel { Spacing = 10, Children =
        {
            Ui.Label("The server gives the part its number, and it opens in PhysCAD, checked out to you."),
            Ui.Label("Vault", true), vault, Ui.Label("Description", true), desc, Ui.Buttons(cancel, ok),
        } };
        var w = Ui.Window("New part", panel);
        ok.Click += (_, _) =>
        {
            if (string.IsNullOrWhiteSpace(desc.Text)) { desc.Focus(); return; }
            tcs.TrySetResult((vaults[Math.Max(0, vault.SelectedIndex)].Id, desc.Text!.Trim().ToUpperInvariant()));
            w.Close();
        };
        cancel.Click += (_, _) => w.Close();
        w.Closed += (_, _) => tcs.TrySetResult(null);
        w.Opened += (_, _) => desc.Focus();
        w.Show();
        return tcs.Task;
    }
}

/// <summary>Server, sign-in, workspace and PhysCAD connection.</summary>
sealed class SettingsWindow : Window
{
    public SettingsWindow(AgentService agent, bool firstRun, Action<Func<Task>> run)
    {
        Title = "PLM Lite Agent";
        Width = 480;
        SizeToContent = SizeToContent.Height;
        CanResize = false;
        WindowStartupLocation = WindowStartupLocation.CenterScreen;
        Icon = new WindowIcon(App.AppBitmap());

        var cfg = agent.Config;
        var serverBox = new TextBox { Text = cfg.ServerUrl, Watermark = "http://192.168.1.106:8490" };
        var status = Ui.Label(cfg.SignedIn ? $"Signed in as {cfg.UserName}." : "Not signed in.", true);
        var signIn = Ui.Button(cfg.SignedIn ? "Sign in again" : "Sign in", true);
        var signOut = Ui.Button("Sign out");
        signOut.IsVisible = cfg.SignedIn;

        var wsBox = new TextBox { Text = agent.Workspace.Root, IsReadOnly = true };
        var browse = Ui.Button("Change…");
        var portBox = new TextBox { Text = cfg.McpPort?.ToString() ?? "", Watermark = $"{cfg.ResolveMcpPort()} (from PhysCAD settings)" };
        var mcpStatus = Ui.Label("Checking PhysCAD…", true);
        var test = Ui.Button("Test");
        var links = Ui.Button("Register plmlite:// links");
        var autostart = new CheckBox { Content = "Start when I sign in to this computer" };
        var close = Ui.Button("Close");

        async Task CheckMcp()
        {
            var ok = await agent.PhysCad.IsRunning();
            Dispatcher.UIThread.Post(() => mcpStatus.Text = ok ? $"PhysCAD is reachable on port {cfg.ResolveMcpPort()}." : $"PhysCAD isn't answering on port {cfg.ResolveMcpPort()}. Open PhysCAD and turn on Preferences → AI (MCP).");
        }

        signIn.Click += (_, _) =>
        {
            if (string.IsNullOrWhiteSpace(serverBox.Text)) { serverBox.Focus(); return; }
            status.Text = "Waiting for you to approve in the browser…";
            var server = serverBox.Text!;
            run(async () =>
            {
                try
                {
                    await agent.SignIn(server);
                    Dispatcher.UIThread.Post(() => { status.Text = $"Signed in as {cfg.UserName}."; signOut.IsVisible = true; });
                    try { UrlScheme.Register(); } catch { /* not fatal */ }
                }
                catch (Exception e) { Dispatcher.UIThread.Post(() => status.Text = e.Message); throw; }
            });
        };
        signOut.Click += (_, _) => { agent.SignOut(); status.Text = "Not signed in."; signOut.IsVisible = false; };
        browse.Click += async (_, _) =>
        {
            var picked = await StorageProvider.OpenFolderPickerAsync(new FolderPickerOpenOptions { Title = "Workspace folder", AllowMultiple = false });
            var p = picked.FirstOrDefault()?.TryGetLocalPath();
            if (p is null) return;
            agent.SetWorkspace(p);
            wsBox.Text = agent.Workspace.Root;
        };
        test.Click += (_, _) =>
        {
            agent.SetMcpPort(int.TryParse(portBox.Text, out var port) && port > 0 ? port : null);
            mcpStatus.Text = "Checking PhysCAD…";
            _ = CheckMcp();
        };
        links.Click += (_, _) => { try { Toast.Show(UrlScheme.Register(), NoticeLevel.Success); } catch (Exception e) { Toast.Show(e.Message, NoticeLevel.Error); } };
        autostart.IsCheckedChanged += (_, _) => { try { UrlScheme.EnableAutostart(autostart.IsChecked == true); } catch (Exception e) { Toast.Show(e.Message, NoticeLevel.Error); } };
        close.Click += (_, _) => Close();
        var web = Ui.Button("Open web app");
        web.IsVisible = cfg.SignedIn;
        web.Click += (_, _) => AgentService.OpenUrl(cfg.ServerUrl);
        var quit = Ui.Button("Quit agent");
        quit.Click += (_, _) => (Application.Current?.ApplicationLifetime as Avalonia.Controls.ApplicationLifetimes.IClassicDesktopStyleApplicationLifetime)?.Shutdown();

        var welcome = Ui.Label("Welcome! Enter the address of your PLM Lite server and sign in. Your browser opens to approve this computer.");
        welcome.IsVisible = firstRun;

        Content = new Border
        {
            Padding = new Thickness(20),
            Child = new StackPanel
            {
                Spacing = 8,
                Children =
                {
                    welcome,
                    Section("Server"), serverBox, status, Ui.Buttons(signOut, signIn),
                    Section("Workspace"), Ui.Label("Checked-out parts and the parts they link are kept here.", true),
                    Row(wsBox, browse),
                    Section("PhysCAD"), Ui.Label("MCP port (leave empty to use PhysCAD's setting)", true), Row(portBox, test), mcpStatus,
                    Section("This computer"), links, autostart,
                    Ui.Buttons(quit, web, close),
                },
            },
        };
        Opened += (_, _) => _ = CheckMcp();
    }

    static TextBlock Section(string text) => new() { Text = text, FontWeight = FontWeight.SemiBold, Margin = new Thickness(0, 10, 0, 0) };

    static Grid Row(Control main, Control side)
    {
        var g = new Grid { ColumnDefinitions = new ColumnDefinitions("*,8,Auto") };
        g.Children.Add(main);
        Grid.SetColumn(side, 2);
        g.Children.Add(side);
        return g;
    }
}

/// <summary>A small notification in the corner of the screen (tray apps have no portable balloon API).</summary>
static class Toast
{
    static readonly List<Window> open = new();

    public static void Show(string text, NoticeLevel level)
    {
        var accent = level switch { NoticeLevel.Error => Color.Parse("#ef4444"), NoticeLevel.Success => Color.Parse("#10b981"), _ => Color.Parse("#2563eb") };
        var w = new Window
        {
            SystemDecorations = SystemDecorations.None,
            ShowInTaskbar = false,
            Topmost = true,
            CanResize = false,
            Width = 340,
            SizeToContent = SizeToContent.Height,
            ShowActivated = false,
            Background = Brushes.Transparent,
            TransparencyLevelHint = new[] { WindowTransparencyLevel.Transparent },
            Content = new Border
            {
                Background = new SolidColorBrush(Color.Parse("#1f2937")),
                BorderBrush = new SolidColorBrush(accent),
                BorderThickness = new Thickness(4, 0, 0, 0),
                CornerRadius = new CornerRadius(6),
                Padding = new Thickness(14, 10),
                Child = new TextBlock { Text = text, Foreground = Brushes.White, TextWrapping = TextWrapping.Wrap, FontSize = 13 },
            },
        };
        w.Opened += (_, _) =>
        {
            var screen = w.Screens.Primary ?? w.Screens.All.FirstOrDefault();
            if (screen is null) return;
            var area = screen.WorkingArea;
            var scale = screen.Scaling;
            var y = area.Bottom - 16;
            foreach (var o in open) y -= (int)((o.Bounds.Height + 8) * scale);
            w.Position = new PixelPoint(area.Right - (int)((w.Bounds.Width + 16) * scale), y - (int)(w.Bounds.Height * scale));
            open.Add(w);
        };
        w.Closed += (_, _) => open.Remove(w);
        w.PointerPressed += (_, _) => w.Close();
        w.Show();
        DispatcherTimer.RunOnce(() => { if (w.IsVisible) w.Close(); }, TimeSpan.FromSeconds(level == NoticeLevel.Error ? 9 : 5));
    }
}
