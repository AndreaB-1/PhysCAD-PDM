using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization.Metadata;

namespace PlmAgent.Core;

public sealed class ApiException(HttpStatusCode status, string message, string? code) : Exception(message)
{
    public HttpStatusCode Status { get; } = status;
    public string? Code { get; } = code;
}

/// <summary>Talks to the PLM Lite server (docs/agent-api.md).</summary>
public sealed class ApiClient : IDisposable
{
    readonly HttpClient http;
    public string BaseUrl { get; }

    public ApiClient(string serverUrl, string? token, HttpMessageHandler? handler = null)
    {
        BaseUrl = NormalizeServer(serverUrl);
        http = handler is null ? new HttpClient() : new HttpClient(handler);
        http.BaseAddress = new Uri(BaseUrl + "/api/");
        http.Timeout = TimeSpan.FromMinutes(10);
        http.DefaultRequestHeaders.UserAgent.ParseAdd("PLMLiteAgent/0.1");
        if (!string.IsNullOrEmpty(token)) http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
    }

    /// <summary>"192.168.1.106:8490/" → "http://192.168.1.106:8490".</summary>
    public static string NormalizeServer(string url)
    {
        url = url.Trim().TrimEnd('/');
        if (!url.StartsWith("http://", StringComparison.OrdinalIgnoreCase) && !url.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
            url = "http://" + url;
        return url;
    }

    public static bool SameServer(string a, string b) =>
        string.Equals(NormalizeServer(a), NormalizeServer(b), StringComparison.OrdinalIgnoreCase);

    // ---- sign-in
    public Task<DeviceCode> StartDeviceSignIn(string clientName) =>
        Send(HttpMethod.Post, "device/code", Json(new Dictionary<string, string> { ["clientName"] = clientName }), AgentJson.Default.DeviceCode);

    /// <summary>Null while the person hasn't approved yet.</summary>
    public async Task<string?> PollDeviceToken(string deviceCode)
    {
        try { return (await Send(HttpMethod.Post, "device/token", Json(new Dictionary<string, string> { ["deviceCode"] = deviceCode }), AgentJson.Default.TokenResponse)).Token; }
        catch (ApiException e) when (e.Code == "authorization_pending" || e.Message == "authorization_pending") { return null; }
    }

    public Task<MeResponse> Me() => Send(HttpMethod.Get, "auth/me", null, AgentJson.Default.MeResponse);
    public Task<List<VaultInfo>> Vaults() => Send(HttpMethod.Get, "vaults", null, AgentJson.Default.ListVaultInfo);
    public Task<ItemDetail> Item(string id) => Send(HttpMethod.Get, $"items/{id}", null, AgentJson.Default.ItemDetail);
    public Task<ItemDetail> ItemByNumber(string vaultId, string number) => Send(HttpMethod.Get, $"vaults/{vaultId}/items/by-number/{Uri.EscapeDataString(number)}", null, AgentJson.Default.ItemDetail);
    public Task<List<CheckoutRow>> MyCheckouts() => Send(HttpMethod.Get, "me/checkouts", null, AgentJson.Default.ListCheckoutRow);

    public Task<NewItemResponse> CreateItem(string vaultId, string description, string machine, string workspace) =>
        Send(HttpMethod.Post, $"vaults/{vaultId}/items", JsonObj(new() { ["description"] = description, ["checkout"] = true, ["machine"] = machine, ["workspacePath"] = workspace }), AgentJson.Default.NewItemResponse);

    public Task<ItemDetail> Checkout(string itemId, string machine, string workspace) =>
        Send(HttpMethod.Post, $"items/{itemId}/checkout", JsonObj(new() { ["machine"] = machine, ["workspacePath"] = workspace }), AgentJson.Default.ItemDetail);

    public Task<ItemDetail> Revise(string itemId, string machine, string workspace) =>
        Send(HttpMethod.Post, $"items/{itemId}/revise", JsonObj(new() { ["machine"] = machine, ["workspacePath"] = workspace }), AgentJson.Default.ItemDetail);

    public Task<ItemDetail> Checkin(string itemId, string comment) =>
        Send(HttpMethod.Post, $"items/{itemId}/checkin", Json(new Dictionary<string, string> { ["comment"] = comment }), AgentJson.Default.ItemDetail);

    public async Task CancelCheckout(string itemId)
    {
        using var res = await http.PostAsync($"items/{itemId}/cancel-checkout", Json(new Dictionary<string, string>()));
        await EnsureOk(res);
    }

    /// <summary>Upload a save: the native file plus any derived files (kind → path).</summary>
    public Task<BaselineUploadResponse> UploadBaseline(string itemId, IReadOnlyDictionary<string, string> files, string? comment = null)
    {
        var form = Multipart(files);
        if (!string.IsNullOrEmpty(comment)) form.Add(new StringContent(comment), "comment");
        return Send(HttpMethod.Post, $"items/{itemId}/baselines", form, AgentJson.Default.BaselineUploadResponse);
    }

    public async Task AttachFiles(string baselineId, IReadOnlyDictionary<string, string> files)
    {
        using var res = await http.PostAsync($"baselines/{baselineId}/files", Multipart(files));
        await EnsureOk(res);
    }

    public async Task Download(string fileId, string dest)
    {
        using var res = await http.GetAsync($"files/{fileId}?download=1", HttpCompletionOption.ResponseHeadersRead);
        await EnsureOk(res);
        Directory.CreateDirectory(Path.GetDirectoryName(dest)!);
        var tmp = dest + ".part";
        await using (var fs = File.Create(tmp)) await res.Content.CopyToAsync(fs);
        File.Move(tmp, dest, true);
    }

    // ---- plumbing
    static MultipartFormDataContent Multipart(IReadOnlyDictionary<string, string> files)
    {
        var form = new MultipartFormDataContent();
        foreach (var (kind, path) in files)
        {
            var content = new StreamContent(File.OpenRead(path));
            content.Headers.ContentType = new MediaTypeHeaderValue("application/octet-stream");
            form.Add(content, kind, Path.GetFileName(path));
        }
        return form;
    }

    static StringContent Json(Dictionary<string, string> body) =>
        new(JsonSerializer.Serialize(body, AgentJson.Default.DictionaryStringString), Encoding.UTF8, "application/json");

    static StringContent JsonObj(Dictionary<string, object> body)
    {
        // Small hand-rolled writer keeps the source-generated context simple (strings and booleans only).
        using var ms = new MemoryStream();
        using (var w = new Utf8JsonWriter(ms))
        {
            w.WriteStartObject();
            foreach (var (k, v) in body)
            {
                if (v is bool b) w.WriteBoolean(k, b);
                else w.WriteString(k, v?.ToString());
            }
            w.WriteEndObject();
        }
        return new StringContent(Encoding.UTF8.GetString(ms.ToArray()), Encoding.UTF8, "application/json");
    }

    async Task<T> Send<T>(HttpMethod method, string path, HttpContent? body, JsonTypeInfo<T> type)
    {
        using var req = new HttpRequestMessage(method, path) { Content = body };
        using var res = await http.SendAsync(req);
        await EnsureOk(res);
        var text = await res.Content.ReadAsStringAsync();
        return JsonSerializer.Deserialize(text, type) ?? throw new ApiException(res.StatusCode, "Empty response", null);
    }

    static async Task EnsureOk(HttpResponseMessage res)
    {
        if (res.IsSuccessStatusCode) return;
        var text = await res.Content.ReadAsStringAsync();
        ApiError? err = null;
        try { err = JsonSerializer.Deserialize(text, AgentJson.Default.ApiError); } catch { /* not JSON */ }
        var msg = err?.Error ?? (string.IsNullOrWhiteSpace(text) ? res.ReasonPhrase ?? "Request failed" : text);
        throw new ApiException(res.StatusCode, msg, err?.Code ?? err?.Error);
    }

    public void Dispose() => http.Dispose();
}
