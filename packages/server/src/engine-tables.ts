import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

export const nizhalMutations = pgTable("_nizhal_mutations", {
  clientMutationId: text("client_mutation_id").primaryKey(),
  clientId: text("client_id"),
  serverId: text("server_id"),
  error: text("error"),
  appliedAt: timestamp("applied_at", { withTimezone: true }).notNull().defaultNow(),
});

export const nizhalClients = pgTable("_nizhal_clients", {
  clientId: text("client_id").primaryKey(),
  lastMutationId: bigint("last_mutation_id", { mode: "number" }).notNull().default(0),
});

export const nizhalTombstones = pgTable("_nizhal_tombstones", {
  tableName: text("table_name").notNull(),
  rowId: text("row_id").notNull(),
  clientKey: text("client_key").notNull(),
  bucketKey: text("bucket_key").notNull(),
  kind: text("kind").notNull().default("tombstone"),
  rowVersion: bigint("row_version", { mode: "bigint" }).notNull(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }).notNull().defaultNow(),
});

export const nizhalSyncControl = pgTable("_nizhal_sync_control", {
  id: boolean("id").primaryKey().default(true),
  suppressNotify: boolean("suppress_notify").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const nizhalClientBuckets = pgTable("_nizhal_client_buckets", {
  clientId: text("client_id").notNull(),
  bucketKey: text("bucket_key").notNull(),
  lastSeenCursor: bigint("last_seen_cursor", { mode: "bigint" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const nizhalJobs = pgTable("_nizhal_jobs", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  taskSlug: text("task_slug").notNull(),
  input: jsonb("input").notNull(),
  status: text("status").notNull().default("queued"),
  attempts: integer("attempts").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull().default(3),
  runAt: timestamp("run_at", { withTimezone: true }).notNull().defaultNow(),
  lockedAt: timestamp("locked_at", { withTimezone: true }),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const nizhalAuditLog = pgTable("_nizhal_audit_log", {
  rowVersion: bigint("row_version", { mode: "bigint" })
    .primaryKey()
    .default(sql`_nizhal_next_row_version()`),
  clientMutationId: text("client_mutation_id").notNull(),
  mutationName: text("mutation_name").notNull(),
  args: jsonb("args").notNull(),
  actor: jsonb("actor").notNull(),
  clientId: text("client_id"),
  mutationId: bigint("mutation_id", { mode: "number" }),
  hlc: text("hlc"),
  affectedBuckets: jsonb("affected_buckets").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
