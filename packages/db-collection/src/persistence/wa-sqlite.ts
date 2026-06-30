import {
  DEFAULT_APPLIED_TX_PRUNE_MAX_AGE_SECONDS,
  DEFAULT_APPLIED_TX_PRUNE_MAX_ROWS,
  type PersistedCollectionCoordinator,
  type PersistedCollectionMode,
  type PersistedCollectionPersistence,
  type SQLiteDriver,
  SingleProcessCoordinator,
  createSQLiteCorePersistenceAdapter,
} from "@tanstack/db-sqlite-persistence-core";
import { createSQLiteClientIdStorage, createSQLiteMetaStorage } from "./client-meta.js";
import { createSQLiteDeadLetterStorage } from "./dead-letter-storage.js";
import {
  type ClientStoreMigration,
  NIZHAL_CLIENT_STORE_VERSION,
  type NizhalSQLitePersistence,
  mergeClientStoreMigrations,
  migrateClientStore,
} from "./migrate.js";
import { createSQLiteOutboxStorage } from "./sqlite-storage.js";
import type { NizhalSerializedWaSqliteDatabase } from "./wa-sqlite-database.js";

export interface WaSqlitePersistenceOptions {
  database: NizhalSerializedWaSqliteDatabase;
  migrations?: ReadonlyArray<ClientStoreMigration>;
}

type BrowserSQLiteCoreSchemaMismatchPolicy = "sync-present-reset" | "sync-absent-error" | "reset";
type BrowserWASQLiteSchemaMismatchPolicy = BrowserSQLiteCoreSchemaMismatchPolicy | "throw";

class NizhalWaSqliteDriver implements SQLiteDriver {
  private readonly database: NizhalSerializedWaSqliteDatabase;
  private initOnce: Promise<void> | null = null;
  private nextSavepointId = 1;

  constructor(database: NizhalSerializedWaSqliteDatabase) {
    this.database = database;
  }

  runOnceInit(operation: () => Promise<void>): Promise<void> {
    if (!this.initOnce) {
      this.initOnce = operation();
    }
    return this.initOnce;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    return this.database.scheduleOperation(operation);
  }

  private runSql<TRow>(sql: string, params?: ReadonlyArray<unknown>): Promise<ReadonlyArray<TRow>> {
    return this.database.runSql<TRow>(sql, params);
  }

  async exec(sql: string): Promise<void> {
    await this.enqueue(async () => {
      await this.runSql(sql);
    });
  }

  async query<T>(sql: string, params: ReadonlyArray<unknown> = []): Promise<ReadonlyArray<T>> {
    return this.enqueue(async () => {
      const rows = await this.runSql<T>(sql, params);
      return rows ?? [];
    });
  }

  async run(sql: string, params: ReadonlyArray<unknown> = []): Promise<void> {
    await this.enqueue(async () => {
      await this.runSql(sql, params);
    });
  }

  async transaction<T>(fn: (driver: SQLiteDriver) => Promise<T>): Promise<T> {
    return this.enqueue(async () => {
      await this.runSql("BEGIN IMMEDIATE");
      try {
        const result = await fn(this.createTransactionDriver());
        await this.runSql("COMMIT");
        return result;
      } catch (error) {
        try {
          await this.runSql("ROLLBACK");
        } catch {
          // Preserve the original error.
        }
        throw error;
      }
    });
  }

  async transactionWithDriver<T>(fn: (driver: SQLiteDriver) => Promise<T>): Promise<T> {
    return this.transaction(fn);
  }

  private createTransactionDriver(): SQLiteDriver {
    return {
      exec: async (sql) => {
        await this.runSql(sql);
      },
      query: async <T>(sql: string, params: ReadonlyArray<unknown> = []) => {
        const rows = await this.runSql<T>(sql, params);
        return rows ?? [];
      },
      run: async (sql, params = []) => {
        await this.runSql(sql, params);
      },
      transaction: async <T>(fn: (driver: SQLiteDriver) => Promise<T>) => {
        return this.runNestedTransaction(fn);
      },
      transactionWithDriver: async <T>(fn: (driver: SQLiteDriver) => Promise<T>) => {
        return this.runNestedTransaction(fn);
      },
    };
  }

