// PLM Lite: revision control for PhysCAD (proof of concept). Runs with the Vault Viewer (a web
// page) that browses the vault, creates parts, releases them and opens them in PhysCAD.
//
// This plugin's job, inside PhysCAD:
//   * every save of a vault part records a new baseline in the vault (01.001, 01.002 ...);
//   * for an assembly, it records which part baselines it links to (its "uses");
//   * it tells you when a saved document's name breaks the naming convention.
//
// Naming:     AB + 5 digits, a space-dash-space, an upper-case description: "AB00042 - MOUNTING BRACKET"
// Revisions:  two digits, 01, 02 ...; each save is a baseline .001, .002 ...; a released revision is
//             frozen and the next save starts the next revision (02.001).
// Vault:      <vault>/AB00042.json               the part's record
//             <vault>/AB00042_01.003.physcad     a baseline (never changed once written)
//             <vault>/work/AB00042 - ....physcad the working copy you edit (the Viewer makes it)

const PART_RE = /^AB\d{5}$/;
const DESC_RE = /^[A-Z0-9][A-Z0-9 \-_.()&+]*$/;
const NAME_RE = /^(AB\d{5}) - (.+)$/;
const BASELINE_FILE_RE = /^(AB\d{5})_(\d{2})\.(\d{3})\.physcad$/i;

const sep = (p) => (p.includes("\\") ? "\\" : "/");
const join = (a, b) => a.replace(/[\\/]+$/, "") + sep(a) + b;
const pad = (n, w) => String(n).padStart(w, "0");
const now = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1, 2)}-${pad(d.getDate(), 2)} ${pad(d.getHours(), 2)}:${pad(d.getMinutes(), 2)}`;
};
const label = (rev, b) => `${rev}.${pad(b, 3)}`;
const baseName = (p) => String(p || "").split(/[\\/]/).pop();

function parseName(name) {
  const m = NAME_RE.exec(name || "");
  return m ? { number: m[1], description: m[2], valid: PART_RE.test(m[1]) && DESC_RE.test(m[2]) } : null;
}

async function vault() {
  const v = await physcad.storage.get("vault");
  return typeof v === "string" && v ? v : null;
}
async function readText(path) {
  const raw = await physcad.files.read(path);
  return typeof raw === "string" ? raw : (raw && (raw.text || raw.data)) || "";
}
async function readRecord(v, number) {
  try { return JSON.parse(await readText(join(v, `${number}.json`))); } catch (e) { return null; }
}

// Which vault baselines does this document link to? (Add to File, linked, from a baseline file.)
function usesOf(doc) {
  const counts = new Map();
  for (const f of doc.features || []) {
    if (f.type !== "import") continue;
    const file = baseName((f.link && f.link.path) || f.fileName);
    const m = BASELINE_FILE_RE.exec(file);
    if (!m) continue;
    const key = file.toUpperCase();
    const u = counts.get(key) || { number: m[1].toUpperCase(), rev: m[2], baseline: +m[3], count: 0 };
    u.count++;
    counts.set(key, u);
  }
  return [...counts.values()];
}

// A picture of the view as it is now, for the Vault Viewer (it turns the .b64 text into a .png).
// Only when the Viewer has made <vault>/.previews; a missing picture is made later by the Viewer.
async function savePreview(v, file) {
  try {
    const c = await physcad.commands.run("view.capture", { width: 640, height: 480 });
    let data = typeof c === "string" ? c : c && (c.__image || c.image || c.data || c.png || c.dataUrl || c.url);
    if (typeof data !== "string") {
      await physcad.storage.set("previewError", "capture gave: " + JSON.stringify(c).slice(0, 200));
      return;
    }
    data = data.replace(/^data:image\/\w+;base64,/, "");
    await physcad.files.write(join(join(v, ".previews"), file.replace(/\.physcad$/, ".b64")), data);
    await physcad.storage.remove("previewError");
  } catch (e) { await physcad.storage.set("previewError", e.message); }
}

physcad.commands.register({
  id: "diagnose",
  title: "PLM Lite: diagnose",
  description: "What PLM Lite last had trouble with.",
  async run() { return { vault: await vault(), previewError: await physcad.storage.get("previewError") }; },
});

// Record the open document as the next baseline of its part. Returns its label, or null when
// nothing changed since the last baseline.
async function recordBaseline(comment) {
  const v = await vault();
  if (!v) throw new Error("PLM Lite has no vault folder: run its Choose vault folder command");
  const d = await physcad.model.document();
  const p = parseName(d.name);
  if (!p || !p.valid) throw new Error(`"${d.name}" isn't named like a vault part (AB00000 - DESCRIPTION)`);
  const rec = await readRecord(v, p.number);
  if (!rec) throw new Error(`${p.number} isn't in the vault: create it in the Vault Viewer`);
  if (rec.description !== p.description) throw new Error(`The vault knows ${p.number} as "${rec.description}"`);

  const got = await physcad.commands.run("document.getJson", {});
  const text = typeof got === "string" ? got : got && typeof got.json === "string" ? got.json : JSON.stringify(got);

  let rev = rec.revisions[rec.revisions.length - 1];
  const last = rev && rev.baselines[rev.baselines.length - 1];
  if (last) {
    try { if ((await readText(join(v, last.file))) === text) return null; } catch (e) { /* write a new one */ }
  }
  if (!rev || rev.state === "Released") {
    rev = { rev: pad(rev ? +rev.rev + 1 : 1, 2), state: "In work", baselines: [] };
    rec.revisions.push(rev);
  }
  const b = rev.baselines.length + 1;
  if (b > 999) throw new Error(`Revision ${rev.rev} has 999 baselines: release it to start the next`);
  const file = `${rec.number}_${label(rev.rev, b)}.physcad`;
  await physcad.files.write(join(v, file), text);

  let uses = [];
  try { uses = usesOf(JSON.parse(text)); } catch (e) { /* not an assembly */ }
  const entry = { baseline: b, date: now(), comment: comment || (rec.revisions.length === 1 && b === 1 ? "Created" : ""), file };
  if (uses.length) entry.uses = uses;
  rev.baselines.push(entry);
  await physcad.files.write(join(v, `${rec.number}.json`), JSON.stringify(rec, null, 2));
  await savePreview(v, file);
  return { label: label(rev.rev, b), number: rec.number, uses: uses.length };
}

