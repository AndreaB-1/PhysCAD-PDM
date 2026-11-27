import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authenticator } from "otplib";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Agent, makeApp, physcadDoc, signInAdmin } from "./helpers";
import { meshesToGlb } from "../src/worker/glb";

let env: Awaited<ReturnType<typeof makeApp>>;
let admin: Agent;
let totpSecret: string;
let recovery: string[];
let vaultId: string;

beforeAll(async () => {
  env = await makeApp();
  const s = await signInAdmin(env.app);
  admin = s.a; totpSecret = s.secret; recovery = s.recovery;
});
afterAll(async () => { await env.app.close(); await env.client.end(); });

describe("auth", () => {
  it("refuses a second setup and requires 2FA", async () => {
    const other = new Agent(env.app);
    expect((await other.req("POST", "/api/setup", { setupToken: "SETUP", email: "x@example.com", name: "X", password: "0123456789ab" })).statusCode).toBe(409);
    expect((await other.req("POST", "/api/auth/login", { email: "admin@example.com", password: "nope" })).statusCode).toBe(401);
    const r = await other.req("POST", "/api/auth/login", { email: "admin@example.com", password: "correct horse battery" });
    expect(r.json().next).toBe("mfa");
    await other.refreshCsrf();
    expect((await other.req("GET", "/api/vaults")).statusCode).toBe(401);
    expect((await other.req("POST", "/api/auth/mfa", { code: "000000" })).statusCode).toBe(401);
    // a recovery code works once
    await other.json("POST", "/api/auth/mfa", { code: recovery[0] });
    expect((await other.req("GET", "/api/vaults")).statusCode).toBe(200);
  });

  it("rejects state changes without CSRF", async () => {
    const r = await env.app.inject({ method: "POST", url: "/api/vaults", headers: { cookie: admin.cookie, "content-type": "application/json" }, payload: "{}" });
    expect(r.statusCode).toBe(403);
  });

  it("totp code signs in", async () => {
    const other = new Agent(env.app);
    await other.req("POST", "/api/auth/login", { email: "admin@example.com", password: "correct horse battery" });
    await other.refreshCsrf();
    await other.json("POST", "/api/auth/mfa", { code: authenticator.generate(totpSecret) });
    expect((await other.refreshCsrf()).mfaOk).toBe(true);
  });
});

