import { is } from "drizzle-orm";
import { SQLiteTable, SQLiteView, getTableConfig, getViewConfig } from "drizzle-orm/sqlite-core";
import { SQLiteRelationalQuery } from "drizzle-orm/sqlite-core/query-builders/query";

interface Watcher {
  tables: ReadonlySet<string> | undefined;
  fire: () => void;
}

export interface TableWatcher {
  /** Feed a table change in; watchers re-fire coalesced per microtask. */
  notify(tableName: string): void;
  /** `tables === undefined` fires on every change. Returns an unsubscribe function. */
  subscribe(tables: ReadonlySet<string> | undefined, fire: () => void): () => void;
}

export function createTableWatcher(): TableWatcher {
  const watchers = new Set<Watcher>();
  let pending: Set<string> | undefined;

  return {
    notify(tableName) {
      if (!pending) {
        pending = new Set();
        queueMicrotask(() => {
          const batch = pending;
          pending = undefined;
          if (!batch) return;
          for (const watcher of watchers) {
            if (!watcher.tables) {
              watcher.fire();
              continue;
            }
            for (const table of batch) {
              if (watcher.tables.has(table)) {
                watcher.fire();
                break;
              }
            }
          }
        });
      }
      pending.add(tableName);
    },
    subscribe(tables, fire) {
      const watcher: Watcher = { tables, fire };
      watchers.add(watcher);
      return () => {
        watchers.delete(watcher);
      };
    },
  };
}

/**
 * The SQL table a query reads from — derived exactly the way drizzle's own expo-sqlite
 * `useLiveQuery` does it (public `is()` checks on the query's primary table; no fragile
 * internals). Joins beyond the primary table need an explicit `tables` override.
 */
export function deriveQueryTables(query: unknown): ReadonlyArray<string> | undefined {
  const entity = is(query, SQLiteRelationalQuery)
    ? (query as unknown as { table: unknown }).table
    : (query as { config?: { table?: unknown } }).config?.table;
  if (is(entity, SQLiteTable)) return [getTableConfig(entity).name];
  if (is(entity, SQLiteView)) return [getViewConfig(entity).name];
  return undefined;
}
