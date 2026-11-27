import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { readFile, rename, mkdir, copyFile, rm } from "node:fs/promises";
import path from "node:path";
import {
  baselineFileBase, baselineLabel, findLinkedParts, formatNumber, revLabel,
  type RevScheme, type UsesEntry,
} from "@plm/shared";
import {
  baselineUses, baselines, files, items, locks, revisions, stateHistory, states, users, vaults,
} from "../db/schema";
import type { DB, Tx } from "../db";
import type { Ctx, User } from "./context";
import { badRequest, conflict, forbidden, notFound } from "./errors";
import { safeJoin, storeBuffer, trash, vaultRoot } from "./storage";

export type Vault = typeof vaults.$inferSelect;
export type Item = typeof items.$inferSelect;
export type State = typeof states.$inferSelect;

export const EXT: Record<string, string> = {
  native: "physcad", step: "step", stl: "stl", glb: "glb", png: "png", "3mf": "3mf", obj: "obj", pdf: "pdf",
};

export const DEFAULT_STATES = [
  { name: "In work", color: "#3b82f6", freezes: false, isRelease: false, isInitial: true, allowedRoles: ["admin", "editor"], to: ["Prototype", "Released", "Obsolete"] },
  { name: "Prototype", color: "#f59e0b", freezes: true, isRelease: false, isInitial: false, allowedRoles: ["admin", "editor"], to: ["Released", "Obsolete"] },
  { name: "Released", color: "#22c55e", freezes: true, isRelease: true, isInitial: false, allowedRoles: ["admin", "editor"], to: ["Obsolete"] },
  { name: "Obsolete", color: "#6b7280", freezes: true, isRelease: false, isInitial: false, allowedRoles: ["admin"], to: [] },
] as const;

export function rootOf(ctx: Ctx, v: Vault) {
  return vaultRoot(ctx.config.vaultsRoot, v.folder);
}

export async function getVault(db: DB | Tx, id: string) {
  const [v] = await db.select().from(vaults).where(eq(vaults.id, id)).limit(1);
  if (!v) throw notFound("Vault not found");
  return v;
}
export async function getItem(db: DB | Tx, id: string) {
  const [i] = await db.select().from(items).where(eq(items.id, id)).limit(1);
  if (!i) throw notFound("Item not found");
  return i;
}

export async function createDefaultStates(db: DB | Tx, vaultId: string) {
  const rows = await db.insert(states).values(DEFAULT_STATES.map((s, i) => ({
    vaultId, name: s.name, color: s.color, sort: i, freezes: s.freezes, isRelease: s.isRelease,
    isInitial: s.isInitial, allowedRoles: [...s.allowedRoles], transitionsTo: [],
  }))).returning();
  const byName = new Map(rows.map((r) => [r.name, r.id]));
  for (const s of DEFAULT_STATES) {
    await db.update(states).set({ transitionsTo: s.to.map((n) => byName.get(n)!) }).where(eq(states.id, byName.get(s.name)!));
  }
}

export async function initialState(db: DB | Tx, vaultId: string) {
  const [s] = await db.select().from(states)
    .where(and(eq(states.vaultId, vaultId), eq(states.isInitial, true), eq(states.archived, false))).limit(1);
  if (!s) throw conflict("This vault has no initial lifecycle state");
  return s;
}

export function normalizeDescription(v: Vault, d: string) {
  const s = d.trim().replace(/\s+/g, " ");
  if (!s) throw badRequest("Description is required");
  if (v.uppercaseDescriptions) {
    const up = s.toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9 \-_.()&+/,]*$/.test(up)) {
      throw badRequest("Description may use letters, digits, spaces and - _ . ( ) & + / ,");
    }
    return up;
  }
  return s;
}

// ---------------------------------------------------------------- items

