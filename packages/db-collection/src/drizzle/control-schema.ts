import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// The client control plane lives as REAL drizzle tables in the SAME SQLite file as the synced
// tables — so optimistic apply + outbox enqueue, and pull-apply + cursor advance, each commit in
// one SQLite transaction (invariant H2 by construction; rfc-drizzle-native-sync-client T2).

export const nizhalOutbox = sqliteTable("nizhal_outbox", {
  ordinal: integer("ordinal").primaryKey({ autoIncrement: true }),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  /** The canonical mutation envelope: { name, args, clientID, hlc } (+ dependsOn separately). */
  envelope: text("envelope", { mode: "json" }).notNull().$type<{
    name: string;
    args: unknown;
    clientID: string;
    hlc?: string;
  }>(),
  dependsOn: text("depends_on"),
  enqueuedAt: integer("enqueued_at").notNull(),
});

export const nizhalMeta = sqliteTable("nizhal_meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const nizhalDeadLetter = sqliteTable("nizhal_dead_letter", {
  idempotencyKey: text("idempotency_key").primaryKey(),
  dependencyKey: text("dependency_key"),
  mutation: text("mutation", { mode: "json" }).notNull().$type<Record<string, unknown>>(),
  errorMessage: text("error_message").notNull(),
  parkedAt: integer("parked_at").notNull(),
});

export const CONTROL_TABLE_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS nizhal_outbox (
    ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
    idempotency_key TEXT NOT NULL UNIQUE,
    envelope TEXT NOT NULL,
    depends_on TEXT,
    enqueued_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS nizhal_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS nizhal_dead_letter (
    idempotency_key TEXT PRIMARY KEY,
    dependency_key TEXT,
    mutation TEXT NOT NULL,
    error_message TEXT NOT NULL,
    parked_at INTEGER NOT NULL
  )`,
];
