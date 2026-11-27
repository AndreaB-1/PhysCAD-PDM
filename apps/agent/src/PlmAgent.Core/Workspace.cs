using System.Text.Json;

namespace PlmAgent.Core;

/// <summary>
/// The workspace folder on this PC:
///   &lt;ws&gt;/AB00042_01.003.physcad   working copies (writable) and the parts they link (read-only), side by side
///   &lt;ws&gt;/.plm/state.json         what is checked out here
///   &lt;ws&gt;/.plm/view/              read-only copies opened just to look at
///   &lt;ws&gt;/.plm/requests/          requests dropped by the PhysCAD plugin
///   &lt;ws&gt;/.plm/tmp/, .plm/trash/
/// </summary>
public sealed class Workspace
{
    public string Root { get; }
    public string Meta => Path.Combine(Root, ".plm");
    public string ViewDir => Path.Combine(Meta, "view");
    public string RequestsDir => Path.Combine(Meta, "requests");
    public string TmpDir => Path.Combine(Meta, "tmp");
    public string TrashDir => Path.Combine(Meta, "trash");
    string StatePath => Path.Combine(Meta, "state.json");
    readonly object sync = new();
    public WorkspaceState State { get; private set; } = new();

    public Workspace(string root)
    {
        Root = Path.GetFullPath(root);
        foreach (var d in new[] { Root, Meta, ViewDir, RequestsDir, TmpDir, TrashDir }) Directory.CreateDirectory(d);
        Load();
    }

    void Load()
    {
        try { if (File.Exists(StatePath)) State = JsonSerializer.Deserialize(File.ReadAllText(StatePath), AgentJson.Default.WorkspaceState) ?? new(); }
        catch { State = new(); }
    }

    public void Save()
    {
        lock (sync)
        {
            var tmp = StatePath + ".tmp";
            File.WriteAllText(tmp, JsonSerializer.Serialize(State, AgentJson.Default.WorkspaceState));
            File.Move(tmp, StatePath, true);
        }
    }

    public WorkingCopy? ByPath(string path) { lock (sync) return State.Copies.FirstOrDefault(c => PhysCad.SamePath(c.Path, path)); }
    public WorkingCopy? ByItem(string itemId) { lock (sync) return State.Copies.FirstOrDefault(c => c.ItemId == itemId); }
    public List<WorkingCopy> Copies() { lock (sync) return State.Copies.ToList(); }

    public void Upsert(WorkingCopy c)
    {
        lock (sync)
        {
            State.Copies.RemoveAll(x => x.ItemId == c.ItemId);
            State.Copies.Add(c);
        }
        Save();
    }

    public void Remove(string itemId)
    {
        lock (sync) State.Copies.RemoveAll(x => x.ItemId == itemId);
        Save();
    }

    public static void SetReadOnly(string path, bool readOnly)
    {
        if (!File.Exists(path)) return;
        if (OperatingSystem.IsWindows())
        {
            var a = File.GetAttributes(path);
            File.SetAttributes(path, readOnly ? a | FileAttributes.ReadOnly : a & ~FileAttributes.ReadOnly);
        }
        else
        {
            var m = File.GetUnixFileMode(path);
            var w = UnixFileMode.UserWrite | UnixFileMode.GroupWrite | UnixFileMode.OtherWrite;
            File.SetUnixFileMode(path, readOnly ? m & ~w : m | UnixFileMode.UserWrite);
        }
    }

    /// <summary>Write text to a file even if it's currently read-only, and set the read-only flag afterwards.</summary>
    public static void WriteFile(string path, string text, bool readOnly)
    {
        if (File.Exists(path)) SetReadOnly(path, false);
        File.WriteAllText(path, text);
        SetReadOnly(path, readOnly);
    }

    /// <summary>Move a file into .plm/trash (never delete outright).</summary>
    public void Trash(string path)
    {
        if (!File.Exists(path)) return;
        SetReadOnly(path, false);
        var dest = Path.Combine(TrashDir, $"{DateTime.Now:yyyyMMdd-HHmmss}-{Path.GetFileName(path)}");
        File.Move(path, dest, true);
    }
}
