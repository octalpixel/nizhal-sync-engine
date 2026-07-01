import { applyBundledMigrations } from "./migrations.js";
import type { LiveResult, LocalDb, OpenLocalDbOptions, WatchOptions } from "./types.js";
import { createTableWatcher, deriveQueryTables } from "./watcher.js";

export type {
  BundledMigrations,
  LiveResult,
  LocalDb,
  OpenLocalDbOptions,
  TableChangeSource,
  WatchOptions,
} from "./types.js";
export { applyBundledMigrations } from "./migrations.js";

/**
 * Open a purely local, migrated, reactive Drizzle database — WatermelonDB-style, but the query
 * surface is drizzle itself. Build the drizzle db the way the drizzle docs show for your
 * platform, then hand it here with the drizzle-kit migration bundle and a platform change feed:
 *
 * ```ts
 * const expo = openDatabaseSync("app.db", { enableChangeListener: true });
 * const local = await openLocalDb({
 *   db: drizzle(expo, { schema }),
 *   migrations,                              // ./drizzle/migrations (drizzle-kit generate)
 *   changes: expoSqliteChanges(SQLite),      // @nizhal/local/expo-sqlite
 * });
 * local.db.select().from(schema.tasks);      // the real drizzle query builder
 * local.watch(local.db.select().from(schema.tasks), ({ data }) => render(data));
 * ```
 */
export async function openLocalDb<TDb>(opts: OpenLocalDbOptions<TDb>): Promise<LocalDb<TDb>> {
  if (opts.migrations) {
    await applyBundledMigrations(opts.db, opts.migrations);
  }

  const watcher = createTableWatcher();
  const stopChanges = opts.changes?.subscribe((table) => watcher.notify(table));
  let warnedNoChanges = false;

  function watch<T>(
    query: PromiseLike<T>,
    onResult: (result: LiveResult<T>) => void,
    options?: WatchOptions,
  ): () => void {
    if (!opts.changes && !warnedNoChanges) {
      warnedNoChanges = true;
      console.warn(
        "[@nizhal/local] watch(): no change source configured — results will not auto-refresh",
      );
    }
    const tables = options?.tables ?? deriveQueryTables(query);
    let closed = false;
    const run = () => {
      query.then(
        (data) => {
          if (!closed) onResult({ data, error: undefined, updatedAt: new Date() });
        },
        (error: unknown) => {
          if (closed) return;
          onResult({
            data: undefined,
            error: error instanceof Error ? error : new Error(String(error)),
            updatedAt: new Date(),
          });
        },
      );
    };
    run();
    const unsubscribe = watcher.subscribe(tables ? new Set(tables) : undefined, run);
    return () => {
      closed = true;
      unsubscribe();
    };
  }

  return {
    db: opts.db,
    watch,
    async dispose() {
      stopChanges?.();
      await opts.close?.();
    },
  };
}
