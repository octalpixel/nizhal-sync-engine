import type { DrizzleConfig } from "drizzle-orm";
import { drizzle } from "drizzle-orm/op-sqlite";
import type { OPSQLiteDatabase } from "drizzle-orm/op-sqlite";
import type { TableChangeSource } from "./types.js";

/** The slice of an op-sqlite `DB` handle this adapter needs (structural — no op-sqlite dep). */
export interface OpSqliteDatabaseLike {
  updateHook(callback: ((event: { table: string }) => void) | null): void;
}

interface OpSqliteExecable {
  execute(
    sql: string,
    params?: unknown[],
  ): Promise<{
    rows?: Record<string, unknown>[];
    insertId?: number;
    rowsAffected?: number;
  }>;
  executeSync?(sql: string, params?: unknown[]): { rows?: Record<string, unknown>[] };
  executeRaw(sql: string, params?: unknown[]): Promise<unknown>;
}

/**
 * A drizzle database over op-sqlite ≥v17. Drizzle's shipped op-sqlite driver targets the old
 * (<v11) API — it calls `executeAsync`/`executeRawAsync` and reads `result.rows._array`, all of
 * which changed in v17 (found live on-device: `rows.map is not a function` inside
 * `OPSQLitePreparedQuery#all`). This shim presents exactly the surface the driver consumes.
 */
export function opSqliteDrizzle<TSchema extends Record<string, unknown> = Record<string, never>>(
  raw: unknown,
  config?: DrizzleConfig<TSchema>,
): OPSQLiteDatabase<TSchema> {
  const db = raw as OpSqliteExecable;
  const toLegacyResult = (result: {
    rows?: Record<string, unknown>[];
    insertId?: number;
    rowsAffected?: number;
  }) => {
    const rows = result.rows ?? [];
    return {
      ...result,
      rows: { _array: rows, length: rows.length, item: (index: number) => rows[index] },
    };
  };
  const toValueArrays = (result: unknown): unknown[] => {
    if (Array.isArray(result)) return result;
    const record = result as { rawRows?: unknown[]; rows?: unknown[] } | null;
    return record?.rawRows ?? record?.rows ?? [];
  };
  const compat = {
    // drizzle's sync path (`client.execute(...).rows?._array`) — back with executeSync when the
    // build has it; otherwise return a shape whose miss degrades to [] the way the driver expects.
    execute: (sql: string, params?: unknown[]) =>
      db.executeSync ? toLegacyResult(db.executeSync(sql, params)) : { rows: undefined },
    executeAsync: async (sql: string, params?: unknown[]) =>
      toLegacyResult(await db.execute(sql, params)),
    executeRawAsync: async (sql: string, params?: unknown[]) =>
      toValueArrays(await db.executeRaw(sql, params)),
  };
  return drizzle(compat as never, config);
}

/**
 * Change feed for op-sqlite, backed by its SQLite update hook.
 *
 * op-sqlite exposes a single hook slot per connection — this adapter owns it and fans out to
 * any number of subscribers. Do not call `db.updateHook` yourself after wiring this.
 */
export function opSqliteChanges(database: OpSqliteDatabaseLike): TableChangeSource {
  const listeners = new Set<(tableName: string) => void>();
  let hooked = false;

  return {
    subscribe(listener) {
      listeners.add(listener);
      if (!hooked) {
        hooked = true;
        database.updateHook((event) => {
          for (const fn of listeners) fn(event.table);
        });
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && hooked) {
          hooked = false;
          database.updateHook(null);
        }
      };
    },
  };
}
