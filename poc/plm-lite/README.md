# PLM Lite plugin (proof of concept)

The PhysCAD half of PLM Lite. The other half is the **Vault Viewer** (`../vault-viewer`), a web page where you browse parts, create them, release them, build assemblies and open things in PhysCAD. The plugin has no panel of its own.

## What it does inside PhysCAD
- **PLM Vault toolbar button** (blue document icon): opens the Vault Viewer in your browser, showing the part you have open. The Viewer has to be running (Start Vault Viewer.cmd); if it isn't, PhysCAD says so. PhysCAD doesn't let plugin windows show web pages or open links, so the button leaves a small note (`.open-viewer.json`) in the vault and the Viewer opens the page.
- **Every save of a vault part records a baseline** in the vault: `AB00042_01.001.physcad`, then `01.002`… A save with no changes records nothing.
- **After a release**, the next save starts the next revision: `02.001`.
- **For an assembly**, each baseline lists the exact part baselines it links to, and how many of each (`uses`).
- **A preview picture** is taken of the view as it is when you save.
- **Naming check:** saving a document whose name isn't `AB00000 - DESCRIPTION` shows a message.
- **Past baselines** opened read-only (`… [01.002]`) are never recorded.

## Naming and numbering
| | Format | Example |
|---|---|---|
| Part number | `AB` + 5 digits | `AB00042` |
| Description | upper case: letters, digits, spaces, `- _ . ( ) & +` | `MOUNTING BRACKET` |
| Revision | 2 digits | `01`, `02` |
| Baseline | revision + 3 digits, one per save | `01.003` |

## Commands (command palette)
- **PLM Lite: choose vault folder**: once; pick the same folder the Viewer uses.
- **PLM Lite: record a baseline**: the same as saving.
- **PLM Lite: diagnose**: shows the vault folder and the last preview problem.

## Permissions
`model.read` (read the document), `view` (take the preview picture), `files` (write to the vault folder you picked), `ui` (messages).

## Install / develop
- **Share:** `plm-lite.physcadplugin` (Preferences → Plugins → Install plugin…).
- **Develop:** Preferences → Plugins → Developer: load from folder…, then pick this folder.
