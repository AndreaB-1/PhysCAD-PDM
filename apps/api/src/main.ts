import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";
import PgBoss from "pg-boss";
import { loadConfig } from "./config";
import { createDb, runMigrations } from "./db";
import type { Ctx } from "./lib/context";
import { buildApp } from "./app";
import { userCount } from "./routes/auth";
import { randomToken } from "./lib/crypto";
import { startWorker, JOBS } from "./worker";
import { rebuildFromDisk } from "./lib/rebuild";
import { ensureSecret } from "./lib/settings";

async function main() {
  const config = loadConfig();
  const { db, client } = createDb(config.dbUrl);
  const ctx: Ctx = { db, config };
  const migrations = fileURLToPath(new URL("../drizzle", import.meta.url));
  const [cmd, ...args] = process.argv.slice(2);

  // app and worker start together: serialise migrations and queue creation
  const startup = await client.reserve();
  await startup`select pg_advisory_lock(727001)`;
  try {
    await runMigrations(db, migrations);
  } catch (e) {
    await startup`select pg_advisory_unlock(727001)`; startup.release();
    throw e;
  }
  config.sessionSecret = await ensureSecret(db, config.sessionSecret);
  if (cmd === "migrate") { console.log("migrations applied"); await client.end(); return; }
  if (cmd === "rebuild") {
    await startup`select pg_advisory_unlock(727001)`; startup.release();
    console.log(await rebuildFromDisk(ctx, args[0]!));
    await client.end();
    return;
  }

  await mkdir(config.dataDir, { recursive: true }).catch(() => {});
  const boss = new PgBoss({ connectionString: config.dbUrl, schema: "pgboss" });
  boss.on("error", (e: unknown) => console.error("pg-boss", e));
  await boss.start();
  for (const q of JOBS) await boss.createQueue(q);
  await startup`select pg_advisory_unlock(727001)`;
  startup.release();
  ctx.enqueue = async (name, data) => { await boss.send(name, data, { retryLimit: 3, retryDelay: 30 }); };

  if (config.role === "worker" || config.role === "all") await startWorker(ctx, boss);
  if (config.role === "worker") { console.log("worker running"); return; }

  if ((await userCount(ctx)) === 0) {
    ctx.setupToken = process.env.SETUP_TOKEN || randomToken(9);
    console.log("\n==========================================================");
    console.log(" PLM Lite first run: open http://<this-server>:" + config.port + "/setup");
    console.log(" Setup token: " + ctx.setupToken);
    console.log("==========================================================\n");
  }
  const app = await buildApp(ctx);
  await app.listen({ host: "0.0.0.0", port: config.port });
  const stop = async () => { await app.close(); await boss.stop(); await client.end(); process.exit(0); };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

main().catch((e) => { console.error(e); process.exit(1); });
