using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text.Json;
using System.Web;

namespace PlmAgent.Core;

public enum NoticeLevel { Info, Success, Error }

/// <summary>
/// The agent's work: sign in, open / check out, upload saves, check in, cancel, new part.
/// UI-free so it can run in the tray app, on the command line and in tests.
/// </summary>
public sealed class AgentService : IDisposable
{
    public AgentConfig Config { get; }
    public Workspace Workspace { get; private set; }
    public ApiClient? Api { get; private set; }
    public PhysCad PhysCad { get; private set; }
    public string Machine { get; } = Environment.MachineName;

    public event Action<string, NoticeLevel>? Notice;
    public event Action? Changed;

    FileSystemWatcher? watcher, requestWatcher;
    readonly ConcurrentDictionary<string, CancellationTokenSource> pendingSaves = new(StringComparer.OrdinalIgnoreCase);
    readonly SemaphoreSlim uploadGate = new(1, 1);
    /// <summary>Debounce before a save is uploaded (PhysCAD may write the file in steps).</summary>
    public TimeSpan SaveDelay { get; set; } = TimeSpan.FromSeconds(1.5);
    /// <summary>Ask PhysCAD for STEP/GLB/picture after each save (off in tests without PhysCAD).</summary>
    public bool ExportDerived { get; set; } = true;

    public AgentService(AgentConfig config, PhysCad? physCad = null)
    {
        Config = config;
        Workspace = new Workspace(config.Workspace);
        PhysCad = physCad ?? new PhysCad(new McpClient(config.ResolveMcpPort()));
        if (config.SignedIn) Api = new ApiClient(config.ServerUrl, config.Token);
    }

    void Say(string text, NoticeLevel level = NoticeLevel.Info) => Notice?.Invoke(text, level);
    public void RaiseError(string text) => Say(text, NoticeLevel.Error);

    /// <summary>Details that don't deserve a notification go to &lt;workspace&gt;/.plm/agent.log.</summary>
    public void Log(string text)
    {
        try
        {
            var f = Path.Combine(Workspace.Meta, "agent.log");
            if (File.Exists(f) && new FileInfo(f).Length > 1_000_000) File.Move(f, f + ".old", true);
            File.AppendAllText(f, $"{DateTime.Now:yyyy-MM-dd HH:mm:ss} {text}{Environment.NewLine}");
        }
        catch { }
    }

    ApiClient RequireApi() => Api ?? throw new InvalidOperationException("Not signed in. Choose “Sign in…” in the tray menu first.");

    // ---------------------------------------------------------------- sign-in

    /// <summary>Device-code sign-in: opens the browser, waits for approval, stores the token.</summary>
    public async Task SignIn(string serverUrl, Action<string>? openBrowser = null, CancellationToken ct = default)
    {
        var server = ApiClient.NormalizeServer(serverUrl);
        using var anon = new ApiClient(server, null);
        var code = await anon.StartDeviceSignIn($"PLM agent on {Machine}");
        (openBrowser ?? OpenUrl)(code.VerificationUriComplete);
        Say($"Approve the sign-in in your browser (code {code.UserCode}).");
        var until = DateTime.UtcNow.AddSeconds(code.ExpiresIn);
        while (DateTime.UtcNow < until)
        {
            await Task.Delay(TimeSpan.FromSeconds(Math.Max(1, code.Interval)), ct);
            var token = await anon.PollDeviceToken(code.Code);
            if (token is null) continue;
            await UseToken(server, token);
            Say($"Signed in as {Config.UserName}.", NoticeLevel.Success);
            return;
        }
        throw new TimeoutException("The sign-in code expired. Try again.");
    }

    /// <summary>Store a token (from the device flow, or pasted from Account → Access tokens).</summary>
    public async Task UseToken(string serverUrl, string token)
    {
        var api = new ApiClient(serverUrl, token);
        var me = await api.Me();
        if (me.User is null) { api.Dispose(); throw new InvalidOperationException("The server didn't accept the token."); }
        Api?.Dispose();
        Api = api;
        Config.ServerUrl = api.BaseUrl;
        Config.Token = token;
        Config.UserId = me.User.Id;
        Config.UserName = me.User.Name;
        Config.Save();
        Workspace.State.Server = api.BaseUrl;
        Workspace.Save();
        Changed?.Invoke();
    }

    public void SignOut()
    {
        Api?.Dispose(); Api = null;
        Config.Token = null; Config.UserId = null; Config.UserName = null;
        Config.Save();
        Changed?.Invoke();
    }

