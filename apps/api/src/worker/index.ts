import type PgBoss from "pg-boss";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, rm, writeFile, readFile } from "node:fs/promises";
import { randomBytes, createHash } from "node:crypto";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import type { Ctx } from "../lib/context";
import { baselines, files, items, revisions, vaults } from "../db/schema";
import { attachFile, rootOf } from "../lib/pdm";
import { safeJoin } from "../lib/storage";
import { logAudit } from "../lib/audit";
import { stepToGlb } from "./glb";

export const JOBS = ["derive-glb", "backup"] as const;

export async function startWorker(ctx: Ctx, boss: PgBoss) {
  await boss.work<{ baselineId: string }>("derive-glb", async (jobs) => {
    for (const job of jobs) await deriveGlb(ctx, job.data.baselineId);
  });
  await boss.work("backup", async () => { await backup(ctx); });
  await boss.schedule("backup", ctx.config.backupCron, {}, { tz: process.env.TZ || "UTC" });
}

export async function deriveGlb(ctx: Ctx, baselineId: string) {
  const [row] = await ctx.db.select({ f: files, v: vaults, i: items }).from(files)
    .innerJoin(baselines, eq(baselines.id, files.baselineId))
    .innerJoin(revisions, eq(revisions.id, baselines.revisionId))
    .innerJoin(items, eq(items.id, revisions.itemId))
    .innerJoin(vaults, eq(vaults.id, items.vaultId))
    .where(and(eq(files.baselineId, baselineId), eq(files.kind, "step")));
  if (!row) return;
  const [hasGlb] = await ctx.db.select({ id: files.id }).from(files).where(and(eq(files.baselineId, baselineId), eq(files.kind, "glb")));
  if (hasGlb) return;
  const root = rootOf(ctx, row.v);
  const glb = await stepToGlb(await readFile(safeJoin(root, row.f.relPath)));
  const tmpDir = path.join(root, ".plm-tmp");
  await mkdir(tmpDir, { recursive: true });
  const tmpPath = path.join(tmpDir, randomBytes(8).toString("hex"));
  await writeFile(tmpPath, glb);
  await attachFile(ctx, baselineId, { kind: "glb", tmpPath, size: glb.length, sha256: createHash("sha256").update(glb).digest("hex") });
  await logAudit(ctx, null, "worker.glb_derived", { vaultId: row.v.id, itemId: row.i.id, actor: "worker", details: { baselineId, bytes: glb.length } });
}

/** pg_dump into <vaults>/.plm-backups, keeping the newest BACKUP_KEEP files. */
export async function backup(ctx: Ctx) {
  const dir = path.join(ctx.config.vaultsRoot, ".plm-backups");
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const out = path.join(dir, `plm-${stamp}.dump`);
  await new Promise<void>((resolve, reject) => {
    const p = spawn("pg_dump", ["--format=custom", "--no-owner", "--dbname", ctx.config.dbUrl], { stdio: ["ignore", "pipe", "pipe"] });
    const ws = createWriteStream(out);
    p.stdout.pipe(ws);
    let err = "";
    p.stderr.on("data", (d) => { err += d; });
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`pg_dump failed: ${err}`))));
  });
  const all = (await readdir(dir)).filter((f) => /^plm-.*\.dump$/.test(f)).sort();
  for (const old of all.slice(0, Math.max(0, all.length - ctx.config.backupKeep))) await rm(path.join(dir, old));
  await logAudit(ctx, null, "worker.backup", { actor: "worker", details: { file: path.basename(out) } });
}
