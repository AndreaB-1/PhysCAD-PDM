import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { mkdir, rename, rm } from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import {
  collectionCreateSchema, collectionItemsSchema, collectionItemUpdateSchema, collectionUpdateSchema,
  projectDocSchema, projectDocUpdateSchema,
} from "@plm/shared";
import type { Ctx } from "../lib/context";
import { collectionItems, collections, items, projectDocs, projectFiles, vaultMembers, vaults, users } from "../db/schema";
import type { User } from "../lib/context";
import { requireUser } from "../lib/auth";
import { badRequest, forbidden, notFound } from "../lib/errors";
import { logAudit } from "../lib/audit";
import { cleanup, readMultipart } from "../lib/upload";
import { safeJoin } from "../lib/storage";
import { LIST_SQL } from "./items";

type Collection = typeof collections.$inferSelect;

/**
 * Catalogs and projects: nested folders of *links* to items (an item can be in any number of them, and
 * is never copied). Projects also have Markdown notes and attached files.
 * Everyone signed in can see them; the items inside are filtered by vault access. Anyone who can edit
 * in some vault (or an admin) can change them.
 */
export async function collectionRoutes(app: FastifyInstance, ctx: Ctx) {
  const filesRoot = () => path.join(ctx.config.vaultsRoot, ".plm-projects");

  /** Vault ids this user may see; null = all (admins). */
  async function visibleVaults(user: User): Promise<string[] | null> {
    if (user.isAdmin) return null;
    const rows = await ctx.db.select({ v: vaultMembers.vaultId }).from(vaultMembers).where(eq(vaultMembers.userId, user.id));
    return rows.map((r) => r.v);
  }

  async function canEdit(user: User) {
    if (user.isAdmin) return true;
    const [m] = await ctx.db.select({ r: vaultMembers.role }).from(vaultMembers)
      .where(and(eq(vaultMembers.userId, user.id), inArray(vaultMembers.role, ["editor", "admin"]))).limit(1);
    return !!m;
  }

  async function requireEditor(req: FastifyRequest) {
    const user = requireUser(req, { write: true });
    if (!(await canEdit(user))) throw forbidden("You need the editor role in a vault to change catalogs and projects");
    return user;
  }

  async function getCollection(id: string): Promise<Collection> {
    const [c] = await ctx.db.select().from(collections).where(eq(collections.id, id));
    if (!c) throw notFound("Catalog or project not found");
    return c;
  }

  async function touch(id: string) {
    await ctx.db.update(collections).set({ updatedAt: new Date() }).where(eq(collections.id, id));
  }

  /** Breadcrumbs from the top down to (and including) this collection. */
  async function pathOf(c: Collection) {
    const out = [{ id: c.id, name: c.name }];
    let parent = c.parentId;
    for (let i = 0; parent && i < 50; i++) {
      const p = await getCollection(parent);
      out.unshift({ id: p.id, name: p.name });
      parent = p.parentId;
    }
    return out;
  }

  async function checkParent(kind: string, parentId: string | null, selfId?: string) {
    if (!parentId) return;
    const p = await getCollection(parentId);
    if (p.kind !== kind) throw badRequest(`A ${kind} can only sit inside another ${kind}`);
    // no cycles: walk up from the new parent
    let cur: string | null = p.id;
    for (let i = 0; cur && i < 50; i++) {
      if (cur === selfId) throw badRequest("A folder can't go inside itself");
      cur = (await getCollection(cur)).parentId;
    }
  }

  const itemFilter = (vaultIds: string[] | null) =>
    vaultIds === null ? sql`true` : vaultIds.length ? sql`i.vault_id in (${sql.join(vaultIds.map((v) => sql`${v}`), sql`, `)})` : sql`false`;

  // ---------------------------------------------------------------- collections

  app.get<{ Querystring: { kind?: string } }>("/collections", async (req) => {
    const user = requireUser(req);
    const kind = req.query.kind === "project" ? "project" : "catalog";
    const vis = await visibleVaults(user);
    const rows = await ctx.db.execute(sql`
      select c.id, c.kind, c.parent_id as "parentId", c.name, c.description, c.color, c.status, c.updated_at as "updatedAt",
             (select count(*)::int from collection_items ci join items i on i.id = ci.item_id where ci.collection_id = c.id and ${itemFilter(vis)}) as "itemCount",
             (select count(*)::int from project_docs d where d.collection_id = c.id) as "docCount",
             (select count(*)::int from project_files f where f.collection_id = c.id) as "fileCount"
      from collections c where c.kind = ${kind} order by lower(c.name)`) as unknown as Array<Record<string, unknown>>;
    return { collections: rows, canEdit: await canEdit(user) };
  });

  app.post("/collections", async (req) => {
    const user = await requireEditor(req);
    const body = collectionCreateSchema.parse(req.body);
    await checkParent(body.kind, body.parentId);
    const [c] = await ctx.db.insert(collections).values({
      kind: body.kind, name: body.name, description: body.description, color: body.color, parentId: body.parentId,
      status: body.kind === "project" ? body.status ?? "active" : null, createdBy: user.id,
    }).returning();
    await logAudit(ctx, req, `${body.kind}.created`, { details: { id: c!.id, name: c!.name } });
    return c;
  });

  app.get<{ Params: { id: string } }>("/collections/:id", async (req) => {
    const user = requireUser(req);
    const c = await getCollection(req.params.id);
    const vis = await visibleVaults(user);
    const children = await ctx.db.execute(sql`
      select c.id, c.name, c.color, c.status, c.description,
             (select count(*)::int from collection_items ci join items i on i.id = ci.item_id where ci.collection_id = c.id and ${itemFilter(vis)}) as "itemCount"
      from collections c where c.parent_id = ${c.id} order by lower(c.name)`) as unknown as Array<Record<string, unknown>>;
    const links = await ctx.db.select().from(collectionItems).where(eq(collectionItems.collectionId, c.id));
    let itemRows: Array<Record<string, unknown>> = [];
    if (links.length) {
      const ids = links.map((l) => l.itemId);
      itemRows = await ctx.db.execute(LIST_SQL(
        sql`i.id in (${sql.join(ids.map((x) => sql`${x}`), sql`, `)}) and ${itemFilter(vis)}`, sql`i.number`, 1000, 0,
      )) as unknown as Array<Record<string, unknown>>;
    }
    const vaultNames = new Map((await ctx.db.select({ id: vaults.id, name: vaults.name }).from(vaults)).map((v) => [v.id, v.name]));
    const linkBy = new Map(links.map((l) => [l.itemId, l]));
    const itemsOut = itemRows.map(({ total: _t, ...r }) => {
      const l = linkBy.get(r.id as string)!;
      return { ...r, vaultName: vaultNames.get(r.vaultId as string) ?? "", note: l.note, quantity: l.quantity, addedAt: l.addedAt };
    });
    const extra = c.kind === "project" ? {
      docs: await ctx.db.select({ id: projectDocs.id, title: projectDocs.title, updatedAt: projectDocs.updatedAt, updatedBy: projectDocs.updatedBy, sort: projectDocs.sort })
        .from(projectDocs).where(eq(projectDocs.collectionId, c.id)).orderBy(asc(projectDocs.sort), asc(projectDocs.createdAt)),
      files: (await ctx.db.select().from(projectFiles).where(eq(projectFiles.collectionId, c.id)).orderBy(desc(projectFiles.createdAt)))
        .map(({ relPath: _p, ...f }) => f),
    } : {};
    return {
      collection: c, path: await pathOf(c), children, items: itemsOut,
      hiddenItems: links.length - itemsOut.length, canEdit: await canEdit(user), ...extra,
    };
  });

  app.patch<{ Params: { id: string } }>("/collections/:id", async (req) => {
    await requireEditor(req);
    const c = await getCollection(req.params.id);
    const body = collectionUpdateSchema.parse(req.body);
    if (body.parentId !== undefined) await checkParent(c.kind, body.parentId, c.id);
    const [u] = await ctx.db.update(collections).set({
      ...body, status: c.kind === "project" ? body.status ?? c.status : null, updatedAt: new Date(),
    }).where(eq(collections.id, c.id)).returning();
    await logAudit(ctx, req, `${c.kind}.updated`, { details: { id: c.id, name: u!.name } });
    return u;
  });

  app.delete<{ Params: { id: string } }>("/collections/:id", async (req) => {
    await requireEditor(req);
    const c = await getCollection(req.params.id);
    // Sub-folders go with it (cascade); remove their attached files from disk too.
    const tree = await ctx.db.execute(sql`
      with recursive t as (select id from collections where id = ${c.id} union all select c.id from collections c join t on c.parent_id = t.id)
      select id from t`) as unknown as Array<{ id: string }>;
    await ctx.db.delete(collections).where(eq(collections.id, c.id));
    for (const t of tree) await rm(safeJoin(filesRoot(), t.id), { recursive: true, force: true });
    await logAudit(ctx, req, `${c.kind}.deleted`, { details: { id: c.id, name: c.name, folders: tree.length } });
    return { ok: true };
  });

  // ---------------------------------------------------------------- item links

  app.post<{ Params: { id: string } }>("/collections/:id/items", async (req) => {
    const user = await requireEditor(req);
    const c = await getCollection(req.params.id);
    const body = collectionItemsSchema.parse(req.body);
    const vis = await visibleVaults(user);
    const found = await ctx.db.select({ id: items.id, vaultId: items.vaultId }).from(items).where(inArray(items.id, body.itemIds));
    const allowed = found.filter((i) => vis === null || vis.includes(i.vaultId));
    if (!allowed.length) throw notFound("No such items");
    const added = await ctx.db.insert(collectionItems)
      .values(allowed.map((i) => ({ collectionId: c.id, itemId: i.id, note: body.note ?? "", addedBy: user.id })))
      .onConflictDoNothing().returning({ itemId: collectionItems.itemId });
    await touch(c.id);
    await logAudit(ctx, req, `${c.kind}.items_added`, { details: { id: c.id, name: c.name, count: added.length } });
    return { added: added.length, alreadyThere: allowed.length - added.length };
  });

  app.patch<{ Params: { id: string; itemId: string } }>("/collections/:id/items/:itemId", async (req) => {
    await requireEditor(req);
    const body = collectionItemUpdateSchema.parse(req.body);
    const [u] = await ctx.db.update(collectionItems).set(body)
      .where(and(eq(collectionItems.collectionId, req.params.id), eq(collectionItems.itemId, req.params.itemId))).returning();
    if (!u) throw notFound("That item isn't in here");
    return u;
  });

  app.delete<{ Params: { id: string; itemId: string } }>("/collections/:id/items/:itemId", async (req) => {
    await requireEditor(req);
    const c = await getCollection(req.params.id);
    await ctx.db.delete(collectionItems).where(and(eq(collectionItems.collectionId, c.id), eq(collectionItems.itemId, req.params.itemId)));
    await touch(c.id);
    return { ok: true };
  });

  /** Catalogs and projects an item is in (shown on the item page). */
  app.get<{ Params: { id: string } }>("/items/:id/collections", async (req) => {
    requireUser(req);
    return ctx.db.select({ id: collections.id, kind: collections.kind, name: collections.name, color: collections.color })
      .from(collectionItems).innerJoin(collections, eq(collections.id, collectionItems.collectionId))
      .where(eq(collectionItems.itemId, req.params.id)).orderBy(collections.kind, collections.name);
  });

  // ---------------------------------------------------------------- project notes

  async function requireProject(id: string) {
    const c = await getCollection(id);
    if (c.kind !== "project") throw badRequest("Notes and files belong to projects");
    return c;
  }

  app.post<{ Params: { id: string } }>("/collections/:id/docs", async (req) => {
    const user = await requireEditor(req);
    const c = await requireProject(req.params.id);
    const body = projectDocSchema.parse(req.body);
    const [{ n }] = await ctx.db.execute(sql`select coalesce(max(sort), 0) + 1 as n from project_docs where collection_id = ${c.id}`) as unknown as [{ n: number }];
    const [d] = await ctx.db.insert(projectDocs).values({ collectionId: c.id, title: body.title, body: body.body, sort: Number(n), updatedBy: user.name }).returning();
    await touch(c.id);
    return d;
  });

  app.get<{ Params: { docId: string } }>("/docs/:docId", async (req) => {
    requireUser(req);
    const [d] = await ctx.db.select().from(projectDocs).where(eq(projectDocs.id, req.params.docId));
    if (!d) throw notFound("Note not found");
    return d;
  });

  app.patch<{ Params: { docId: string } }>("/docs/:docId", async (req) => {
    const user = await requireEditor(req);
    const body = projectDocUpdateSchema.parse(req.body);
    const [d] = await ctx.db.update(projectDocs).set({ ...body, updatedBy: user.name, updatedAt: new Date() })
      .where(eq(projectDocs.id, req.params.docId)).returning();
    if (!d) throw notFound("Note not found");
    await touch(d.collectionId);
    return d;
  });

  app.delete<{ Params: { docId: string } }>("/docs/:docId", async (req) => {
    await requireEditor(req);
    const [d] = await ctx.db.delete(projectDocs).where(eq(projectDocs.id, req.params.docId)).returning();
    if (d) await logAudit(ctx, req, "project.doc_deleted", { details: { project: d.collectionId, title: d.title } });
    return { ok: true };
  });

  // ---------------------------------------------------------------- project files

  app.post<{ Params: { id: string } }>("/collections/:id/files", async (req) => {
    const user = await requireEditor(req);
    const c = await requireProject(req.params.id);
    if (!req.isMultipart()) throw badRequest("Send the files as multipart/form-data");
    const root = filesRoot();
    await mkdir(root, { recursive: true });
    const { fields, incoming } = await readMultipart(req, root);
    if (!incoming.length) throw badRequest("No file received");
    const out = [];
    try {
      await mkdir(safeJoin(root, c.id), { recursive: true });
      for (const f of incoming) {
        const name = cleanName(f.fileName || "file");
        const [row] = await ctx.db.insert(projectFiles).values({
          collectionId: c.id, name, relPath: "pending", size: f.size, sha256: f.sha256,
          mime: f.mime || "application/octet-stream", note: fields.note ?? "", uploadedBy: user.name,
        }).returning();
        const rel = `${c.id}/${row!.id}-${name}`;
        await rename(f.tmpPath, safeJoin(root, rel));
        await ctx.db.update(projectFiles).set({ relPath: rel }).where(eq(projectFiles.id, row!.id));
        out.push({ id: row!.id, name, size: f.size });
      }
    } catch (e) { await cleanup(incoming); throw e; }
    await touch(c.id);
    await logAudit(ctx, req, "project.files_uploaded", { details: { project: c.id, files: out.map((f) => f.name) } });
    return { files: out };
  });

  app.get<{ Params: { fileId: string }; Querystring: { download?: string } }>("/project-files/:fileId", async (req, reply) => {
    requireUser(req);
    const [f] = await ctx.db.select().from(projectFiles).where(eq(projectFiles.id, req.params.fileId));
    if (!f) throw notFound("File not found");
    // Only show pictures, PDFs and plain text in the browser; everything else downloads (no HTML from uploads).
    const inlineOk = /^(image\/(png|jpeg|gif|webp)|application\/pdf|text\/plain)$/.test(f.mime);
    const inline = inlineOk && req.query.download !== "1";
    reply.header("content-type", inlineOk ? f.mime : "application/octet-stream");
    reply.header("content-length", f.size);
    reply.header("x-content-type-options", "nosniff");
    reply.header("content-security-policy", "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox");
    reply.header("cache-control", "private, max-age=3600");
    reply.header("content-disposition", `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(f.name)}`);
    return reply.send(createReadStream(safeJoin(filesRoot(), f.relPath)));
  });

  app.patch<{ Params: { fileId: string } }>("/project-files/:fileId", async (req) => {
    await requireEditor(req);
    const body = (req.body ?? {}) as { note?: unknown; name?: unknown };
    const set: Partial<typeof projectFiles.$inferInsert> = {};
    if (typeof body.note === "string") set.note = body.note.slice(0, 500);
    if (typeof body.name === "string" && body.name.trim()) set.name = cleanName(body.name);
    const [f] = await ctx.db.update(projectFiles).set(set).where(eq(projectFiles.id, req.params.fileId)).returning();
    if (!f) throw notFound("File not found");
    const { relPath: _p, ...rest } = f;
    return rest;
  });

  app.delete<{ Params: { fileId: string } }>("/project-files/:fileId", async (req) => {
    await requireEditor(req);
    const [f] = await ctx.db.delete(projectFiles).where(eq(projectFiles.id, req.params.fileId)).returning();
    if (f) {
      await rm(safeJoin(filesRoot(), f.relPath), { force: true });
      await logAudit(ctx, req, "project.file_deleted", { details: { project: f.collectionId, name: f.name } });
    }
    return { ok: true };
  });

  void users;
}

/** A safe file name: no folders, no control characters. */
function cleanName(name: string) {
  const base = name.replace(/^.*[\\/]/, "").replace(/[\u0000-\u001f<>:"|?*]/g, "_").trim().slice(0, 150);
  return base && base !== "." && base !== ".." ? base : "file";
}
