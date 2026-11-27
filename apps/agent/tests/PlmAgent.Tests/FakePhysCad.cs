using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json.Nodes;

namespace PlmAgent.Tests;

/// <summary>
/// Stands in for PhysCAD's MCP server: keeps an "active document" and writes real files for
/// saveAs / exports, so the agent's whole save loop can run without PhysCAD.
/// Replies to tools/call as SSE (like streamable HTTP servers often do) and to the rest as JSON.
/// </summary>
public sealed class FakePhysCad : IDisposable
{
    readonly HttpListener listener = new();
    public int Port { get; }
    public string? ActiveFile { get; set; }
    public List<string> Calls { get; } = new();
    public string SessionId { get; } = Guid.NewGuid().ToString("N");

    // A 1×1 PNG.
    const string Png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

    public FakePhysCad()
    {
        var l = new TcpListener(IPAddress.Loopback, 0);
        l.Start();
        Port = ((IPEndPoint)l.LocalEndpoint).Port;
        l.Stop();
        listener.Prefixes.Add($"http://127.0.0.1:{Port}/");
        listener.Start();
        _ = Loop();
    }

    async Task Loop()
    {
        while (listener.IsListening)
        {
            HttpListenerContext ctx;
            try { ctx = await listener.GetContextAsync(); } catch { return; }
            try { await Handle(ctx); } catch { try { ctx.Response.StatusCode = 500; ctx.Response.Close(); } catch { } }
        }
    }

    async Task Handle(HttpListenerContext ctx)
    {
        using var reader = new StreamReader(ctx.Request.InputStream);
        var msg = JsonNode.Parse(await reader.ReadToEndAsync())!.AsObject();
        var method = (string)msg["method"]!;
        var res = ctx.Response;
        if (method == "initialize")
        {
            res.Headers["Mcp-Session-Id"] = SessionId;
            await Json(res, Reply(msg, new JsonObject { ["protocolVersion"] = "2025-03-26", ["capabilities"] = new JsonObject(), ["serverInfo"] = new JsonObject { ["name"] = "fake-physcad" } }));
            return;
        }
        if (msg["id"] is null) { res.StatusCode = 202; res.Close(); return; }
        if (ctx.Request.Headers["Mcp-Session-Id"] != SessionId) { res.StatusCode = 400; await Write(res, "{\"error\":\"bad session\"}", "application/json"); return; }

        var p = msg["params"]!;
        var tool = (string)p["name"]!;
        var args = p["arguments"] as JsonObject ?? new JsonObject();
        lock (Calls) Calls.Add(tool);
        JsonNode result = tool switch
        {
            "document_new" => Do(() => { ActiveFile = null; }),
            "document_rename" => Do(() => { }),
            "document_saveAs" => Do(() => { var path = (string)args["path"]!; File.WriteAllText(path, Doc(Path.GetFileNameWithoutExtension(path))); ActiveFile = path; }),
            "document_open" => Do(() => { ActiveFile = (string)args["path"]!; }),
            "document_get" => new JsonObject { ["file"] = ActiveFile, ["name"] = "doc" },
            "tab_list" => new JsonArray(),
            "file_exportStep" => Do(() => File.WriteAllText((string)args["path"]!, "ISO-10303-21;\nEND-ISO-10303-21;\n")),
            "file_export" => Do(() => File.WriteAllBytes((string)args["path"]!, Encoding.ASCII.GetBytes("glTF\u0002\0\0\0"))),
            "component_activate" => Do(() => { }),
            "view_capture" => new JsonObject { ["__image"] = "data:image/png;base64," + Png },
            _ => throw new InvalidOperationException("unknown tool " + tool),
        };
        var payload = Reply(msg, new JsonObject { ["content"] = new JsonArray(new JsonObject { ["type"] = "text", ["text"] = result.ToJsonString() }) });
        res.ContentType = "text/event-stream";
        await Write(res, $"event: message\ndata: {payload.ToJsonString()}\n\n", "text/event-stream");
    }

    public static string Doc(string name, params string[] links) => new JsonObject
    {
        ["format"] = "physcad", ["version"] = 3, ["name"] = name, ["units"] = "mm", ["components"] = new JsonArray(),
        ["features"] = new JsonArray(new JsonNode[] { new JsonObject { ["type"] = "box", ["id"] = "f1" } }
            .Concat(links.Select((l, i) => (JsonNode)new JsonObject
            {
                ["type"] = "import", ["id"] = $"l{i}", ["fileName"] = l, ["format"] = "physcad",
                ["link"] = new JsonObject { ["path"] = $"C:\\elsewhere\\{l}", ["mtime"] = 0, ["hash"] = "x" }, ["parts"] = new JsonArray(),
            })).ToArray()),
    }.ToJsonString();

    static JsonNode Do(Action a) { a(); return new JsonObject { ["ok"] = true }; }
    static JsonObject Reply(JsonObject req, JsonNode result) => new() { ["jsonrpc"] = "2.0", ["id"] = req["id"]!.DeepClone(), ["result"] = result };
    static Task Json(HttpListenerResponse r, JsonNode n) => Write(r, n.ToJsonString(), "application/json");

    static async Task Write(HttpListenerResponse r, string text, string type)
    {
        var b = Encoding.UTF8.GetBytes(text);
        r.ContentType = type;
        r.ContentLength64 = b.Length;
        await r.OutputStream.WriteAsync(b);
        r.Close();
    }

    public void Dispose() { try { listener.Stop(); listener.Close(); } catch { } }
}
