import { Table, getTableColumns, getTableName, is } from "drizzle-orm";
import { describeSyncedTables } from "./sync-rules.js";
import type { SyncRules } from "./types.js";

// Schema-evolution guards for an un-updatable fleet (rfc-production-readiness P4). A snapshot of the
// SYNCED columns is compared release-to-release: additive changes (new nullable / defaulted columns,
// new tables) are safe for old clients; drops, renames, retypes, and new NOT-NULL-without-default
// columns are breaking — an old client still expects the old shape. Used by `nizhal migrate` (T16)
// and on-device schema migration (T17).

export interface ColumnShape {
  type: string;
  notNull: boolean;
  hasDefault: boolean;
}
/** table name → column name → shape, for the synced subset of the schema. */
export type SyncedSchemaSnapshot = Record<string, Record<string, ColumnShape>>;

/** Derive the synced-column snapshot from a Drizzle schema + sync rules. */
export function syncedSchemaSnapshot(
  schema: Record<string, unknown>,
  syncRules: SyncRules,
): SyncedSchemaSnapshot {
  const synced = describeSyncedTables(syncRules);
  const snapshot: SyncedSchemaSnapshot = {};
  for (const value of Object.values(schema)) {
    if (!is(value, Table)) continue;
    const tableName = getTableName(value);
    if (!synced.has(tableName)) continue;
    const columns: Record<string, ColumnShape> = {};
    for (const column of Object.values(getTableColumns(value))) {
      const c = column as unknown as {
        name: string;
        notNull: boolean;
        hasDefault: boolean;
        getSQLType(): string;
      };
      columns[c.name] = { type: c.getSQLType(), notNull: c.notNull, hasDefault: c.hasDefault };
    }
    snapshot[tableName] = columns;
  }
  return snapshot;
}

export type BreakingKind =
  | "dropped"
  | "retyped"
  | "newColumnNotNullNoDefault"
  | "nowNotNullNoDefault";

export interface BreakingChange {
  table: string;
  column: string;
  kind: BreakingKind;
  message: string;
}

/**
 * Breaking synced-schema changes from `prev` to `next` — the shapes an un-updatable client cannot
 * survive. Empty array = fully additive (safe). New tables and new nullable/defaulted columns are
 * never breaking.
 */
export function diffSyncedSchema(
  prev: SyncedSchemaSnapshot,
  next: SyncedSchemaSnapshot,
): BreakingChange[] {
  const breaks: BreakingChange[] = [];
  const two = "ship it in two releases (add-then-remove) or pass --allow-breaking";
  for (const [table, prevColumns] of Object.entries(prev)) {
    const nextColumns = next[table];
    if (!nextColumns) continue; // whole synced table gone — a table-level change, not covered here
    for (const [column, prevShape] of Object.entries(prevColumns)) {
      const nextShape = nextColumns[column];
      if (!nextShape) {
        breaks.push({
          table,
          column,
          kind: "dropped",
          message: `synced column '${table}.${column}' was dropped or renamed — old clients still expect it; ${two}`,
        });
        continue;
      }
      if (nextShape.type !== prevShape.type) {
        breaks.push({
          table,
          column,
          kind: "retyped",
          message: `synced column '${table}.${column}' changed type ${prevShape.type} → ${nextShape.type} — old clients decode the old type; ${two}`,
        });
      }
      if (nextShape.notNull && !prevShape.notNull && !nextShape.hasDefault) {
        breaks.push({
          table,
          column,
          kind: "nowNotNullNoDefault",
          message: `synced column '${table}.${column}' became NOT NULL without a default — old clients write rows without it; add a default or ${two}`,
        });
      }
    }
  }
  for (const [table, nextColumns] of Object.entries(next)) {
    const prevColumns = prev[table];
    if (!prevColumns) continue; // new synced table — additive
    for (const [column, nextShape] of Object.entries(nextColumns)) {
      if (prevColumns[column]) continue; // existing column — handled above
      if (nextShape.notNull && !nextShape.hasDefault) {
        breaks.push({
          table,
          column,
          kind: "newColumnNotNullNoDefault",
          message: `new synced column '${table}.${column}' is NOT NULL without a default — old clients write rows without it and fail; make it nullable, give it a default, or ${two}`,
        });
      }
    }
  }
  return breaks;
}
