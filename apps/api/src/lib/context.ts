import type { DB } from "../db";
import type { Config } from "../config";
import type { users, sessions, apiTokens } from "../db/schema";

export type User = typeof users.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type ApiToken = typeof apiTokens.$inferSelect;

export interface Ctx {
  db: DB;
  config: Config;
  enqueue?: (job: string, data: object) => Promise<void>;
  setupToken?: string | null;
}

export interface AuthInfo {
  user: User;
  session?: Session;
  token?: ApiToken;
  mfaOk: boolean;
}

declare module "fastify" {
  interface FastifyRequest {
    auth?: AuthInfo;
  }
}
