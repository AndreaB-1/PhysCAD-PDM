# PLM Lite Server: plan for a self-hosted PDM for PhysCAD

*Written 2026-11-27 at the end of the proof-of-concept session. Paste the "Session starter" below into a new session, and keep this file in the repo as `docs/PLAN.md`.*

---

## Session starter (paste this into the new session)

> I'm building **PLM Lite Server**, a self-hosted PDM/PLM web app for the PhysCAD CAD program, deployed as a Docker stack in Portainer, with vaults on my NAS. A working proof of concept exists in this folder: a PhysCAD plugin (`plm-lite/`), a local Vault Viewer (`vault-viewer/`) and a tray launcher (`launcher/`). Read `NEXT - PDM web app plan.md` (the plan, decisions and everything learned about PhysCAD's plugin and MCP APIs) and the PoC code. Then start with **Phase 0** (repo + spikes). Before writing code, confirm the open decisions in section 11 with me. Don't break the PoC: it stays usable until Phase 3 replaces it.

---

## 1. What we're building

A web application that is the single home of your CAD data:

- **Standalone and self-hosted:** one Docker stack (app + database) that anyone can deploy from Portainer with a compose file and a few environment variables.
- **Vaults on the NAS:** one or more vaults, each a mapped folder. Files stay human-readable on disk.
- **PDM workflow:** part numbering and naming rules, **check-out / check-in with locks**, revisions and baselines, **configurable release states** (Prototype, Released…), assemblies with contains / where-used.
- **Browser features:** a **3D viewer**, **downloads** (native, STEP, STL…), **share links for externals**.
- **Security:** user management, roles, **two-factor sign-in**, an audit log.
- **PhysCAD integration** through an updated plugin and a small **desktop agent** (the evolution of the tray launcher), because a server on the NAS can't reach PhysCAD on your PC by itself (see section 4).

**Not in scope** (for now): change management (ECR/ECO workflows), approvals with multiple sign-offs, ERP, CAD formats other than PhysCAD (beyond STEP import/preview).

## 2. What the proof of concept taught us (keep this: it saves days)

### PhysCAD plugin API (Labs, apiVersion 1)
- **Structure:** a plugin is a zip renamed `.physcadplugin`: `plugin.json`, `main.js` (one file, sandboxed worker, no imports), optional panels (`html` + `js`). Unknown manifest fields are refused.
- **Permissions:** `model.read`, `model.write`, `view`, `files`, `ui`, `cam`, `network`. Adding one makes PhysCAD ask the person again, and the plugin stays stopped until they approve.
- **Commands:** `physcad.commands.run("<area>.<command>", args)` runs PhysCAD commands (same names as the MCP tools, dots instead of underscores). Some aren't open to plugins (`tab.list` isn't).
- **No file paths into PhysCAD commands:** plugins can't give `document.save/saveAs/open`, `file.export*` or `document.addToFile` a file path. They can only use files through `physcad.files.read/write/list/pickFolder/open/save`, and only inside folders the person picked with `pickFolder`.
- **Files:**
  - `files.write` doesn't create folders, but can write into existing sub-folders of a picked folder.
  - `files.list(folder)`; `files.read(path)` returns text.
- **Document access:**
  - `physcad.model.document()` gives `{ name, file, dirty, components, timeline, bodies }`.
  - `document.getJson` returns `{ json: "<the .physcad file text>" }`.
  - `document.load {json}` replaces the current document, and plugins *can* call it.
