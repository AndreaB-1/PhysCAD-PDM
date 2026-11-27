import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { authenticator } from "otplib";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../src/config";
import { createDb, runMigrations } from "../src/db";
import { buildApp } from "../src/app";
import type { Ctx } from "../src/lib/context";

export async function makeApp() {
  const vaultsRoot = await mkdtemp(path.join(os.tmpdir(), "plm-vaults-"));
  process.env.VAULTS_ROOT = vaultsRoot;
  process.env.DATA_DIR = path.join(vaultsRoot, ".data");
  process.env.SESSION_SECRET = "test-secret-test-secret-test-secret-123";
  process.env.DATABASE_URL ||= "postgres://plm:plm@localhost:5432/plm_test";
  const config = loadConfig();
  const { db, client } = createDb(config.dbUrl);
  await client.unsafe("drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;");
  await runMigrations(db, fileURLToPath(new URL("../drizzle", import.meta.url)));
  const ctx: Ctx = { db, config, setupToken: "SETUP", enqueue: async () => {} };
  const app = await buildApp(ctx, { logger: false });
  return { app, ctx, client, vaultsRoot };
}

/** A tiny HTTP client that keeps the session cookie and CSRF token. */
export class Agent {
  cookie = "";
  csrf = "";
  constructor(private app: FastifyInstance) {}
  async req(method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await this.app.inject({
      method: method as "GET", url,
      headers: { ...(this.cookie ? { cookie: this.cookie } : {}), ...(this.csrf ? { "x-csrf-token": this.csrf } : {}), ...(body && !(body instanceof Buffer) ? { "content-type": "application/json" } : {}), ...headers },
      payload: body instanceof Buffer ? body : body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers["set-cookie"];
    if (set) {
      const c = (Array.isArray(set) ? set : [set]).find((s) => s.startsWith("plm_session="));
      if (c) this.cookie = c.split(";")[0]!;
    }
    return res;
  }
  async refreshCsrf() {
    const me = (await this.req("GET", "/api/auth/me")).json();
    this.csrf = me.csrf ?? "";
    return me;
  }
  async json(method: string, url: string, body?: unknown) {
    const r = await this.req(method, url, body);
    if (r.statusCode >= 400) throw new Error(`${method} ${url} → ${r.statusCode} ${r.body}`);
    return r.json();
  }
  async upload(url: string, parts: Record<string, string | Buffer>, fileKinds: string[]) {
    const boundary = "----plmtest" + Math.random().toString(16).slice(2);
    const chunks: Buffer[] = [];
    for (const [k, v] of Object.entries(parts)) {
      const isFile = fileKinds.includes(k);
      chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"${isFile ? `; filename="${k}.bin"` : ""}\r\n${isFile ? "Content-Type: application/octet-stream\r\n" : ""}\r\n`));
      chunks.push(Buffer.isBuffer(v) ? v : Buffer.from(v));
      chunks.push(Buffer.from("\r\n"));
    }
    chunks.push(Buffer.from(`--${boundary}--\r\n`));
    return this.req("POST", url, Buffer.concat(chunks), { "content-type": `multipart/form-data; boundary=${boundary}` });
  }
}

export async function signInAdmin(app: FastifyInstance) {
  const a = new Agent(app);
  let r = await a.req("POST", "/api/setup", { setupToken: "SETUP", email: "admin@example.com", name: "Admin", password: "correct horse battery" });
  if (r.statusCode !== 200) throw new Error(r.body);
  await a.refreshCsrf();
  const setup = await a.json("POST", "/api/auth/totp/setup");
  const codes = await a.json("POST", "/api/auth/totp/confirm", { code: authenticator.generate(setup.secret) });
  await a.refreshCsrf();
  return { a, secret: setup.secret as string, recovery: codes.recoveryCodes as string[] };
}

export function physcadDoc(name: string, links: string[] = []) {
  return JSON.stringify({
    format: "physcad", version: 3, name, units: "mm", components: [],
    features: [
      { type: "box", id: "f1", size: [10, 20, 30] },
      ...links.map((l, i) => ({ type: "import", id: `l${i}`, fileName: l, format: "physcad", link: { path: `C:\\work\\${l}`, mtime: 0, hash: "x" }, parts: [] })),
    ],
  });
}
