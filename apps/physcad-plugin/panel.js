const $ = (id) => document.getElementById(id);

async function refresh() {
  let s;
  try { s = await physcad.commands.run("status"); } catch (e) { $("state").textContent = e.message; return; }
  $("ws").textContent = s.workspace ? "Workspace: " + s.workspace : "";
  $("checkinCard").hidden = !s.checkedOut;
  if (!s.workspace) {
    $("title").textContent = "PLM Lite";
    $("state").textContent = "Choose the PLM workspace folder (the one in the PLM Lite agent's settings) with Workspace….";
    return;
  }
  if (!s.file) {
    $("title").textContent = "PLM Lite";
    $("state").textContent = "Open a part from PLM Lite (Open in PhysCAD in the browser) to work on it.";
    return;
  }
  if (s.checkedOut) {
    $("title").innerHTML = "";
    const chip = document.createElement("span");
    chip.className = "chip out";
    chip.textContent = "Checked out";
    $("title").append(s.name || s.number, " ", chip);
    $("state").textContent = s.baseline ? "Last saved as " + s.baseline + (s.dirty ? " · unsaved changes" : "") : "Not saved to the server yet";
  } else {
    $("title").innerHTML = "";
    const chip = document.createElement("span");
    chip.className = "chip ro";
    chip.textContent = "Read-only";
    $("title").append(s.name || "", " ", chip);
    $("state").textContent = s.inWorkspace || (s.file && s.file.replace(/\\/g, "/").includes("/.plm/"))
      ? "Not checked out to you: saves stay on this PC. Check it out in PLM Lite to change it."
      : "This file isn't in the PLM workspace.";
  }
}

$("checkin").addEventListener("click", async () => {
  try {
    await physcad.commands.run("checkin", { comment: $("comment").value });
    $("comment").value = "";
    setTimeout(refresh, 1500);
  } catch (e) { await physcad.ui.toast(e.message, "error"); }
});
$("browser").addEventListener("click", async () => {
  try { await physcad.commands.run("openBrowser"); } catch (e) { await physcad.ui.toast(e.message, "error"); }
});
$("choose").addEventListener("click", async () => { await physcad.commands.run("chooseWorkspace"); refresh(); });
$("refresh").addEventListener("click", refresh);
for (const ev of ["documentOpened", "documentSaved", "documentChanged"]) {
  try { physcad.events.on(ev, () => setTimeout(refresh, 800)); } catch (e) { /* unknown event */ }
}
refresh();
