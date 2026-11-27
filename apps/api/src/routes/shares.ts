import type { FastifyInstance } from "fastify";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { shareCreateSchema } from "@plm/shared";
import { baselines, files, items, revisions, shareLinks, states, users, vaults } from "../db/schema";
import type { Ctx } from "../lib/context";
import { originOf, requireUser, requireVaultRole, vaultRole } from "../lib/auth";
import { hashPassword, randomToken, sha256, signGrant, verifyGrant, verifyPassword } from "../lib/crypto";
import { badRequest, forbidden, notFound, unauthorized } from "../lib/errors";
import { logAudit } from "../lib/audit";
import { getSettings } from "../lib/settings";
import { getItem, itemDetail, rootOf } from "../lib/pdm";
import { sendVaultFile } from "./items";

type Share = typeof shareLinks.$inferSelect;
const publicLimit = { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } };

async function resolveShareBaseline(ctx: Ctx, s: Share) {
  if (s.target === "baseline") return s.baselineId;
  if (s.target === "revision") {
    const [b] = await ctx.db.select().from(baselines)
      .where(and(eq(baselines.revisionId, s.revisionId!), eq(baselines.status, "checked_in"))).orderBy(desc(baselines.seq)).limit(1);
    return b?.id ?? null;
  }
  const d = await itemDetail(ctx.db, s.itemId);
  return d.released?.id ?? null;
}

function shareState(s: Share | undefined) {
  if (!s) return "missing";
  if (s.revokedAt) return "revoked";
  if (s.expiresAt && s.expiresAt < new Date()) return "expired";
  if (s.maxDownloads != null && s.downloads >= s.maxDownloads) return "used_up";
  return "active";
}

