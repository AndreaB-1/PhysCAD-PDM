import { eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { settings } from "../db/schema";
import type { DB } from "../db";

export type AppSettings = {
  mfaMandatory: boolean;
  shareDefaults: { formats: string[]; expiresInDays: number | null; requirePassword: boolean; maxExpiryDays: number };
  minPasswordLength: number;
};
export const DEFAULT_SETTINGS: AppSettings = {
  mfaMandatory: true,
  shareDefaults: { formats: ["step", "png"], expiresInDays: 14, requirePassword: false, maxExpiryDays: 90 },
  minPasswordLength: 10,
};

export async function getSettings(db: DB): Promise<AppSettings> {
  const [row] = await db.select().from(settings).where(eq(settings.key, "app"));
  return { ...DEFAULT_SETTINGS, ...((row?.value as Partial<AppSettings>) ?? {}) };
}
/** The secret that signs grants and encrypts 2FA keys: SESSION_SECRET, or one generated once and kept in the database. */
export async function ensureSecret(db: DB, fromEnv: string): Promise<string> {
  if (fromEnv) return fromEnv;
  const [row] = await db.select().from(settings).where(eq(settings.key, "secret"));
  if (row) return row.value as string;
  const secret = randomBytes(32).toString("hex");
  await db.insert(settings).values({ key: "secret", value: secret }).onConflictDoNothing();
  const [again] = await db.select().from(settings).where(eq(settings.key, "secret"));
  return again!.value as string;
}

export async function saveSettings(db: DB, s: AppSettings) {
  await db.insert(settings).values({ key: "app", value: s }).onConflictDoUpdate({ target: settings.key, set: { value: s } });
}