// ---------- commands ----------

physcad.commands.register({
  id: "chooseVault",
  title: "PLM Lite: choose vault folder",
  description: "Pick the vault folder (the same one the Vault Viewer uses).",
  async run() {
    const picked = await physcad.files.pickFolder();
    const path = typeof picked === "string" ? picked : picked && (picked.path || picked.folder);
    if (!path) return { vault: await vault() };
    await physcad.storage.set("vault", path);
    await physcad.ui.toast(physcad.tx("PLM Lite vault: {0}", path), "success");
    return { vault: path };
  },
});

physcad.commands.register({
  id: "baseline",
  title: "PLM Lite: record a baseline",
  description: "Record the open vault part as its next baseline now (saving does this too).",
  params: { type: "object", properties: { comment: { type: "string" } }, additionalProperties: false },
  async run({ comment = "" } = {}) {
    const r = await recordBaseline(comment.trim());
    if (!r) { await physcad.ui.toast(physcad.tx("No changes since the last baseline"), "success"); return { unchanged: true }; }
    await physcad.ui.toast(physcad.tx("{0} baseline {1}", r.number, r.label), "success");
    return r;
  },
});

// A toolbar button that opens the Vault Viewer in your browser, showing the part you have open.
// Plugins can't open a browser, so it leaves a note in the vault that the Viewer picks up.
const OPEN_NOTE = ".open-viewer.json";
physcad.commands.register({
  id: "openVault",
  title: "PLM Vault",
  description: "Open the PLM Lite Vault Viewer in your browser (it must be running).",
  async run() {
    const v = await vault();
    if (!v) throw new Error("PLM Lite has no vault folder: run its Choose vault folder command");
    let part = null;
    try { const p = parseName((await physcad.model.document()).name); if (p && p.valid) part = p.number; } catch (e) { /* no part */ }
    await physcad.files.write(join(v, OPEN_NOTE), JSON.stringify({ part, at: Date.now() }));
    // The Viewer deletes the note when it opens the page; if it's still there, it isn't running.
    for (let i = 0; i < 8; i++) {
      await new Promise((r) => setTimeout(r, 400));
      let names = [];
      try { const r = await physcad.files.list(v); names = (Array.isArray(r) ? r : (r && (r.entries || r.files)) || []).map((e) => baseName(typeof e === "string" ? e : e.name || e.path)); } catch (e) { /* keep waiting */ }
      if (!names.includes(OPEN_NOTE)) return { opened: true, part };
    }
    await physcad.ui.toast(physcad.tx("The Vault Viewer isn't running: start it with Start Vault Viewer.cmd"), "error");
    return { opened: false };
  },
});
physcad.ui.addToolbarButton({ command: "openVault", tip: physcad.tx("PLM Vault") });

// Every save of a vault part is a baseline; other documents get a naming check.
physcad.events.on("documentSaved", async () => {
  try {
    const d = await physcad.model.document();
    const p = parseName(d.name);
    if (/\[\d{2}\.\d{3}\]$/.test(d.name)) {
      await physcad.ui.toast(physcad.tx("{0} is a past baseline opened for reference: saving it doesn't change the vault", d.name), "success");
      return;
    }
    if (!p || !p.valid) {
      await physcad.ui.toast(physcad.tx("\"{0}\" doesn't follow the naming convention AB00000 - DESCRIPTION. Make it a part in the Vault Viewer.", d.name), "error");
      return;
    }
    const r = await recordBaseline("");
    if (r) await physcad.ui.toast(physcad.tx("{0} baseline {1} recorded", r.number, r.label), "success");
  } catch (e) {
    try { await physcad.ui.toast(physcad.tx("PLM Lite: {0}", e.message), "error"); } catch (e2) { /* nothing more to do */ }
  }
});