export async function createItem(ctx: Ctx, user: User, vaultId: string, input: { description: string; checkout?: boolean; machine?: string; workspacePath?: string }) {
  return ctx.db.transaction(async (tx) => {
    const v = await getVault(tx, vaultId);
    const description = normalizeDescription(v, input.description);
    const [bumped] = await tx.update(vaults).set({ nextNumber: sql`${vaults.nextNumber} + 1` })
      .where(eq(vaults.id, vaultId)).returning({ n: vaults.nextNumber });
    const number = formatNumber(v.prefix, v.digits, bumped!.n - 1);
    const st = await initialState(tx, vaultId);
    const [item] = await tx.insert(items).values({ vaultId, number, description, createdBy: user.id }).returning();
    const [rev] = await tx.insert(revisions).values({
      itemId: item!.id, rev: revLabel(0, v.revScheme), revIndex: 0, stateId: st.id, createdBy: user.id,
    }).returning();
    await tx.insert(stateHistory).values({ revisionId: rev!.id, toStateId: st.id, userId: user.id, note: "Created" });
    if (input.checkout) {
      await tx.insert(locks).values({ itemId: item!.id, userId: user.id, machine: input.machine, workspacePath: input.workspacePath });
    }
    return item!;
  });
}

async function latestRevision(db: DB | Tx, itemId: string) {
  const [r] = await db.select().from(revisions).where(eq(revisions.itemId, itemId)).orderBy(desc(revisions.revIndex)).limit(1);
  if (!r) throw conflict("Item has no revision");
  return r;
}

export async function checkout(ctx: Ctx, user: User, itemId: string, opts: { machine?: string; workspacePath?: string }) {
  return ctx.db.transaction(async (tx) => {
    await tx.execute(sql`select id from items where id = ${itemId} for update`);
    const item = await getItem(tx, itemId);
    const [lock] = await tx.select().from(locks).where(eq(locks.itemId, itemId)).limit(1);
    if (lock) {
      if (lock.userId === user.id) return { item, alreadyMine: true };
      const [holder] = await tx.select({ name: users.name }).from(users).where(eq(users.id, lock.userId));
      throw conflict(`Checked out by ${holder?.name ?? "someone else"} since ${lock.createdAt.toISOString()}`, "locked");
    }
    const rev = await latestRevision(tx, itemId);
    if (rev.frozen) throw conflict(`Revision ${rev.rev} is frozen: use Revise to start the next revision`, "frozen");
    await tx.insert(locks).values({ itemId, userId: user.id, machine: opts.machine, workspacePath: opts.workspacePath });
    return { item, alreadyMine: false };
  });
}

async function requireMyLock(tx: Tx, itemId: string, user: User) {
  await tx.execute(sql`select id from items where id = ${itemId} for update`);
  const [lock] = await tx.select().from(locks).where(eq(locks.itemId, itemId)).limit(1);
  if (!lock) throw conflict("Check the item out first", "not_checked_out");
  if (lock.userId !== user.id) throw conflict("Checked out by someone else", "locked");
  return lock;
}

export type IncomingFile = { kind: string; tmpPath: string; size: number; sha256: string };

async function resolveUses(tx: Tx, vaultId: string, nativeAbs: string | null): Promise<UsesEntry[]> {
  if (!nativeAbs) return [];
  let doc: unknown;
  try { doc = JSON.parse(await readFile(nativeAbs, "utf8")); } catch { return []; }
  const { refs } = findLinkedParts(doc);
  const agg = new Map<string, UsesEntry>();
  for (const r of refs) {
    const key = `${r.number}_${r.rev}.${r.seq}`;
    const e = agg.get(key);
    if (e) { e.count++; continue; }
    agg.set(key, { number: r.number, rev: r.rev, seq: r.seq, baseline: null, count: 1, itemId: null, baselineId: null });
  }
  for (const e of agg.values()) {
    const [row] = await tx.select({ itemId: items.id, baselineId: baselines.id, label: baselines.label })
      .from(items)
      .leftJoin(revisions, and(eq(revisions.itemId, items.id), eq(revisions.rev, e.rev!)))
      .leftJoin(baselines, and(eq(baselines.revisionId, revisions.id), eq(baselines.seq, e.seq!)))
      .where(and(eq(items.vaultId, vaultId), eq(items.number, e.number))).limit(1);
    if (row) { e.itemId = row.itemId; e.baselineId = row.baselineId; e.baseline = row.label; }
  }
  return [...agg.values()];
}

/**
 * Record a new baseline from uploaded files (already streamed to temp files).
 * `checkin` makes it the checked-in baseline and releases the lock.
 */
