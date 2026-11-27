import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import * as schema from "./schema";

export type DB = ReturnType<typeof createDb>["db"];
export type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];

export function createDb(url: string) {
  const client = postgres(url, { max: 10, onnotice: () => {} });
  const db = drizzle(client, { schema });
  return { db, client };
}

export async function runMigrations(db: DB, folder: string) {
  await migrate(db, { migrationsFolder: folder });
}

export { schema };