export async function shareRoutes(app: FastifyInstance, ctx: Ctx) {
  app.get("/shares/defaults", async (req) => {
    requireUser(req);
    return (await getSettings(ctx.db)).shareDefaults;
  });

  app.post("/shares", async (req) => {
    const body = shareCreateSchema.parse(req.body);
    const item = await getItem(ctx.db, body.itemId);
    const { user } = await requireVaultRole(ctx, req, item.vaultId, "editor");
    const settings = await getSettings(ctx.db);
    if (settings.shareDefaults.requirePassword && !body.password) throw badRequest("A password is required for share links on this server");
    const days = body.expiresInDays ?? null;
    if (days === null && !user.isAdmin) throw badRequest("Only administrators can create links that never expire");
    if (days !== null && days > settings.shareDefaults.maxExpiryDays) throw badRequest(`Links can last at most ${settings.shareDefaults.maxExpiryDays} days`);
    if (body.target === "baseline") {
      const [b] = await ctx.db.select({ id: baselines.id }).from(baselines).innerJoin(revisions, eq(revisions.id, baselines.revisionId))
        .where(and(eq(baselines.id, body.baselineId ?? "00000000-0000-0000-0000-000000000000"), eq(revisions.itemId, item.id)));
      if (!b) throw badRequest("Pick a baseline of this item");
    }
    if (body.target === "revision") {
      const [r] = await ctx.db.select({ id: revisions.id }).from(revisions).where(and(eq(revisions.id, body.revisionId ?? "00000000-0000-0000-0000-000000000000"), eq(revisions.itemId, item.id)));
      if (!r) throw badRequest("Pick a revision of this item");
    }
    const token = randomToken(24); // 192 bits
    const [s] = await ctx.db.insert(shareLinks).values({
      tokenHash: sha256(token), target: body.target, itemId: item.id,
      revisionId: body.target === "revision" ? body.revisionId : null,
      baselineId: body.target === "baseline" ? body.baselineId : null,
      formats: body.formats, expiresAt: days ? new Date(Date.now() + days * 86400_000) : null,
      passwordHash: body.password ? await hashPassword(body.password) : null,
      maxDownloads: body.maxDownloads ?? null, note: body.note ?? null, createdBy: user.id,
    }).returning();
    await logAudit(ctx, req, "share.created", { vaultId: item.vaultId, itemId: item.id, details: { shareId: s!.id, target: body.target, formats: body.formats, expiresInDays: days, password: !!body.password } });
    return { id: s!.id, url: `${ctx.config.publicShareUrl || originOf(ctx, req)}/s/${token}` };
  });

  app.get<{ Querystring: { all?: string; itemId?: string } }>("/shares", async (req) => {
    const u = requireUser(req);
    const conds = [];
    if (!(u.isAdmin && req.query.all === "1")) conds.push(eq(shareLinks.createdBy, u.id));
    if (req.query.itemId) conds.push(eq(shareLinks.itemId, req.query.itemId));
    const rows = await ctx.db.select({ s: shareLinks, number: items.number, description: items.description, vaultId: items.vaultId, by: users.name, label: baselines.label, rev: revisions.rev })
      .from(shareLinks).innerJoin(items, eq(items.id, shareLinks.itemId)).innerJoin(users, eq(users.id, shareLinks.createdBy))
      .leftJoin(baselines, eq(baselines.id, shareLinks.baselineId)).leftJoin(revisions, eq(revisions.id, shareLinks.revisionId))
      .where(conds.length ? and(...conds) : undefined).orderBy(desc(shareLinks.createdAt)).limit(500);
    return rows.map(({ s, ...r }) => ({
      id: s.id, target: s.target, formats: s.formats, expiresAt: s.expiresAt, password: !!s.passwordHash, maxDownloads: s.maxDownloads,
      downloads: s.downloads, note: s.note, createdAt: s.createdAt, revokedAt: s.revokedAt, status: shareState(s), itemId: s.itemId, ...r,
    }));
  });

  app.delete<{ Params: { id: string } }>("/shares/:id", async (req) => {
    const u = requireUser(req, { write: true });
    const [s] = await ctx.db.select().from(shareLinks).where(eq(shareLinks.id, req.params.id));
    if (!s) throw notFound();
    const item = await getItem(ctx.db, s.itemId);
    if (s.createdBy !== u.id && (await vaultRole(ctx, u, item.vaultId)) !== "admin") throw forbidden();
    await ctx.db.update(shareLinks).set({ revokedAt: new Date() }).where(and(eq(shareLinks.id, s.id), isNull(shareLinks.revokedAt)));
    await logAudit(ctx, req, "share.revoked", { vaultId: item.vaultId, itemId: item.id, details: { shareId: s.id } });
    return { ok: true };
  });

  // ---- public (no sign-in)
  const load = async (token: string) => {
    const [s] = await ctx.db.select().from(shareLinks).where(eq(shareLinks.tokenHash, sha256(token)));
    const st = shareState(s);
    if (st !== "active") throw notFound(st === "missing" ? "This link doesn't exist" : `This link is ${st.replace("_", " ")}`);
    return s!;
  };
  const checkGrant = (s: Share, grant: string | undefined) => {
    if (!s.passwordHash) return;
    if (!grant || !verifyGrant(ctx.config.sessionSecret, grant, s.id)) throw unauthorized("Password required");
  };

  app.get<{ Params: { token: string }; Querystring: { g?: string } }>("/public/shares/:token", publicLimit, async (req) => {
    const s = await load(req.params.token);
    if (s.passwordHash) {
      try { checkGrant(s, req.query.g); } catch { return { needsPassword: true }; }
    }
    const baselineId = await resolveShareBaseline(ctx, s);
    const item = await getItem(ctx.db, s.itemId);
    if (!baselineId) return { needsPassword: false, number: item.number, description: item.description, baseline: null, files: [] };
    const [row] = await ctx.db.select({ b: baselines, r: revisions, st: states }).from(baselines)
      .innerJoin(revisions, eq(revisions.id, baselines.revisionId)).innerJoin(states, eq(states.id, revisions.stateId)).where(eq(baselines.id, baselineId));
    const fls = await ctx.db.select().from(files).where(eq(files.baselineId, baselineId));
    return {
      needsPassword: false, number: item.number, description: item.description,
      baseline: { label: row!.b.label, rev: row!.r.rev, state: { name: row!.st.name, color: row!.st.color }, date: row!.b.createdAt },
      expiresAt: s.expiresAt, downloadsLeft: s.maxDownloads != null ? s.maxDownloads - s.downloads : null,
      preview: fls.find((f) => f.kind === "png")?.id ?? null,
      model: fls.find((f) => f.kind === "glb")?.id ?? null,
      files: fls.filter((f) => s.formats.includes(f.kind)).map((f) => ({ id: f.id, kind: f.kind, size: f.size })),
    };
  });

  app.post<{ Params: { token: string } }>("/public/shares/:token/unlock", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req) => {
    const s = await load(req.params.token);
    const { password } = z.object({ password: z.string().max(200) }).parse(req.body);
    if (!s.passwordHash || !(await verifyPassword(s.passwordHash, password))) {
      await logAudit(ctx, req, "share.password_failed", { itemId: s.itemId, details: { shareId: s.id } });
      throw unauthorized("Wrong password");
    }
    return { grant: signGrant(ctx.config.sessionSecret, s.id, 3600) };
  });

  app.get<{ Params: { token: string; fileId: string }; Querystring: { g?: string; download?: string } }>("/public/shares/:token/files/:fileId", publicLimit, async (req, reply) => {
    const s = await load(req.params.token);
    checkGrant(s, req.query.g);
    const baselineId = await resolveShareBaseline(ctx, s);
    const [f] = await ctx.db.select().from(files).where(and(eq(files.id, req.params.fileId), eq(files.baselineId, baselineId ?? "00000000-0000-0000-0000-000000000000")));
    if (!f) throw notFound();
    const download = req.query.download === "1";
    const previewOnly = !download && (f.kind === "png" || f.kind === "glb");
    if (!previewOnly && !s.formats.includes(f.kind)) throw forbidden("This format isn't shared");
    const item = await getItem(ctx.db, s.itemId);
    if (!previewOnly) {
      // count the download atomically against the limit
      const [ok] = await ctx.db.update(shareLinks).set({ downloads: sql`${shareLinks.downloads} + 1` })
        .where(and(eq(shareLinks.id, s.id), sql`(${shareLinks.maxDownloads} is null or ${shareLinks.downloads} < ${shareLinks.maxDownloads})`)).returning({ id: shareLinks.id });
      if (!ok) throw forbidden("The download limit is reached");
      await logAudit(ctx, req, "share.download", { vaultId: item.vaultId, itemId: item.id, details: { shareId: s.id, kind: f.kind }, actor: "share link" });
    }
    const [v] = await ctx.db.select().from(vaults).where(eq(vaults.id, item.vaultId));
    reply.header("cache-control", "no-store");
    return sendVaultFile(reply, rootOf(ctx, v!), f, !previewOnly);
  });
}