- **Events:** `physcad.events.on("documentSaved" | "documentOpened" | …)` works in `main.js` and in panels. `documentSaved` fires for saves made through MCP too.
- **Toasts:** `physcad.ui.toast(text, "success" | "error")`. Other types are unverified.
- **Pictures:** `view.capture {width,height}` needs the `view` permission and returns `{ __image: "data:image/png;base64,…" }`. It captures the view as the person sees it.
- **Plugin windows are walled off:** panels can't show web pages (an iframe stays blank) and can't open links (`window.open` returns null).
- **Network, not yet tested:** `physcad.net.fetch(url)` reaches only the https domains listed in `"network"`, in the desktop app only. Whether a LAN hostname, a private IP, http, or a self-signed certificate is allowed is untested, so **spike it first (Phase 0)**.
- **Limits:** a plugin silent for 15 s, or a command running past 60 s, is stopped. 5 errors a minute stop it; stopped 3 times, it's turned off.
- **Developer mode:** Preferences → Plugins → *Developer: load from folder*, which reloads on every file save. The "Offer its commands to the AI" switch lets an agent run plugin commands (`plugins_run`), and errors show in `plugins_list`.

### PhysCAD MCP server (Preferences → AI (MCP))
- **Connection:** streamable HTTP at `http://127.0.0.1:<port>/mcp`, port 47173 by default. The port is also in `%APPDATA%\PhysCAD\physcad-settings.json` (`mcpPort`).
- **Localhost only.** It asks the person before touching folders outside the approved ones.
- **546 tools.** The useful ones:
  - `document_get`, `document_getJson`, `document_load`, `document_new {scratch}`, `document_open {path}`, `document_save {path}`, `document_saveAs {path}`, `document_rename`
  - `document_addToFile {path, how:"linked", where:"folder", move}`, `document_checkLinks`, `document_syncLinked`
  - `tab_list / tab_switch {id} / tab_close {id}`. **Always close by id**: closing "the active tab" once closed the wrong document.
  - `view_capture`, `view_iso`, `view_fit`
  - `file_export {format: step|stl|3mf|obj|fbx|glb|dae, path}`, `file_exportStep {path}`
  - `component_activate {id:"root"}`: PhysCAD fades everything outside the active component, so activate the root before captures.
  - `engine_tasks` (`busy`), `plugins_devLoad`, `plugins_list`, `plugins_run`, `plugins_reload`
- **Never let a background job drive the person's PhysCAD while they work.** Temporary tabs can catch their Ctrl+S. Do PhysCAD-side work at moments the person triggers (save, check-in), or in a headless PhysCAD (`--headless --allow-folder`, mentioned in the MCP preferences; untested).

### The .physcad file
- **Format:** JSON: `{format:"physcad", version:3, name, units, components[], features[], …}`. Features are a parametric timeline (`box`, `extrude`, `import`…), so **a browser can't render it**: geometry needs PhysCAD's kernel. The 3D viewer needs exported meshes (section 6).
- **Linked parts** (Add to File, linked) appear as features like this:
  `{ "type":"import", "fileName":"AB00003_01.004.physcad", "format":"physcad", "link":{"path":"C:\\…\\AB00003_01.004.physcad","mtime":…,"hash":"…"}, "parts":[{"name":…, "step":"<base64 STEP of the body>"}], "base":"c1", "compMap":{…} }`
  - The linked geometry is **embedded as STEP**, so an assembly opens even when the linked files are missing (PhysCAD flags them).
  - `link.path` is an **absolute local path**. In a server world, rewrite it when files are checked out to another machine (section 5).
  - Reading `fileName` / `link.path` is how an assembly's "uses" are found.

### The PoC's model (carry it over)
- **Naming:** part number `AB` + 5 digits (prefix and width configurable per vault), description in upper case, document name `AB00042 - DESCRIPTION`.
- **Numbering:** revision `01`, `02`…; baseline `.001`, `.002`… One baseline per save. A released revision is frozen, and the next change starts the next revision.
- **Uses:** each assembly baseline lists `uses: [{number, rev, baseline, count}]`. Where-used is the reverse.
- **Previews** come from PhysCAD (`view.capture`).

## 3. Architecture