export async function addBaseline(ctx: Ctx, user: User, itemId: string, incoming: IncomingFile[], opts: { comment?: string; checkin?: boolean; keepLock?: boolean }) {
  const native = incoming.find((f) => f.kind === "native");
  if (!native) throw badRequest("A native .physcad file is required");
  for (const f of incoming) if (!EXT[f.kind]) throw badRequest(`Unknown file kind ${f.kind}`);
  if (opts.checkin && !opts.comment?.trim()) throw badRequest("A check-in comment is required");

  const result = await ctx.db.transaction(async (tx) => {
    const lock = await requireMyLock(tx, itemId, user);
    const item = await getItem(tx, itemId);
    const v = await getVault(tx, item.vaultId);
    const root = rootOf(ctx, v);
    const rev = await latestRevision(tx, itemId);
    if (rev.frozen) throw conflict(`Revision ${rev.rev} is frozen`, "frozen");

    const [last] = await tx.select().from(baselines).where(eq(baselines.revisionId, rev.id)).orderBy(desc(baselines.seq)).limit(1);
    if (last && !opts.checkin) {
      const [lastNative] = await tx.select().from(files).where(and(eq(files.baselineId, last.id), eq(files.kind, "native")));
      if (lastNative?.sha256 === native.sha256) return { unchanged: true as const, item, baseline: last };
    }
    const seq = (last?.seq ?? 0) + 1;
    if (v.revScheme === "numeric" && seq > 999) throw conflict(`Revision ${rev.rev} has 999 baselines`);
    const label = baselineLabel(rev.rev, seq, v.revScheme);
    const uses = await resolveUses(tx, v.id, native.tmpPath);
    const [b] = await tx.insert(baselines).values({
      revisionId: rev.id, seq, label, status: opts.checkin ? "checked_in" : "wip",
      authorId: user.id, authorName: user.name, comment: opts.comment?.trim() ?? "", uses,
    }).returning();
    const base = baselineFileBase(item.number, rev.rev, seq, v.revScheme);
    for (const f of incoming) {
      const rel = `${item.number}/${base}.${EXT[f.kind]}`;
      const abs = safeJoin(root, rel);
      await mkdir(path.dirname(abs), { recursive: true });
      await rename(f.tmpPath, abs);
      await tx.insert(files).values({ baselineId: b!.id, kind: f.kind, relPath: rel, size: f.size, sha256: f.sha256 });
    }
    for (const u of uses) {
      if (!u.itemId) continue;
      await tx.insert(baselineUses).values({ baselineId: b!.id, childItemId: u.itemId, childBaselineId: u.baselineId, count: u.count })
        .onConflictDoUpdate({ target: [baselineUses.baselineId, baselineUses.childItemId], set: { count: sql`${baselineUses.count} + ${u.count}` } });
    }
    await tx.update(items).set({ type: uses.length ? "assembly" : "part", updatedAt: new Date() }).where(eq(items.id, itemId));
    if (opts.checkin && !opts.keepLock) await tx.delete(locks).where(eq(locks.itemId, lock.itemId));
    return { unchanged: false as const, item, baseline: b!, vault: v };
  });
  if (result.unchanged) for (const f of incoming) await rm(f.tmpPath, { force: true });
  else await writeItemRecord(ctx, itemId);
  return result;
}

