using System.Security.Cryptography;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace PlmAgent.Core;

/// <summary>Helpers for .physcad documents (JSON). Mirrors packages/shared/src/physcad.ts on the server.</summary>
public static partial class PhysCadFile
{
    [GeneratedRegex(@"^([A-Za-z0-9-]+)_([A-Za-z0-9]+)\.(\d+)\.physcad$", RegexOptions.IgnoreCase)]
    private static partial Regex BaselineName();

    public sealed record BaselineName_(string Number, string Rev, int Seq);

    /// <summary>"AB00003_01.004.physcad" → (AB00003, 01, 4).</summary>
    public static BaselineName_? ParseBaselineFileName(string fileName)
    {
        var m = BaselineName().Match(Path.GetFileName(fileName.Replace('\\', '/')));
        if (!m.Success) return null;
        return new BaselineName_(m.Groups[1].Value.ToUpperInvariant(), m.Groups[2].Value.ToUpperInvariant(), int.Parse(m.Groups[3].Value));
    }

    /// <summary>File name of a baseline, e.g. AB00003_01.004.physcad (numeric) or AB00003_A.4.physcad (letters).</summary>
    public static string BaselineFileName(string number, string rev, int seq, string? scheme) =>
        scheme == "letters" ? $"{number}_{rev}.{seq}.physcad" : $"{number}_{rev}.{seq:000}.physcad";

    /// <summary>The fileName of every linked part (features with type "import" and format "physcad").</summary>
    public static List<string> LinkedFileNames(string jsonText)
    {
        var list = new List<string>();
        if (JsonNode.Parse(jsonText) is not JsonObject doc || doc["features"] is not JsonArray features) return list;
        foreach (var f in features.OfType<JsonObject>())
        {
            if ((string?)f["type"] != "import") continue;
            var format = (string?)f["format"];
            if (format is not null && format != "physcad") continue;
            var name = (string?)f["fileName"] ?? (string?)f["link"]?["path"];
            if (!string.IsNullOrEmpty(name)) list.Add(Path.GetFileName(name.Replace('\\', '/')));
        }
        return list;
    }

    /// <summary>Point every linked part's link.path at <paramref name="folder"/>/fileName. Returns the new JSON text.</summary>
    public static string RewriteLinkPaths(string jsonText, string folder)
    {
        if (JsonNode.Parse(jsonText) is not JsonObject doc) return jsonText;
        if (doc["features"] is JsonArray features)
            foreach (var f in features.OfType<JsonObject>())
                if ((string?)f["type"] == "import" && f["link"] is JsonObject link && f["fileName"] is JsonValue fn && fn.TryGetValue(out string? fileName))
                    link["path"] = Path.Combine(folder, Path.GetFileName(fileName.Replace('\\', '/')));
        return doc.ToJsonString();
    }

    /// <summary>A minimal empty document named "AB00042 - DESCRIPTION" (used only when PhysCAD can't create one).</summary>
    public static string DocumentName(string number, string description) => $"{number} - {description}";

    public static string Sha256(string path)
    {
        using var s = File.OpenRead(path);
        return Convert.ToHexString(SHA256.HashData(s)).ToLowerInvariant();
    }
}