```
            ┌───────────────────────── Docker stack (Portainer) ─────────────────────────┐
 Browser ──►│  web (React SPA, served by the API)                                        │
 (LAN, or   │  api  (Node/TypeScript, Fastify) ──► Postgres (metadata, users, locks,     │
  internet  │        │                               audit, share links)                │
  through a │        ├──► /vaults/<name>/…  (bind mount → NAS share): files, derived     │
  reverse   │        └──► worker (same image): thumbnails, STEP→GLB, pack-and-go zips    │
  proxy)    └────────────────────────────────────────────────────────────────────────────┘
                   ▲  HTTPS + API token
                   │
   Your PC:  Desktop agent (tray app, ex-launcher) ◄─► PhysCAD MCP (127.0.0.1)
             • signs in once (device code), keeps a local workspace folder
             • check-out: downloads to the workspace, opens it in PhysCAD
             • save / check-in: uploads the baseline + STEP + GLB + picture
             • registers plmlite:// links so the web app's "Open in PhysCAD" works
             PhysCAD plugin v2: naming rules, toolbar buttons, a status strip, and
             (if net.fetch reaches the server) direct calls to the API
```

### Why a desktop agent
The server runs on the NAS. PhysCAD's MCP is localhost-only, and the plugin can't open files by path or launch anything. Something on the PC has to download, open, export and upload. The tray launcher you have is the natural place, and it already bundles its own runtime.

### Stack recommendation
| Piece | Choice | Why |
|---|---|---|
| Language | TypeScript everywhere | one language for API, web, agent and plugin |
| API | Node 22 + Fastify, zod validation, OpenAPI generated | fast, typed, small image |
| Database | **PostgreSQL 16** in the stack (Drizzle ORM + migrations) | real transactions for locks; safe on a local volume; `pg_dump` backups. *Never put SQLite or Postgres data on an SMB/NFS share.* |
| Jobs | pg-boss (queue in Postgres) | no extra Redis container |
| Web | React + Vite + TanStack Router/Query + Tailwind + shadcn/ui | fast to build a polished UI |
| 3D | three.js via react-three-fiber + drei, GLB (Draco/meshopt) | standard, quick to load |
| STEP in the browser/worker | occt-import-js (OpenCascade WASM) | preview uploaded STEP files with no PhysCAD involved |
| Auth | argon2id passwords, TOTP 2FA (otplib) + recovery codes, WebAuthn passkeys later; cookie sessions; OIDC optional later | standard, homelab-friendly |
| Agent | the C# tray app, or rebuilt in .NET 8 single-file (still no install) | keeps "runs on any PC" |
| Image | one image: API + SPA + worker (role chosen by env), multi-arch amd64/arm64 | simple Portainer stack |

## 4. Docker / Portainer

- **Files:** `docker-compose.yml` in the repo root, plus `.env.example`.
- **Services:**
  - `app`: the API and SPA, port 8080.
  - `worker`: the same image with `ROLE=worker`.
  - `db`: `postgres:16-alpine`.
- **Volumes:**
  - `db-data`: a named volume on the Docker host's local disk.
  - `/vaults`: a bind mount to the NAS share, e.g. `/mnt/user/pdm-vaults:/vaults`. Each sub-folder can become a vault.
  - `/data`: app data (config, logs, temp, derived cache) on a local volume.
- **Environment:** `APP_URL`, `SESSION_SECRET`, `DB_*`, `ADMIN_EMAIL` (first-run admin; the setup wizard sets the password and 2FA), `TRUST_PROXY`, `PUBLIC_SHARE_URL`.
- **Health check and first run:** `/healthz` for the health check. First-run wizard: create the admin, enrol 2FA, add the first vault (pick a folder under `/vaults`), set numbering rules.
- **Images:** GitHub Actions builds `ghcr.io/<you>/plm-lite` on every tag. Portainer pulls the tag, and updates are "re-pull and redeploy".
- **Exposure later:** put it behind a reverse proxy (Nginx Proxy Manager, Traefik or Caddy) with HTTPS, or a Cloudflare Tunnel.
  - Consider exposing **only `/s/*` (share links)** to the internet at first, keeping the app LAN-only.
  - Rate-limit sign-in and share endpoints.