/** Attach derived files (STEP/GLB/PNG…) to an existing baseline: agent or worker. */
export async function attachFile(ctx: Ctx, baselineId: string, f: IncomingFile) {
  if (!EXT[f.kind] || f.kind === "native") throw badRequest("Only derived files can be attached");
  const [row] = await ctx.db.select({ b: baselines, r: revisions, i: items, v: vaults }).from(baselines)
    .innerJoin(revisions, eq(revisions.id, baselines.revisionId))
    .innerJoin(items, eq(items.id, revisions.itemId))
    .innerJoin(vaults, eq(vaults.id, items.vaultId))
    .where(eq(baselines.id, baselineId));
  if (!row) throw notFound("Baseline not found");
  const base = baselineFileBase(row.i.number, row.r.rev, row.b.seq, row.v.revScheme);
  const rel = `${row.i.number}/${base}.${EXT[f.kind]}`;
  const abs = safeJoin(rootOf(ctx, row.v), rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await rename(f.tmpPath, abs);
  await ctx.db.insert(files).values({ baselineId, kind: f.kind, relPath: rel, size: f.size, sha256: f.sha256 })
    .onConflictDoUpdate({ target: [files.baselineId, files.kind], set: { size: f.size, sha256: f.sha256, relPath: rel, createdAt: new Date() } });
  return row;
}

export async function checkin(ctx: Ctx, user: User, itemId: string, comment: string) {
  if (!comment.trim()) throw badRequest("A check-in comment is required");
  const r = await ctx.db.transaction(async (tx) => {
    const lock = await requireMyLock(tx, itemId, user);
    const rev = await latestRevision(tx, itemId);
    const [wip] = await tx.select().from(baselines)
      .where(and(eq(baselines.revisionId, rev.id), eq(baselines.status, "wip"), gt(baselines.createdAt, lock.createdAt)))
      .orderBy(desc(baselines.seq)).limit(1);
    if (wip) {
      await tx.update(baselines).set({ status: "checked_in", comment: comment.trim() }).where(eq(baselines.id, wip.id));
    }
    await tx.delete(locks).where(eq(locks.itemId, itemId));
    return { baseline: wip ? { ...wip, status: "checked_in" as const } : null };
  });
  await writeItemRecord(ctx, itemId);
  return r;
}

/** Releases the lock and discards the baselines made during this check-out. */
export async function cancelCheckout(ctx: Ctx, user: User | null, itemId: string) {
  const discarded = await ctx.db.transaction(async (tx) => {
    await tx.execute(sql`select id from items where id = ${itemId} for update`);
    const [lock] = await tx.select().from(locks).where(eq(locks.itemId, itemId)).limit(1);
    if (!lock) throw conflict("Not checked out", "not_checked_out");
    if (user && lock.userId !== user.id) throw forbidden("Checked out by someone else");
    const item = await getItem(tx, itemId);
    const v = await getVault(tx, item.vaultId);
    const revs = await tx.select().from(revisions).where(eq(revisions.itemId, itemId));
    const revIds = revs.map((r) => r.id);
    const wips = revIds.length ? await tx.select().from(baselines)
      .where(and(inArray(baselines.revisionId, revIds), eq(baselines.status, "wip"), gt(baselines.createdAt, lock.createdAt))) : [];
    const rels: string[] = [];
    if (wips.length) {
      const fs = await tx.select().from(files).where(inArray(files.baselineId, wips.map((w) => w.id)));
      rels.push(...fs.map((f) => f.relPath));
      await tx.delete(baselines).where(inArray(baselines.id, wips.map((w) => w.id)));
    }
    // A revision started by Revise that now has nothing in it goes away too.
    for (const r of revs.filter((r) => r.revIndex > 0)) {
      const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(baselines).where(eq(baselines.revisionId, r.id));
      if (n === 0) await tx.delete(revisions).where(eq(revisions.id, r.id));
    }
    await tx.delete(locks).where(eq(locks.itemId, itemId));
    return { root: rootOf(ctx, v), rels, count: wips.length };
  });
  for (const rel of discarded.rels) await trash(discarded.root, rel);
  await writeItemRecord(ctx, itemId);
  return { discarded: discarded.count };
}

export async function revise(ctx: Ctx, user: User, itemId: string, opts: { machine?: string; workspacePath?: string }) {
  const r = await ctx.db.transaction(async (tx) => {
    await tx.execute(sql`select id from items where id = ${itemId} for update`);
    const item = await getItem(tx, itemId);
    const v = await getVault(tx, item.vaultId);
    const [lock] = await tx.select().from(locks).where(eq(locks.itemId, itemId)).limit(1);
    if (lock) throw conflict("The item is checked out", "locked");
    const prev = await latestRevision(tx, itemId);
    if (!prev.frozen) throw conflict(`Revision ${prev.rev} isn't frozen: check it out instead`);
    const [src] = await tx.select().from(baselines)
      .where(and(eq(baselines.revisionId, prev.id), eq(baselines.status, "checked_in"))).orderBy(desc(baselines.seq)).limit(1);
    const st = await initialState(tx, v.id);
    const revName = revLabel(prev.revIndex + 1, v.revScheme);
    const [rev] = await tx.insert(revisions).values({ itemId, rev: revName, revIndex: prev.revIndex + 1, stateId: st.id, createdBy: user.id }).returning();
    await tx.insert(stateHistory).values({ revisionId: rev!.id, toStateId: st.id, userId: user.id, note: `Revised from ${prev.rev}` });
    const [newLock] = await tx.insert(locks).values({ itemId, userId: user.id, machine: opts.machine, workspacePath: opts.workspacePath }).returning();
    let baseline = null;
    if (src) {
      const [srcNative] = await tx.select().from(files).where(and(eq(files.baselineId, src.id), eq(files.kind, "native")));
      if (srcNative) {
        const label = baselineLabel(revName, 1, v.revScheme);
        // Created just after the lock so Cancel check-out discards it with the revision.
        const [b] = await tx.insert(baselines).values({
          revisionId: rev!.id, seq: 1, label, status: "wip", authorId: user.id, authorName: user.name,
          comment: `Revised from ${src.label}`, uses: src.uses, createdAt: new Date(newLock!.createdAt.getTime() + 1),
        }).returning();
        const root = rootOf(ctx, v);
        const rel = `${item.number}/${baselineFileBase(item.number, revName, 1, v.revScheme)}.physcad`;
        await mkdir(path.dirname(safeJoin(root, rel)), { recursive: true });
        await copyFile(safeJoin(root, srcNative.relPath), safeJoin(root, rel));
        await tx.insert(files).values({ baselineId: b!.id, kind: "native", relPath: rel, size: srcNative.size, sha256: srcNative.sha256 });
        const su = await tx.select().from(baselineUses).where(eq(baselineUses.baselineId, src.id));
        if (su.length) await tx.insert(baselineUses).values(su.map((u) => ({ ...u, baselineId: b!.id })));
        baseline = b!;
      }
    }
    return { revision: rev!, baseline };
  });
  await writeItemRecord(ctx, itemId);
  return r;
}

export async function changeState(ctx: Ctx, user: User, role: string, revisionId: string, toStateId: string, note: string) {
  if (!note.trim()) throw badRequest("A note is required");
  const r = await ctx.db.transaction(async (tx) => {
    await tx.execute(sql`select id from revisions where id = ${revisionId} for update`);
    const [rev] = await tx.select().from(revisions).where(eq(revisions.id, revisionId));
    if (!rev) throw notFound("Revision not found");
    const [from] = await tx.select().from(states).where(eq(states.id, rev.stateId));
    const [to] = await tx.select().from(states).where(eq(states.id, toStateId));
    const item = await getItem(tx, rev.itemId);
    if (!to || to.vaultId !== item.vaultId || to.archived) throw badRequest("Unknown state");
    if (!from!.transitionsTo.includes(to.id)) throw conflict(`${from!.name} → ${to.name} isn't an allowed transition`);
    if (role !== "admin" && !to.allowedRoles.includes(role as never)) throw forbidden(`Your role can't set ${to.name}`);
    if (to.freezes) {
      const [lock] = await tx.select().from(locks).where(eq(locks.itemId, rev.itemId));
      const latest = await latestRevision(tx, rev.itemId);
      if (lock && latest.id === rev.id) throw conflict("Check the item in before changing this revision's state", "locked");
      const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(baselines)
        .where(and(eq(baselines.revisionId, rev.id), eq(baselines.status, "checked_in")));
      if (n === 0) throw conflict("The revision has no checked-in baseline yet");
    }
    await tx.update(revisions).set({ stateId: to.id, frozen: to.freezes || rev.frozen }).where(eq(revisions.id, rev.id));
    await tx.insert(stateHistory).values({ revisionId: rev.id, fromStateId: from!.id, toStateId: to.id, userId: user.id, note: note.trim() });
    return { item, rev, from: from!, to };
  });
  await writeItemRecord(ctx, r.item.id);
  return r;
}

// ---------------------------------------------------------------- reading

export async function itemDetail(db: DB, itemId: string) {
  const item = await getItem(db, itemId);
  const v = await getVault(db, item.vaultId);
  const sts = await db.select().from(states).where(eq(states.vaultId, v.id)).orderBy(asc(states.sort));
  const stateById = new Map(sts.map((s) => [s.id, s]));
  const [lockRow] = await db.select({ l: locks, name: users.name }).from(locks).innerJoin(users, eq(users.id, locks.userId)).where(eq(locks.itemId, itemId));
  const revs = await db.select().from(revisions).where(eq(revisions.itemId, itemId)).orderBy(desc(revisions.revIndex));
  const revIds = revs.map((r) => r.id);
  const bls = revIds.length ? await db.select().from(baselines).where(inArray(baselines.revisionId, revIds)).orderBy(desc(baselines.seq)) : [];
  const fls = bls.length ? await db.select().from(files).where(inArray(files.baselineId, bls.map((b) => b.id))) : [];
  const hist = revIds.length ? await db.select({ h: stateHistory, name: users.name }).from(stateHistory)
    .leftJoin(users, eq(users.id, stateHistory.userId)).where(inArray(stateHistory.revisionId, revIds)).orderBy(desc(stateHistory.at)) : [];
  const revisionsOut = revs.map((r) => ({
    id: r.id, rev: r.rev, frozen: r.frozen, createdAt: r.createdAt, state: pickState(stateById.get(r.stateId)!),
    history: hist.filter((h) => h.h.revisionId === r.id).map((h) => ({
      at: h.h.at, by: h.name, note: h.h.note,
      from: h.h.fromStateId ? stateById.get(h.h.fromStateId)?.name ?? null : null,
      to: stateById.get(h.h.toStateId)?.name ?? "?",
    })),
    baselines: bls.filter((b) => b.revisionId === r.id).map((b) => ({
      id: b.id, label: b.label, seq: b.seq, status: b.status, author: b.authorName, comment: b.comment,
      createdAt: b.createdAt, uses: b.uses,
      files: fls.filter((f) => f.baselineId === b.id).map((f) => ({ id: f.id, kind: f.kind, size: f.size, name: path.basename(f.relPath) })),
    })),
  }));
  const current = revisionsOut.flatMap((r) => r.baselines).find((b) => b.status === "checked_in") ?? null;
  const released = revisionsOut.find((r) => r.state.isRelease)?.baselines.find((b) => b.status === "checked_in") ?? null;
  const latestAny = revisionsOut[0]?.baselines[0] ?? null;
  return {
    item, vault: { id: v.id, name: v.name, revScheme: v.revScheme as RevScheme },
    lock: lockRow ? { userId: lockRow.l.userId, user: lockRow.name, machine: lockRow.l.machine, since: lockRow.l.createdAt } : null,
    revisions: revisionsOut,
    current, released, latest: latestAny,
    states: sts.filter((s) => !s.archived).map(pickState),
  };
}

export function pickState(s: State) {
  return { id: s.id, name: s.name, color: s.color, freezes: s.freezes, isRelease: s.isRelease, isInitial: s.isInitial, allowedRoles: s.allowedRoles, transitionsTo: s.transitionsTo, sort: s.sort };
}

/** Write <vault>/<NUMBER>/<NUMBER>.json: a human-readable record used by "rebuild index from disk". */
export async function writeItemRecord(ctx: Ctx, itemId: string) {
  try {
    const d = await itemDetail(ctx.db, itemId);
    const v = await getVault(ctx.db, d.item.vaultId);
    const record = {
      format: "plm-lite-item", version: 1,
      number: d.item.number, description: d.item.description, type: d.item.type, createdAt: d.item.createdAt,
      revisions: [...d.revisions].reverse().map((r) => ({
        rev: r.rev, state: r.state.name, frozen: r.frozen, createdAt: r.createdAt, history: [...r.history].reverse(),
        baselines: [...r.baselines].reverse().map((b) => ({
          baseline: b.seq, label: b.label, status: b.status, author: b.author, date: b.createdAt, comment: b.comment,
          files: Object.fromEntries(b.files.map((f) => [f.kind, f.name])),
          uses: b.uses.map((u) => ({ number: u.number, rev: u.rev, baseline: u.seq, count: u.count })),
        })),
      })),
    };
    await storeBuffer(rootOf(ctx, v), `${d.item.number}/${d.item.number}.json`, JSON.stringify(record, null, 2));
  } catch (e) {
    console.error("writeItemRecord failed", itemId, e);
  }
}
