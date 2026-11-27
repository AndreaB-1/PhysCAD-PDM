// PLM Lite plugin v2. The desktop agent does the work (it watches the workspace, uploads every save,
// downloads and opens parts); this plugin is the part of it you see inside PhysCAD:
//   * a panel that shows whether the open document is checked out, with Check in and Open in browser;
//   * a toast when you save a document the server won't record (a read-only copy, or outside the workspace).
//
// Plugins can't reach the agent directly (no localhost network, no file paths into commands), so they
// talk through files in the workspace the person picked once:
//   <workspace>/.plm/status.json          written by the agent: { "<file name>": "<number>|<last baseline>" }
//   <workspace>/.plm/requests/<id>.json   written here: { action: "checkin" | "open-browser", file, comment }

const sep = (p) => (p.includes("\\") ? "\\" : "/");
const join = (...parts) => parts.reduce((a, b) => a.replace(/[\\/]+$/, "") + sep(a) + b);
const baseName = (p) => String(p || "").split(/[\\/]/).pop();
const dirName = (p) => String(p || "").replace(/[\\/][^\\/]*$/, "");
const samePath = (a, b) => String(a || "").replace(/\\/g, "/").toLowerCase() === String(b || "").replace(/\\/g, "/").toLowerCase();

async function workspace() {
  const v = await physcad.storage.get("workspace");
  return typeof v === "string" && v ? v : null;
}

async function readJson(path) {
  try { return JSON.parse(await physcad.files.read(path)); } catch (e) { return null; }
}

/** What the agent says about the open document: { workspace, file, number, baseline, checkedOut, inWorkspace }. */
async function status() {
  const ws = await workspace();
  let doc = null;
  try { doc = await physcad.model.document(); } catch (e) { /* no document */ }
  const file = doc && doc.file ? doc.file : null;
  const out = { workspace: ws, file, name: doc ? doc.name : null, dirty: !!(doc && doc.dirty), checkedOut: false, inWorkspace: false, number: null, baseline: null };
  if (!ws || !file) return out;
  out.inWorkspace = samePath(dirName(file), ws);
  const map = (await readJson(join(ws, ".plm", "status.json"))) || {};
  const entry = out.inWorkspace ? map[baseName(file)] : null;
  if (entry) {
    const [number, baseline] = String(entry).split("|");
    Object.assign(out, { checkedOut: true, number, baseline: baseline || null });
  }
  return out;
}

async function sendRequest(req) {
  const ws = await workspace();
  if (!ws) throw new Error(physcad.tx("Choose the PLM workspace folder first (the one set in the PLM Lite agent)."));
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  await physcad.files.write(join(ws, ".plm", "requests", id + ".json"), JSON.stringify(req));
  // The agent picks requests up within a second; if the file is still there, it isn't running.
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 400));
    let names = [];
    try {
      const r = await physcad.files.list(join(ws, ".plm", "requests"));
      names = (Array.isArray(r) ? r : (r && (r.entries || r.files)) || []).map((e) => baseName(typeof e === "string" ? e : e.name || e.path));
    } catch (e) { /* keep waiting */ }
    if (!names.includes(id + ".json")) return true;
  }
  throw new Error(physcad.tx("The PLM Lite agent isn't running. Start it, then try again."));
}

// ---------- commands ----------

physcad.commands.register({
  id: "chooseWorkspace",
  title: "PLM Lite: choose workspace folder",
  description: "Pick the PLM workspace folder (the one shown in the PLM Lite agent's settings).",
  async run() {
    const picked = await physcad.files.pickFolder();
    const path = typeof picked === "string" ? picked : picked && (picked.path || picked.folder);
    if (!path) return { workspace: await workspace() };
    await physcad.storage.set("workspace", path);
    await physcad.ui.toast(physcad.tx("PLM workspace: {0}", path), "success");
    return { workspace: path };
  },
});

physcad.commands.register({
  id: "status",
  title: "PLM Lite: status",
  description: "Whether the open document is checked out to you, and its last saved baseline.",
  run: () => status(),
});

physcad.commands.register({
  id: "checkin",
  title: "PLM Lite: check in",
  description: "Check in the open document (it must be checked out to you). comment: what changed.",
  params: { type: "object", properties: { comment: { type: "string" } }, additionalProperties: false },
  async run({ comment = "" } = {}) {
    const s = await status();
    if (!s.checkedOut) throw new Error(physcad.tx("This document isn't checked out on this PC."));
    if (s.dirty) throw new Error(physcad.tx("Save the document first."));
    await sendRequest({ action: "checkin", file: baseName(s.file), comment: comment.trim() || "Checked in from PhysCAD" });
    await physcad.ui.toast(physcad.tx("{0}: checking in…", s.number), "success");
    return { number: s.number };
  },
});

physcad.commands.register({
  id: "openBrowser",
  title: "PLM Lite: open in browser",
  description: "Open the open document's item page (or the PLM Lite home page) in your browser.",
  async run() {
    const s = await status();
    await sendRequest({ action: "open-browser", file: s.file ? baseName(s.file) : null });
    return { number: s.number };
  },
});

physcad.commands.register({ id: "open", title: "PLM Lite", run: () => physcad.ui.openPanel("panel") });
physcad.ui.addToolbarButton({ command: "open", tip: physcad.tx("PLM Lite") });

// The agent uploads saves of checked-out parts by itself; here we only warn about saves it won't record.
physcad.events.on("documentSaved", async () => {
  try {
    const s = await status();
    if (!s.workspace || !s.file || s.checkedOut) return;
    if (s.inWorkspace || samePath(dirName(dirName(s.file)), s.workspace)) {
      await physcad.ui.toast(physcad.tx("{0} isn't checked out to you: this save stays on this PC. Check it out in PLM Lite to change it.", s.name || baseName(s.file)), "error");
    }
  } catch (e) { /* never break saving */ }
});
