import type { PGlite } from "@electric-sql/pglite";
import type { MutatorTx } from "@nizhal/kernel";
import { and, eq } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import type { SQL } from "drizzle-orm/sql";
import type { Table } from "drizzle-orm/table";
import type postgres from "postgres";

export type PostgresClient = ReturnType<typeof postgres>;
export type PgliteClient = PGlite;

export type DrizzleClient = ReturnType<typeof drizzlePostgres> | ReturnType<typeof drizzlePglite>;
export type DrizzleTx = Parameters<Parameters<DrizzleClient["transaction"]>[0]>[0];
export type NizhalDb = DrizzleClient | DrizzleTx;

export interface StorageTx extends MutatorTx {
  readonly db: NizhalDb;
}

export function toNizhalDb(client: PostgresClient | PgliteClient | NizhalDb): {
  db: NizhalDb;
  rawClient: PostgresClient | PgliteClient | NizhalDb;
} {
  if (isNizhalDb(client)) return { db: client, rawClient: client };
  if (typeof client === "function") return { db: drizzlePostgres({ client }), rawClient: client };
  return { db: drizzlePglite({ client }), rawClient: client };
}

export function createStorageTx(db: NizhalDb): StorageTx {
  return {
    db,
    insert(table) {
      return {
        async values(row) {
          return db
            .insert(table as PgTable)
            .values(row)
            .returning();
        },
      };
    },
    update(table, where) {
      return {
        async set(patch) {
          return db
            .update(table as PgTable)
            .set(patch)
            .where(whereToPredicate(table, where))
            .returning();
        },
      };
    },
    async delete(table, where) {
      return db
        .delete(table as PgTable)
        .where(whereToPredicate(table, where))
        .returning();
    },
  };
}

// Compile a structured mutator `where` (a column→value equality map) into a drizzle predicate. The
// public MutatorTx speaks structured filters; the drizzle-backed layer and merge helpers speak SQL.
export function whereToPredicate<TTable extends Table>(
  table: TTable,
  where: Partial<Record<string, unknown>>,
): SQL {
  const columns = table as unknown as Record<string, PgColumn>;
  const clauses = Object.entries(where).map(([field, value]) => {
    const column = columns[field];
    if (!column)
      throw new Error(`[@nizhal] update/delete where references unknown column '${field}'`);
    return eq(column, value);
  });
  if (clauses.length === 0) throw new Error("[@nizhal] update/delete requires a non-empty where");
  return (clauses.length === 1 ? clauses[0] : and(...clauses)) as SQL;
}

export async function executeRows<T extends Record<string, unknown>>(
  db: NizhalDb,
  query: SQL | string,
): Promise<T[]> {
  const result = await db.execute<T>(query);
  if (Array.isArray(result)) return result as T[];
  if (isRowsResult<T>(result)) return result.rows;
  return [];
}

export async function closeRawClient(
  client: PostgresClient | PgliteClient | NizhalDb,
): Promise<void> {
  if (isPostgresClient(client)) await client.end({ timeout: 1 });
  if (isPgliteClient(client)) await client.close();
}

function isNizhalDb(value: unknown): value is NizhalDb {
  return (
    typeof value === "object" &&
    value !== null &&
    "insert" in value &&
    "select" in value &&
    "execute" in value
  );
}

function isRowsResult<T extends Record<string, unknown>>(value: unknown): value is { rows: T[] } {
  return (
    typeof value === "object" && value !== null && Array.isArray((value as { rows?: unknown }).rows)
  );
}

function isPostgresClient(value: unknown): value is PostgresClient {
  return typeof value === "function" && "end" in value && typeof value.end === "function";
}

function isPgliteClient(value: unknown): value is PgliteClient {
  return (
    typeof value === "object" &&
    value !== null &&
    "query" in value &&
    "close" in value &&
    typeof (value as { close?: unknown }).close === "function"
  );
}
