using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace PlmAgent.Core;

public sealed class McpException(string message) : Exception(message);

/// <summary>
/// Minimal MCP client for PhysCAD's server (streamable HTTP at http://127.0.0.1:&lt;port&gt;/mcp).
/// Handles both plain JSON and SSE responses, and the Mcp-Session-Id header.
/// </summary>
public sealed class McpClient : IDisposable
{
    readonly HttpClient http;
    readonly Uri endpoint;
    string? sessionId;
    bool initialized;
    int nextId = 1;
    readonly SemaphoreSlim gate = new(1, 1);

    public McpClient(int port, HttpMessageHandler? handler = null)
    {
        http = handler is null ? new HttpClient() : new HttpClient(handler);
        http.Timeout = TimeSpan.FromMinutes(3);
        endpoint = new Uri($"http://127.0.0.1:{port}/mcp");
    }

    /// <summary>True if PhysCAD answers on its MCP port.</summary>
    public async Task<bool> IsAvailable()
    {
        try { await EnsureInitialized(); return true; }
        catch { initialized = false; sessionId = null; return false; }
    }

    /// <summary>Call a tool; returns the parsed JSON of its first text content (or the text itself as a JSON string).</summary>
    public async Task<JsonNode?> Call(string tool, object? args = null)
    {
        await gate.WaitAsync();
        try
        {
            await EnsureInitializedLocked();
            JsonNode? result;
            try { result = await Request("tools/call", new JsonObject { ["name"] = tool, ["arguments"] = ToNode(args) ?? new JsonObject() }); }
            catch (McpException e) when (e.Message.Contains("session", StringComparison.OrdinalIgnoreCase))
            {
                // PhysCAD restarted: start a new session once.
                initialized = false; sessionId = null;
                await EnsureInitializedLocked();
                result = await Request("tools/call", new JsonObject { ["name"] = tool, ["arguments"] = ToNode(args) ?? new JsonObject() });
            }
            var text = result?["content"]?.AsArray().OfType<JsonObject>().FirstOrDefault(c => (string?)c["type"] == "text")?["text"]?.GetValue<string>();
            if (result?["isError"]?.GetValue<bool>() == true) throw new McpException($"{tool}: {text ?? "error"}");
            if (result?["structuredContent"] is JsonNode sc) return sc.DeepClone();
            if (text is null) return result?.DeepClone();
            try { return JsonNode.Parse(text); } catch { return JsonValue.Create(text); }
        }
        finally { gate.Release(); }
    }

    async Task EnsureInitialized()
    {
        await gate.WaitAsync();
        try { await EnsureInitializedLocked(); } finally { gate.Release(); }
    }

    async Task EnsureInitializedLocked()
    {
        if (initialized) return;
        await Request("initialize", new JsonObject
        {
            ["protocolVersion"] = "2025-03-26",
            ["capabilities"] = new JsonObject(),
            ["clientInfo"] = new JsonObject { ["name"] = "plm-lite-agent", ["version"] = "0.1.0" },
        });
        await Notify("notifications/initialized");
        initialized = true;
    }

    async Task Notify(string method)
    {
        using var req = NewRequest(new JsonObject { ["jsonrpc"] = "2.0", ["method"] = method });
        using var res = await http.SendAsync(req);
    }

    async Task<JsonNode?> Request(string method, JsonObject @params)
    {
        var id = nextId++;
        using var req = NewRequest(new JsonObject { ["jsonrpc"] = "2.0", ["id"] = id, ["method"] = method, ["params"] = @params });
        using var res = await http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead);
        if (res.Headers.TryGetValues("Mcp-Session-Id", out var sid)) sessionId = sid.FirstOrDefault() ?? sessionId;
        if (!res.IsSuccessStatusCode)
        {
            var body = await res.Content.ReadAsStringAsync();
            throw new McpException($"PhysCAD MCP {(int)res.StatusCode}: {body}");
        }
        var mediaType = res.Content.Headers.ContentType?.MediaType ?? "";
        JsonNode? msg = null;
        if (mediaType.Contains("event-stream"))
        {
            using var stream = await res.Content.ReadAsStreamAsync();
            msg = await ReadSse(stream, id);
        }
        else
        {
            var text = await res.Content.ReadAsStringAsync();
            msg = string.IsNullOrWhiteSpace(text) ? null : JsonNode.Parse(text);
            if (msg is JsonArray arr) msg = arr.FirstOrDefault(m => (int?)m?["id"] == id);
        }
        if (msg is null) throw new McpException($"No reply to {method}");
        if (msg["error"] is JsonNode err) throw new McpException((string?)err["message"] ?? err.ToJsonString());
        return msg["result"];
    }

    /// <summary>Read "data:" events until the response with our id arrives.</summary>
    internal static async Task<JsonNode?> ReadSse(Stream stream, int id)
    {
        using var reader = new StreamReader(stream, Encoding.UTF8);
        var data = new StringBuilder();
        string? line;
        while ((line = await reader.ReadLineAsync()) is not null)
        {
            if (line.StartsWith("data:")) { data.Append(line.AsSpan(5).TrimStart()); continue; }
            if (line.Length == 0 && data.Length > 0)
            {
                JsonNode? node = null;
                try { node = JsonNode.Parse(data.ToString()); } catch { /* skip junk */ }
                data.Clear();
                if (node is not null && (int?)node["id"] == id) return node;
            }
        }
        if (data.Length > 0)
        {
            var node = JsonNode.Parse(data.ToString());
            if ((int?)node?["id"] == id) return node;
        }
        return null;
    }

    HttpRequestMessage NewRequest(JsonObject body)
    {
        var req = new HttpRequestMessage(HttpMethod.Post, endpoint)
        {
            Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json"),
        };
        req.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        req.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("text/event-stream"));
        if (sessionId is not null) req.Headers.Add("Mcp-Session-Id", sessionId);
        return req;
    }

    static JsonNode? ToNode(object? args) => args switch
    {
        null => null,
        JsonNode n => n,
        IDictionary<string, object?> d => new JsonObject(d.Select(kv => new KeyValuePair<string, JsonNode?>(kv.Key, kv.Value switch
        {
            null => null,
            string s => JsonValue.Create(s),
            bool b => JsonValue.Create(b),
            int i => JsonValue.Create(i),
            double x => JsonValue.Create(x),
            JsonNode jn => jn,
            _ => JsonValue.Create(kv.Value.ToString()),
        }))),
        _ => throw new ArgumentException("args must be a JsonNode or a dictionary"),
    };

    public void Dispose() { http.Dispose(); gate.Dispose(); }
}

