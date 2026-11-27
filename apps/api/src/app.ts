import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import path from "node:path";
import { ZodError } from "zod";
import type { Ctx } from "./lib/context";
import { HttpError } from "./lib/errors";
import { resolveAuth } from "./lib/auth";
import { authRoutes } from "./routes/auth";
import { adminRoutes } from "./routes/admin";
import { vaultRoutes } from "./routes/vaults";
import { itemRoutes } from "./routes/items";
import { shareRoutes } from "./routes/shares";

export async function buildApp(ctx: Ctx, opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    // Fastify's JSON logger is unreadable in Portainer; we print one plain line per request instead.
    logger: false,
    trustProxy: ctx.config.trustProxy,
    bodyLimit: 2 * 1024 * 1024,
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'wasm-unsafe-eval'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "blob:"],
        connectSrc: ["'self'", "blob:", "data:"],
        workerSrc: ["'self'", "blob:"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: ctx.config.secureCookies ? [] : null,
      },
    },
    hsts: ctx.config.secureCookies,
    crossOriginEmbedderPolicy: false,
  });
  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  await app.register(multipart, { limits: { fileSize: ctx.config.maxUploadMb * 1024 * 1024, files: 10, fields: 20 } });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message, code: err.code });
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "), code: "validation" });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.status(status).send({ error: (err as Error).message, code: (err as { code?: string }).code });
    console.error(`${new Date().toISOString()} ERROR ${req.method} ${req.url}`, err);
    return reply.status(500).send({ error: "Internal error", code: "internal" });
  });

  app.addHook("onRequest", async (req) => {
    if (req.url.startsWith("/api/")) await resolveAuth(ctx, req);
  });

  // One short line per real request; skip health checks and static assets.
  if (opts.logger ?? true) {
    app.addHook("onResponse", async (req, reply) => {
      const url = req.url;
      if (!url.startsWith("/api/") && !url.startsWith("/s/")) return;
      const ms = Math.round(reply.elapsedTime);
      const who = req.auth?.user ? ` ${req.auth.user.email}` : "";
      console.log(`${new Date().toISOString()} ${req.method} ${url.split("?")[0]} ${reply.statusCode} ${ms}ms${who}`);
    });
  }

  app.get("/healthz", async () => {
    await ctx.db.execute("select 1" as never);
    return { ok: true };
  });

  await app.register(async (api) => {
    await authRoutes(api, ctx);
    await adminRoutes(api, ctx);
    await vaultRoutes(api, ctx);
    await itemRoutes(api, ctx);
    await shareRoutes(api, ctx);
  }, { prefix: "/api" });

  // Single-page app
  const dist = ctx.config.webDist;
  if (existsSync(path.join(dist, "index.html"))) {
    await app.register(fastifyStatic, { root: dist, index: false, wildcard: false, maxAge: "1h" });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/") || req.method !== "GET") return reply.status(404).send({ error: "Not found" });
      return reply.header("cache-control", "no-cache").sendFile("index.html");
    });
  }
  return app;
}
