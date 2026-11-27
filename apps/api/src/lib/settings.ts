import { eq } from "drizzle-orm";
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
export async function saveSettings(db: DB, s: AppSettings) {
  await db.insert(settings).values({ key: "app", value: s }).onConflictDoUpdate({ target: settings.key, set: { value: s } });
}