/// <summary>The PhysCAD operations the agent needs, on top of MCP tool calls.</summary>
public sealed class PhysCad(McpClient mcp)
{
    public McpClient Mcp { get; } = mcp;

    public Task<bool> IsRunning() => Mcp.IsAvailable();

    public async Task Open(string path)
    {
        // If it's already open in a tab, switch to it instead of opening a second copy.
        var tab = await FindTab(path);
        if (tab is not null) { await Mcp.Call("tab_switch", new Dictionary<string, object?> { ["id"] = tab }); return; }
        await Mcp.Call("document_open", new Dictionary<string, object?> { ["path"] = path });
    }

    /// <summary>Path of the active document, if PhysCAD reports one.</summary>
    public async Task<string?> ActiveFile()
    {
        var doc = await Mcp.Call("document_get");
        return (string?)doc?["file"] ?? (string?)doc?["path"] ?? (string?)doc?["document"]?["file"];
    }

    public async Task<string?> FindTab(string path)
    {
        try
        {
            var tabs = await Mcp.Call("tab_list");
            var arr = tabs as JsonArray ?? tabs?["tabs"] as JsonArray;
            if (arr is null) return null;
            foreach (var t in arr.OfType<JsonObject>())
            {
                var file = (string?)t["file"] ?? (string?)t["path"];
                if (file is not null && SamePath(file, path)) return t["id"]?.ToString();
            }
        }
        catch { /* older PhysCAD: no tab_list */ }
        return null;
    }

    /// <summary>New document named "AB00042 - DESCRIPTION", saved at <paramref name="path"/>.</summary>
    public async Task CreateNew(string path, string documentName)
    {
        await Mcp.Call("document_new", new Dictionary<string, object?>());
        try { await Mcp.Call("document_rename", new Dictionary<string, object?> { ["name"] = documentName }); } catch { /* optional */ }
        await Mcp.Call("document_saveAs", new Dictionary<string, object?> { ["path"] = path });
    }

    /// <summary>Export STEP, GLB and a picture of the active document into <paramref name="folder"/>. Missing exports are skipped.</summary>
    public async Task<Dictionary<string, string>> ExportDerived(string folder, string baseName)
    {
        Directory.CreateDirectory(folder);
        var outFiles = new Dictionary<string, string>();
        var step = Path.Combine(folder, baseName + ".step");
        var glb = Path.Combine(folder, baseName + ".glb");
        var png = Path.Combine(folder, baseName + ".png");
        try { await Mcp.Call("file_exportStep", new Dictionary<string, object?> { ["path"] = step }); if (File.Exists(step)) outFiles["step"] = step; } catch { }
        try { await Mcp.Call("file_export", new Dictionary<string, object?> { ["format"] = "glb", ["path"] = glb }); if (File.Exists(glb)) outFiles["glb"] = glb; } catch { }
        try
        {
            try { await Mcp.Call("component_activate", new Dictionary<string, object?> { ["id"] = "root" }); } catch { }
            var cap = await Mcp.Call("view_capture", new Dictionary<string, object?> { ["width"] = 800, ["height"] = 600 });
            var dataUrl = (string?)cap?["__image"] ?? (string?)cap?["image"] ?? (cap is JsonValue v && v.TryGetValue(out string? s) ? s : null);
            if (dataUrl is not null && dataUrl.Contains("base64,"))
            {
                await File.WriteAllBytesAsync(png, Convert.FromBase64String(dataUrl[(dataUrl.IndexOf("base64,", StringComparison.Ordinal) + 7)..]));
                outFiles["png"] = png;
            }
        }
        catch { }
        return outFiles;
    }

    public static bool SamePath(string a, string b)
    {
        static string N(string p) { try { p = Path.GetFullPath(p); } catch { } return p.Replace('\\', '/').TrimEnd('/'); }
        return string.Equals(N(a), N(b), OperatingSystem.IsLinux() ? StringComparison.Ordinal : StringComparison.OrdinalIgnoreCase);
    }
}
