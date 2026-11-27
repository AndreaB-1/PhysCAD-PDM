# PLM Lite Server

A self-hosted PDM for **PhysCAD**: one Docker stack (app + worker + Postgres) that you deploy from Portainer, with vaults that are plain folders on your NAS.

- **Part numbering and naming:** `AB00042 - MOUNTING BRACKET`; prefix, digits and description rules per vault.
- **Check-out / check-in with locks:** one person edits an item at a time. Saves while checked out become *work in progress* baselines (`01.004`); check-in needs a comment.
- **Revisions and baselines:** `01.001`, `01.002`… (or `A.1`). Released revisions are frozen; **Revise** starts `02`.
- **Configurable lifecycle per vault:** default *In work → Prototype → Released → Obsolete*. Each state has its colour, whether it freezes, who may set it, and allowed transitions.
- **Assemblies:** linked parts are read from the `.physcad` file and pinned to exact baselines. **Contains** shows "newer / released available"; **Where used** is recursive; **pack and go** zips the whole tree.
- **Browser:** grid/table lists, search, a 3D viewer (sections, measure, part visibility), downloads, and **share links** for externals (expiry, password, download limit, revocable).
- **Security:** argon2id passwords, mandatory **TOTP 2FA** with recovery codes, CSRF-protected cookie sessions, per-vault roles (admin / editor / viewer), personal access tokens, device-code sign-in for the desktop agent, and an **audit log** of everything.
- **Files stay readable without the app:** `<vault>/AB00042/AB00042_01.003.physcad|step|glb|png` plus a `AB00042.json` record per item. Admin → Vaults → *Rebuild index from disk* re-imports them.

![Item page](docs/screenshots/item-3d.png)

The plan, decisions and everything learned about PhysCAD's plugin and MCP APIs are in [docs/PLAN.md](docs/PLAN.md).

## Deploy in Portainer

1. **Stacks → Add stack**, paste [`docker-compose.yml`](docker-compose.yml).
2. Set the environment variables (see [`.env.example`](.env.example)):

   | Variable | Example | |
   |---|---|---|
   | `APP_URL` | `http://nas.lan:8080` | how browsers reach the app; `https://…` turns on Secure cookies and HSTS |
   | `SESSION_SECRET` | `openssl rand -hex 32` | keep it: changing it signs everyone out and breaks enrolled 2FA |
   | `DB_PASSWORD` | random | |
   | `VAULTS_PATH` | `/mnt/user/pdm-vaults` | NAS folder holding the vaults (each sub-folder can be a vault) |
   | `ADMIN_EMAIL` | optional | only this email may create the first admin |
   | `TRUST_PROXY` | `true` behind a reverse proxy | |
   | `PLM_IMAGE` | `ghcr.io/andreab-1/physcad-pdm:v0.1.0` | pin a version |

3. Deploy, open the **app container's logs**, and copy the **setup token**.
4. Open `APP_URL/setup`: create the admin, scan the 2FA QR code, save the recovery codes, create the first vault.

The Postgres data lives in the `db-data` named volume on the Docker host's local disk. **Never put Postgres on an SMB/NFS share.** The worker writes a nightly `pg_dump` to `<VAULTS_PATH>/.plm-backups` (14 kept).

**Restore:** `docker exec -i <db> pg_restore -U plm -d plm --clean < plm-….dump`. If you only have the vault folders, create the vault again on the same folder and run **Rebuild index from disk**.

**Updates:** re-pull the image and redeploy. Migrations run at start-up.

**Exposing it:** keep the app on the LAN and publish only `/s/*` and `/api/public/*` (share links) through a reverse proxy or Cloudflare Tunnel; set `PUBLIC_SHARE_URL` to that public address.

## Develop

Needs Node 22 and a Postgres 16.

```bash
npm install
```
```bash
DATABASE_URL=postgres://plm:plm@localhost:5432/plm VAULTS_ROOT=./.vaults DATA_DIR=./.data SETUP_TOKEN=dev npm run dev:api
```
```bash
npm run dev:web
```

Open http://localhost:5173 (Vite proxies `/api` to the API on :8080).

```bash
DATABASE_URL=postgres://plm:plm@localhost:5432/plm_test npm test
```

Tests run against a real Postgres. The test database is wiped on every run.

| Path | What |
|---|---|
| `apps/api` | Fastify API, the worker (`ROLE=worker`: STEP→GLB, backups), Drizzle schema and migrations |
| `apps/web` | React + Vite + TanStack Router/Query + Tailwind SPA, the three.js viewer |
| `packages/shared` | zod schemas, revision/numbering helpers, `.physcad` link parsing |
| `poc/` | the proof-of-concept plugin and PhysCAD's plugin guide, for reference |
| `docs/` | plan, decisions, spikes, the agent/plugin API |

Schema change: edit `apps/api/src/db/schema.ts`, then `npm run db:generate`.

## Status

Phases 0–2 of the plan, the server half of phase 3 and a first phase-4 viewer are done. Still to do: the **desktop agent** and **plugin v2** (see [docs/agent-api.md](docs/agent-api.md)), the PhysCAD **spikes** in [docs/spikes.md](docs/spikes.md) (they need PhysCAD on your PC), passkeys, notifications.
