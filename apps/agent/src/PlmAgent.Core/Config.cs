using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace PlmAgent.Core;

/// <summary>Settings kept in the user's config folder (agent.json). The token is encrypted with DPAPI on Windows.</summary>
public sealed class AgentConfig
{
    public string ServerUrl { get; set; } = "";
    public string Workspace { get; set; } = DefaultWorkspace();
    public int? McpPort { get; set; }
    /// <summary>Stored form of the API token: "dpapi:&lt;base64&gt;" on Windows, the plain token elsewhere (file is chmod 600).</summary>
    public string? TokenStored { get; set; }
    public string? UserName { get; set; }
    public string? UserId { get; set; }

    [JsonIgnore]
    public string? Token
    {
        get => Unprotect(TokenStored);
        set => TokenStored = Protect(value);
    }

    [JsonIgnore] public bool SignedIn => !string.IsNullOrEmpty(TokenStored) && !string.IsNullOrEmpty(ServerUrl);

    public static string ConfigDir()
    {
        var env = Environment.GetEnvironmentVariable("PLM_AGENT_HOME");
        if (!string.IsNullOrEmpty(env)) return env;
        if (OperatingSystem.IsMacOS())
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Library", "Application Support", "PLMLite");
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "PLMLite");
    }

    public static string DefaultWorkspace() =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "PLM Workspace");

    static string FilePath => Path.Combine(ConfigDir(), "agent.json");

    public static AgentConfig Load()
    {
        try
        {
            if (File.Exists(FilePath))
                return JsonSerializer.Deserialize(File.ReadAllText(FilePath), AgentJson.Default.AgentConfig) ?? new AgentConfig();
        }
        catch { /* corrupt file: start over */ }
        return new AgentConfig();
    }

    public void Save()
    {
        Directory.CreateDirectory(ConfigDir());
        var tmp = FilePath + ".tmp";
        File.WriteAllText(tmp, JsonSerializer.Serialize(this, AgentJson.Default.AgentConfig));
        if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(tmp, UnixFileMode.UserRead | UnixFileMode.UserWrite);
        File.Move(tmp, FilePath, true);
    }

    static string? Protect(string? token)
    {
        if (string.IsNullOrEmpty(token)) return null;
        if (!OperatingSystem.IsWindows()) return token;
        var data = ProtectedData.Protect(Encoding.UTF8.GetBytes(token), null, DataProtectionScope.CurrentUser);
        return "dpapi:" + Convert.ToBase64String(data);
    }

    static string? Unprotect(string? stored)
    {
        if (string.IsNullOrEmpty(stored)) return null;
        if (!stored.StartsWith("dpapi:")) return stored;
        if (!OperatingSystem.IsWindows()) return null;
        try { return Encoding.UTF8.GetString(ProtectedData.Unprotect(Convert.FromBase64String(stored[6..]), null, DataProtectionScope.CurrentUser)); }
        catch { return null; }
    }

    /// <summary>PhysCAD's MCP port: the setting here, else physcad-settings.json (mcpPort), else 47173.</summary>
    public int ResolveMcpPort()
    {
        if (McpPort is > 0) return McpPort.Value;
        foreach (var dir in PhysCadSettingsDirs())
        {
            try
            {
                var f = Path.Combine(dir, "physcad-settings.json");
                if (!File.Exists(f)) continue;
                using var doc = JsonDocument.Parse(File.ReadAllText(f));
                if (doc.RootElement.TryGetProperty("mcpPort", out var p) && p.TryGetInt32(out var port) && port > 0) return port;
            }
            catch { /* ignore */ }
        }
        return 47173;
    }

    static IEnumerable<string> PhysCadSettingsDirs()
    {
        var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        yield return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "PhysCAD");
        yield return Path.Combine(home, "Library", "Application Support", "PhysCAD");
        yield return Path.Combine(home, ".config", "PhysCAD");
    }
}
