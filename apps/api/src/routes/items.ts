import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import archiver from "archiver";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { itemCreateSchema, rewriteLinkPaths } from "@plm/shared";
import { audit, baselineUses, baselines, files, items, revisions, states, users, vaults } from "../db/schema";
import type { Ctx } from "../lib/context";
import { requireUser, requireVaultRole, vaultRole } from "../lib/auth";
import { badRequest, notFound } from "../lib/errors";
import { logAudit } from "../lib/audit";
import {
  addBaseline, attachFile, cancelCheckout, changeState, checkin, checkout, createItem, getItem, getVault, itemDetail,
  normalizeDescription, revise, rootOf, writeItemRecord,
} from "../lib/pdm";
import { cleanup, readMultipart } from "../lib/upload";
import { openRead, safeJoin } from "../lib/storage";

const agentOpts = z.object({ machine: z.string().max(100).optional(), workspacePath: z.string().max(500).optional() });

const LIST_SQL = (where: ReturnType<typeof sql>, order: ReturnType<typeof sql>, limit: number, offset: number) => sql`
  select i.id, i.number, i.description, i.type, i.updated_at as "updatedAt", i.vault_id as "vaultId",
         l.user_id as "lockUserId", lu.name as "lockUser", l.created_at as "lockSince",
         r.rev, r.frozen, s.name as "stateName", s.color as "stateColor", s.is_release as "stateIsRelease",
         cb.label as "currentLabel", lb.label as "latestLabel", lb.status as "latestStatus",
         (select f.id from files f where f.kind = 'png' and f.baseline_id = coalesce(lb.id, cb.id) limit 1) as "thumbId",
         (select f.id from files f where f.kind = 'png' and f.baseline_id = cb.id limit 1) as "thumbCurrentId",
         count(*) over() as "total"
  from items i
  left join locks l on l.item_id = i.id
  left join users lu on lu.id = l.user_id
  left join lateral (select * from revisions r where r.item_id = i.id order by r.rev_index desc limit 1) r on true
  left join lifecycle_states s on s.id = r.state_id
  left join lateral (select b.* from baselines b join revisions r2 on r2.id = b.revision_id
                     where r2.item_id = i.id and b.status = 'checked_in' order by r2.rev_index desc, b.seq desc limit 1) cb on true
  left join lateral (select b.* from baselines b where b.revision_id = r.id order by b.seq desc limit 1) lb on true
  where ${where}
  order by ${order}
  limit ${limit} offset ${offset}`;

async function itemVaultGuard(ctx: Ctx, req: FastifyRequest, itemId: string, min: "viewer" | "editor" | "admin") {
  const item = await getItem(ctx.db, itemId);
  const r = await requireVaultRole(ctx, req, item.vaultId, min);
  return { item, ...r };
}

async function baselineContext(ctx: Ctx, baselineId: string) {
  const [row] = await ctx.db.select({ b: baselines, r: revisions, i: items, v: vaults }).from(baselines)
    .innerJoin(revisions, eq(revisions.id, baselines.revisionId))
    .innerJoin(items, eq(items.id, revisions.itemId))
    .innerJoin(vaults, eq(vaults.id, items.vaultId))
    .where(eq(baselines.id, baselineId));
  if (!row) throw notFound("Baseline not found");
  return row;
}

/** All baselines needed for a pack: the root plus every pinned child, recursively. */
export async function collectPack(ctx: Ctx, rootBaselineId: string) {
  const seen = new Set<string>();
  const queue = [rootBaselineId];
  const out: { baselineId: string; native: typeof files.$inferSelect | undefined; label: string; number: string }[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const ctxRow = await baselineContext(ctx, id);
    const [native] = await ctx.db.select().from(files).where(and(eq(files.baselineId, id), eq(files.kind, "native")));
    out.push({ baselineId: id, native, label: ctxRow.b.label, number: ctxRow.i.number });
    for (const u of ctxRow.b.uses) if (u.baselineId) queue.push(u.baselineId);
  }
  return out;
}