## 5. Domain model and workflows

### Entities
- **Vault:** name, root folder; numbering rules (prefix, digits, next number); description rules; revision scheme (2-digit numeric, baseline 3-digit; letters as an option); its lifecycle (state set).
- **Item** (a part or assembly): number, description, type (part / assembly, derived from uses), created by and when, current lock.
- **Revision:** `01`, `02`…; lifecycle state; frozen flag; state history.
- **Baseline:** `.001`…; author, time, comment; file hash; derived files (STEP, GLB, PNG); `uses[]`.
- **Lifecycle state (configurable per vault):** name, colour, order; *locks the revision* (yes/no); *allowed transitions*; *who may set it* (role). Default set: **In work → Prototype → Released → Obsolete**, where Prototype and Released freeze.
- **Lock** (check-out): item, user, machine, workspace path, time.
- **User, role, vault permission:** roles are *admin*, *editor*, *viewer*, set per vault.
- **Share link:** token, what it points at (baseline / revision / latest released), allowed formats, expiry, optional password, download limit, created by, revoked.
- **Audit event:** who, what, when, from where. Every check-out, check-in, release, download, share and admin action is recorded.

### Check-out / check-in (the Teamcenter-style lock the PoC lacked)
- **Check out** (web or agent): takes an exclusive lock on the item, and only one person can hold it. The agent downloads the latest baseline (and, for an assembly, the baselines it uses, read-only) into the workspace, rewrites `link.path`s to the local copies, and opens it in PhysCAD.
- **While checked out:**
  - Each **save** uploads a baseline (`01.004`, `01.005`…): kept, but marked *work in progress*.
  - Nobody else can upload or check out. Others still see and download the last **checked-in** baseline.
- **Check in** (comment required): uploads the final baseline, marks it *checked in*, releases the lock, and offers to clean up the local copy. Plain saves while checked out could alternatively stay private until check-in; decision in section 11.
- **Cancel check-out:** releases the lock and discards the work-in-progress baselines.
- **Admin:** can force-release a lock (audited), e.g. when a laptop is lost.
- **Released revisions can't be checked out.** "Revise" starts the next revision (`02.001`) and checks it out in the same step.
- **The web app shows locks everywhere:** a lock icon with who and since when, plus "My check-outs".

### Release states
- **Changing state:** per revision, through a "Change state" dialog. It lists only the allowed transitions and requires a note, which goes into the history.
- **Release artefacts:** at Released (configurable per state), the agent or worker produces the release files (STEP and, later, a PDF drawing) and keeps them with the revision.
- **Where-used warnings:** for example, "assembly AB00050 rev 03 (Released) uses AB00042 01.003, which is now Obsolete."

### Assemblies
- **Inserting a part (from the web or agent):** pins it to an exact baseline, as in the PoC.
- **Contains tree:** shows the pinned baseline, its state, and "newer/released available".
- **"Update to latest released":** for one child or all of them, done by the agent on the open assembly. Needs a spike: replacing a linked feature's file. PhysCAD may support it through `document_syncLinked` after the file is swapped, or through delete and re-insert.
- **Where-used:** a recursive tree, filterable by state.
- **Pack and go:** a zip of the assembly and everything it uses, at the pinned baselines.

## 6. 3D viewer, downloads, share links

- **Derived files per baseline:** PNG (from the agent at save), **GLB** for the viewer, and **STEP** for sharing. All produced by the agent through PhysCAD MCP `file_export` at check-in (or each save), then uploaded. *Spike: exporting to a path from MCP, and the GLB quality and size.*
- **Viewer:**
  - Navigation: orbit, pan, zoom, fit, standard views.
  - Display: shaded / edges, section plane, show/hide parts of an assembly from the tree, explode slider (later), simple measure (distance between two points).
  - Loads GLB progressively. Thumbnails in lists, the viewer in the detail page.