  private async runNestedTransaction<T>(fn: (driver: SQLiteDriver) => Promise<T>): Promise<T> {
    const savepoint = `echo_wa_sp_${this.nextSavepointId}`;
    this.nextSavepointId += 1;
    await this.runSql(`SAVEPOINT ${savepoint}`);
    try {
      const result = await fn(this.createTransactionDriver());
      await this.runSql(`RELEASE SAVEPOINT ${savepoint}`);
      return result;
    } catch (error) {
      await this.runSql(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      await this.runSql(`RELEASE SAVEPOINT ${savepoint}`);
      throw error;
    }
  }
}

function normalizeSchemaMismatchPolicy(
  policy: BrowserWASQLiteSchemaMismatchPolicy,
): BrowserSQLiteCoreSchemaMismatchPolicy {
  if (policy === "throw") {
    return "sync-absent-error";
  }
  return policy;
}

function resolveSchemaMismatchPolicy(
  explicitPolicy: BrowserWASQLiteSchemaMismatchPolicy | undefined,
  mode: PersistedCollectionMode,
): BrowserSQLiteCoreSchemaMismatchPolicy {
  if (explicitPolicy) {
    return normalizeSchemaMismatchPolicy(explicitPolicy);
  }
  return mode === "sync-present" ? "sync-present-reset" : "sync-absent-error";
}

function createAdapterCacheKey(
  schemaMismatchPolicy: BrowserSQLiteCoreSchemaMismatchPolicy,
  schemaVersion: number | undefined,
): string {
  const schemaVersionKey =
    schemaVersion === undefined ? "schema:default" : `schema:${schemaVersion}`;
  return `${schemaMismatchPolicy}|${schemaVersionKey}`;
}

function createNizhalWaSqlitePersistence(
  driver: NizhalWaSqliteDriver,
  options?: {
    schemaMismatchPolicy?: BrowserWASQLiteSchemaMismatchPolicy;
    coordinator?: PersistedCollectionCoordinator;
  },
): PersistedCollectionPersistence {
  const { coordinator, schemaMismatchPolicy } = options ?? {};
  const adapterBaseOptions = {
    appliedTxPruneMaxRows: DEFAULT_APPLIED_TX_PRUNE_MAX_ROWS,
    appliedTxPruneMaxAgeSeconds: DEFAULT_APPLIED_TX_PRUNE_MAX_AGE_SECONDS,
  };
  const resolvedCoordinator = coordinator ?? new SingleProcessCoordinator();
  const adapterCache = new Map<string, ReturnType<typeof createSQLiteCorePersistenceAdapter>>();

  const getAdapterForCollection = (
    mode: PersistedCollectionMode,
    schemaVersion: number | undefined,
  ) => {
    const resolvedSchemaMismatchPolicy = resolveSchemaMismatchPolicy(schemaMismatchPolicy, mode);
    const cacheKey = createAdapterCacheKey(resolvedSchemaMismatchPolicy, schemaVersion);
    const cachedAdapter = adapterCache.get(cacheKey);
    if (cachedAdapter) {
      return cachedAdapter;
    }

    const adapter = createSQLiteCorePersistenceAdapter({
      ...adapterBaseOptions,
      driver,
      schemaMismatchPolicy: resolvedSchemaMismatchPolicy,
      ...(schemaVersion === undefined ? {} : { schemaVersion }),
    });
    adapterCache.set(cacheKey, adapter);
    return adapter;
  };

  const createCollectionPersistence = (
    mode: PersistedCollectionMode,
    schemaVersion: number | undefined,
  ): PersistedCollectionPersistence => ({
    adapter: getAdapterForCollection(mode, schemaVersion),
    coordinator: resolvedCoordinator,
  });

  const defaultPersistence = createCollectionPersistence("sync-absent", undefined);

  return {
    ...defaultPersistence,
    resolvePersistenceForCollection: ({ mode, schemaVersion }) =>
      createCollectionPersistence(mode, schemaVersion),
    resolvePersistenceForMode: (mode) => createCollectionPersistence(mode, undefined),
  };
}

export async function waSqlitePersistence(
  options: WaSqlitePersistenceOptions,
): Promise<NizhalSQLitePersistence> {
  const driver = new NizhalWaSqliteDriver(options.database);
  await migrateClientStore(driver, {
    targetVersion: NIZHAL_CLIENT_STORE_VERSION,
    migrations: mergeClientStoreMigrations(options.migrations),
  });

  const persistence = createNizhalWaSqlitePersistence(driver, {
    schemaMismatchPolicy: "throw",
  });

  const warmAdapter =
    persistence.resolvePersistenceForMode?.("sync-present")?.adapter ?? persistence.adapter;
  if (warmAdapter && typeof warmAdapter.getStreamPosition === "function") {
    const getStreamPosition = warmAdapter.getStreamPosition.bind(warmAdapter);
    await driver.runOnceInit(async () => {
      await getStreamPosition("_nizhal_schema_warm");
    });
  }

  const whenIdle = () => options.database.whenIdle();
  const outboxStorage = createSQLiteOutboxStorage(driver, whenIdle);
  const clientIdStorage = createSQLiteClientIdStorage(driver);
  const metaStorage = createSQLiteMetaStorage(driver);
  const deadLetterStorage = createSQLiteDeadLetterStorage(driver, whenIdle);
  const clientId = await clientIdStorage.getClientId();

  return {
    persistence,
    outboxStorage,
    flushOutbox: () => outboxStorage.flush(),
    dispose: async () => {
      await outboxStorage.dispose();
      await deadLetterStorage.dispose();
      await whenIdle();
    },
    clientId,
    clientIdStorage,
    metaStorage,
    deadLetterStorage,
  };
}
