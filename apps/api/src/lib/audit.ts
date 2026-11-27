import type { FastifyRequest } from "fastify";
import { audit } from "../db/schema";
import type { Ctx } from "./context";
import type { DB, Tx } from "../db";

export async function logAudit(
  ctx: Ctx | { db: DB | Tx },
  req: FastifyRequest | null,
  action: string,
  opts: { vaultId?: string | null; itemId?: string | null; details?: Record<string, unknown>; actor?: string; userId?: string | null } = {},
) {
  const user = req?.auth?.user;
  await ctx.db.insert(audit).values({
    userId: opts.userId ?? user?.id ?? null,
    actor: opts.actor ?? (user ? user.email + (req?.auth?.token ? ` (token ${req.auth.token.name})` : "") : "anonymous"),
    action,
    vaultId: opts.vaultId ?? null,
    itemId: opts.itemId ?? null,
    details: opts.details ?? {},
    ip: req?.ip ?? null,
  });
}
