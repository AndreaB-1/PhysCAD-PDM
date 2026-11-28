import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authenticator } from "otplib";
import { existsSync } from "node:fs";
import path from "node:path";
import { Agent, makeApp, physcadDoc, signInAdmin } from "./helpers";

let env: Awaited<ReturnType<typeof makeApp>>;
let admin: Agent;
let vaultA: string;
let vaultB: string;
const ids: Record<string, string> = {};

async function newItem(vaultId: string, description: string) {
  const it = await admin.json("POST", `/api/vaults/${vaultId}/items`, { description, checkout: true });
  return it as { id: string; number: string };
}

/** A user who can only view vault A. */
async function viewer() {
  const u = await admin.json("POST", "/api/admin/users", { email: "viewer@example.com", name: "Viewer", password: "viewer password 1" });
  await admin.json("PUT", `/api/vaults/${vaultA}/members/${u.id}`, { role: "viewer" });
  const a = new Agent(env.app);
  await a.req("POST", "/api/auth/login", { email: "viewer@example.com", password: "viewer password 1" });
  await a.refreshCsrf();
  const s = await a.json("POST", "/api/auth/totp/setup");
  await a.json("POST", "/api/auth/totp/confirm", { code: authenticator.generate(s.secret) });
  await a.refreshCsrf();
  return a;
}

beforeAll(async () => {
  env = await makeApp();
  admin = (await signInAdmin(env.app)).a;
  vaultA = (await admin.json("POST", "/api/vaults", { name: "Main", folder: "main", prefix: "AB", digits: 5 })).id;
  vaultB = (await admin.json("POST", "/api/vaults", { name: "Hardware", folder: "hw", prefix: "HW", digits: 4 })).id;
  for (const [k, v, d] of [["bracket", vaultA, "BRACKET"], ["screw", vaultB, "M3X8 SCREW"], ["washer", vaultB, "M3 WASHER"]] as const) {
    ids[k] = (await newItem(v, d)).id;
  }
});
afterAll(async () => { await env.app.close(); await env.client.end(); });

describe("catalogs", () => {
  let hardware: string;
  let screws: string;

  it("nests catalogs and links items without copying them", async () => {
    hardware = (await admin.json("POST", "/api/collections", { kind: "catalog", name: "Hardware" })).id;
    screws = (await admin.json("POST", "/api/collections", { kind: "catalog", name: "Screws", parentId: hardware, color: "#f59e0b" })).id;
    const r = await admin.json("POST", `/api/collections/${screws}/items`, { itemIds: [ids.screw, ids.washer] });
    expect(r).toEqual({ added: 2, alreadyThere: 0 });
    // adding again is a no-op: links, never duplicates
    expect(await admin.json("POST", `/api/collections/${screws}/items`, { itemIds: [ids.screw] })).toEqual({ added: 0, alreadyThere: 1 });
    // the same item can sit in several catalogs
    await admin.json("POST", `/api/collections/${hardware}/items`, { itemIds: [ids.screw] });

    const d = await admin.json("GET", `/api/collections/${screws}`);
    expect(d.path.map((p: { name: string }) => p.name)).toEqual(["Hardware", "Screws"]);
    expect(d.items.map((i: { number: string }) => i.number).sort()).toEqual(["HW0001", "HW0002"]);
    expect(d.items[0].vaultName).toBe("Hardware");
    const top = await admin.json("GET", `/api/collections/${hardware}`);
    expect(top.children).toHaveLength(1);
    expect((await admin.json("GET", `/api/items/${ids.screw}/collections`)).map((c: { name: string }) => c.name)).toEqual(["Hardware", "Screws"]);

    const list = await admin.json("GET", "/api/collections?kind=catalog");
    expect(list.collections.find((c: { id: string }) => c.id === screws).itemCount).toBe(2);
  });

  it("keeps notes and quantities per link, and removes links only", async () => {
    await admin.json("PATCH", `/api/collections/${screws}/items/${ids.washer}`, { note: "stainless", quantity: 50 });
    let d = await admin.json("GET", `/api/collections/${screws}`);
    expect(d.items.find((i: { id: string }) => i.id === ids.washer)).toMatchObject({ note: "stainless", quantity: 50 });
    await admin.json("DELETE", `/api/collections/${screws}/items/${ids.washer}`);
    d = await admin.json("GET", `/api/collections/${screws}`);
    expect(d.items).toHaveLength(1);
    expect((await admin.req("GET", `/api/items/${ids.washer}`)).statusCode).toBe(200); // the item itself is untouched
  });

  it("refuses cycles and mixing kinds", async () => {
    expect((await admin.req("PATCH", `/api/collections/${hardware}`, { parentId: screws })).statusCode).toBe(400);
    const p = await admin.json("POST", "/api/collections", { kind: "project", name: "Shed" });
    expect((await admin.req("POST", "/api/collections", { kind: "catalog", name: "x", parentId: p.id })).statusCode).toBe(400);
  });

  it("shows viewers only the items of vaults they can see, read-only", async () => {
    await admin.json("POST", `/api/collections/${screws}/items`, { itemIds: [ids.bracket] });
    const v = await viewer();
    const d = await v.json("GET", `/api/collections/${screws}`);
    expect(d.items.map((i: { id: string }) => i.id)).toEqual([ids.bracket]);
    expect(d.hiddenItems).toBe(1);
    expect(d.canEdit).toBe(false);
    expect((await v.req("POST", "/api/collections", { kind: "catalog", name: "Mine" })).statusCode).toBe(403);
  });

  it("deletes a catalog with its sub-catalogs, never the items", async () => {
    await admin.json("DELETE", `/api/collections/${hardware}`);
    expect((await admin.req("GET", `/api/collections/${screws}`)).statusCode).toBe(404);
    expect((await admin.req("GET", `/api/items/${ids.screw}`)).statusCode).toBe(200);
  });
});

