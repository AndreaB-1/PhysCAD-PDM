using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;

namespace PlmAgent.Core;

/// <summary>
/// A tiny HTTP listener on 127.0.0.1 only. It keeps the agent single-instance (a second launch for a
/// plmlite:// link hands the link over and exits) and lets the PhysCAD plugin reach the agent if its
/// network permission allows localhost.
///   GET  /status            → {"ok":true,...}
///   POST /open   {url}      → handle a plmlite:// link
///   POST /request {action,file,comment}  → same as a request file from the plugin
///   POST /show              → bring up the agent's window (someone launched the app again)
/// </summary>
public sealed class LocalServer : IDisposable
{
    public const int DefaultPort = 47180;
    readonly TcpListener listener;
    readonly AgentService agent;
    readonly CancellationTokenSource cts = new();
    public int Port { get; }

    LocalServer(TcpListener l, AgentService a, int port) { listener = l; agent = a; Port = port; }

    /// <summary>Start listening; null if another agent already owns the port.</summary>
    public static LocalServer? TryStart(AgentService agent, int port = DefaultPort)
    {
        var l = new TcpListener(IPAddress.Loopback, port);
        try { l.Start(); }
        catch (SocketException) { return null; }
        var s = new LocalServer(l, agent, port);
        _ = s.Loop();
        return s;
    }

    /// <summary>Hand a plmlite:// link to the running agent. False if none is running.</summary>
    public static async Task<bool> SendToRunning(string url, int port = DefaultPort)
    {
        try
        {
            using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };
            var body = JsonSerializer.Serialize(new Dictionary<string, string> { ["url"] = url }, AgentJson.Default.DictionaryStringString);
            var res = await http.PostAsync($"http://127.0.0.1:{port}/open", new StringContent(body, Encoding.UTF8, "application/json"));
            return res.IsSuccessStatusCode;
        }
        catch { return false; }
    }

    /// <summary>Raised when another launch asks the running agent to show itself.</summary>
    public event Action? ShowRequested;

    /// <summary>Ask the running agent to show its window. False if none is running.</summary>
    public static async Task<bool> ShowRunning(int port = DefaultPort)
    {
        try
        {
            using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };
            return (await http.PostAsync($"http://127.0.0.1:{port}/show", new StringContent(""))).IsSuccessStatusCode;
        }
        catch { return false; }
    }

    public static async Task<bool> IsRunning(int port = DefaultPort)
    {
        try
        {
            using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };
            return (await http.GetAsync($"http://127.0.0.1:{port}/status")).IsSuccessStatusCode;
        }
        catch { return false; }
    }

    async Task Loop()
    {
        while (!cts.IsCancellationRequested)
        {
            TcpClient client;
            try { client = await listener.AcceptTcpClientAsync(cts.Token); }
            catch { break; }
            _ = Handle(client);
        }
    }

    async Task Handle(TcpClient client)
    {
        using var conn = client;
        try
        {
            var stream = client.GetStream();
            stream.ReadTimeout = 5000;
            var (method, path, headers, body) = await ReadRequest(stream);
            // Browsers send an Origin header; only the plugin / our own process may call in. Reject web pages.
            if (headers.TryGetValue("origin", out var origin) && !origin.StartsWith("app://", StringComparison.OrdinalIgnoreCase))
            { await Write(stream, 403, "{\"error\":\"forbidden\"}"); return; }

            if (method == "GET" && path == "/status")
            {
                var json = $"{{\"ok\":true,\"signedIn\":{(agent.Config.SignedIn ? "true" : "false")},\"workspace\":{JsonSerializer.Serialize(agent.Workspace.Root)}}}";
                await Write(stream, 200, json);
                return;
            }
            if (method == "POST" && path == "/open")
            {
                var d = JsonSerializer.Deserialize(body, AgentJson.Default.DictionaryStringString);
                var url = d?.GetValueOrDefault("url");
                if (string.IsNullOrEmpty(url)) { await Write(stream, 400, "{\"error\":\"url missing\"}"); return; }
                await Write(stream, 202, "{\"ok\":true}");
                _ = Task.Run(async () => { try { await agent.HandleUrl(url); } catch (Exception e) { agent.RaiseError(e.Message); } });
                return;
            }
            if (method == "POST" && path == "/show")
            {
                await Write(stream, 200, "{\"ok\":true}");
                ShowRequested?.Invoke();
                return;
            }
            if (method == "POST" && path == "/request")
            {
                var req = JsonSerializer.Deserialize(body, AgentJson.Default.PluginRequest);
                if (req is null) { await Write(stream, 400, "{\"error\":\"bad request\"}"); return; }
                try { await agent.HandleRequest(req); await Write(stream, 200, "{\"ok\":true}"); }
                catch (Exception e) { await Write(stream, 409, JsonSerializer.Serialize(new Dictionary<string, string> { ["error"] = e.Message }, AgentJson.Default.DictionaryStringString)); }
                return;
            }
            await Write(stream, 404, "{\"error\":\"not found\"}");
        }
        catch { /* client went away */ }
    }

    static async Task<(string method, string path, Dictionary<string, string> headers, string body)> ReadRequest(NetworkStream s)
    {
        var buf = new List<byte>();
        var one = new byte[1];
        while (buf.Count < 16384)
        {
            if (await s.ReadAsync(one) == 0) break;
            buf.Add(one[0]);
            var n = buf.Count;
            if (n >= 4 && buf[n - 4] == '\r' && buf[n - 3] == '\n' && buf[n - 2] == '\r' && buf[n - 1] == '\n') break;
        }
        var head = Encoding.ASCII.GetString(buf.ToArray()).Split("\r\n");
        var first = head[0].Split(' ');
        var headers = head.Skip(1).Where(h => h.Contains(':'))
            .Select(h => (k: h[..h.IndexOf(':')].Trim().ToLowerInvariant(), v: h[(h.IndexOf(':') + 1)..].Trim()))
            .GroupBy(x => x.k).ToDictionary(g => g.Key, g => g.First().v);
        var len = headers.TryGetValue("content-length", out var cl) && int.TryParse(cl, out var l) ? Math.Min(l, 1 << 20) : 0;
        var body = new byte[len];
        var read = 0;
        while (read < len) { var r = await s.ReadAsync(body.AsMemory(read)); if (r == 0) break; read += r; }
        return (first[0], first.Length > 1 ? first[1].Split('?')[0] : "/", headers, Encoding.UTF8.GetString(body, 0, read));
    }

    static async Task Write(NetworkStream s, int status, string json)
    {
        var bytes = Encoding.UTF8.GetBytes(json);
        var head = $"HTTP/1.1 {status} {(status < 300 ? "OK" : "Error")}\r\nContent-Type: application/json\r\nContent-Length: {bytes.Length}\r\nConnection: close\r\n\r\n";
        await s.WriteAsync(Encoding.ASCII.GetBytes(head));
        await s.WriteAsync(bytes);
    }

    public void Dispose() { cts.Cancel(); listener.Stop(); }
}
