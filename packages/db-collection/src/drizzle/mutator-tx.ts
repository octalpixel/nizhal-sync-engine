import type { Actor, JobScheduler, MutatorTx } from "@nizhal/kernel";
import { and, eq, getTableColumns, getTableName, sql } from "drizzle-orm";
import type { SQLWrapper } from "drizzle-orm";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import type { Table } from "drizzle-orm/table";
import { safeRandomUUID } from "../client.js";
import type { AnyDrizzleSqliteDb, DerivedTableMap } from "./types.js";

// The client-side MutatorTx over REAL derived sqlite tables. Mutator functions are written
// against the PG schema tables; we resolve each to its derived twin by SQL table name and write
// with drizzle. Inserts are upserts on purpose: replay-rebase (pull.ts) re-runs pending outbox
// mutations after authoritative rows land, so every write must be idempotent under re-execution.

function derivedFor(tables: DerivedTableMap, table: Table): SQLiteTable {
  const name = getTableName(table);
  const derived = tables[name];
  if (!derived) {
    throw new Error(`[@nizhal/db-collection] no derived client table for '${name}'`);
  }
  return derived;
}

function columnsOf(table: SQLiteTable): Record<string, SQLiteColumn> {
  return getTableColumns(table) as Record<string, SQLiteColumn>;
}

function wherePredicate(
  table: SQLiteTable,
  where: Record<string, unknown>,
): SQLWrapper | undefined {
  const columns = columnsOf(table);
  const clauses = Object.entries(where).map(([field, value]) => {
    const column = columns[field];
    if (!column) {
      throw new Error(
        `[@nizhal/db-collection] structured where references unknown column '${field}' on '${getTableName(table)}'`,
      );
    }
    return eq(column, value);
  });
  return clauses.length === 0 ? undefined : and(...clauses);
}

function primaryKeyColumn(table: SQLiteTable): SQLiteColumn {
  const primaries = Object.values(columnsOf(table)).filter((column) => column.primary);
  const first = primaries[0];
  if (!first || primaries.length !== 1) {
    throw new Error(
      `[@nizhal/db-collection] table '${getTableName(table)}' needs exactly one primary key`,
    );
  }
  return first;
}

export function drizzleMutatorTx(
  db: AnyDrizzleSqliteDb,
  tables: DerivedTableMap,
  onTouch?: (tableName: string) => void,
): MutatorTx {
  return {
    insert(table) {
      return {
        async values(rowOrRows) {
          onTouch?.(getTableName(table));
          const derived = derivedFor(tables, table);
          const rows = Array.isArray(rowOrRows) ? rowOrRows : [rowOrRows];
          if (rows.length === 0) return [];
          const pk = primaryKeyColumn(derived);
          const columns = columnsOf(derived);
          for (const row of rows) {
            const set: Record<string, unknown> = {};
            for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
              if (columns[key] && columns[key] !== pk) set[key] = value;
            }
            const insert = db.insert(derived).values(row as Record<string, unknown>);
            if (Object.keys(set).length > 0) {
              await insert.onConflictDoUpdate({ target: pk, set });
            } else {
              await insert.onConflictDoNothing();
            }
          }
          return rows;
        },
      };
    },
    update(table, where) {
      return {
        async set(patch) {
          onTouch?.(getTableName(table));
          const derived = derivedFor(tables, table);
          const predicate = wherePredicate(derived, where as Record<string, unknown>);
          const update = db.update(derived).set(patch as Record<string, unknown>);
          await (predicate ? update.where(predicate.getSQL()) : update);
          return [];
        },
      };
    },
    async delete(table, where) {
      onTouch?.(getTableName(table));
      const derived = derivedFor(tables, table);
      const predicate = wherePredicate(derived, where as Record<string, unknown>);
      const del = db.delete(derived);
      await (predicate ? del.where(predicate.getSQL()) : del);
      return [];
    },
  };
}

export function createDrizzleClientMutatorCtx(
  db: AnyDrizzleSqliteDb,
  tables: DerivedTableMap,
  actor: Actor,
  onTouch?: (tableName: string) => void,
) {
  return {
    tx: drizzleMutatorTx(db, tables, onTouch),
    location: "client" as const,
    actor,
    ownerId: actor.ownerId,
    userId: actor.userId,
    locationId: typeof actor.locationId === "string" ? actor.locationId : undefined,
    now: () => Date.now(),
    newId: () => safeRandomUUID(),
    jobs: noopJobs(),
    // Provisional client-side guess (local max + 1) for the optimistic UI; the server assigns the
    // authoritative value under a lock and the row rebases to it on the next pull.
    nextInBucket: async ({
      table,
      sequenceColumn,
      scopeColumn,
      scopeValue,
    }: {
      table: string;
      sequenceColumn: string;
      scopeColumn: string;
      scopeValue: string | number;
    }) => {
      const derived = tables[table];
      if (!derived) return 1;
      const columns = columnsOf(derived);
      const seq = columns[sequenceColumn];
      const scope = columns[scopeColumn];
      if (!seq || !scope) return 1;
      const rows = (await db
        .select({ max: sql<number | null>`max(${seq})` })
        .from(derived)
        .where(eq(scope, scopeValue))) as Array<{ max: number | null }>;
      return (rows[0]?.max ?? 0) + 1;
    },
  };
}

function noopJobs(): JobScheduler {
  return {
    enqueue() {},
    scheduleAt() {},
  };
}
