import type { FastifyInstance } from "fastify";
import { and, desc, eq, lt, sql, type SQL } from "drizzle-orm";
import { readdir } from "node:fs/promises";
import { z } from "zod";
import { audit, items, sessions, users, vaultMembers, vaults } from "../db/schema";
import type { Ctx } from "../lib/context";
import { requireAdmin } from "../lib/auth";
import { hashPassword } from "../lib/crypto";
import { badRequest, conflict, notFound } from "../lib/errors";
import { logAudit } from "../lib/audit";
import { getSettings, saveSettings } from "../lib/settings";
import { publicUser } from "./auth";

export async function adminRoutes(app: FastifyInstance, ctx: Ctx) {
  app.get("/admin/users", async (req) => {
    requireAdmin(req);
    const rows = await ctx.db.select().from(users).orderBy(users.name);
    const mem = await ctx.db.select().from(vaultMembers);
    return rows.map((u) => ({ ...publicUser(u), vaults: mem.filter((m) => m.userId === u.id).map((m) => ({ vaultId: m.vaultId, role: m.role })) }));
  });

  app.post("/admin/users", async (req) => {
    requireAdmin(req);
    const s = await getSettings(ctx.db);
    const body = z.object({
      email: z.string().email(), name: z.string().min(1).max(100), password: z.string().min(s.minPasswordLength).max(200), isAdmin: z.boolean().default(false),
    }).parse(req.body);
    const [exists] = await ctx.db.select({ id: users.id }).from(users).where(eq(users.email, body.email.toLowerCase()));
    if (exists) throw conflict("A user with that email exists");
    const [u] = await ctx.db.insert(users).values({ email: body.email.toLowerCase(), name: body.name, passwordHash: await hashPassword(body.password), isAdmin: body.isAdmin }).returning();
    await logAudit(ctx, req, "admin.user_created", { details: { email: u!.email, isAdmin: u!.isAdmin } });
    return publicUser(u!);
  });

  app.patch<{ Params: { id: string } }>("/admin/users/:id", async (req) => {
    const me = requireAdmin(req);
    const body = z.object({
      name: z.string().min(1).max(100).optional(), isAdmin: z.boolean().optional(), disabled: z.boolean().optional(),
      password: z.string().min(10).max(200).optional(), resetTotp: z.boolean().optional(), unlock: z.boolean().optional(),
    }).parse(req.body);
    if (req.params.id === me.id && (body.isAdmin === false || body.disabled)) throw badRequest("You can't remove your own admin rights or disable yourself");
    const patch: Partial<typeof users.$inferInsert> = {};
    if (body.name) patch.name = body.name;
    if (body.isAdmin !== undefined) patch.isAdmin = body.isAdmin;
    if (body.disabled !== undefined) patch.disabled = body.disabled;
    if (body.password) patch.passwordHash = await hashPassword(body.password);
    if (body.resetTotp) Object.assign(patch, { totpEnabled: false, totpSecret: null, recoveryCodes: [] });
    if (body.unlock) Object.assign(patch, { failedLogins: 0, lockedUntil: null });
    const [u] = await ctx.db.update(users).set(patch).where(eq(users.id, req.params.id)).returning();
    if (!u) throw notFound();
    if (body.disabled || body.password || body.resetTotp) await ctx.db.delete(sessions).where(eq(sessions.userId, u.id));
    await logAudit(ctx, req, "admin.user_updated", { details: { email: u.email, ...body, password: body.password ? "(changed)" : undefined } });
    return publicUser(u);
  });

  app.get("/admin/settings", async (req) => { requireAdmin(req); return getSettings(ctx.db); });
  app.put("/admin/settings", async (req) => {
    requireAdmin(req);
    const body = z.object({
      mfaMandatory: z.boolean(),
      minPasswordLength: z.number().int().min(8).max(128),
      shareDefaults: z.object({
        formats: z.array(z.string()).min(1), expiresInDays: z.number().int().min(1).max(365).nullable(),
        requirePassword: z.boolean(), maxExpiryDays: z.number().int().min(1).max(3650),
      }),
    }).parse(req.body);
    await saveSettings(ctx.db, body);
    await logAudit(ctx, req, "admin.settings_changed", { details: body });
    return body;
  });

  app.get<{ Querystring: { before?: string; action?: string; itemId?: string; userId?: string; vaultId?: string; limit?: string } }>("/admin/audit", async (req) => {
    requireAdmin(req);
    const q = req.query;
    const conds: SQL[] = [];
    if (q.before) conds.push(lt(audit.id, Number(q.before)));
    if (q.action) conds.push(sql`${audit.action} like ${q.action.replace(/[%_]/g, "") + "%"}`);
    if (q.itemId) conds.push(eq(audit.itemId, q.itemId));
    if (q.userId) conds.push(eq(audit.userId, q.userId));
    if (q.vaultId) conds.push(eq(audit.vaultId, q.vaultId));
    const limit = Math.min(500, Number(q.limit) || 100);
    return ctx.db.select({ a: audit, number: items.number }).from(audit).leftJoin(items, eq(items.id, audit.itemId))
      .where(conds.length ? and(...conds) : undefined).orderBy(desc(audit.id)).limit(limit)
      .then((rows) => rows.map((r) => ({ ...r.a, itemNumber: r.number })));
  });

  /** Sub-folders of /vaults that can become a vault. */
  app.get("/admin/folders", async (req) => {
    requireAdmin(req);
    let entries: string[] = [];
    try {
      entries = (await readdir(ctx.config.vaultsRoot, { withFileTypes: true }))
        .filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name);
    } catch { /* missing mount */ }
    const used = new Set((await ctx.db.select({ f: vaults.folder }).from(vaults)).map((r) => r.f));
    return { root: ctx.config.vaultsRoot, folders: entries.sort().map((name) => ({ name, used: used.has(name) })) };
  });

  app.post("/admin/backup", async (req) => {
    requireAdmin(req);
    if (!ctx.enqueue) throw conflict("The worker isn't running");
    await ctx.enqueue("backup", {});
    await logAudit(ctx, req, "admin.backup_requested");
    return { ok: true };
  });
}
