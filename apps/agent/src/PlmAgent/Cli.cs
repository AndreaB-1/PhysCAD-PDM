using PlmAgent.Core;

namespace PlmAgent;

/// <summary>Command-line use of the agent, without the tray (headless PCs, scripts, tests).</summary>
public static class Cli
{
    const string Help = """
        plm-agent cli <command>
          signin <server>                 device-code sign-in (opens the browser)
          token <server> <token>          sign in with an access token from Account → Access tokens
          signout
          workspace [<folder>]            show or set the workspace folder
          status                          who you are and what's checked out here
          open <plmlite-url | itemId>     open an item (read-only unless it's checked out to you)
          checkout <itemId>               check out and open
          new <vaultId> <description>     create a part, checked out, in PhysCAD
          upload <file>                   upload a working copy now (normally automatic on save)
          checkin <number|itemId> <comment...>
          cancel <number|itemId>
          watch                           run in the foreground and upload saves
          register                        register plmlite:// links for this user
        """;

    public static async Task<int> Run(string[] args)
    {
        if (args.Length == 0 || args[0] is "-h" or "--help" or "help") { Console.WriteLine(Help); return 0; }
        var cfg = AgentConfig.Load();
        using var agent = new AgentService(cfg);
        agent.Notice += (t, l) => (l == NoticeLevel.Error ? Console.Error : Console.Out).WriteLine((l == NoticeLevel.Error ? "! " : "") + t);
        try
        {
            switch (args[0])
            {
                case "signin": await agent.SignIn(Arg(args, 1, "server")); break;
                case "token": await agent.UseToken(Arg(args, 1, "server"), Arg(args, 2, "token")); Console.WriteLine($"Signed in as {cfg.UserName}."); break;
                case "signout": agent.SignOut(); Console.WriteLine("Signed out."); break;
                case "workspace":
                    if (args.Length > 1) agent.SetWorkspace(args[1]);
                    Console.WriteLine(agent.Workspace.Root);
                    break;
                case "status":
                    Console.WriteLine(cfg.SignedIn ? $"Signed in to {cfg.ServerUrl} as {cfg.UserName}" : "Not signed in.");
                    Console.WriteLine($"Workspace: {agent.Workspace.Root}");
                    Console.WriteLine($"PhysCAD MCP (port {cfg.ResolveMcpPort()}): {(await agent.PhysCad.IsRunning() ? "reachable" : "not running")}");
                    if (cfg.SignedIn) await agent.Reconcile();
                    foreach (var c in agent.Workspace.Copies()) Console.WriteLine($"  {c.Number} - {c.Description}  [{c.LastBaselineLabel ?? "no baseline yet"}]  {c.Path}");
                    break;
                case "open":
                    var target = Arg(args, 1, "link or item id");
                    if (target.StartsWith("plmlite:", StringComparison.OrdinalIgnoreCase)) await agent.HandleUrl(target);
                    else Console.WriteLine(await agent.Open(target));
                    break;
                case "checkout": Console.WriteLine(await agent.CheckoutAndOpen(Arg(args, 1, "item id"))); break;
                case "new": Console.WriteLine(await agent.NewPart(Arg(args, 1, "vault id"), string.Join(' ', args[2..]))); break;
                case "upload":
                    var b = await agent.UploadSave(Path.GetFullPath(Arg(args, 1, "file")));
                    Console.WriteLine(b is null ? "Nothing new to upload." : $"Uploaded as {b.Label}.");
                    break;
                case "checkin": await agent.Checkin(Resolve(agent, Arg(args, 1, "item")), string.Join(' ', args[2..]).Trim() is { Length: > 0 } msg ? msg : "Checked in"); break;
                case "cancel": await agent.CancelCheckout(Resolve(agent, Arg(args, 1, "item"))); break;
                case "watch":
                    agent.StartWatching();
                    using (var server = LocalServer.TryStart(agent))
                    {
                        Console.WriteLine($"Watching {agent.Workspace.Root}{(server is null ? " (another agent owns the local port)" : "")}. Ctrl+C to stop.");
                        var done = new TaskCompletionSource();
                        Console.CancelKeyPress += (_, e) => { e.Cancel = true; done.TrySetResult(); };
                        await done.Task;
                    }
                    break;
                case "register": Console.WriteLine(UrlScheme.Register()); break;
                default: Console.Error.WriteLine($"Unknown command “{args[0]}”.\n\n{Help}"); return 2;
            }
            return 0;
        }
        catch (Exception e)
        {
            Console.Error.WriteLine("! " + e.Message);
            return 1;
        }
    }

    static string Arg(string[] a, int i, string name) => a.Length > i ? a[i] : throw new ArgumentException($"Missing {name}.");

    /// <summary>A part number of a working copy here, or an item id.</summary>
    static string Resolve(AgentService agent, string s) =>
        agent.Workspace.Copies().FirstOrDefault(c => c.Number.Equals(s, StringComparison.OrdinalIgnoreCase))?.ItemId ?? s;
}
