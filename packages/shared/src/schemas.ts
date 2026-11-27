import { z } from "zod";

export const FILE_KINDS = ["native", "step", "stl", "glb", "png", "3mf", "obj", "pdf"] as const;
export type FileKind = (typeof FILE_KINDS)[number];
export const SHAREABLE_KINDS = ["native", "step", "stl", "glb", "png", "3mf", "pdf"] as const;

export const ROLES = ["admin", "editor", "viewer"] as const;
export type VaultRole = (typeof ROLES)[number];

export const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });
export const mfaSchema = z.object({ code: z.string().min(6).max(32) });
export const setupSchema = z.object({
  setupToken: z.string().min(1),
  email: z.string().email(),
  name: z.string().min(1).max(100),
  password: z.string().min(10).max(200),
});

export const vaultCreateSchema = z.object({
  name: z.string().min(1).max(80),
  folder: z.string().regex(/^[A-Za-z0-9 _.-]+$/).refine((s) => s !== "." && s !== "..", "invalid folder"),
  prefix: z.string().regex(/^[A-Z0-9]{0,8}$/).default("AB"),
  digits: z.number().int().min(3).max(10).default(5),
  nextNumber: z.number().int().min(1).default(1),
  revScheme: z.enum(["numeric", "letters"]).default("numeric"),
  uppercaseDescriptions: z.boolean().default(true),
});
export const vaultUpdateSchema = vaultCreateSchema.omit({ folder: true }).partial();

export const stateSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().min(1).max(40),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  freezes: z.boolean(),
  isRelease: z.boolean(),
  isInitial: z.boolean(),
  allowedRoles: z.array(z.enum(ROLES)).min(1),
  transitionsTo: z.array(z.string()), // state names
});
export const lifecycleSchema = z.object({ states: z.array(stateSchema).min(1) });

export const itemCreateSchema = z.object({
  description: z.string().min(1).max(200),
  checkout: z.boolean().default(false),
  machine: z.string().max(100).optional(),
  workspacePath: z.string().max(500).optional(),
});

export const shareCreateSchema = z.object({
  target: z.enum(["baseline", "revision", "latest_released"]),
  itemId: z.string().uuid(),
  revisionId: z.string().uuid().optional(),
  baselineId: z.string().uuid().optional(),
  formats: z.array(z.enum(SHAREABLE_KINDS)).min(1),
  expiresInDays: z.number().int().min(1).max(365).nullable(),
  password: z.string().min(4).max(200).optional(),
  maxDownloads: z.number().int().min(1).max(100000).nullable().optional(),
  note: z.string().max(200).optional(),
});

export type UsesEntry = {
  number: string;
  rev: string | null;
  seq: number | null;
  baseline: string | null;
  count: number;
  itemId: string | null;
  baselineId: string | null;
};