describe("projects", () => {
  let project: string;

  it("has items, notes and files", async () => {
    project = (await admin.json("POST", "/api/collections", { kind: "project", name: "Garden shed", description: "Summer build" })).id;
    expect((await admin.json("GET", `/api/collections/${project}`)).collection.status).toBe("active");
    await admin.json("POST", `/api/collections/${project}/items`, { itemIds: [ids.bracket, ids.screw] });

    const doc = await admin.json("POST", `/api/collections/${project}/docs`, { title: "Plan", body: "# Shed\n- buy wood" });
    await admin.json("PATCH", `/api/docs/${doc.id}`, { body: "# Shed\n- buy wood\n- **paint**" });
    expect((await admin.json("GET", `/api/docs/${doc.id}`)).body).toContain("**paint**");

    const up = await admin.upload(`/api/collections/${project}/files`, { file: "receipt contents", note: "hardware store" }, ["file"]);
    expect(up.statusCode).toBe(200);
    const fileId = up.json().files[0].id;
    const d = await admin.json("GET", `/api/collections/${project}`);
    expect(d.items).toHaveLength(2);
    expect(d.docs.map((x: { title: string }) => x.title)).toEqual(["Plan"]);
    expect(d.files[0]).toMatchObject({ name: "file.bin", note: "hardware store", size: 16 });
    expect(d.files[0].relPath).toBeUndefined();

    const dl = await admin.req("GET", `/api/project-files/${fileId}`);
    expect(dl.body).toBe("receipt contents");
    // unknown types always download; never rendered by the browser
    expect(dl.headers["content-disposition"]).toMatch(/^attachment/);
    expect(dl.headers["content-type"]).toBe("application/octet-stream");

    await admin.json("PATCH", `/api/collections/${project}`, { status: "done" });
    expect((await admin.json("GET", "/api/collections?kind=project")).collections[0]).toMatchObject({ status: "done", docCount: 1, fileCount: 1, itemCount: 2 });
  });

  it("removes attached files from disk when a project is deleted", async () => {
    const dir = path.join(env.vaultsRoot, ".plm-projects", project);
    expect(existsSync(dir)).toBe(true);
    await admin.json("DELETE", `/api/collections/${project}`);
    expect(existsSync(dir)).toBe(false);
  });
});

describe("assembly tagging", () => {
  it("marks an item as an assembly when it links other files, even outside the vault", async () => {
    const asm = await newItem(vaultA, "FRAME");
    const r = await admin.upload(`/api/items/${asm.id}/baselines`, { native: physcadDoc("FRAME", ["bolt from the internet.physcad"]) }, ["native"]);
    expect(r.statusCode).toBe(200);
    expect((await admin.json("GET", `/api/items/${asm.id}`)).item.type).toBe("assembly");
    await admin.upload(`/api/items/${asm.id}/baselines`, { native: physcadDoc("FRAME v2") }, ["native"]);
    expect((await admin.json("GET", `/api/items/${asm.id}`)).item.type).toBe("part");
  });
});
