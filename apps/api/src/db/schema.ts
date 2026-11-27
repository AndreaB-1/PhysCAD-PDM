import {
  pgTable, uuid, text, integer, boolean, timestamp, jsonb, bigserial, bigint, primaryKey, uniqueIndex, index, type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { UsesEntry } from "@plm/shared";

const id = () => uuid("id").primaryKey().default(sql`gen_random_uuid()`);
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const users = pgTable("users", {
  id: id(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
  isAdmin: boolean("is_admin").notNull().default(false),
  disabled: boolean("disabled").notNull().default(false),
  totpSecret: text("totp_secret"), // encrypted
  totpEnabled: boolean("totp_enabled").notNull().default(false),
  recoveryCodes: jsonb("recovery_codes").$type<string[]>().notNull().default([]), // sha256 hashes
  failedLogins: integer("failed_logins").notNull().default(0),
  lockedUntil: timestamp("locked_until", { withTimezone: true }),
  createdAt: createdAt(),
});

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(), // sha256(token)
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  csrf: text("csrf").notNull(),
  mfaPassed: boolean("mfa_passed").notNull().default(false),
  ip: text("ip"),
  userAgent: text("user_agent"),
  createdAt: createdAt(),
  lastSeen: timestamp("last_seen", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export const apiTokens = pgTable("api_tokens", {
  id: id(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  prefix: text("prefix").notNull(),
  scopes: jsonb("scopes").$type<("read" | "write")[]>().notNull(),
  vaultId: uuid("vault_id"),
  createdAt: createdAt(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

export const deviceCodes = pgTable("device_codes", {
  id: id(),
  deviceCodeHash: text("device_code_hash").notNull().unique(),
  userCode: text("user_code").notNull().unique(),
  clientName: text("client_name").notNull(),
  status: text("status").$type<"pending" | "approved" | "denied" | "used">().notNull().default("pending"),
  userId: uuid("user_id"),
  tokenPlain: text("token_plain"), // held only between approval and the agent's next poll
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: createdAt(),
});

export const vaults = pgTable("vaults", {
  id: id(),
  name: text("name").notNull(),
  folder: text("folder").notNull().unique(),
  prefix: text("prefix").notNull(),
  digits: integer("digits").notNull(),
  nextNumber: integer("next_number").notNull().default(1),
  revScheme: text("rev_scheme").$type<"numeric" | "letters">().notNull().default("numeric"),
  uppercaseDescriptions: boolean("uppercase_descriptions").notNull().default(true),
  createdAt: createdAt(),
});

export const vaultMembers = pgTable("vault_members", {
  vaultId: uuid("vault_id").notNull().references(() => vaults.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  role: text("role").$type<"admin" | "editor" | "viewer">().notNull(),
}, (t) => [primaryKey({ columns: [t.vaultId, t.userId] })]);

export const states = pgTable("lifecycle_states", {
  id: id(),
  vaultId: uuid("vault_id").notNull().references(() => vaults.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  color: text("color").notNull(),
  sort: integer("sort").notNull(),
  freezes: boolean("freezes").notNull().default(false),
  isRelease: boolean("is_release").notNull().default(false),
  isInitial: boolean("is_initial").notNull().default(false),
  allowedRoles: jsonb("allowed_roles").$type<("admin" | "editor" | "viewer")[]>().notNull(),
  transitionsTo: jsonb("transitions_to").$type<string[]>().notNull().default([]), // state ids
  archived: boolean("archived").notNull().default(false),
});

export const items = pgTable("items", {
  id: id(),
  vaultId: uuid("vault_id").notNull().references(() => vaults.id, { onDelete: "cascade" }),
  number: text("number").notNull(),
  description: text("description").notNull(),
  type: text("type").$type<"part" | "assembly">().notNull().default("part"),
  createdBy: uuid("created_by"),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("items_vault_number").on(t.vaultId, t.number)]);

export const locks = pgTable("locks", {
  itemId: uuid("item_id").primaryKey().references(() => items.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id),
  machine: text("machine"),
  workspacePath: text("workspace_path"),
  createdAt: createdAt(),
});

export const revisions = pgTable("revisions", {
  id: id(),
  itemId: uuid("item_id").notNull().references(() => items.id, { onDelete: "cascade" }),
  rev: text("rev").notNull(),
  revIndex: integer("rev_index").notNull(),
  stateId: uuid("state_id").notNull().references(() => states.id),
  frozen: boolean("frozen").notNull().default(false),
  createdBy: uuid("created_by"),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("revisions_item_idx").on(t.itemId, t.revIndex)]);

export const stateHistory = pgTable("state_history", {
  id: id(),
  revisionId: uuid("revision_id").notNull().references(() => revisions.id, { onDelete: "cascade" }),
  fromStateId: uuid("from_state_id"),
  toStateId: uuid("to_state_id").notNull(),
  userId: uuid("user_id"),
  note: text("note").notNull(),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
});

export const baselines = pgTable("baselines", {
  id: id(),
  revisionId: uuid("revision_id").notNull().references(() => revisions.id, { onDelete: "cascade" }),
  seq: integer("seq").notNull(),
  label: text("label").notNull(),
  status: text("status").$type<"wip" | "checked_in">().notNull(),
  authorId: uuid("author_id"),
  authorName: text("author_name"),
  comment: text("comment").notNull().default(""),
  uses: jsonb("uses").$type<UsesEntry[]>().notNull().default([]),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("baselines_rev_seq").on(t.revisionId, t.seq)]);

export const baselineUses = pgTable("baseline_uses", {
  baselineId: uuid("baseline_id").notNull().references(() => baselines.id, { onDelete: "cascade" }),
  childItemId: uuid("child_item_id").notNull().references(() => items.id, { onDelete: "cascade" }),
  childBaselineId: uuid("child_baseline_id"),
  count: integer("count").notNull().default(1),
}, (t) => [primaryKey({ columns: [t.baselineId, t.childItemId] }), index("uses_child").on(t.childItemId)]);

export const files = pgTable("files", {
  id: id(),
  baselineId: uuid("baseline_id").notNull().references(() => baselines.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  relPath: text("rel_path").notNull(), // relative to the vault root
  size: bigint("size", { mode: "number" }).notNull(),
  sha256: text("sha256").notNull(),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("files_baseline_kind").on(t.baselineId, t.kind)]);

export const shareLinks = pgTable("share_links", {
  id: id(),
  tokenHash: text("token_hash").notNull().unique(),
  target: text("target").$type<"baseline" | "revision" | "latest_released">().notNull(),
  itemId: uuid("item_id").notNull().references(() => items.id, { onDelete: "cascade" }),
  revisionId: uuid("revision_id"),
  baselineId: uuid("baseline_id"),
  formats: jsonb("formats").$type<string[]>().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  passwordHash: text("password_hash"),
  maxDownloads: integer("max_downloads"),
  downloads: integer("downloads").notNull().default(0),
  note: text("note"),
  createdBy: uuid("created_by").notNull(),
  createdAt: createdAt(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

export const audit = pgTable("audit", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  userId: uuid("user_id"),
  actor: text("actor").notNull(),
  action: text("action").notNull(),
  vaultId: uuid("vault_id"),
  itemId: uuid("item_id"),
  details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
  ip: text("ip"),
}, (t) => [index("audit_at").on(t.at), index("audit_item").on(t.itemId)]);

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
});

// ---- catalogs and projects ("collections"): folders of links to items, never copies

export const collections = pgTable("collections", {
  id: id(),
  kind: text("kind").$type<"catalog" | "project">().notNull(),
  parentId: uuid("parent_id").references((): AnyPgColumn => collections.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  color: text("color").notNull().default("#64748b"),
  /** projects only: planning | active | on_hold | done */
  status: text("status"),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("collections_parent").on(t.kind, t.parentId)]);

export const collectionItems = pgTable("collection_items", {
  collectionId: uuid("collection_id").notNull().references(() => collections.id, { onDelete: "cascade" }),
  itemId: uuid("item_id").notNull().references(() => items.id, { onDelete: "cascade" }),
  note: text("note").notNull().default(""),
  quantity: integer("quantity"),
  addedBy: uuid("added_by").references(() => users.id, { onDelete: "set null" }),
  addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.collectionId, t.itemId] }), index("collection_items_item").on(t.itemId)]);

/** Project notes: Markdown pages written in the browser. */
export const projectDocs = pgTable("project_docs", {
  id: id(),
  collectionId: uuid("collection_id").notNull().references(() => collections.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  body: text("body").notNull().default(""),
  sort: integer("sort").notNull().default(0),
  updatedBy: text("updated_by"),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Any file attached to a project (manuals, receipts, photos…), stored under <vaults>/.plm-projects/. */
export const projectFiles = pgTable("project_files", {
  id: id(),
  collectionId: uuid("collection_id").notNull().references(() => collections.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  relPath: text("rel_path").notNull(), // relative to <vaults>/.plm-projects
  size: bigint("size", { mode: "number" }).notNull(),
  sha256: text("sha256").notNull(),
  mime: text("mime").notNull().default("application/octet-stream"),
  note: text("note").notNull().default(""),
  uploadedBy: text("uploaded_by"),
  createdAt: createdAt(),
}, (t) => [index("project_files_collection").on(t.collectionId)]);