export async function streamPack(ctx: Ctx, rootBaselineId: string) {
  const root = await baselineContext(ctx, rootBaselineId);
  const parts = await collectPack(ctx, rootBaselineId);
  const zip = archiver("zip", { zlib: { level: 6 } });
  const vaultRootDir = rootOf(ctx, root.v);
  (async () => {
    try {
      for (const p of parts) {
        if (!p.native) continue;
        const text = await readFile(safeJoin(vaultRootDir, p.native.relPath), "utf8");
        // Linked parts point at their file name: everything sits next to each other in the zip.
        let out = text;
        try { out = rewriteLinkPaths(text, (fileName) => fileName.replace(/^.*[\\/]/, "")); } catch { /* not JSON */ }
        zip.append(out, { name: path.basename(p.native.relPath) });
      }
      await zip.finalize();
    } catch (e) { zip.abort(); console.error(e); }
  })();
  return { zip, name: `${root.i.number}_${root.b.label} pack.zip`, count: parts.length, root };
}

export async function itemRoutes(app: FastifyInstance, ctx: Ctx) {
  // ---- lists and search
  app.get<{ Params: { id: string }; Querystring: Record<string, string> }>("/vaults/:id/items", async (req) => {
    await requireVaultRole(ctx, req, req.params.id, "viewer");
    const q = req.query;
    const user = req.auth!.user;
    const conds = [sql`i.vault_id = ${req.params.id}`];
    if (q.q?.trim()) {
      const like = `%${q.q.trim().replace(/[%_\\]/g, (m) => "\\" + m)}%`;
      conds.push(sql`(i.number ilike ${like} or i.description ilike ${like} or exists (
        select 1 from baselines b join revisions r3 on r3.id = b.revision_id where r3.item_id = i.id and b.comment ilike ${like}))`);
    }
    if (q.state) conds.push(sql`s.id = ${q.state}`);
    if (q.type === "part" || q.type === "assembly") conds.push(sql`i.type = ${q.type}`);
    if (q.locked === "1") conds.push(sql`l.item_id is not null`);
    if (q.mine === "1") conds.push(sql`l.user_id = ${user.id}`);
    if (q.released === "1") conds.push(sql`exists (select 1 from revisions r4 join lifecycle_states s4 on s4.id = r4.state_id where r4.item_id = i.id and s4.is_release)`);
    const sorts: Record<string, ReturnType<typeof sql>> = {
      number: sql`i.number asc`, "-number": sql`i.number desc`, description: sql`i.description asc`,
      updated: sql`i.updated_at asc`, "-updated": sql`i.updated_at desc`, state: sql`s.sort asc, i.number asc`,
    };
    const order = sorts[q.sort ?? "-updated"] ?? sorts["-updated"]!;
    const limit = Math.min(200, Number(q.limit) || 60);
    const offset = Math.max(0, Number(q.offset) || 0);
    const rows = await ctx.db.execute(LIST_SQL(sql.join(conds, sql` and `), order, limit, offset)) as unknown as Array<Record<string, unknown>>;
    return { total: Number(rows[0]?.total ?? 0), items: rows.map(({ total: _t, ...r }) => r) };
  });

  app.get("/me/checkouts", async (req) => {
    const u = requireUser(req);
    const rows = await ctx.db.execute(LIST_SQL(sql`l.user_id = ${u.id}`, sql`l.created_at desc`, 200, 0)) as unknown as Array<Record<string, unknown>>;
    return rows.map(({ total: _t, ...r }) => r);
  });

  app.get<{ Querystring: { q?: string } }>("/search", async (req) => {
    const u = requireUser(req);
    const q = (req.query.q ?? "").trim();
    if (!q) return [];
    const like = `%${q.replace(/[%_\\]/g, (m) => "\\" + m)}%`;
    const rows = await ctx.db.select({ id: items.id, number: items.number, description: items.description, vaultId: items.vaultId, vaultName: vaults.name })
      .from(items).innerJoin(vaults, eq(vaults.id, items.vaultId))
      .where(sql`${items.number} ilike ${like} or ${items.description} ilike ${like}`).orderBy(items.number).limit(50);
    const roles = new Map<string, boolean>();
    const out = [];
    for (const r of rows) {
      if (!roles.has(r.vaultId)) roles.set(r.vaultId, !!(await vaultRole(ctx, u, r.vaultId)));
      if (roles.get(r.vaultId)) out.push(r);
    }
    return out.slice(0, 20);
  });

  // ---- create
  app.post<{ Params: { id: string } }>("/vaults/:id/items", async (req) => {
    const { user } = await requireVaultRole(ctx, req, req.params.id, "editor");
    const body = itemCreateSchema.parse(req.body);
    const item = await createItem(ctx, user, req.params.id, body);
    await logAudit(ctx, req, "item.created", { vaultId: item.vaultId, itemId: item.id, details: { number: item.number, description: item.description, checkout: body.checkout } });
    await writeItemRecord(ctx, item.id);
    return item;
  });

  app.get<{ Params: { id: string } }>("/items/:id", async (req) => {
    const { role } = await itemVaultGuard(ctx, req, req.params.id, "viewer");
    return { ...(await itemDetail(ctx.db, req.params.id)), role };
  });

  app.get<{ Params: { vaultId: string; number: string } }>("/vaults/:vaultId/items/by-number/:number", async (req) => {
    const { role } = await requireVaultRole(ctx, req, req.params.vaultId, "viewer");
    const [i] = await ctx.db.select().from(items).where(and(eq(items.vaultId, req.params.vaultId), eq(items.number, req.params.number.toUpperCase())));
    if (!i) throw notFound("Item not found");
    return { ...(await itemDetail(ctx.db, i.id)), role };
  });

  app.patch<{ Params: { id: string } }>("/items/:id", async (req) => {
    const { item } = await itemVaultGuard(ctx, req, req.params.id, "editor");
    const body = z.object({ description: z.string().min(1).max(200) }).parse(req.body);
    const v = await getVault(ctx.db, item.vaultId);
    const description = normalizeDescription(v, body.description);
    await ctx.db.update(items).set({ description, updatedAt: new Date() }).where(eq(items.id, item.id));
    await logAudit(ctx, req, "item.renamed", { vaultId: item.vaultId, itemId: item.id, details: { from: item.description, to: description } });
    await writeItemRecord(ctx, item.id);
    return { ok: true, description };
  });

  // ---- workflow
  app.post<{ Params: { id: string } }>("/items/:id/checkout", async (req) => {
    const { item, user } = await itemVaultGuard(ctx, req, req.params.id, "editor");
    const opts = agentOpts.parse(req.body ?? {});
    const r = await checkout(ctx, user, item.id, opts);
    if (!r.alreadyMine) await logAudit(ctx, req, "item.checkout", { vaultId: item.vaultId, itemId: item.id, details: opts });
    return itemDetail(ctx.db, item.id);
  });

  app.post<{ Params: { id: string } }>("/items/:id/checkin", async (req) => {
    const { item, user } = await itemVaultGuard(ctx, req, req.params.id, "editor");
    const isMultipart = req.isMultipart();
    if (isMultipart) {
      const v = await getVault(ctx.db, item.vaultId);
      const { fields, incoming } = await readMultipart(req, rootOf(ctx, v));
      try {
        const r = await addBaseline(ctx, user, item.id, incoming, { comment: fields.comment, checkin: true });
        await logAudit(ctx, req, "item.checkin", { vaultId: item.vaultId, itemId: item.id, details: { baseline: r.baseline.label, comment: fields.comment } });
        return itemDetail(ctx.db, item.id);
      } catch (e) { await cleanup(incoming); throw e; }
    }
    const { comment } = z.object({ comment: z.string().min(1).max(2000) }).parse(req.body);
    const r = await checkin(ctx, user, item.id, comment);
    await logAudit(ctx, req, "item.checkin", { vaultId: item.vaultId, itemId: item.id, details: { baseline: r.baseline?.label ?? null, comment } });
    return itemDetail(ctx.db, item.id);
  });

  app.post<{ Params: { id: string } }>("/items/:id/baselines", async (req) => {
    const { item, user } = await itemVaultGuard(ctx, req, req.params.id, "editor");
    if (!req.isMultipart()) throw badRequest("Send the files as multipart/form-data (field names: native, step, glb, png, stl…)");
    const v = await getVault(ctx.db, item.vaultId);
    const { fields, incoming } = await readMultipart(req, rootOf(ctx, v));
    try {
      const r = await addBaseline(ctx, user, item.id, incoming, { comment: fields.comment, checkin: fields.checkin === "true" });
      if (r.unchanged) return { unchanged: true, baseline: { id: r.baseline.id, label: r.baseline.label } };
      await logAudit(ctx, req, fields.checkin === "true" ? "item.checkin" : "item.baseline", { vaultId: item.vaultId, itemId: item.id, details: { baseline: r.baseline.label, files: incoming.map((f) => f.kind) } });
      const step = incoming.some((f) => f.kind === "step");
      const glb = incoming.some((f) => f.kind === "glb");
      if (step && !glb && ctx.enqueue) await ctx.enqueue("derive-glb", { baselineId: r.baseline.id });
      return { unchanged: false, baseline: { id: r.baseline.id, label: r.baseline.label, status: r.baseline.status, uses: r.baseline.uses } };
    } catch (e) { await cleanup(incoming); throw e; }
  });

  app.post<{ Params: { id: string } }>("/baselines/:id/files", async (req) => {
    const row = await baselineContext(ctx, req.params.id);
    await requireVaultRole(ctx, req, row.v.id, "editor");
    if (!req.isMultipart()) throw badRequest("multipart/form-data expected");
    const { incoming } = await readMultipart(req, rootOf(ctx, row.v));
    try {
      for (const f of incoming) await attachFile(ctx, req.params.id, f);
    } catch (e) { await cleanup(incoming); throw e; }
    await logAudit(ctx, req, "baseline.files_attached", { vaultId: row.v.id, itemId: row.i.id, details: { baseline: row.b.label, kinds: incoming.map((f) => f.kind) } });
    await writeItemRecord(ctx, row.i.id);
    if (incoming.some((f) => f.kind === "step") && !incoming.some((f) => f.kind === "glb") && ctx.enqueue) {
      await ctx.enqueue("derive-glb", { baselineId: req.params.id });
    }
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/items/:id/cancel-checkout", async (req) => {
    const { item, user } = await itemVaultGuard(ctx, req, req.params.id, "editor");
    const r = await cancelCheckout(ctx, user, item.id);
    await logAudit(ctx, req, "item.cancel_checkout", { vaultId: item.vaultId, itemId: item.id, details: r });
    return { ...r, item: await itemDetail(ctx.db, item.id) };
  });

  app.post<{ Params: { id: string } }>("/items/:id/force-unlock", async (req) => {
    const { item } = await itemVaultGuard(ctx, req, req.params.id, "admin");
    const { discard } = z.object({ discard: z.boolean().default(false) }).parse(req.body ?? {});
    if (discard) {
      const r = await cancelCheckout(ctx, null, item.id);
      await logAudit(ctx, req, "item.force_unlock", { vaultId: item.vaultId, itemId: item.id, details: { discarded: r.discarded } });
    } else {
      const { locks } = await import("../db/schema");
      const [l] = await ctx.db.delete(locks).where(eq(locks.itemId, item.id)).returning();
      await logAudit(ctx, req, "item.force_unlock", { vaultId: item.vaultId, itemId: item.id, details: { heldBy: l?.userId ?? null } });
    }
    return itemDetail(ctx.db, item.id);
  });

  app.post<{ Params: { id: string } }>("/items/:id/revise", async (req) => {
    const { item, user } = await itemVaultGuard(ctx, req, req.params.id, "editor");
    const opts = agentOpts.parse(req.body ?? {});
    const r = await revise(ctx, user, item.id, opts);
    await logAudit(ctx, req, "item.revise", { vaultId: item.vaultId, itemId: item.id, details: { revision: r.revision.rev } });
    return itemDetail(ctx.db, item.id);
  });

  app.post<{ Params: { id: string } }>("/revisions/:id/state", async (req) => {
    const [rev] = await ctx.db.select().from(revisions).where(eq(revisions.id, req.params.id));
    if (!rev) throw notFound("Revision not found");
    const { item, user, role } = await itemVaultGuard(ctx, req, rev.itemId, "editor");
    const body = z.object({ stateId: z.string().uuid(), note: z.string().min(1).max(2000) }).parse(req.body);
    const r = await changeState(ctx, user, role, rev.id, body.stateId, body.note);
    await logAudit(ctx, req, "revision.state_changed", { vaultId: item.vaultId, itemId: item.id, details: { revision: rev.rev, from: r.from.name, to: r.to.name, note: body.note } });
    return itemDetail(ctx.db, item.id);
  });

  // ---- structure
  app.get<{ Params: { id: string }; Querystring: { baselineId?: string } }>("/items/:id/contains", async (req) => {
    await itemVaultGuard(ctx, req, req.params.id, "viewer");
    const detail = await itemDetail(ctx.db, req.params.id);
    const all = detail.revisions.flatMap((r) => r.baselines);
    const b = req.query.baselineId ? all.find((x) => x.id === req.query.baselineId) : (detail.latest ?? undefined);
    if (!b) return { baseline: null, children: [] };
    const childIds = [...new Set(b.uses.map((u) => u.itemId).filter(Boolean))] as string[];
    const children = [];
    const details = new Map<string, Awaited<ReturnType<typeof itemDetail>>>();
    for (const id of childIds) details.set(id, await itemDetail(ctx.db, id));
    for (const u of b.uses) {
      const d = u.itemId ? details.get(u.itemId) : undefined;
      const pinnedRev = d?.revisions.find((r) => r.rev === u.rev);
      children.push({
        ...u,
        description: d?.item.description ?? null,
        type: d?.item.type ?? null,
        pinnedState: pinnedRev?.state ?? null,
        latestCheckedIn: d?.current?.label ?? null,
        latestReleased: d?.released?.label ?? null,
        newerAvailable: !!(d?.current && u.baseline && d.current.label !== u.baseline),
        releasedAvailable: !!(d?.released && u.baseline && d.released.label !== u.baseline),
        thumbFileId: d?.revisions.flatMap((r) => r.baselines).find((x) => x.id === u.baselineId)?.files.find((f) => f.kind === "png")?.id ?? null,
      });
    }
    return { baseline: { id: b.id, label: b.label }, children };
  });

  app.get<{ Params: { id: string } }>("/items/:id/where-used", async (req) => {
    await itemVaultGuard(ctx, req, req.params.id, "viewer");
    type Node = { itemId: string; number: string; description: string; usages: { parentBaseline: string; parentBaselineId: string; status: string; rev: string; state: { name: string; color: string; freezes: boolean }; childBaseline: string | null; count: number }[]; parents: Node[] };
    const visit = async (itemId: string, depth: number, path: Set<string>): Promise<Node[]> => {
      if (depth > 12) return [];
      const rows = await ctx.db.select({
        u: baselineUses, b: baselines, r: revisions, i: items, s: states,
      }).from(baselineUses)
        .innerJoin(baselines, eq(baselines.id, baselineUses.baselineId))
        .innerJoin(revisions, eq(revisions.id, baselines.revisionId))
        .innerJoin(items, eq(items.id, revisions.itemId))
        .innerJoin(states, eq(states.id, revisions.stateId))
        .where(eq(baselineUses.childItemId, itemId))
        .orderBy(items.number, desc(revisions.revIndex), desc(baselines.seq));
      const byParent = new Map<string, Node>();
      for (const row of rows) {
        let n = byParent.get(row.i.id);
        if (!n) { n = { itemId: row.i.id, number: row.i.number, description: row.i.description, usages: [], parents: [] }; byParent.set(row.i.id, n); }
        const child = row.b.uses.find((x) => x.itemId === itemId);
        n.usages.push({ parentBaseline: row.b.label, parentBaselineId: row.b.id, status: row.b.status, rev: row.r.rev, state: { name: row.s.name, color: row.s.color, freezes: row.s.freezes }, childBaseline: child?.baseline ?? null, count: row.u.count });
      }
      for (const n of byParent.values()) {
        if (path.has(n.itemId)) continue;
        n.parents = await visit(n.itemId, depth + 1, new Set([...path, n.itemId]));
      }
      return [...byParent.values()];
    };
    return visit(req.params.id, 0, new Set([req.params.id]));
  });

  app.get<{ Params: { id: string } }>("/items/:id/activity", async (req) => {
    await itemVaultGuard(ctx, req, req.params.id, "viewer");
    return ctx.db.select().from(audit).where(eq(audit.itemId, req.params.id)).orderBy(desc(audit.id)).limit(200);
  });

  // ---- downloads
  app.get<{ Params: { id: string }; Querystring: { download?: string } }>("/files/:id", async (req, reply) => {
    const [f] = await ctx.db.select().from(files).where(eq(files.id, req.params.id));
    if (!f) throw notFound("File not found");
    const row = await baselineContext(ctx, f.baselineId);
    await requireVaultRole(ctx, req, row.v.id, "viewer");
    const download = req.query.download === "1" || f.kind === "native" || f.kind === "step";
    if (download) await logAudit(ctx, req, "file.download", { vaultId: row.v.id, itemId: row.i.id, details: { baseline: row.b.label, kind: f.kind } });
    return sendVaultFile(reply, rootOf(ctx, row.v), f, download);
  });

  app.get<{ Params: { id: string } }>("/baselines/:id/pack", async (req, reply) => {
    const row = await baselineContext(ctx, req.params.id);
    await requireVaultRole(ctx, req, row.v.id, "viewer");
    const p = await streamPack(ctx, req.params.id);
    await logAudit(ctx, req, "file.pack_and_go", { vaultId: row.v.id, itemId: row.i.id, details: { baseline: row.b.label, files: p.count } });
    reply.header("content-type", "application/zip");
    reply.header("content-disposition", `attachment; filename="${encodeURIComponent(p.name)}"`);
    return reply.send(p.zip);
  });

  app.get<{ Params: { id: string } }>("/vaults/:id/users", async (req) => {
    await requireVaultRole(ctx, req, req.params.id, "viewer");
    return ctx.db.select({ id: users.id, name: users.name }).from(users).where(eq(users.disabled, false));
  });
  void inArray;
}

const MIME: Record<string, string> = {
  native: "application/json", step: "model/step", stl: "model/stl", glb: "model/gltf-binary", png: "image/png",
  "3mf": "model/3mf", obj: "model/obj", pdf: "application/pdf",
};

export function sendVaultFile(reply: import("fastify").FastifyReply, root: string, f: typeof files.$inferSelect, download: boolean) {
  const name = path.basename(f.relPath);
  reply.header("content-type", MIME[f.kind] ?? "application/octet-stream");
  reply.header("content-length", f.size);
  reply.header("etag", `"${f.sha256}"`);
  reply.header("cache-control", "private, max-age=86400");
  reply.header("x-content-type-options", "nosniff");
  reply.header("content-disposition", `${download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(name)}`);
  return reply.send(openRead(root, f.relPath));
}
