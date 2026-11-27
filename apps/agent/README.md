# PLM Lite Agent

A small tray app for your PC (Windows, Linux or macOS) that connects PhysCAD to the PLM Lite server:

- **Open in PhysCAD** links in the web app open the part on this PC: your working copy if it's checked out to you, otherwise a read-only copy. Linked parts are downloaded too, with their link paths pointing at the local copies.
- **Every save** of a checked-out part is uploaded as a new baseline (`01.004`…), with a STEP, a GLB for the 3D viewer and a picture exported from PhysCAD.
- **Check in**, **Cancel check-out** and **New part…** from the tray menu, or from the PhysCAD plugin's panel.

Nothing to install: it's one file, built with .NET 8 and Avalonia.

## Install

Download from the GitHub Release (or, between releases, from the latest **Agent** workflow run → *Artifacts*):

| System | File | How |
|---|---|---|
| Windows | `plm-agent-windows-x64.zip` | Unzip `plm-agent.exe` anywhere (e.g. `Documents\PLM Lite`) and run it. SmartScreen may warn once (the exe isn't code-signed): *More info → Run anyway*. |
| macOS | `PLM-Lite-Agent-macos-arm64.zip` (Apple Silicon) or `-x64` (Intel) | Unzip, move **PLM Lite Agent.app** to Applications, then right-click → **Open** the first time (it isn't notarized). It lives in the menu bar. |
| Linux | `plm-agent-linux-x64.tar.gz` | `tar xzf …`, then run `./plm-agent`. The tray icon needs a desktop with StatusNotifier/AppIndicator support (KDE, GNOME with the AppIndicator extension, …). |

## First run

1. The settings window opens. Enter your server address, e.g. `http://192.168.1.106:8490`, and click **Sign in**.
2. Your browser opens the server's *Approve this device* page. Approve it: the agent gets its own access token (you can revoke it in **Account → Access tokens**).
3. Check the **workspace** folder (default: `PLM Workspace` in your home folder) and that **PhysCAD** shows as reachable. PhysCAD needs **Preferences → AI (MCP)** turned on.
4. Signing in registers `plmlite://` links for you. On macOS the app does that by itself. Tick **Start when I sign in** if you like.

## The PhysCAD plugin (optional)

`plm-lite.physcadplugin` adds a **PLM Lite** panel to PhysCAD. It shows whether the open part is checked out, and has **Check in** and **Open in browser** buttons. It also warns you when you save a read-only copy. Install it from **Preferences → Plugins**. Then run **PLM Lite: choose workspace folder** once and pick the same workspace folder as the agent.

The plugin can't reach the agent over the network (plugins have no localhost access), so they talk through files in `<workspace>/.plm/`.

## Workspace layout

```
PLM Workspace/
  AB00042_01.003.physcad    your working copies (writable) and the parts they link (read-only)
  .plm/state.json           what is checked out on this PC
  .plm/view/                read-only copies you opened just to look at
  .plm/requests/            requests from the PhysCAD plugin
  .plm/trash/               working copies of cancelled check-outs (never deleted outright)
```

## Command line

The same binary works without the tray. Use it on a headless PC, in scripts, or to see errors:

```
plm-agent cli status
plm-agent cli token http://server:8490 plm_xxx     # sign in with a token from Account → Access tokens
plm-agent cli open "plmlite://open?server=…&item=…"
plm-agent cli checkin AB00042 "Thicker flange"
plm-agent cli watch                               # upload saves in the foreground
plm-agent cli help
```

## Developing

```
cd apps/agent
dotnet build src/PlmAgent && dotnet run --project src/PlmAgent      # tray app
tests/run-integration.sh      # unit tests + the full loop against a real API and a fake PhysCAD (needs Postgres)
build/package.sh              # release downloads into dist/ (macOS bundles: run it on a Mac)
```

`src/PlmAgent.Core` holds the work (API client, PhysCAD MCP client, workspace, save watcher) and has no UI. `src/PlmAgent` is the tray app and CLI.
