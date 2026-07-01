import type { DrizzleConfig } from "drizzle-orm";
import { type SqliteRemoteDatabase, drizzle } from "drizzle-orm/sqlite-proxy";
import type { TableChangeSource } from "./types.js";

const SQLITE_ROW = 100;
const SQLITE_DONE = 101;

/**
 * The slice of the wa-sqlite API this driver needs (structural — works with both
 * `wa-sqlite` and `@journeyapps/wa-sqlite` builds). Obtained from
 * `SQLite.Factory(module)`; the app opens the database itself via `open_v2`.
 */
export interface WaSqliteApiLike {
  statements(db: number, sql: string): AsyncIterable<number>;
  // Param/return types mirror wa-sqlite's own unions so its concrete `SQLiteAPI` object
  // satisfies this interface without casts (methods compare bivariantly).
  bind_collection(
    statement: number,
    params: ReadonlyArray<unknown> | Record<string, unknown>,
  ): unknown;
  column_names(statement: number): ReadonlyArray<string>;
  step(statement: number): Promise<number>;
  row(statement: number): ReadonlyArray<unknown>;
  close(db: number): Promise<unknown>;
  update_hook?(
    db: number,
    callback: (updateType: number, dbName: string, tableName: string, rowid: bigint) => void,
  ): void;
}

export interface WaSqliteDrizzleOptions<TSchema extends Record<string, unknown>> {
  sqlite3: WaSqliteApiLike;
  /** The database pointer returned by `sqlite3.open_v2(...)`. */
  database: number;
  config?: DrizzleConfig<TSchema>;
}

/**
 * A real drizzle database over wa-sqlite (browser OPFS / in-memory), via drizzle's
 * `sqlite-proxy` driver. Statements are serialized on one internal queue — wa-sqlite
 * connections are not re-entrant, and interleaved statement iterators trip SQLITE_MISUSE.
 */
export function waSqliteDrizzle<TSchema extends Record<string, unknown> = Record<string, never>>(
  opts: WaSqliteDrizzleOptions<TSchema>,
): SqliteRemoteDatabase<TSchema> {
  const { sqlite3, database } = opts;

  let chain: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = chain.then(operation, operation);
    chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const execute = (sql: string, params: ReadonlyArray<unknown>): Promise<unknown[][]> =>
    enqueue(async () => {
      const rows: unknown[][] = [];
      let parametersBound = false;
      for await (const statement of sqlite3.statements(database, sql)) {
        if (params.length > 0) {
          if (parametersBound) {
            throw new Error(
              "[@nizhal/local] wa-sqlite only supports parameter binding for a single SQL statement",
            );
          }
          sqlite3.bind_collection(statement, params);
          parametersBound = true;
        }
        for (;;) {
          const stepResult = await sqlite3.step(statement);
          if (stepResult === SQLITE_ROW) {
            rows.push([...sqlite3.row(statement)]);
            continue;
          }
          if (stepResult === SQLITE_DONE) break;
          throw new Error(
            `[@nizhal/local] wa-sqlite step returned unexpected result code: ${String(stepResult)}`,
          );
        }
      }
      return rows;
    });

  return drizzle<TSchema>(async (sql, params, method) => {
    const rows = await execute(sql, params ?? []);
    // 'get' must return a falsy `rows` when there is no row — drizzle maps [] to a real row.
    if (method === "get") return { rows: rows[0] } as { rows: unknown[] };
    return { rows };
  }, opts.config);
}

/**
 * Change feed for wa-sqlite, backed by `sqlite3_update_hook`. Single hook slot per
 * connection — this adapter owns it and fans out; do not register your own hook.
 */
export function waSqliteChanges(sqlite3: WaSqliteApiLike, database: number): TableChangeSource {
  if (typeof sqlite3.update_hook !== "function") {
    throw new Error(
      "[@nizhal/local] this wa-sqlite build does not expose update_hook — live queries need it",
    );
  }
  const hook = sqlite3.update_hook.bind(sqlite3);
  const listeners = new Set<(tableName: string) => void>();
  let hooked = false;

  return {
    subscribe(listener) {
      listeners.add(listener);
      if (!hooked) {
        // Registered once for the connection's lifetime — an empty listener set is a no-op.
        hooked = true;
        hook(database, (_type, _dbName, tableName) => {
          if (!tableName) return;
          for (const fn of listeners) fn(tableName);
        });
      }
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
