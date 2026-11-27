
function env(name: string, def?: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") {
    if (def !== undefined) return def;
    throw new Error(`Missing environment variable ${name}`);
  }
  return v;
}

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig() {
  // Optional: without APP_URL the app uses the address the browser used to reach it.
  const appUrl = (process.env.APP_URL || "").replace(/\/$/, "");
  // Optional: without SESSION_SECRET one is generated on first start and kept in the database.
  const sessionSecret = process.env.SESSION_SECRET || "";
  if (sessionSecret && sessionSecret.length < 32) throw new Error("SESSION_SECRET must be at least 32 characters");
  const dbUrl =
    process.env.DATABASE_URL ||
    `postgres://${encodeURIComponent(env("DB_USER", "plm"))}:${encodeURIComponent(env("DB_PASSWORD", "plm"))}@${env("DB_HOST", "localhost")}:${env("DB_PORT", "5432")}/${env("DB_NAME", "plm")}`;
  return {
    role: env("ROLE", "app") as "app" | "worker" | "all",
    port: parseInt(env("PORT", "8080"), 10),
    appUrl,
    publicShareUrl: (process.env.PUBLIC_SHARE_URL || "").replace(/\/$/, ""),
    secureCookies: appUrl.startsWith("https://"),
    sessionSecret,
    dbUrl,
    vaultsRoot: env("VAULTS_ROOT", "/vaults"),
    dataDir: env("DATA_DIR", "/data"),
    adminEmail: process.env.ADMIN_EMAIL || "",
    trustProxy: env("TRUST_PROXY", "false") === "true",
    webDist: env("WEB_DIST", new URL("../../web/dist", import.meta.url).pathname),
    sessionIdleMinutes: parseInt(env("SESSION_IDLE_MINUTES", "720"), 10),
    sessionMaxDays: parseInt(env("SESSION_MAX_DAYS", "14"), 10),
    maxUploadMb: parseInt(env("MAX_UPLOAD_MB", "512"), 10),
    backupCron: env("BACKUP_CRON", "30 2 * * *"),
    backupKeep: parseInt(env("BACKUP_KEEP", "14"), 10),
  };
}
