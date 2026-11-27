import type { FastifyReply, FastifyRequest } from "fastify";
import { and, eq, gt, isNull } from "drizzle-orm";
import { apiTokens, sessions, users, vaultMembers } from "../db/schema";
import { randomToken, sha256 } from "./crypto";
import { forbidden, unauthorized } from "./errors";
import type { Ctx, User } from "./context";
import type { VaultRole } from "@plm/shared";

export const SESSION_COOKIE = "plm_session";

/** The app's address: APP_URL if set, otherwise the address this request came in on. */
export function originOf(ctx: Ctx, req: FastifyRequest) {
  return ctx.config.appUrl || `${req.protocol}://${req.host}`;
}

export async function createSession(ctx: Ctx, req: FastifyRequest, reply: FastifyReply, user: User, mfaPassed: boolean) {
  const token = randomToken();
  const expiresAt = new Date(Date.now() + ctx.config.sessionMaxDays * 86400_000);
  const [s] = await ctx.db.insert(sessions).values({
    id: sha256(token), userId: user.id, csrf: randomToken(18), mfaPassed,
    ip: req.ip, userAgent: String(req.headers["user-agent"] ?? "").slice(0, 300), expiresAt,
  }).returning();
  reply.setCookie(SESSION_COOKIE, token, {
    path: "/", httpOnly: true, sameSite: "lax", secure: ctx.config.secureCookies || req.protocol === "https", expires: expiresAt,
  });
  return s!;
}

export async function resolveAuth(ctx: Ctx, req: FastifyRequest): Promise<void> {
  const authz = req.headers.authorization;
  if (authz?.startsWith("Bearer ")) {
    const raw = authz.slice(7).trim();
    const [t] = await ctx.db.select().from(apiTokens)
      .where(and(eq(apiTokens.tokenHash, sha256(raw)), isNull(apiTokens.revokedAt))).limit(1);
    if (!t) throw unauthorized("Invalid token");
    const [u] = await ctx.db.select().from(users).where(eq(users.id, t.userId)).limit(1);
    if (!u || u.disabled) throw unauthorized("Invalid token");
    await ctx.db.update(apiTokens).set({ lastUsedAt: new Date() }).where(eq(apiTokens.id, t.id));
    req.auth = { user: u, token: t, mfaOk: true };
    return;
  }
  const cookie = req.cookies?.[SESSION_COOKIE];
  if (!cookie) return;
  const id = sha256(cookie);
  const [s] = await ctx.db.select().from(sessions).where(and(eq(sessions.id, id), gt(sessions.expiresAt, new Date()))).limit(1);
  if (!s) return;
  const idleLimit = Date.now() - ctx.config.sessionIdleMinutes * 60_000;
  if (s.lastSeen.getTime() < idleLimit) {
    await ctx.db.delete(sessions).where(eq(sessions.id, id));
    return;
  }
  const [u] = await ctx.db.select().from(users).where(eq(users.id, s.userId)).limit(1);
  if (!u || u.disabled) return;
  if (Date.now() - s.lastSeen.getTime() > 60_000) {
    await ctx.db.update(sessions).set({ lastSeen: new Date() }).where(eq(sessions.id, id));
  }
  req.auth = { user: u, session: s, mfaOk: s.mfaPassed };
  // CSRF: cookie-authenticated state changes need the session's CSRF token in a header.
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    if (req.headers["x-csrf-token"] !== s.csrf) throw forbidden("Missing or invalid CSRF token");
  }
}

/** A signed-in user who has passed 2FA (or uses an API token). */
export function requireUser(req: FastifyRequest, opts: { write?: boolean } = {}): User {
  const a = req.auth;
  if (!a) throw unauthorized();
  if (!a.mfaOk) throw unauthorized("Two-factor sign-in required");
  if (opts.write && a.token && !a.token.scopes.includes("write")) throw forbidden("Token is read-only");
  return a.user;
}
export function requireAdmin(req: FastifyRequest): User {
  const u = requireUser(req);
  if (!u.isAdmin) throw forbidden("Administrators only");
  if (req.auth?.token) throw forbidden("Administration needs a browser session");
  return u;
}

const RANK: Record<VaultRole, number> = { viewer: 1, editor: 2, admin: 3 };

export async function vaultRole(ctx: Ctx, user: User, vaultId: string): Promise<VaultRole | null> {
  if (user.isAdmin) return "admin";
  const [m] = await ctx.db.select().from(vaultMembers)
    .where(and(eq(vaultMembers.vaultId, vaultId), eq(vaultMembers.userId, user.id))).limit(1);
  return m?.role ?? null;
}

export async function requireVaultRole(ctx: Ctx, req: FastifyRequest, vaultId: string, min: VaultRole) {
  const user = requireUser(req, { write: min !== "viewer" });
  const t = req.auth?.token;
  if (t?.vaultId && t.vaultId !== vaultId) throw forbidden("Token is limited to another vault");
  const role = await vaultRole(ctx, user, vaultId);
  if (!role) throw forbidden("No access to this vault");
  if (RANK[role] < RANK[min]) throw forbidden(`Needs the ${min} role in this vault`);
  return { user, role };
}
