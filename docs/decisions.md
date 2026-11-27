# Decisions (plan section 11)

Taken on 2026-11-27, using the plan's recommendations. Anything here can be revisited.

| # | Question | Decision | Where it lives |
|---|---|---|---|
| 1 | Saves while checked out | **Visible to everyone, marked WIP.** Check-in turns the last WIP baseline into the checked-in one; earlier WIP baselines stay in the history. Cancel check-out discards the WIP baselines of that check-out (files go to `<vault>/.trash`). | `lib/pdm.ts` |
| 2 | Revision scheme | **`01.001` by default**, letters (`A.1`) per vault as an option. | vault settings |
| 3 | Database | **Postgres 16 in the stack.** | `docker-compose.yml` |
| 4 | Where Docker runs | Works either way. On the NAS itself (vault = local path) is ideal. On another host, mount the share and keep `db-data` local. | README |
| 5 | HTTPS on the LAN | Plain HTTP works to start; `APP_URL=https://…` behind a reverse proxy turns on Secure cookies and HSTS. HTTPS will be needed for passkeys and probably for `physcad.net.fetch`. | `config.ts` |
| 6 | Agent technology | **Open.** The server API for it is done ([agent-api.md](agent-api.md)). | — |
| 7 | Share link defaults | **STEP + PNG, 14 days, no password, at most 90 days**, never the native file by default. Admins can change them; only admins can make links that never expire. | Admin → Settings |
| 8 | Product name | Working name **PLM Lite**. The repo is called PhysCAD-PDM: rename it before making it public. | — |

Other choices:

- **No PoC data is migrated:** vaults start empty (decided 2026-11-27).
- **Disk layout:** one folder per item, `<vault>/AB00042/AB00042_01.003.<ext>` + `AB00042.json`. The file names match the PoC, so linked parts still resolve by file name.
- **First-run protection:** the setup wizard needs a one-time token printed in the server log, so nobody else on the network can claim the admin account first.
- **2FA is mandatory by default** (Admin → Settings).
- **Saving the same file twice records nothing**, as in the PoC.
