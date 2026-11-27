import type { FastifyInstance } from "fastify";
import { and, asc, eq, inArray } from "drizzle-orm";
import { mkdir } from "node:fs/promises";
import { z } from "zod";
import { lifecycleSchema, vaultCreateSchema, vaultUpdateSchema, ROLES } from "@plm/shared";
import { revisions, states, users, vaultMembers, vaults } from "../db/schema";
import type { Ctx } from "../lib/context";
import { requireAdmin, requireUser, requireVaultRole, vaultRole } from "../lib/auth";
import { badRequest, conflict } from "../lib/errors";
import { logAudit } from "../lib/audit";
import { createDefaultStates, getVault, pickState } from "../lib/pdm";
import { vaultRoot } from "../lib/storage";
import { rebuildFromDisk } from "../lib/rebuild";

export async function vaultRoutes(app: FastifyInstance, ctx: Ctx) {
  app.get("/vaults", async (req) => {
    const u = requireUser(req);
    const all = await ctx.db.select().from(vaults).orderBy(asc(vaults.name));
    const out = [];
    for (const v of all) {
      const role = await vaultRole(ctx, u, v.id);
      if (role && (!req.auth?.token?.vaultId || req.auth.token.vaultId === v.id)) out.push({ ...v, role });
    }
    return out;
  });

  app.post("/vaults", async (req) => {
    requireAdmin(req);
    const body = vaultCreateSchema.parse(req.body);
    const root = vaultRoot(ctx.config.vaultsRoot, body.folder);
    const [dup] = await ctx.db.select({ id: vaults.id }).from(vaults).where(eq(vaults.folder, body.folder));
    if (dup) throw conflict("That folder is already a vault");
    await mkdir(root, { recursive: true });
    const v = await ctx.db.transaction(async (tx) => {
      const [v] = await tx.insert(vaults).values(body).returning();
      await createDefaultStates(tx, v!.id);
      return v!;
    });
    await logAudit(ctx, req, "vault.created", { vaultId: v.id, details: { name: v.name, folder: v.folder } });
    return v;
  });

  app.get<{ Params: { id: string } }>("/vaults/:id", async (req) => {
    const { role } = await requireVaultRole(ctx, req, req.params.id, "viewer");
    const v = await getVault(ctx.db, req.params.id);
    const sts = await ctx.db.select().from(states).where(eq(states.vaultId, v.id)).orderBy(asc(states.sort));
    return { ...v, role, states: sts.filter((s) => !s.archived).map(pickState) };
  });

  app.patch<{ Params: { id: string } }>("/vaults/:id", async (req) => {
    await requireVaultRole(ctx, req, req.params.id, "admin");
    const body = vaultUpdateSchema.parse(req.body);
    const [v] = await ctx.db.update(vaults).set(body).where(eq(vaults.id, req.params.id)).returning();
    await logAudit(ctx, req, "vault.updated", { vaultId: req.params.id, details: body });
    return v;
  });

  // ---- members
  app.get<{ Params: { id: string } }>("/vaults/:id/members", async (req) => {
    await requireVaultRole(ctx, req, req.params.id, "admin");
    return ctx.db.select({ userId: users.id, name: users.name, email: users.email, role: vaultMembers.role })
      .from(vaultMembers).innerJoin(users, eq(users.id, vaultMembers.userId)).where(eq(vaultMembers.vaultId, req.params.id));
  });
  app.put<{ Params: { id: string; userId: string } }>("/vaults/:id/members/:userId", async (req) => {
    await requireVaultRole(ctx, req, req.params.id, "admin");
    const { role } = z.object({ role: z.enum(ROLES) }).parse(req.body);
    await ctx.db.insert(vaultMembers).values({ vaultId: req.params.id, userId: req.params.userId, role })
      .onConflictDoUpdate({ target: [vaultMembers.vaultId, vaultMembers.userId], set: { role } });
    await logAudit(ctx, req, "vault.member_set", { vaultId: req.params.id, details: { userId: req.params.userId, role } });
    return { ok: true };
  });
  app.delete<{ Params: { id: string; userId: string } }>("/vaults/:id/members/:userId", async (req) => {
    await requireVaultRole(ctx, req, req.params.id, "admin");
    await ctx.db.delete(vaultMembers).where(and(eq(vaultMembers.vaultId, req.params.id), eq(vaultMembers.userId, req.params.userId)));
    await logAudit(ctx, req, "vault.member_removed", { vaultId: req.params.id, details: { userId: req.params.userId } });
    return { ok: true };
  });

  // ---- lifecycle
  app.put<{ Params: { id: string } }>("/vaults/:id/lifecycle", async (req) => {
    await requireVaultRole(ctx, req, req.params.id, "admin");
    const { states: input } = lifecycleSchema.parse(req.body);
    const names = input.map((s) => s.name.trim());
    if (new Set(names.map((n) => n.toLowerCase())).size !== names.length) throw badRequest("State names must be unique");
    if (input.filter((s) => s.isInitial).length !== 1) throw badRequest("Exactly one state must be the initial state");
    for (const s of input) for (const t of s.transitionsTo) if (!names.includes(t)) throw badRequest(`Unknown transition target ${t}`);
    const vaultId = req.params.id;
    await ctx.db.transaction(async (tx) => {
      const existing = await tx.select().from(states).where(eq(states.vaultId, vaultId));
      const ids = new Map<string, string>();
      for (const [i, s] of input.entries()) {
        const values = { name: s.name.trim(), color: s.color, sort: i, freezes: s.freezes, isRelease: s.isRelease, isInitial: s.isInitial, allowedRoles: s.allowedRoles, archived: false };
        const match = existing.find((e) => e.id === s.id);
        if (match) { await tx.update(states).set(values).where(eq(states.id, match.id)); ids.set(values.name, match.id); }
        else { const [n] = await tx.insert(states).values({ ...values, vaultId, transitionsTo: [] }).returning(); ids.set(values.name, n!.id); }
      }
      for (const s of input) {
        await tx.update(states).set({ transitionsTo: s.transitionsTo.map((t) => ids.get(t)!) }).where(eq(states.id, ids.get(s.name.trim())!));
      }
      const keep = new Set(ids.values());
      const gone = existing.filter((e) => !keep.has(e.id)).map((e) => e.id);
      if (gone.length) {
        const used = await tx.select({ id: revisions.stateId }).from(revisions).where(inArray(revisions.stateId, gone));
        const usedIds = new Set(used.map((u) => u.id));
        for (const g of gone) {
          if (usedIds.has(g)) await tx.update(states).set({ archived: true, isInitial: false, transitionsTo: [] }).where(eq(states.id, g));
          else await tx.delete(states).where(eq(states.id, g));
        }
      }
    });
    await logAudit(ctx, req, "vault.lifecycle_changed", { vaultId, details: { states: names } });
    const sts = await ctx.db.select().from(states).where(and(eq(states.vaultId, vaultId), eq(states.archived, false))).orderBy(asc(states.sort));
    return sts.map(pickState);
  });

  app.post<{ Params: { id: string } }>("/vaults/:id/rebuild", async (req) => {
    requireAdmin(req);
    const r = await rebuildFromDisk(ctx, req.params.id);
    await logAudit(ctx, req, "vault.rebuild_index", { vaultId: req.params.id, details: r });
    return r;
  });
}
