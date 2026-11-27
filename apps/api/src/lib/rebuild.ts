import { and, eq, sql } from "drizzle-orm";
import { readdir, readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { baselineUses, baselines, files, items, revisions, states, vaults } from "../db/schema";
import type { Ctx } from "./context";
import { getVault, initialState, rootOf, writeItemRecord } from "./pdm";
import { safeJoin } from "./storage";

type RecordFile = {
  format: string; number: string; description: string; createdAt?: string;
  revisions: Array<{ rev: string; state: string; frozen?: boolean; baselines: Array<{ baseline: number; label: string; status?: string; author?: string; date?: string; comment?: string; files?: Record<string, string> }> }>;
};

async function sha256File(p: string) {
  return createHash("sha256").update(await readFile(p)).digest("hex");
}

/**
 * Re-import items from <vault>/<NUMBER>/<NUMBER>.json records that the database doesn't know.
 * Existing items are left alone. "Uses" are re-resolved from the native files afterwards.
 */
export async function rebuildFromDisk(ctx: Ctx, vaultId: string) {
  const v = await getVault(ctx.db, vaultId);
  const root = rootOf(ctx, v);
  const report = { scanned: 0, imported: 0, skipped: 0, errors: [] as string[] };
  let dirs: string[] = [];
  try { dirs = (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory() && !d.name.startsWith(".")).map((d) => d.name); } catch { return report; }
  const st = await ctx.db.select().from(states).where(eq(states.vaultId, vaultId));
  const init = await initialState(ctx.db, vaultId);
  let maxNumber = 0;
  for (const dir of dirs) {
    const recPath = path.join(root, dir, `${dir}.json`);
    let rec: RecordFile;
    try { rec = JSON.parse(await readFile(recPath, "utf8")); } catch { continue; }
    if (rec.format !== "plm-lite-item" || rec.number !== dir) continue;
    report.scanned++;
    const n = parseInt(rec.number.slice(v.prefix.length), 10);
    if (rec.number.startsWith(v.prefix) && n > maxNumber) maxNumber = n;
    const [exists] = await ctx.db.select({ id: items.id }).from(items).where(and(eq(items.vaultId, vaultId), eq(items.number, rec.number)));
    if (exists) { report.skipped++; continue; }
    try {
      await ctx.db.transaction(async (tx) => {
        const [item] = await tx.insert(items).values({ vaultId, number: rec.number, description: rec.description, createdAt: rec.createdAt ? new Date(rec.createdAt) : undefined }).returning();
        for (const [ri, r] of rec.revisions.entries()) {
          const state = st.find((s) => s.name === r.state) ?? init;
          const [rev] = await tx.insert(revisions).values({ itemId: item!.id, rev: r.rev, revIndex: ri, stateId: state.id, frozen: r.frozen ?? state.freezes }).returning();
          for (const b of r.baselines) {
            const [bl] = await tx.insert(baselines).values({
              revisionId: rev!.id, seq: b.baseline, label: b.label, status: b.status === "wip" ? "wip" : "checked_in",
              authorName: b.author ?? null, comment: b.comment ?? "", createdAt: b.date ? new Date(b.date) : undefined,
            }).returning();
            for (const [kind, name] of Object.entries(b.files ?? {})) {
              const rel = `${rec.number}/${name}`;
              const abs = safeJoin(root, rel);
              try {
                const s = await stat(abs);
                await tx.insert(files).values({ baselineId: bl!.id, kind, relPath: rel, size: s.size, sha256: await sha256File(abs) });
              } catch { report.errors.push(`${rec.number}: missing ${name}`); }
            }
          }
        }
      });
      report.imported++;
    } catch (e) {
      report.errors.push(`${rec.number}: ${(e as Error).message}`);
    }
  }
  await ctx.db.update(vaults).set({ nextNumber: sql`greatest(${vaults.nextNumber}, ${maxNumber + 1})` }).where(eq(vaults.id, vaultId));
  await relinkUses(ctx, vaultId);
  return report;
}

/** Recompute uses for every baseline of a vault from the stored native files. */
export async function relinkUses(ctx: Ctx, vaultId: string) {
  const { findLinkedParts } = await import("@plm/shared");
  const v = await getVault(ctx.db, vaultId);
  const root = rootOf(ctx, v);
  const rows = await ctx.db.select({ b: baselines, f: files, itemId: items.id }).from(baselines)
    .innerJoin(revisions, eq(revisions.id, baselines.revisionId))
    .innerJoin(items, eq(items.id, revisions.itemId))
    .innerJoin(files, and(eq(files.baselineId, baselines.id), eq(files.kind, "native")))
    .where(eq(items.vaultId, vaultId));
  const touched = new Set<string>();
  for (const { b, f, itemId } of rows) {
    let doc: unknown;
    try { doc = JSON.parse(await readFile(safeJoin(root, f.relPath), "utf8")); } catch { continue; }
    const { refs } = findLinkedParts(doc);
    if (!refs.length) continue;
    const agg = new Map<string, { number: string; rev: string; seq: number; count: number }>();
    for (const r of refs) {
      const k = `${r.number}_${r.rev}.${r.seq}`;
      const e = agg.get(k); if (e) e.count++; else agg.set(k, { number: r.number, rev: r.rev, seq: r.seq, count: 1 });
    }
    const uses = [];
    await ctx.db.delete(baselineUses).where(eq(baselineUses.baselineId, b.id));
    for (const e of agg.values()) {
      const [row] = await ctx.db.select({ itemId: items.id, baselineId: baselines.id, label: baselines.label }).from(items)
        .leftJoin(revisions, and(eq(revisions.itemId, items.id), eq(revisions.rev, e.rev)))
        .leftJoin(baselines, and(eq(baselines.revisionId, revisions.id), eq(baselines.seq, e.seq)))
        .where(and(eq(items.vaultId, vaultId), eq(items.number, e.number))).limit(1);
      uses.push({ ...e, baseline: row?.label ?? null, itemId: row?.itemId ?? null, baselineId: row?.baselineId ?? null });
      if (row?.itemId) {
        await ctx.db.insert(baselineUses).values({ baselineId: b.id, childItemId: row.itemId, childBaselineId: row.baselineId, count: e.count })
          .onConflictDoUpdate({ target: [baselineUses.baselineId, baselineUses.childItemId], set: { count: sql`${baselineUses.count} + ${e.count}` } });
      }
    }
    await ctx.db.update(baselines).set({ uses }).where(eq(baselines.id, b.id));
    await ctx.db.update(items).set({ type: "assembly" }).where(eq(items.id, itemId));
    touched.add(itemId);
  }
  for (const id of touched) await writeItemRecord(ctx, id);
}