- **Fallback when no GLB exists** (a baseline from a PC without the agent): if a STEP exists, the worker converts STEP to GLB with occt-import-js. Otherwise it shows the picture.
- **Downloads:** native `.physcad`, STEP, STL, GLB; zip for assemblies (pack and go). Every download is audited.
- **Share links:**
  - Created from any item, revision or baseline. Choose formats (default: STEP + PNG, **not** the native file), expiry (default 14 days), an optional password, and a download limit.
  - The public page `/s/<token>` shows the picture, the 3D viewer, and download buttons. Nothing else of the vault is visible.
  - Links can be revoked, and there's a list of all of them.

## 7. Security
- **Passwords:** argon2id, minimum length, a breached-password check optional. Lockout and backoff on failed sign-ins.
- **2FA (TOTP):** set up with a QR code and 10 recovery codes. It can be made mandatory for everyone (on by default) and reset by an admin (audited). Passkeys (WebAuthn) come next.
- **Sessions:** httpOnly, `Secure` and `SameSite=Lax` cookies; CSRF tokens on state-changing requests; idle and absolute timeouts; "sign out everywhere".
- **Tokens for the agent and plugin:** personal access tokens, scoped (read / write / vault), shown once and revocable. The agent gets one through a device-code sign-in in the browser.
- **Headers:** CSP, HSTS (when on HTTPS), no directory listing, no path input from clients: files are addressed by IDs, never by paths.
- **Share links:** long random tokens (≥128 bits), stored hashed, rate-limited, with nothing guessable.
- **Backups:** a nightly `pg_dump` into the vault share, and the documented restore. The vault folders stay readable without the app: there's a "rebuild index from disk" tool that re-imports `*.json` records.

## 8. Interface (make it nice)
- **Look:** dark and light themes, close to PhysCAD's look (the PoC's viewer is a good starting point).
- **Layout:** a left sidebar (vault switcher, Search, My check-outs, Recent, Released, Shared links, Admin) and a top bar with global search (number, description, comments).
- **Item page:**
  - Header: number, description, state chip, lock chip.
  - Large preview / 3D tab.
  - Actions: Check out / Check in / Open in PhysCAD / Download ▾ / Share / Change state / Revise.
  - Tabs: **History** (revisions → baselines, comments, who), **Contains**, **Where used**, **Files**, **Activity**.
- **Lists:** a grid of cards with previews, or a table with sortable columns and filters by state, type, locked, owner.
- **Admin:** users and roles, 2FA status, vaults (folder, numbering, revision scheme), lifecycle states editor (drag to order, colours, transitions), share link policy, audit log viewer, backups.
- **First-run wizard and empty states** that explain what to do next.

