using System.Text.Json;
using System.Text.Json.Serialization;

namespace PlmAgent.Core;

public sealed class DeviceCode
{
    [JsonPropertyName("deviceCode")] public string Code { get; set; } = "";
    public string UserCode { get; set; } = "";
    public string VerificationUriComplete { get; set; } = "";
    public int Interval { get; set; } = 3;
    public int ExpiresIn { get; set; } = 600;
}

public sealed record TokenResponse(string Token);
public sealed record ApiError(string? Error, string? Code);

public sealed record MeResponse(PublicUser? User);
public sealed record PublicUser(string Id, string Email, string Name);

public sealed record VaultInfo(string Id, string Name, string? Role);

public sealed record FileRow(string Id, string Kind, long Size, string Name);
public sealed record Use(string? Number, string? Rev, int? Seq, string? Baseline, string? BaselineId, string? ItemId, int Count);
public sealed record Baseline(string Id, string Label, int Seq, string Status, string? Author, string? Comment, DateTime CreatedAt, List<Use>? Uses, List<FileRow> Files);
public sealed record StateInfo(string Id, string Name, bool Freezes, bool IsRelease);
public sealed record Revision(string Id, string Rev, bool Frozen, StateInfo State, List<Baseline> Baselines);
public sealed record ItemInfo(string Id, string Number, string Description, string Type, string VaultId);
public sealed record LockInfo(string UserId, string? User, string? Machine, DateTime Since);
public sealed record VaultRef(string Id, string Name, string? RevScheme);
public sealed record ItemDetail(ItemInfo Item, VaultRef Vault, LockInfo? Lock, List<Revision> Revisions, Baseline? Current, Baseline? Released, Baseline? Latest);

public sealed record CheckoutRow(string Id, string Number, string Description, string VaultId, string? Rev, string? LatestLabel, string? LatestStatus);

public sealed record NewItemResponse(string Id, string Number);
public sealed record BaselineRef(string Id, string Label, string? Status);
public sealed record BaselineUploadResponse(bool Unchanged, BaselineRef? Baseline);

/// <summary>What the agent remembers about each working copy in the workspace.</summary>
public sealed class WorkingCopy
{
    public string ItemId { get; set; } = "";
    public string Number { get; set; } = "";
    public string Description { get; set; } = "";
    public string VaultId { get; set; } = "";
    public string Path { get; set; } = "";
    /// <summary>sha256 of the file as last uploaded or downloaded; a save with the same hash is ignored.</summary>
    public string? LastHash { get; set; }
    public string? LastBaselineId { get; set; }
    public string? LastBaselineLabel { get; set; }
}

public sealed class WorkspaceState
{
    public string? Server { get; set; }
    public List<WorkingCopy> Copies { get; set; } = new();
}

/// <summary>A request the PhysCAD plugin drops into &lt;workspace&gt;/.plm/requests/.</summary>
public sealed record PluginRequest(string Action, string? File, string? Comment, string? Number);

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase, WriteIndented = true,
    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull, PropertyNameCaseInsensitive = true)]
[JsonSerializable(typeof(AgentConfig))]
[JsonSerializable(typeof(WorkspaceState))]
[JsonSerializable(typeof(DeviceCode))]
[JsonSerializable(typeof(TokenResponse))]
[JsonSerializable(typeof(ApiError))]
[JsonSerializable(typeof(MeResponse))]
[JsonSerializable(typeof(List<VaultInfo>))]
[JsonSerializable(typeof(ItemDetail))]
[JsonSerializable(typeof(List<CheckoutRow>))]
[JsonSerializable(typeof(NewItemResponse))]
[JsonSerializable(typeof(BaselineUploadResponse))]
[JsonSerializable(typeof(PluginRequest))]
[JsonSerializable(typeof(Dictionary<string, string>))]
[JsonSerializable(typeof(Dictionary<string, object>))]
[JsonSerializable(typeof(JsonElement))]
internal partial class AgentJson : JsonSerializerContext { }