describe("pdm workflow", () => {
  let part: { id: string; number: string };
  let partB: { id: string; number: string };

  it("creates a vault with the default lifecycle", async () => {
    const v = await admin.json("POST", "/api/vaults", { name: "Main", folder: "main", prefix: "AB", digits: 5 });
    vaultId = v.id;
    const detail = await admin.json("GET", `/api/vaults/${vaultId}`);
    expect(detail.states.map((s: { name: string }) => s.name)).toEqual(["In work", "Prototype", "Released", "Obsolete"]);
  });

  it("numbers parts and checks out", async () => {
    part = await admin.json("POST", `/api/vaults/${vaultId}/items`, { description: "mounting bracket", checkout: true });
    expect(part.number).toBe("AB00001");
    expect((part as unknown as { description: string }).description).toBe("MOUNTING BRACKET");
    partB = await admin.json("POST", `/api/vaults/${vaultId}/items`, { description: "Spacer" });
    expect(partB.number).toBe("AB00002");
  });

  it("records baselines while checked out and ignores unchanged saves", async () => {
    const doc = physcadDoc("AB00001 - MOUNTING BRACKET");
    let r = await admin.upload(`/api/items/${part.id}/baselines`, { native: doc, png: Buffer.from([137, 80, 78, 71]) }, ["native", "png"]);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().baseline.label).toBe("01.001");
    expect(r.json().baseline.status).toBe("wip");
    r = await admin.upload(`/api/items/${part.id}/baselines`, { native: doc }, ["native"]);
    expect(r.json().unchanged).toBe(true);
    r = await admin.upload(`/api/items/${part.id}/baselines`, { native: physcadDoc("AB00001 - MOUNTING BRACKET") + " " }, ["native"]);
    expect(r.json().baseline.label).toBe("01.002");
    expect(existsSync(path.join(env.vaultsRoot, "main", "AB00001", "AB00001_01.002.physcad"))).toBe(true);
  });

  it("check-in needs a comment and releases the lock", async () => {
    expect((await admin.req("POST", `/api/items/${part.id}/checkin`, { comment: "" })).statusCode).toBe(400);
    const d = await admin.json("POST", `/api/items/${part.id}/checkin`, { comment: "first version" });
    expect(d.lock).toBeNull();
    expect(d.current.label).toBe("01.002");
    expect(d.revisions[0].baselines.map((b: { status: string }) => b.status)).toEqual(["checked_in", "wip"]);
    const rec = JSON.parse(readFileSync(path.join(env.vaultsRoot, "main", "AB00001", "AB00001.json"), "utf8"));
    expect(rec.revisions[0].baselines).toHaveLength(2);
  });

  it("can't upload without a lock", async () => {
    const r = await admin.upload(`/api/items/${part.id}/baselines`, { native: physcadDoc("x") }, ["native"]);
    expect(r.statusCode).toBe(409);
  });

  it("releases, freezes, and revises", async () => {
    let d = await admin.json("GET", `/api/items/${part.id}`);
    const released = d.states.find((s: { name: string }) => s.name === "Released");
    expect((await admin.req("POST", `/api/revisions/${d.revisions[0].id}/state`, { stateId: released.id, note: "" })).statusCode).toBe(400);
    d = await admin.json("POST", `/api/revisions/${d.revisions[0].id}/state`, { stateId: released.id, note: "ok to build" });
    expect(d.revisions[0].frozen).toBe(true);
    expect(d.released.label).toBe("01.002");
    const r = await admin.req("POST", `/api/items/${part.id}/checkout`, {});
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe("frozen");
    d = await admin.json("POST", `/api/items/${part.id}/revise`, {});
    expect(d.revisions[0].rev).toBe("02");
    expect(d.revisions[0].baselines[0].label).toBe("02.001");
    expect(d.lock).not.toBeNull();
    // cancel removes the new revision again
    const c = await admin.json("POST", `/api/items/${part.id}/cancel-checkout`, {});
    expect(c.discarded).toBe(1);
    expect(c.item.revisions.map((x: { rev: string }) => x.rev)).toEqual(["01"]);
  });

  it("tracks assembly uses and where-used", async () => {
    // give the spacer a checked-in baseline
    await admin.json("POST", `/api/items/${partB.id}/checkout`, {});
    await admin.upload(`/api/items/${partB.id}/checkin`, { native: physcadDoc("AB00002 - SPACER"), comment: "spacer" }, ["native"]);
    const asm = await admin.json("POST", `/api/vaults/${vaultId}/items`, { description: "frame", checkout: true });
    const r = await admin.upload(`/api/items/${asm.id}/baselines`, {
      native: physcadDoc("AB00003 - FRAME", ["AB00001_01.002.physcad", "AB00002_01.001.physcad", "AB00002_01.001.physcad", "AB09999_01.001.physcad"]),
      comment: "frame", checkin: "true",
    }, ["native"]);
    expect(r.statusCode, r.body).toBe(200);
    const uses = r.json().baseline.uses;
    expect(uses).toHaveLength(3);
    expect(uses.find((u: { number: string }) => u.number === "AB00002").count).toBe(2);
    expect(uses.find((u: { number: string }) => u.number === "AB09999").itemId).toBeNull();

    const contains = await admin.json("GET", `/api/items/${asm.id}/contains`);
    expect(contains.children.find((c: { number: string }) => c.number === "AB00001").pinnedState.name).toBe("Released");
    const wu = await admin.json("GET", `/api/items/${part.id}/where-used`);
    expect(wu[0].number).toBe("AB00003");
    expect(wu[0].usages[0].childBaseline).toBe("01.002");

    const list = await admin.json("GET", `/api/vaults/${vaultId}/items?type=assembly`);
    expect(list.items.map((i: { number: string }) => i.number)).toEqual(["AB00003"]);
    const search = await admin.json("GET", `/api/vaults/${vaultId}/items?q=spac`);
    expect(search.total).toBe(1);

    // pack and go
    const pack = await admin.req("GET", `/api/baselines/${r.json().baseline.id}/pack`);
    expect(pack.statusCode).toBe(200);
    expect(pack.rawPayload.subarray(0, 2).toString()).toBe("PK");
  });

  it("enforces roles", async () => {
    const viewer = await admin.json("POST", "/api/admin/users", { email: "v@example.com", name: "Viewer", password: "viewer-password-1" });
    await admin.json("PUT", `/api/vaults/${vaultId}/members/${viewer.id}`, { role: "viewer" });
    await admin.json("PUT", "/api/admin/settings", { mfaMandatory: false, minPasswordLength: 10, shareDefaults: { formats: ["step", "png"], expiresInDays: 14, requirePassword: false, maxExpiryDays: 90 } });
    const v = new Agent(env.app);
    expect((await v.req("POST", "/api/auth/login", { email: "v@example.com", password: "viewer-password-1" })).json().next).toBe("done");
    await v.refreshCsrf();
    expect((await v.json("GET", `/api/vaults/${vaultId}/items`)).total).toBe(3);
    expect((await v.req("POST", `/api/items/${partB.id}/checkout`, {})).statusCode).toBe(403);
    expect((await v.req("GET", "/api/admin/users")).statusCode).toBe(403);
  });

  it("share links: public page, password, download limit, revoke", async () => {
    const d = await admin.json("GET", `/api/items/${part.id}`);
    const share = await admin.json("POST", "/api/shares", { target: "latest_released", itemId: part.id, formats: ["native"], expiresInDays: 7, password: "letmein", maxDownloads: 1 });
    const token = share.url.split("/s/")[1];
    const anon = new Agent(env.app);
    expect((await anon.json("GET", `/api/public/shares/${token}`)).needsPassword).toBe(true);
    expect((await anon.req("POST", `/api/public/shares/${token}/unlock`, { password: "x" })).statusCode).toBe(401);
    const { grant } = await anon.json("POST", `/api/public/shares/${token}/unlock`, { password: "letmein" });
    const info = await anon.json("GET", `/api/public/shares/${token}?g=${encodeURIComponent(grant)}`);
    expect(info.baseline.label).toBe("01.002");
    expect(info.files.map((f: { kind: string }) => f.kind)).toEqual(["native"]);
    const fileId = info.files[0].id;
    expect((await anon.req("GET", `/api/public/shares/${token}/files/${fileId}?download=1`)).statusCode).toBe(401);
    expect((await anon.req("GET", `/api/public/shares/${token}/files/${fileId}?download=1&g=${encodeURIComponent(grant)}`)).statusCode).toBe(200);
    expect((await anon.req("GET", `/api/public/shares/${token}/files/${fileId}?download=1&g=${encodeURIComponent(grant)}`)).statusCode).toBe(404);
    // another baseline's file can't be fetched through the link
    const other = await admin.json("POST", "/api/shares", { target: "baseline", itemId: part.id, baselineId: d.revisions[0].baselines[1].id, formats: ["png"], expiresInDays: 7 });
    const t2 = other.url.split("/s/")[1];
    expect((await anon.req("GET", `/api/public/shares/${t2}/files/${fileId}?download=1`)).statusCode).toBe(404);
    await admin.json("DELETE", `/api/shares/${other.id}`);
    expect((await anon.req("GET", `/api/public/shares/${t2}`)).statusCode).toBe(404);
  });

  it("device-code sign-in gives the agent a token", async () => {
    const anon = new Agent(env.app);
    const code = await anon.json("POST", "/api/device/code", { clientName: "Desktop agent on PC1" });
    expect((await anon.req("POST", "/api/device/token", { deviceCode: code.deviceCode })).json().error).toBe("authorization_pending");
    await admin.json("POST", "/api/device/approve", { code: code.userCode, approve: true });
    const { token } = await anon.json("POST", "/api/device/token", { deviceCode: code.deviceCode });
    expect(token).toMatch(/^plm_/);
    const r = await env.app.inject({ method: "GET", url: `/api/vaults/${vaultId}/items/by-number/AB00001`, headers: { authorization: `Bearer ${token}` } });
    expect(r.statusCode).toBe(200);
    expect((await anon.req("POST", "/api/device/token", { deviceCode: code.deviceCode })).json().error).toBe("expired_token");
  });

  it("writes an audit trail", async () => {
    const rows = await admin.json("GET", "/api/admin/audit?limit=500");
    const actions = new Set(rows.map((r: { action: string }) => r.action));
    for (const a of ["item.checkout", "item.checkin", "revision.state_changed", "share.download", "file.pack_and_go", "device.approved"]) expect(actions).toContain(a);
  });

  it("rebuilds the index from disk", async () => {
    await env.client.unsafe("delete from items where number = 'AB00002'");
    const r = await admin.json("POST", `/api/vaults/${vaultId}/rebuild`);
    expect(r.imported).toBe(1);
    const d = await admin.json("GET", `/api/vaults/${vaultId}/items/by-number/AB00002`);
    expect(d.current.label).toBe("01.001");
  });
});

describe("glb", () => {
  it("writes a valid GLB header", () => {
    const glb = meshesToGlb([{ attributes: { position: { array: [0, 0, 0, 1, 0, 0, 0, 1, 0] } }, index: { array: [0, 1, 2] } }]);
    expect(glb.readUInt32LE(0)).toBe(0x46546c67);
    expect(glb.readUInt32LE(8)).toBe(glb.length);
  });
});
