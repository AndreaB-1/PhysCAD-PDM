# Proof of concept (reference only)

`plm-lite/` is the PoC PhysCAD plugin (0.2.0). It wrote a flat vault:

- `<vault>/AB00042.json`: the part record `{ number, description, revisions: [{ rev, state, baselines: [{ baseline, date, comment, file, uses? }] }] }`
- `<vault>/AB00042_01.003.physcad`: the baselines
- `<vault>/.previews/AB00042_01.003.(png|b64)`: the previews

No PoC data is migrated: the server starts with empty vaults (decision 2026-11-27).
The `vault-viewer/` and `launcher/` parts of the PoC aren't in this repo yet.