## 9. PhysCAD side v2
- **Desktop agent** (start from `launcher/`):
  - Setup: server URL and sign-in (device code); a workspace folder (default `Documents\PLM Lite Workspace`).
  - Integration: the `plmlite://` link handler, plus the local MCP client (the PoC's `server.js` has a working one).
  - Background work: upload queue with retry (offline-tolerant), and notifications (check-in done, lock lost…).
- **Plugin v2:**
  - Naming check on save.
  - On save of a checked-out item: tell the agent, via a note file in the workspace as in the PoC (`.open-viewer.json`), or directly over HTTPS if `net.fetch` reaches the server.
  - Toolbar buttons: *PLM: Check in…*, *PLM: Open in browser*, *PLM: Insert part…*. The last one opens the web picker, and the agent inserts the part.
  - A small panel showing the item, revision, lock, and "you have unsaved changes since the last baseline".
- **Migration:** a script that imports the PoC vault (`AB*.json` records + baselines + previews) into the first server vault, keeping numbers, revisions, baselines, comments and uses.

## 10. Phases

| Phase | What | Done when |
|---|---|---|
| **0. Repo and spikes** | GitHub repo, monorepo skeleton, CI building a Docker image. **Spikes:** (a) can `physcad.net.fetch` reach `https://<nas>.lan` (self-signed / local CA)? (b) MCP `file_export` GLB + STEP to a path, file sizes; (c) replace a linked child in an assembly; (d) PhysCAD `--headless` for server-side exports? | the image runs in Portainer showing "hello"; spike notes written in `docs/spikes.md` |
| **1. Core server** | Postgres schema, vaults on `/vaults`, users with 2FA and roles, items / revisions / baselines API, upload/download, audit log, first-run wizard, PoC vault import | you can sign in with 2FA, see the imported vault, download files |
| **2. Web app** | item grid/table, item page, history, contains / where-used, search, lifecycle state editor and Change state, share links and the public page | releases with your own states; a link a colleague can open |
| **3. Desktop agent + plugin v2** | device sign-in, workspace, check-out / check-in with locks, save → baseline upload, `plmlite://` open, insert part, derived STEP/GLB/PNG | the full Teamcenter-style loop from browser to PhysCAD and back |
| **4. 3D viewer** | GLB viewer with sections, assembly tree visibility, measure; STEP→GLB fallback in the worker | you can inspect any baseline without PhysCAD |
| **5. Polish and exposure** | passkeys, pack and go, notifications, backups and restore docs, reverse proxy / Cloudflare Tunnel guide, hardening checklist | safe to expose share links publicly |

## 11. Decisions to confirm at the start

1. **Saves while checked out:** baselines visible to everyone (marked WIP), or private until check-in? *Recommendation:* visible but marked WIP, because the history shows it all and nothing is lost.
2. **Revision scheme default:** `01.001` (as now) for every vault, with letters (`A.1`) as an option?
3. **Database:** Postgres in the stack (recommended), or SQLite for a single-container setup (only safe on a local disk)?
4. **Where Docker runs:** on the NAS itself (likely Unraid: the vault is then a local path, which is ideal) or on another host mounting the NAS share (check performance and file locking)?
5. **HTTPS on the LAN:** a reverse proxy with a real domain via DNS challenge (recommended: needed for passkeys and probably for `net.fetch`), or plain HTTP inside the LAN at first?
6. **Agent technology:** keep .NET Framework C# (zero install, works now), or .NET 8 single-file (bigger, more modern)?
7. **Share link defaults:** formats, expiry, password on or off.
8. **Product name** (the repo name). Avoid PhysCAD's name in a public product name.

## 12. GitHub (yes, recommended)
- **A private repo** now; make it public later if you want others to deploy it.
- **Layout:**
  ```
  apps/api   apps/web   apps/worker (or a role of api)   apps/agent   apps/physcad-plugin
  packages/shared (types, zod schemas)   docs/   docker-compose.yml   .env.example
  .github/workflows/ci.yml (lint, test, build)   .github/workflows/release.yml (image → ghcr.io on tag)
  poc/ (today's plm-lite, vault-viewer, launcher, kept for reference)
  ```
- **Releases:** a tag such as `v0.1.0` builds the image, which Portainer pulls by tag. The agent and plugin are attached to the GitHub Release as downloads.
- **What GitHub gives you:** history and rollback, issues as the backlog, CI that builds the image for you, and sessions that can work in branches and pull requests.

## 13. Where things are now (PoC)
| Path | What |
|---|---|
| `plm-lite/` | PhysCAD plugin 0.2.0: baseline on save, uses, preview capture, PLM Vault button. `plm-lite.physcadplugin` is the package. |
| `vault-viewer/` | Node server + single-page viewer: previews, history, contains / used-in, new part, insert, release, open in PhysCAD through MCP. |
| `launcher/` | C# tray launcher (`Launcher.cs`), icon generator, `build.ps1` → `dist/PLM Vault Viewer/` (bundles Node). |
| `PLM-Vault/` | Test vault: AB00002–AB00006, including a two-level assembly (AB00006 → AB00005 → AB00004, AB00003). |
| `PhysCAD Plugin Guide.html`, `hello-box.physcadplugin` | PhysCAD's own plugin docs and example. |
