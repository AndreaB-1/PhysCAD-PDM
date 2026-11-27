import type { FastifyInstance } from "fastify";
import { and, count, desc, eq, isNull, ne } from "drizzle-orm";
import { authenticator } from "otplib";
import QRCode from "qrcode";
import { z } from "zod";
import { loginSchema, mfaSchema, setupSchema } from "@plm/shared";
import { apiTokens, deviceCodes, sessions, users } from "../db/schema";
import type { Ctx, User } from "../lib/context";
import { createSession, requireUser, SESSION_COOKIE } from "../lib/auth";
import { decrypt, encrypt, hashPassword, randomToken, sha256, verifyPassword } from "../lib/crypto";
import { badRequest, conflict, forbidden, unauthorized } from "../lib/errors";
import { logAudit } from "../lib/audit";
import { getSettings } from "../lib/settings";

authenticator.options = { window: 1 };

const loginLimit = { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } };

export async function userCount(ctx: Ctx) {
  const [{ n }] = await ctx.db.select({ n: count() }).from(users);
  return n;
}

export function publicUser(u: User) {
  return { id: u.id, email: u.email, name: u.name, isAdmin: u.isAdmin, totpEnabled: u.totpEnabled, disabled: u.disabled, createdAt: u.createdAt };
}

export function newRecoveryCodes() {
  const codes = Array.from({ length: 10 }, () => {
    const s = randomToken(8).replace(/[^A-Za-z0-9]/g, "").toLowerCase().padEnd(10, "x").slice(0, 10);
    return `${s.slice(0, 5)}-${s.slice(5)}`;
  });
  return { codes, hashes: codes.map((c) => sha256(c)) };
}

export function createApiToken() {
  const raw = `plm_${randomToken(30)}`;
  return { raw, hash: sha256(raw), prefix: raw.slice(0, 10) };
}

