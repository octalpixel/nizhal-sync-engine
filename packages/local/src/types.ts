/**
 * The drizzle-kit bundled migration format (`drizzle.config.ts` with `dialect: "sqlite"`,
 * `driver: "expo"`): the generated `./drizzle/migrations.js` module. The same bundle drives
 * every platform here — expo-sqlite, op-sqlite, and the browser wa-sqlite driver.
 */
export interface BundledMigrations {
  journal: {
    entries: Array<{ idx: number; when: number; tag: string; breakpoints: boolean }>;
  };
  migrations: Record<string, string>;
}

/** Emits the SQL table name whenever a row in it is inserted, updated, or deleted. */
export interface TableChangeSource {
  subscribe(listener: (tableName: string) => void): () => void;
}

export interface LiveResult<T> {
  data: T | undefined;
  error: Error | undefined;
  updatedAt: Date | undefined;
}

export interface WatchOptions {
  /**
   * SQL table names that should re-run this query when written to. Defaults to the query's
   * primary table (joins beyond it need this override, same as drizzle's own useLiveQuery).
   */
  tables?: ReadonlyArray<string>;
}

export interface LocalDb<TDb> {
  /** The app's own drizzle database — the full native query builder, untouched. */
  db: TDb;
  /**
   * Run the query now and re-run it whenever a watched table changes.
   * Returns an unsubscribe function. The query must be a re-executable drizzle
   * query (plain builders and `db.query.*` finders both are).
   */
  watch<T>(
    query: PromiseLike<T>,
    onResult: (result: LiveResult<T>) => void,
    options?: WatchOptions,
  ): () => void;
  dispose(): Promise<void>;
}

export interface OpenLocalDbOptions<TDb> {
  /** A drizzle SQLite database (expo-sqlite / op-sqlite / wa-sqlite / better-sqlite3 …). */
  db: TDb;
  /** Applied (idempotently) before `openLocalDb` resolves. */
  migrations?: BundledMigrations;
  /** Platform change feed; without it `watch` runs queries once and never refreshes. */
  changes?: TableChangeSource;
  /** Called (and awaited) by `dispose()` — close the underlying database here. */
  close?: () => unknown;
}
