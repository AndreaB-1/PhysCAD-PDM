using System.Text;
using System.Text.Json.Nodes;
using PlmAgent.Core;
using Xunit;

namespace PlmAgent.Tests;

public class PhysCadFileTests
{
    [Theory]
    [InlineData("AB00003_01.004.physcad", "AB00003", "01", 4)]
    [InlineData(@"C:\work\ab00003_a.12.PHYSCAD", "AB00003", "A", 12)]
    [InlineData("/home/x/IT0001_02.001.physcad", "IT0001", "02", 1)]
    public void ParsesBaselineNames(string name, string number, string rev, int seq)
    {
        var p = PhysCadFile.ParseBaselineFileName(name)!;
        Assert.Equal((number, rev, seq), (p.Number, p.Rev, p.Seq));
    }

    [Fact]
    public void RejectsOtherNames() => Assert.Null(PhysCadFile.ParseBaselineFileName("bracket.physcad"));

    [Fact]
    public void BaselineFileNames()
    {
        Assert.Equal("AB00042_01.003.physcad", PhysCadFile.BaselineFileName("AB00042", "01", 3, "numeric"));
        Assert.Equal("AB00042_B.7.physcad", PhysCadFile.BaselineFileName("AB00042", "B", 7, "letters"));
    }

    [Fact]
    public void FindsAndRewritesLinks()
    {
        var doc = FakePhysCad.Doc("asm", "AB00001_01.002.physcad", "AB00002_01.001.physcad");
        Assert.Equal(new[] { "AB00001_01.002.physcad", "AB00002_01.001.physcad" }, PhysCadFile.LinkedFileNames(doc));
        var folder = Path.Combine(Path.GetTempPath(), "ws");
        var rewritten = JsonNode.Parse(PhysCadFile.RewriteLinkPaths(doc, folder))!;
        var paths = rewritten["features"]!.AsArray().Where(f => (string?)f!["type"] == "import").Select(f => (string)f!["link"]!["path"]!).ToList();
        Assert.Equal(new[] { Path.Combine(folder, "AB00001_01.002.physcad"), Path.Combine(folder, "AB00002_01.001.physcad") }, paths);
        // Everything else is kept.
        Assert.Equal("box", (string?)rewritten["features"]![0]!["type"]);
    }

    [Fact]
    public void NormalizesServerUrls()
    {
        Assert.Equal("http://192.168.1.106:8490", ApiClient.NormalizeServer(" 192.168.1.106:8490/ "));
        Assert.Equal("https://plm.example.com", ApiClient.NormalizeServer("https://plm.example.com/"));
        Assert.True(ApiClient.SameServer("http://Host:1", "host:1/"));
    }
}

public class McpTests
{
    [Fact]
    public async Task ReadsTheMatchingSseEvent()
    {
        var sse = "event: message\ndata: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\"}\n\n" +
                  "data: {\"jsonrpc\":\"2.0\",\"id\":7,\n" + "data: \"result\":{\"x\":1}}\n\n";
        var node = await McpClient.ReadSse(new MemoryStream(Encoding.UTF8.GetBytes(sse)), 7);
        Assert.Equal(1, (int)node!["result"]!["x"]!);
    }

    [Fact]
    public async Task TalksToAnMcpServer()
    {
        using var fake = new FakePhysCad();
        var dir = Directory.CreateTempSubdirectory().FullName;
        var pc = new PhysCad(new McpClient(fake.Port));
        Assert.True(await pc.IsRunning());
        var path = Path.Combine(dir, "IT0001_01.001.physcad");
        await pc.CreateNew(path, "IT0001 - TEST");
        Assert.True(File.Exists(path));
        Assert.True(PhysCad.SamePath(path, (await pc.ActiveFile())!));
        var files = await pc.ExportDerived(Path.Combine(dir, "out"), "IT0001_01.001");
        Assert.Equal(new[] { "glb", "png", "step" }, files.Keys.OrderBy(k => k));
    }

    [Fact]
    public async Task ReportsPhysCadNotRunning()
    {
        var pc = new PhysCad(new McpClient(1));
        Assert.False(await pc.IsRunning());
    }
}
