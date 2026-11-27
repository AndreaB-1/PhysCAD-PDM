using System.Text.Json.Nodes;
using PlmAgent.Core;
using Xunit;
using Xunit.Abstractions;

namespace PlmAgent.Tests;

/// <summary>
/// The whole loop against a real server (apps/api/test/agent-it-server.ts) and a fake PhysCAD.
/// Runs when PLM_IT_SERVER / PLM_IT_CONTROL / PLM_IT_VAULT are set (see tests/run-integration.sh); passes trivially otherwise.
/// </summary>
public class IntegrationTests(ITestOutputHelper log)
{
    static readonly string? Server = Environment.GetEnvironmentVariable("PLM_IT_SERVER");
    static readonly string? Control = Environment.GetEnvironmentVariable("PLM_IT_CONTROL");
    static readonly string? Vault = Environment.GetEnvironmentVariable("PLM_IT_VAULT");

    [Fact]
    public async Task FullLoop()
    {
        if (Server is null || Control is null || Vault is null) { log.WriteLine("PLM_IT_* not set: skipped"); return; }
        var root = Directory.CreateTempSubdirectory("plm-agent-it-").FullName;
        Environment.SetEnvironmentVariable("PLM_AGENT_HOME", Path.Combine(root, "home"));
        using var fake = new FakePhysCad();
        using var http = new HttpClient();

        var cfg = new AgentConfig { Workspace = Path.Combine(root, "ws") };
        using var agent = new AgentService(cfg, new PhysCad(new McpClient(fake.Port))) { SaveDelay = TimeSpan.FromMilliseconds(300) };
        var notices = new List<string>();
        agent.Notice += (t, l) => { lock (notices) notices.Add($"{l}: {t}"); log.WriteLine($"{l}: {t}"); };

        // 1. Device sign-in: the "browser" approves through the harness.
        await agent.SignIn(Server, url => http.GetAsync($"{Control}/approve?url={Uri.EscapeDataString(url)}").Wait());
        Assert.True(cfg.SignedIn);
        Assert.Equal("Admin", cfg.UserName);
        Assert.True(AgentConfig.Load().SignedIn); // persisted
        agent.StartWatching();

        // 2. New part: created in "PhysCAD", first save uploaded with STEP/GLB/picture.
        var partPath = await agent.NewPart(Vault, "mounting bracket");
        Assert.Equal("IT0001_01.001.physcad", Path.GetFileName(partPath));
        var part = agent.Workspace.ByPath(partPath)!;
        await Until(() => agent.Workspace.ByItem(part.ItemId)?.LastBaselineLabel == "01.001", "first save uploaded");
        var d = await agent.Api!.Item(part.ItemId);
        Assert.Equal("MOUNTING BRACKET", d.Item.Description);
        await Until(async () => (await agent.Api!.Item(part.ItemId)).Latest!.Files.Count == 4, "derived files attached");
        d = await agent.Api!.Item(part.ItemId);
        Assert.Equal(new[] { "glb", "native", "png", "step" }, d.Latest!.Files.Select(f => f.Kind).OrderBy(k => k));
        Assert.Equal("wip", d.Latest.Status);

        // 3. Another save → 01.002; saving identical content again records nothing.
        File.WriteAllText(partPath, FakePhysCad.Doc("IT0001 - MOUNTING BRACKET") + " ");
        await Until(() => agent.Workspace.ByItem(part.ItemId)?.LastBaselineLabel == "01.002", "second save uploaded");
        File.SetLastWriteTimeUtc(partPath, DateTime.UtcNow);
        File.WriteAllText(partPath, File.ReadAllText(partPath));
        await Task.Delay(1500);
        Assert.Equal(2, (await agent.Api!.Item(part.ItemId)).Revisions[0].Baselines.Count);

        // 4. Check in: lock released, working copy becomes read-only.
        await agent.Checkin(part.ItemId, "First version");
        d = await agent.Api!.Item(part.ItemId);
        Assert.Null(d.Lock);
        Assert.Equal("01.002", d.Current!.Label);
        Assert.Null(agent.Workspace.ByItem(part.ItemId));
        Assert.True(IsReadOnly(partPath));

        // 5. An assembly that links the part: the server resolves "uses".
        var asmPath = await agent.NewPart(Vault, "frame assembly");
        var asm = agent.Workspace.ByPath(asmPath)!;
        await Until(() => agent.Workspace.ByItem(asm.ItemId)?.LastBaselineLabel == "01.001", "assembly created");
        File.WriteAllText(asmPath, FakePhysCad.Doc("IT0002 - FRAME ASSEMBLY", "IT0001_01.002.physcad", "IT0001_01.002.physcad"));
        await Until(() => agent.Workspace.ByItem(asm.ItemId)?.LastBaselineLabel == "01.002", "assembly save uploaded");
        await agent.Checkin(asm.ItemId, "Frame with two brackets");
        d = await agent.Api!.Item(asm.ItemId);
        var use = Assert.Single(d.Current!.Uses!);
        Assert.Equal(("IT0001", "01.002", 2), (use.Number, use.Baseline, use.Count));
        Assert.NotNull(use.BaselineId);

        // 6. Someone else's PC opens it from a plmlite:// link: read-only copies with local link paths.
        var cfg2 = new AgentConfig { Workspace = Path.Combine(root, "ws2"), ServerUrl = cfg.ServerUrl, Token = cfg.Token, UserId = cfg.UserId, UserName = cfg.UserName };
        using var agent2 = new AgentService(cfg2, new PhysCad(new McpClient(fake.Port)));
        await agent2.HandleUrl($"plmlite://open?server={Uri.EscapeDataString(Server)}&item={asm.ItemId}");
        var view = agent2.Workspace.ViewDir;
        var opened = Path.Combine(view, "IT0002_01.002.physcad");
        Assert.True(PhysCad.SamePath(fake.ActiveFile!, opened));
        Assert.True(File.Exists(Path.Combine(view, "IT0001_01.002.physcad")));
        Assert.True(IsReadOnly(opened));
        var link = JsonNode.Parse(File.ReadAllText(opened))!["features"]!.AsArray().First(f => (string?)f!["type"] == "import")!["link"]!["path"]!.GetValue<string>();
        Assert.Equal(Path.Combine(view, "IT0001_01.002.physcad"), link);
        await Assert.ThrowsAsync<InvalidOperationException>(() => agent2.HandleUrl($"plmlite://open?server=http%3A%2F%2Fother%3A1&item={asm.ItemId}"));

        // 7. Check out again, then cancel: the WIP is discarded and the file goes to the trash.
        var again = await agent.CheckoutAndOpen(part.ItemId);
        Assert.False(IsReadOnly(again));
        File.WriteAllText(again, FakePhysCad.Doc("IT0001 - MOUNTING BRACKET") + "  ");
        await Until(() => agent.Workspace.ByItem(part.ItemId)?.LastBaselineLabel == "01.003", "third save uploaded");
        await agent.CancelCheckout(part.ItemId);
        d = await agent.Api!.Item(part.ItemId);
        Assert.Null(d.Lock);
        Assert.Equal("01.002", d.Latest!.Label);
        Assert.False(File.Exists(again));
        Assert.NotEmpty(Directory.GetFiles(agent.Workspace.TrashDir));

        // 8. Plugin request file: check in from PhysCAD.
        await agent.CheckoutAndOpen(asm.ItemId);
        File.WriteAllText(Path.Combine(agent.Workspace.RequestsDir, "r1.json"), "{\"action\":\"checkin\",\"file\":\"IT0002_01.002.physcad\",\"comment\":\"From the plugin\"}");
        await Until(async () => (await agent.Api!.Item(asm.ItemId)).Lock is null, "checked in from a plugin request");
        lock (notices) Assert.DoesNotContain(notices, n => n.StartsWith("Error"));
    }

    static bool IsReadOnly(string path) => OperatingSystem.IsWindows()
        ? File.GetAttributes(path).HasFlag(FileAttributes.ReadOnly)
        : !File.GetUnixFileMode(path).HasFlag(UnixFileMode.UserWrite);

    static Task Until(Func<bool> cond, string what) => Until(() => Task.FromResult(cond()), what);

    static async Task Until(Func<Task<bool>> cond, string what)
    {
        var until = DateTime.UtcNow.AddSeconds(15);
        while (DateTime.UtcNow < until)
        {
            if (await cond()) return;
            await Task.Delay(200);
        }
        throw new TimeoutException("Timed out waiting for: " + what);
    }
}
