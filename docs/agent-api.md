# API for the desktop agent and plugin v2

Everything the phase-3 agent needs is in the server already. All endpoints are under `/api`, JSON unless noted.

## Signing in (device code)

1. `POST /device/code {clientName: "PLM agent on WORKSHOP-PC"}` → `{deviceCode, userCode, verificationUriComplete, interval, expiresIn}`
2. Open `verificationUriComplete` in the browser; the person approves.
3. Poll `POST /device/token {deviceCode}` every `interval` s. Until approval: `400 {error:"authorization_pending"}`; then `{token: "plm_…"}` once.
4. Send `Authorization: Bearer plm_…` from then on. No CSRF header is needed with a token. Tokens can be revoked in Account → Access tokens.

## Finding things

- `GET /vaults` → the vaults with your role
- `GET /vaults/:vaultId/items/by-number/AB00042` → item detail: revisions, baselines, files, lock, `current` (checked in), `released`, `latest`
- `GET /items/:id` (same shape), `GET /me/checkouts`, `GET /search?q=`

## The loop

| Step | Call |
|---|---|
| New part | `POST /vaults/:vaultId/items {description, checkout: true, machine, workspacePath}` → `{id, number}` |
| Check out | `POST /items/:id/checkout {machine, workspacePath}`. `409 code=locked` if someone else has it; `409 code=frozen` → use Revise. |
| Download | `GET /files/:fileId?download=1`; for an assembly also download each `uses[].baselineId`'s native file (read-only), then rewrite `link.path` to the local copies. `GET /baselines/:id/pack` gives everything as a zip with link paths already reduced to file names. |
| Save (each) | `POST /items/:id/baselines` multipart: `native` (the .physcad), optional `step`, `glb`, `png`, `stl`, `comment`. Returns `{unchanged}` or `{baseline:{id,label,status:"wip",uses}}`. |
| Derived files later | `POST /baselines/:id/files` multipart with `step` / `glb` / `png`… A STEP without a GLB is converted by the worker. |
| Check in | `POST /items/:id/checkin {comment}`, or multipart with the final files + `comment`. |
| Cancel | `POST /items/:id/cancel-checkout` |
| Revise | `POST /items/:id/revise {machine, workspacePath}`: new revision, `NN.001` copied from the last checked-in baseline, checked out to you. |

`uses` are read by the server from the `.physcad` JSON: `features[]` with `type:"import"`, `format:"physcad"` and a `fileName` like `AB00003_01.004.physcad`.

## Open in PhysCAD

The web app links to `plmlite://open?server=<origin>&item=<itemId>&baseline=<baselineId>`. The agent registers the `plmlite:` URL scheme, checks the server matches its own, downloads and opens the file through PhysCAD MCP (`document_open {path}`).

## Rules learned in the PoC

- Never drive the person's PhysCAD from a background timer. Act only on save / check-in / a click.
- Always close tabs by id.
- Activate the root component (`component_activate {id:"root"}`) before `view_capture`.