export async function authRoutes(app: FastifyInstance, ctx: Ctx) {
  // ---- first run
  app.get("/setup/status", async () => ({ needsSetup: (await userCount(ctx)) === 0, adminEmail: ctx.config.adminEmail || null }));

  app.post("/setup", loginLimit, async (req, reply) => {
    const body = setupSchema.parse(req.body);
    if ((await userCount(ctx)) > 0) throw conflict("Setup is already done");
    if (!ctx.setupToken || body.setupToken.trim() !== ctx.setupToken) throw forbidden("Wrong setup token (see the server log)");
    if (ctx.config.adminEmail && body.email.toLowerCase() !== ctx.config.adminEmail.toLowerCase()) {
      throw forbidden("Use the ADMIN_EMAIL configured for this server");
    }
    const [u] = await ctx.db.insert(users).values({
      email: body.email.toLowerCase(), name: body.name, passwordHash: await hashPassword(body.password), isAdmin: true,
    }).returning();
    ctx.setupToken = null;
    const settings = await getSettings(ctx.db);
    await createSession(ctx, req, reply, u!, !settings.mfaMandatory);
    await logAudit(ctx, req, "setup.admin_created", { userId: u!.id, actor: u!.email });
    return { ok: true, next: settings.mfaMandatory ? "enroll" : "done" };
  });

  // ---- sign-in
  app.post("/auth/login", loginLimit, async (req, reply) => {
    const body = loginSchema.parse(req.body);
    const [u] = await ctx.db.select().from(users).where(eq(users.email, body.email.toLowerCase())).limit(1);
    if (u?.lockedUntil && u.lockedUntil > new Date()) throw unauthorized("Too many failed attempts: try again later");
    const ok = u && !u.disabled && (await verifyPassword(u.passwordHash, body.password));
    if (!ok) {
      if (u) {
        const failed = u.failedLogins + 1;
        const lockedUntil = failed >= 5 ? new Date(Date.now() + Math.min(60, 2 ** (failed - 5)) * 60_000) : null;
        await ctx.db.update(users).set({ failedLogins: failed, lockedUntil }).where(eq(users.id, u.id));
      }
      await logAudit(ctx, req, "auth.login_failed", { details: { email: body.email } });
      throw unauthorized("Wrong email or password");
    }
    await ctx.db.update(users).set({ failedLogins: 0, lockedUntil: null }).where(eq(users.id, u.id));
    const settings = await getSettings(ctx.db);
    const mfaPassed = !u.totpEnabled && !settings.mfaMandatory;
    await createSession(ctx, req, reply, u, mfaPassed);
    await logAudit(ctx, req, "auth.login", { userId: u.id, actor: u.email });
    return { ok: true, next: u.totpEnabled ? "mfa" : settings.mfaMandatory ? "enroll" : "done" };
  });

  app.post("/auth/mfa", loginLimit, async (req) => {
    const a = req.auth;
    if (!a?.session) throw unauthorized();
    const { code } = mfaSchema.parse(req.body);
    const u = a.user;
    if (!u.totpEnabled || !u.totpSecret) throw badRequest("Two-factor sign-in isn't set up");
    if (u.lockedUntil && u.lockedUntil > new Date()) throw unauthorized("Too many failed attempts: try again later");
    const clean = code.trim().toLowerCase();
    let ok = /^\d{6}$/.test(clean) && authenticator.check(clean, decrypt(ctx.config.sessionSecret, u.totpSecret));
    let usedRecovery = false;
    if (!ok && u.recoveryCodes.includes(sha256(clean))) {
      ok = true; usedRecovery = true;
      await ctx.db.update(users).set({ recoveryCodes: u.recoveryCodes.filter((h) => h !== sha256(clean)) }).where(eq(users.id, u.id));
    }
    if (!ok) {
      const failed = u.failedLogins + 1;
      await ctx.db.update(users).set({ failedLogins: failed, lockedUntil: failed >= 5 ? new Date(Date.now() + 5 * 60_000) : null }).where(eq(users.id, u.id));
      throw unauthorized("Wrong code");
    }
    await ctx.db.update(users).set({ failedLogins: 0 }).where(eq(users.id, u.id));
    await ctx.db.update(sessions).set({ mfaPassed: true }).where(eq(sessions.id, a.session.id));
    if (usedRecovery) await logAudit(ctx, req, "auth.recovery_code_used");
    return { ok: true, recoveryCodesLeft: usedRecovery ? u.recoveryCodes.length - 1 : undefined };
  });

  app.post("/auth/logout", async (req, reply) => {
    if (req.auth?.session) await ctx.db.delete(sessions).where(eq(sessions.id, req.auth.session.id));
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.post("/auth/logout-everywhere", async (req, reply) => {
    const u = requireUser(req);
    await ctx.db.delete(sessions).where(eq(sessions.userId, u.id));
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    await logAudit(ctx, req, "auth.logout_everywhere");
    return { ok: true };
  });

  app.get("/auth/me", async (req) => {
    const a = req.auth;
    if (!a) return { user: null, needsSetup: (await userCount(ctx)) === 0 };
    const settings = await getSettings(ctx.db);
    return {
      user: publicUser(a.user),
      mfaOk: a.mfaOk,
      next: a.mfaOk ? "done" : a.user.totpEnabled ? "mfa" : settings.mfaMandatory ? "enroll" : "done",
      csrf: a.session?.csrf ?? null,
      recoveryCodesLeft: a.user.recoveryCodes.length,
      mfaMandatory: settings.mfaMandatory,
    };
  });

  // ---- TOTP enrolment
  app.post("/auth/totp/setup", async (req) => {
    const a = req.auth;
    if (!a?.session) throw unauthorized();
    if (a.user.totpEnabled && !a.mfaOk) throw unauthorized();
    if (a.user.totpEnabled) throw conflict("Two-factor sign-in is already on: turn it off first");
    const secret = authenticator.generateSecret(20);
    await ctx.db.update(users).set({ totpSecret: encrypt(ctx.config.sessionSecret, secret) }).where(eq(users.id, a.user.id));
    const uri = authenticator.keyuri(a.user.email, "PLM Lite", secret);
    return { secret, uri, qr: await QRCode.toDataURL(uri, { margin: 1, width: 220 }) };
  });

  app.post("/auth/totp/confirm", loginLimit, async (req) => {
    const a = req.auth;
    if (!a?.session) throw unauthorized();
    const { code } = mfaSchema.parse(req.body);
    const [u] = await ctx.db.select().from(users).where(eq(users.id, a.user.id));
    if (!u?.totpSecret || u.totpEnabled) throw badRequest("Start the setup first");
    if (!authenticator.check(code.trim(), decrypt(ctx.config.sessionSecret, u.totpSecret))) throw badRequest("Wrong code: check the time on your phone");
    const { codes, hashes } = newRecoveryCodes();
    await ctx.db.update(users).set({ totpEnabled: true, recoveryCodes: hashes }).where(eq(users.id, u.id));
    await ctx.db.update(sessions).set({ mfaPassed: true }).where(eq(sessions.id, a.session.id));
    // other sessions of this user must pass 2FA again
    await ctx.db.delete(sessions).where(and(eq(sessions.userId, u.id), ne(sessions.id, a.session.id)));
    await logAudit(ctx, req, "auth.totp_enabled");
    return { recoveryCodes: codes };
  });

  app.post("/auth/recovery-codes", async (req) => {
    const u = requireUser(req);
    if (!u.totpEnabled) throw badRequest("Two-factor sign-in isn't on");
    const { codes, hashes } = newRecoveryCodes();
    await ctx.db.update(users).set({ recoveryCodes: hashes }).where(eq(users.id, u.id));
    await logAudit(ctx, req, "auth.recovery_codes_regenerated");
    return { recoveryCodes: codes };
  });

  app.post("/auth/totp/disable", async (req) => {
    const u = requireUser(req);
    const { password } = z.object({ password: z.string() }).parse(req.body);
    if ((await getSettings(ctx.db)).mfaMandatory) throw forbidden("Two-factor sign-in is mandatory on this server");
    if (!(await verifyPassword(u.passwordHash, password))) throw unauthorized("Wrong password");
    await ctx.db.update(users).set({ totpEnabled: false, totpSecret: null, recoveryCodes: [] }).where(eq(users.id, u.id));
    await logAudit(ctx, req, "auth.totp_disabled");
    return { ok: true };
  });

  app.post("/auth/password", loginLimit, async (req) => {
    const u = requireUser(req);
    const body = z.object({ current: z.string(), next: z.string().max(200) }).parse(req.body);
    const settings = await getSettings(ctx.db);
    if (body.next.length < settings.minPasswordLength) throw badRequest(`Use at least ${settings.minPasswordLength} characters`);
    if (!(await verifyPassword(u.passwordHash, body.current))) throw unauthorized("Wrong current password");
    await ctx.db.update(users).set({ passwordHash: await hashPassword(body.next) }).where(eq(users.id, u.id));
    if (req.auth?.session) await ctx.db.delete(sessions).where(and(eq(sessions.userId, u.id), ne(sessions.id, req.auth.session.id)));
    await logAudit(ctx, req, "auth.password_changed");
    return { ok: true };
  });

  app.get("/auth/sessions", async (req) => {
    const u = requireUser(req);
    const rows = await ctx.db.select().from(sessions).where(eq(sessions.userId, u.id)).orderBy(desc(sessions.lastSeen));
    return rows.map((s) => ({ current: s.id === req.auth?.session?.id, ip: s.ip, userAgent: s.userAgent, createdAt: s.createdAt, lastSeen: s.lastSeen }));
  });

  // ---- personal access tokens
  app.get("/tokens", async (req) => {
    const u = requireUser(req);
    const rows = await ctx.db.select().from(apiTokens).where(and(eq(apiTokens.userId, u.id), isNull(apiTokens.revokedAt))).orderBy(desc(apiTokens.createdAt));
    return rows.map(({ tokenHash: _h, ...t }) => t);
  });
  app.post("/tokens", async (req) => {
    const u = requireUser(req);
    if (req.auth?.token) throw forbidden("Create tokens from the browser");
    const body = z.object({ name: z.string().min(1).max(60), scopes: z.array(z.enum(["read", "write"])).min(1), vaultId: z.string().uuid().nullable().optional() }).parse(req.body);
    const t = createApiToken();
    const [row] = await ctx.db.insert(apiTokens).values({ userId: u.id, name: body.name, tokenHash: t.hash, prefix: t.prefix, scopes: body.scopes, vaultId: body.vaultId ?? null }).returning();
    await logAudit(ctx, req, "token.created", { details: { name: body.name, scopes: body.scopes } });
    return { id: row!.id, token: t.raw };
  });
  app.delete<{ Params: { id: string } }>("/tokens/:id", async (req) => {
    const u = requireUser(req);
    await ctx.db.update(apiTokens).set({ revokedAt: new Date() }).where(and(eq(apiTokens.id, req.params.id), eq(apiTokens.userId, u.id)));
    await logAudit(ctx, req, "token.revoked", { details: { id: req.params.id } });
    return { ok: true };
  });

  // ---- device-code sign-in for the desktop agent
  app.post("/device/code", loginLimit, async (req) => {
    const { clientName } = z.object({ clientName: z.string().min(1).max(80) }).parse(req.body ?? {});
    const deviceCode = randomToken(32);
    const alphabet = "BCDFGHJKLMNPQRSTVWXZ";
    const bytes = randomToken(16);
    let userCode = "";
    for (let i = 0; i < 8; i++) userCode += alphabet[bytes.charCodeAt(i) % alphabet.length];
    userCode = `${userCode.slice(0, 4)}-${userCode.slice(4)}`;
    await ctx.db.insert(deviceCodes).values({ deviceCodeHash: sha256(deviceCode), userCode, clientName, expiresAt: new Date(Date.now() + 10 * 60_000) });
    return { deviceCode, userCode, verificationUri: `${ctx.config.appUrl}/device`, verificationUriComplete: `${ctx.config.appUrl}/device?code=${userCode}`, interval: 3, expiresIn: 600 };
  });

  app.post("/device/token", { config: { rateLimit: { max: 40, timeWindow: "1 minute" } } }, async (req, reply) => {
    const { deviceCode } = z.object({ deviceCode: z.string() }).parse(req.body);
    const [d] = await ctx.db.select().from(deviceCodes).where(eq(deviceCodes.deviceCodeHash, sha256(deviceCode)));
    if (!d || d.expiresAt < new Date() || d.status === "used") return reply.status(400).send({ error: "expired_token" });
    if (d.status === "denied") return reply.status(400).send({ error: "access_denied" });
    if (d.status === "pending") return reply.status(400).send({ error: "authorization_pending" });
    await ctx.db.update(deviceCodes).set({ status: "used", tokenPlain: null }).where(eq(deviceCodes.id, d.id));
    return { token: d.tokenPlain ? decrypt(ctx.config.sessionSecret, d.tokenPlain) : null };
  });

  app.get<{ Querystring: { code: string } }>("/device/lookup", async (req) => {
    requireUser(req);
    const [d] = await ctx.db.select().from(deviceCodes).where(eq(deviceCodes.userCode, String(req.query.code ?? "").toUpperCase().trim()));
    if (!d || d.expiresAt < new Date() || d.status !== "pending") throw badRequest("Unknown or expired code");
    return { clientName: d.clientName, createdAt: d.createdAt };
  });

  app.post("/device/approve", async (req) => {
    const u = requireUser(req);
    if (req.auth?.token) throw forbidden();
    const body = z.object({ code: z.string(), approve: z.boolean() }).parse(req.body);
    const [d] = await ctx.db.select().from(deviceCodes).where(eq(deviceCodes.userCode, body.code.toUpperCase().trim()));
    if (!d || d.expiresAt < new Date() || d.status !== "pending") throw badRequest("Unknown or expired code");
    if (!body.approve) {
      await ctx.db.update(deviceCodes).set({ status: "denied" }).where(eq(deviceCodes.id, d.id));
      return { ok: true };
    }
    const t = createApiToken();
    await ctx.db.insert(apiTokens).values({ userId: u.id, name: d.clientName, tokenHash: t.hash, prefix: t.prefix, scopes: ["read", "write"] });
    await ctx.db.update(deviceCodes).set({ status: "approved", userId: u.id, tokenPlain: encrypt(ctx.config.sessionSecret, t.raw) }).where(eq(deviceCodes.id, d.id));
    await logAudit(ctx, req, "device.approved", { details: { client: d.clientName } });
    return { ok: true };
  });
}
