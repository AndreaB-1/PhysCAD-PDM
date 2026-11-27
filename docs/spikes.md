# Phase 0 spikes (need PhysCAD on your PC)

These can't run on the server or in CI. Run each one, then write the result under it.

## (a) Can `physcad.net.fetch` reach the server?

Install a throw-away plugin with this manifest (developer mode: Preferences → Plugins → *Developer: load from folder*):

```json
{ "id": "com.andrea.netspike", "name": "Net spike", "version": "0.0.1", "apiVersion": 1, "main": "main.js",
  "permissions": ["ui", "network"], "network": ["nas.lan", "192.168.1.10"] }
```

```js
// main.js
const urls = ["https://nas.lan/healthz", "http://nas.lan:8080/healthz", "http://192.168.1.10:8080/healthz", "https://plm.example.com/healthz"];
physcad.commands.register({ id: "run", title: "Net spike", async run() {
  const out = {};
  for (const u of urls) { try { const r = await physcad.net.fetch(u); out[u] = r.status ?? "ok"; } catch (e) { out[u] = "ERR " + e.message; } }
  await physcad.ui.toast(JSON.stringify(out), "success");
  return out;
}});
```

Record which work: https with a real certificate, a self-signed / local-CA certificate, plain http, a LAN hostname, a private IP. **If none work,** plugin v2 talks to the desktop agent through a note file in the workspace, as the PoC did.

Result: _todo_

## (b) MCP `file_export` to a path: GLB + STEP, sizes and quality

With PhysCAD open and MCP on (port 47173), from any MCP client:

```
file_export {format: "glb", path: "C:\\temp\\spike\\part.glb"}
file_exportStep {path: "C:\\temp\\spike\\part.step"}
view_capture {width: 640, height: 480}
```

Note the file sizes for a part and a 20-part assembly, the GLB's units (metres or mm?) and up axis, and whether colours and body names survive. Upload the GLB to an item (Upload baseline) and check it in the web viewer.

Result: _todo_

## (c) Replace a linked child in an assembly

Goal: "Update to latest released". With an assembly that links `AB00002_01.001.physcad`:

1. Copy `AB00002_01.002.physcad` next to it.
2. Try `document_syncLinked` after editing the feature's `fileName`/`link.path` through `document_getJson` → edit → `document_load`.
3. If that doesn't refresh the geometry, try deleting the import feature and `document_addToFile {path, how:"linked"}` again.

Result: _todo_

## (d) Headless PhysCAD for server-side exports

```
PhysCAD.exe --headless --allow-folder "D:\\plm-workspace"
```

Does it start without a window, serve MCP, and export? If yes, the worker could produce STEP/GLB/PNG for baselines uploaded without the agent.

Result: _todo_