    public void SetWorkspace(string folder)
    {
        StopWatching();
        Config.Workspace = Path.GetFullPath(folder);
        Config.Save();
        Workspace = new Workspace(Config.Workspace);
        StartWatching();
        Changed?.Invoke();
    }

    public void SetMcpPort(int? port)
    {
        Config.McpPort = port;
        Config.Save();
        PhysCad = new PhysCad(new McpClient(Config.ResolveMcpPort()));
    }

    // ---------------------------------------------------------------- open / check out

    /// <summary>Handle plmlite://open?server=…&amp;item=…&amp;baseline=…</summary>
    public async Task HandleUrl(string url)
    {
        var uri = new Uri(url);
        if (!string.Equals(uri.Scheme, "plmlite", StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("Not a plmlite:// link");
        var q = HttpUtility.ParseQueryString(uri.Query);
        var action = uri.Host.Length > 0 ? uri.Host : uri.AbsolutePath.Trim('/');
        var server = q["server"];
        if (server is not null && Config.SignedIn && !ApiClient.SameServer(server, Config.ServerUrl))
            throw new InvalidOperationException($"This link is for {server}, but the agent is signed in to {Config.ServerUrl}.");
        if (server is not null && !Config.SignedIn)
            throw new InvalidOperationException($"Sign in to {server} first (tray menu → Sign in…).");
        var item = q["item"] ?? throw new ArgumentException("The link has no item.");
        switch (action.ToLowerInvariant())
        {
            case "open": await Open(item, q["baseline"]); break;
            case "checkout": await CheckoutAndOpen(item); break;
            default: throw new ArgumentException($"Unknown link action “{action}”.");
        }
    }

    /// <summary>
    /// Open an item in PhysCAD. If it's checked out to you, opens (or fetches) your working copy;
    /// otherwise a read-only copy of the chosen baseline (default: the checked-in one).
    /// </summary>
    public async Task<string> Open(string itemId, string? baselineId = null)
    {
        var api = RequireApi();
        var d = await api.Item(itemId);
        string path;
        var mine = d.Lock is not null && d.Lock.UserId == Config.UserId;
        if (mine && (string.IsNullOrEmpty(baselineId) || baselineId == d.Latest?.Id))
            path = await EnsureWorkingCopy(d);
        else
        {
            var b = FindBaseline(d, baselineId) ?? d.Current ?? d.Latest ?? throw new InvalidOperationException($"{d.Item.Number} has no saved baselines yet.");
            path = await DownloadBaseline(d, b, Workspace.ViewDir, readOnly: true);
        }
        await OpenInPhysCad(path);
        return path;
    }

    public async Task<string> CheckoutAndOpen(string itemId)
    {
        var api = RequireApi();
        var d = await api.Item(itemId);
        if (d.Lock is null)
        {
            var frozen = d.Revisions.FirstOrDefault()?.Frozen == true;
            d = frozen ? await api.Revise(itemId, Machine, Workspace.Root) : await api.Checkout(itemId, Machine, Workspace.Root);
            Say(frozen ? $"{d.Item.Number}: new revision {d.Revisions[0].Rev} started and checked out." : $"{d.Item.Number} checked out.", NoticeLevel.Success);
        }
        else if (d.Lock.UserId != Config.UserId)
            throw new InvalidOperationException($"{d.Item.Number} is checked out by {d.Lock.User ?? "someone else"}.");
        var path = await EnsureWorkingCopy(d);
        await OpenInPhysCad(path);
        return path;
    }

    /// <summary>Make sure the checked-out item has a writable file in the workspace; download or create it.</summary>
    async Task<string> EnsureWorkingCopy(ItemDetail d)
    {
        var existing = Workspace.ByItem(d.Item.Id);
        if (existing is not null && File.Exists(existing.Path)) return existing.Path;
        string path;
        var latest = d.Latest;
        if (latest is not null && latest.Files.Any(f => f.Kind == "native"))
        {
            path = await DownloadBaseline(d, latest, Workspace.Root, readOnly: false);
        }
        else
        {
            var rev = d.Revisions.FirstOrDefault()?.Rev ?? "01";
            path = Path.Combine(Workspace.Root, PhysCadFile.BaselineFileName(d.Item.Number, rev, 1, d.Vault.RevScheme));
            if (!await PhysCad.IsRunning()) throw new InvalidOperationException("Open PhysCAD first: the new part is created there.");
            await PhysCad.CreateNew(path, PhysCadFile.DocumentName(d.Item.Number, d.Item.Description));
        }
        var copy = new WorkingCopy
        {
            ItemId = d.Item.Id, Number = d.Item.Number, Description = d.Item.Description, VaultId = d.Item.VaultId, Path = path,
            LastHash = File.Exists(path) && latest is not null ? PhysCadFile.Sha256(path) : null,
            LastBaselineId = latest?.Id, LastBaselineLabel = latest?.Label,
        };
        Workspace.Upsert(copy);
        Changed?.Invoke();
        // A part created just now was saved before it was registered: upload that first save.
        if (latest is null && File.Exists(path)) QueueSave(path);
        return path;
    }

    static Baseline? FindBaseline(ItemDetail d, string? id) =>
        string.IsNullOrEmpty(id) ? null : d.Revisions.SelectMany(r => r.Baselines).FirstOrDefault(b => b.Id == id);

    /// <summary>
    /// Download a baseline's native file into <paramref name="folder"/>, plus (read-only, recursively) every part it links,
    /// with link paths pointing at the copies next to it.
    /// </summary>
    public async Task<string> DownloadBaseline(ItemDetail d, Baseline b, string folder, bool readOnly, HashSet<string>? seen = null)
    {
        var api = RequireApi();
        seen ??= new HashSet<string>();
        var native = b.Files.FirstOrDefault(f => f.Kind == "native") ?? throw new InvalidOperationException($"{d.Item.Number} {b.Label} has no PhysCAD file.");
        var path = Path.Combine(folder, native.Name);
        seen.Add(b.Id);

        // A working copy of this exact file in the workspace wins over a server copy.
        var wc = Workspace.ByPath(path);
        if (wc is null || !File.Exists(path))
        {
            var tmp = Path.Combine(Workspace.TmpDir, Guid.NewGuid().ToString("N"));
            await api.Download(native.Id, tmp);
            var text = await File.ReadAllTextAsync(tmp);
            File.Delete(tmp);
            try { text = PhysCadFile.RewriteLinkPaths(text, folder); } catch { /* not JSON: keep as is */ }
            Workspace.WriteFile(path, text, readOnly);
        }

        foreach (var u in b.Uses ?? new())
        {
            if (u.ItemId is null || u.BaselineId is null || seen.Contains(u.BaselineId)) continue;
            try
            {
                var child = await api.Item(u.ItemId);
                var cb = FindBaseline(child, u.BaselineId);
                if (cb is not null) await DownloadBaseline(child, cb, folder, readOnly: true, seen);
            }
            catch (Exception e) { Say($"Couldn't fetch {u.Number} {u.Baseline}: {e.Message}", NoticeLevel.Error); }
        }
        return path;
    }

    async Task OpenInPhysCad(string path)
    {
        if (!await PhysCad.IsRunning())
        {
            Say($"Saved {Path.GetFileName(path)} in the workspace. Start PhysCAD (with MCP on) to open it automatically.", NoticeLevel.Error);
            return;
        }
        await PhysCad.Open(path);
    }

    // ---------------------------------------------------------------- new part

    public async Task<string> NewPart(string vaultId, string description)
    {
        var api = RequireApi();
        if (!await PhysCad.IsRunning()) throw new InvalidOperationException("Open PhysCAD first: the new part is created there.");
        var created = await api.CreateItem(vaultId, description.Trim().ToUpperInvariant(), Machine, Workspace.Root);
        var d = await api.Item(created.Id);
        var path = await EnsureWorkingCopy(d);
        Say($"{d.Item.Number} - {d.Item.Description} created and checked out.", NoticeLevel.Success);
        return path;
    }

    // ---------------------------------------------------------------- saves

    public void StartWatching()
    {
        StopWatching();
        watcher = new FileSystemWatcher(Workspace.Root, "*.physcad") { IncludeSubdirectories = false, NotifyFilter = NotifyFilters.LastWrite | NotifyFilters.FileName | NotifyFilters.Size };
        watcher.Changed += (_, e) => QueueSave(e.FullPath);
        watcher.Created += (_, e) => QueueSave(e.FullPath);
        watcher.Renamed += (_, e) => QueueSave(e.FullPath);
        watcher.EnableRaisingEvents = true;

        requestWatcher = new FileSystemWatcher(Workspace.RequestsDir, "*.json") { NotifyFilter = NotifyFilters.LastWrite | NotifyFilters.FileName };
        requestWatcher.Created += (_, e) => _ = HandleRequestFile(e.FullPath);
        requestWatcher.Changed += (_, e) => _ = HandleRequestFile(e.FullPath);
        requestWatcher.Renamed += (_, e) => _ = HandleRequestFile(e.FullPath);
        requestWatcher.EnableRaisingEvents = true;
        foreach (var f in Directory.GetFiles(Workspace.RequestsDir, "*.json")) _ = HandleRequestFile(f);
        WriteStatusFile();
    }

    public void StopWatching()
    {
        watcher?.Dispose(); watcher = null;
        requestWatcher?.Dispose(); requestWatcher = null;
    }

    void QueueSave(string path)
    {
        if (Workspace.ByPath(path) is null) return;
        var cts = new CancellationTokenSource();
        pendingSaves.AddOrUpdate(path, cts, (_, old) => { old.Cancel(); return cts; });
        _ = Task.Run(async () =>
        {
            try { await Task.Delay(SaveDelay, cts.Token); }
            catch (TaskCanceledException) { return; }
            pendingSaves.TryRemove(new KeyValuePair<string, CancellationTokenSource>(path, cts));
            try { await UploadSave(path); }
            catch (Exception e) { Say($"Upload of {Path.GetFileName(path)} failed: {e.Message}", NoticeLevel.Error); }
        });
    }

    /// <summary>Upload the working copy as a new baseline (skipped if unchanged), then its STEP/GLB/picture from PhysCAD.</summary>
    public async Task<BaselineRef?> UploadSave(string path, bool quiet = false)
    {
        var copy = Workspace.ByPath(path);
        if (copy is null || !File.Exists(path)) return null;
        await uploadGate.WaitAsync();
        try
        {
            var hash = await RetryIo(() => PhysCadFile.Sha256(path));
            if (hash == copy.LastHash) return null;
            var api = RequireApi();
            var res = await api.UploadBaseline(copy.ItemId, new Dictionary<string, string> { ["native"] = path });
            copy.LastHash = hash;
            if (res.Unchanged || res.Baseline is null) { Workspace.Upsert(copy); return null; }
            copy.LastBaselineId = res.Baseline.Id;
            copy.LastBaselineLabel = res.Baseline.Label;
            Workspace.Upsert(copy);
            if (!quiet) Say($"{copy.Number} saved as {res.Baseline.Label}.", NoticeLevel.Success);
            Changed?.Invoke();

            if (ExportDerived) await AttachDerived(copy, res.Baseline, path);
            return res.Baseline;
        }
        finally { uploadGate.Release(); WriteStatusFile(); }
    }

    async Task AttachDerived(WorkingCopy copy, BaselineRef b, string path)
    {
        try
        {
            if (!await PhysCad.IsRunning()) return;
            // Export only if the saved file is the one PhysCAD is showing: never switch the person's tabs behind their back.
            var active = await PhysCad.ActiveFile();
            if (active is null || !PhysCad.SamePath(active, path)) return;
            var dir = Path.Combine(Workspace.TmpDir, b.Id);
            var files = await PhysCad.ExportDerived(dir, Path.GetFileNameWithoutExtension(path), m => Log($"{copy.Number} {b.Label}: {m}"));
            if (files.Count > 0) await RequireApi().AttachFiles(b.Id, files);
            try { Directory.Delete(dir, true); } catch { }
        }
        catch (Exception e) { Say($"{copy.Number}: picture/3D export skipped ({e.Message}).", NoticeLevel.Error); }
    }

    static async Task<T> RetryIo<T>(Func<T> f)
    {
        for (var i = 0; ; i++)
        {
            try { return f(); }
            catch (IOException) when (i < 10) { await Task.Delay(300); }
        }
    }

    // ---------------------------------------------------------------- check in / cancel

    public async Task Checkin(string itemId, string comment)
    {
        var api = RequireApi();
        var copy = Workspace.ByItem(itemId);
        if (copy is not null)
        {
            if (pendingSaves.TryRemove(copy.Path, out var p)) p.Cancel();
            await UploadSave(copy.Path, quiet: true);
        }
        var d = await api.Checkin(itemId, comment);
        if (copy is not null)
        {
            Workspace.SetReadOnly(copy.Path, true);
            Workspace.Remove(itemId);
        }
        Say($"{d.Item.Number} checked in as {d.Current?.Label}.", NoticeLevel.Success);
        Changed?.Invoke();
        WriteStatusFile();
    }

    /// <summary>Undo the check-out: the server discards this check-out's WIP baselines; the local file goes to .plm/trash.</summary>
    public async Task CancelCheckout(string itemId)
    {
        var api = RequireApi();
        var copy = Workspace.ByItem(itemId);
        if (copy is not null && pendingSaves.TryRemove(copy.Path, out var p)) p.Cancel();
        await api.CancelCheckout(itemId);
        if (copy is not null)
        {
            Workspace.Trash(copy.Path);
            Workspace.Remove(itemId);
        }
        Say($"Check-out of {copy?.Number ?? "the item"} cancelled.", NoticeLevel.Success);
        Changed?.Invoke();
        WriteStatusFile();
    }

    /// <summary>Drop local records of items that are no longer checked out to us (released in the browser, force-unlocked…).</summary>
    public async Task Reconcile()
    {
        if (Api is null) return;
        var mine = (await Api.MyCheckouts()).Select(c => c.Id).ToHashSet();
        foreach (var c in Workspace.Copies().Where(c => !mine.Contains(c.ItemId)))
        {
            Workspace.SetReadOnly(c.Path, true);
            Workspace.Remove(c.ItemId);
        }
        Changed?.Invoke();
        WriteStatusFile();
    }

    // ---------------------------------------------------------------- plugin requests

    async Task HandleRequestFile(string file)
    {
        if (file.EndsWith(".taken", StringComparison.Ordinal)) return;
        await Task.Delay(200);
        PluginRequest? req;
        // One file can raise several watcher events: whoever renames it first handles it.
        var taken = file + "." + Guid.NewGuid().ToString("N") + ".taken";
        try { File.Move(file, taken); }
        catch { return; }
        try
        {
            var text = await RetryIo(() => File.ReadAllText(taken));
            req = string.IsNullOrWhiteSpace(text) ? null : JsonSerializer.Deserialize(text, AgentJson.Default.PluginRequest);
        }
        catch { req = null; }
        finally { try { File.Delete(taken); } catch { } }
        if (req is null) return;
        try { await HandleRequest(req); }
        catch (Exception e) { Say(e.Message, NoticeLevel.Error); }
    }

    public async Task HandleRequest(PluginRequest req)
    {
        WorkingCopy? copy = null;
        if (req.File is not null) copy = Workspace.ByPath(Path.IsPathRooted(req.File) ? req.File : Path.Combine(Workspace.Root, Path.GetFileName(req.File)));
        if (copy is null && req.Number is not null) copy = Workspace.Copies().FirstOrDefault(c => c.Number.Equals(req.Number, StringComparison.OrdinalIgnoreCase));
        switch (req.Action)
        {
            case "checkin":
                if (copy is null) throw new InvalidOperationException("This document isn't checked out on this PC.");
                await Checkin(copy.ItemId, string.IsNullOrWhiteSpace(req.Comment) ? "Checked in from PhysCAD" : req.Comment);
                break;
            case "saved":
                if (copy is not null) await UploadSave(copy.Path);
                break;
            case "open-browser":
                if (copy is not null) OpenUrl($"{Config.ServerUrl}/items/{copy.ItemId}");
                else OpenUrl(Config.ServerUrl);
                break;
            default: throw new InvalidOperationException($"Unknown request “{req.Action}”.");
        }
    }

    /// <summary>&lt;ws&gt;/.plm/status.json, read by the plugin to show whether the open document is checked out.</summary>
    void WriteStatusFile()
    {
        try
        {
            var map = Workspace.Copies().ToDictionary(c => Path.GetFileName(c.Path), c => $"{c.Number}|{c.LastBaselineLabel}");
            File.WriteAllText(Path.Combine(Workspace.Meta, "status.json"), JsonSerializer.Serialize(map, AgentJson.Default.DictionaryStringString));
        }
        catch { }
    }

    // ---------------------------------------------------------------- misc

    public static void OpenUrl(string url)
    {
        try
        {
            if (OperatingSystem.IsWindows()) Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
            else if (OperatingSystem.IsMacOS()) Process.Start("open", url);
            else Process.Start("xdg-open", url);
        }
        catch { /* nothing to open with */ }
    }

    public void Dispose()
    {
        StopWatching();
        Api?.Dispose();
        PhysCad.Mcp.Dispose();
        uploadGate.Dispose();
    }
}
