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
import { createStorageOperationQueue } from "./storage-operation-queue.js";

// Structural shape this adapter needs from an op-sqlite database handle. Declared with method
// syntax (parameters compared bivariantly) so BOTH op-sqlite's `DB` (execute params typed `Scalar[]`)
// and @tanstack's `OpSQLiteDatabaseLike` (params `ReadonlyArray<unknown>`) satisfy it without a cast —
// the two upstream types are variance-incompatible under strictFunctionTypes, but the execute method
// is duck-typed at runtime (resolveExecuteMethod), so the public type only needs "has one of these".
export interface OpSqliteDatabaseHandle {
  execute?(sql: string, params?: readonly unknown[]): unknown;
  executeAsync?(sql: string, params?: readonly unknown[]): unknown;
  executeRaw?(sql: string, params?: readonly unknown[]): unknown;
  execAsync?(sql: string, params?: readonly unknown[]): unknown;
}

export interface OpSqlitePersistenceOptions {
  database: OpSqliteDatabaseHandle;
  migrations?: ReadonlyArray<ClientStoreMigration>;
}

type ExecuteFn = (sql: string, params?: ReadonlyArray<unknown>) => unknown | Promise<unknown>;

function resolveExecuteMethod(database: OpSqliteDatabaseHandle): ExecuteFn {
  const candidates: Array<unknown> = [
    database.executeAsync,
    database.execute,
    database.executeRaw,
    database.execAsync,
  ];
  const method = candidates.find((candidate) => typeof candidate === "function");
  if (typeof method !== "function") {
    throw new Error(
      "[@nizhal/db-collection] op-sqlite database must provide execute/executeAsync/executeRaw/execAsync",
    );
  }
  return method.bind(database) as ExecuteFn;
}

function extractRows(result: unknown, _sql: string): ReadonlyArray<unknown> {
  if (result == null) {
    return [];
  }

  if (Array.isArray(result)) {
    return result;
  }

  if (typeof result === "object") {
    const record = result as Record<string, unknown>;

    const rowsValue = record.rows;
    if (rowsValue && typeof rowsValue === "object") {
      const rowsRecord = rowsValue as Record<string, unknown>;
      if (Array.isArray(rowsRecord._array)) {
        return rowsRecord._array;
      }
      if (Array.isArray(rowsValue)) {
        return rowsValue;
      }
    }

    if (Array.isArray(record.resultRows)) {
      return record.resultRows;
    }

    if (
      "rowsAffected" in record ||
      "changes" in record ||
      "insertId" in record ||
      "lastInsertRowId" in record
    ) {
      return [];
    }
  }

  return [];
}

class OpSQLiteMigrationDriver implements SQLiteDriver {
  private readonly database: OpSqliteDatabaseHandle;
  private readonly executeMethod: ExecuteFn;
  private readonly operationQueue = createStorageOperationQueue();
  private nextSavepointId = 1;

  constructor(database: OpSqliteDatabaseHandle) {
    this.database = database;
    this.executeMethod = resolveExecuteMethod(database);
  }

  async exec(sql: string): Promise<void> {
    await this.enqueue(async () => {
      await this.execute(sql);
    });
  }

  async query<T>(sql: string, params: ReadonlyArray<unknown> = []): Promise<ReadonlyArray<T>> {
    return this.enqueue(async () => {
      const result = await this.execute(sql, params);
      return extractRows(result, sql) as ReadonlyArray<T>;
    });
  }

  async run(sql: string, params: ReadonlyArray<unknown> = []): Promise<void> {
    await this.enqueue(async () => {
      await this.execute(sql, params);
    });
  }

  async transaction<T>(fn: (driver: SQLiteDriver) => Promise<T>): Promise<T> {
    return this.enqueue(async () => {
      await this.execute("BEGIN IMMEDIATE");
      try {
        const result = await fn(this.createTransactionDriver());
        await this.execute("COMMIT");
        return result;
      } catch (error) {
        try {
          await this.execute("ROLLBACK");
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
        await this.execute(sql);
      },
      query: async <T>(sql: string, params: ReadonlyArray<unknown> = []) => {
        const result = await this.execute(sql, params);
        return extractRows(result, sql) as ReadonlyArray<T>;
      },
      run: async (sql, params = []) => {
        await this.execute(sql, params);
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
    const savepoint = `echo_op_sp_${this.nextSavepointId}`;
    this.nextSavepointId += 1;
    await this.execute(`SAVEPOINT ${savepoint}`);
    try {
      const result = await fn(this.createTransactionDriver());
      await this.execute(`RELEASE SAVEPOINT ${savepoint}`);
      return result;
    } catch (error) {
      await this.execute(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      await this.execute(`RELEASE SAVEPOINT ${savepoint}`);
      throw error;
    }
  }

  private execute(sql: string, params: ReadonlyArray<unknown> = []): Promise<unknown> {
    const normalizedParams = params.length > 0 ? [...params] : undefined;
    const result = this.executeMethod(sql, normalizedParams);
    return Promise.resolve(result);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    return this.operationQueue.enqueue(operation);
  }

  whenIdle(): Promise<void> {
    return this.operationQueue.whenIdle();
  }
}

type CoreSchemaMismatchPolicy = "sync-present-reset" | "sync-absent-error" | "reset";
type OpSchemaMismatchPolicy = CoreSchemaMismatchPolicy | "throw";

function resolveSchemaMismatchPolicy(
  explicit: OpSchemaMismatchPolicy | undefined,
  mode: PersistedCollectionMode,
): CoreSchemaMismatchPolicy {
  if (explicit) return explicit === "throw" ? "sync-absent-error" : explicit;
  return mode === "sync-present" ? "sync-present-reset" : "sync-absent-error";
}

function createAdapterCacheKey(
  policy: CoreSchemaMismatchPolicy,
  schemaVersion: number | undefined,
): string {
  return `${policy}|${schemaVersion === undefined ? "schema:default" : `schema:${schemaVersion}`}`;
}

/**
 * Build the collection persistence from Nizhal's own {@link OpSQLiteMigrationDriver} (which awaits
 * op-sqlite's async `execute` and normalizes result shapes via `extractRows`) — NOT from the raw
 * op-sqlite db. The raw-db `createReactNativeSQLitePersistence` assumes op-sqlite v15 (sync
 * `execute` + `rows._array`); op-sqlite v17 made `execute` async and `rows` a plain array, breaking
 * it ("undefined is not a function" on `rows._array`). The driver-based core adapter is the same
 * path the proven wa-sqlite persistence uses, so it is correct across op-sqlite versions.
 */
function createNizhalOpSqlitePersistence(
  driver: SQLiteDriver,
  options?: {
    schemaMismatchPolicy?: OpSchemaMismatchPolicy;
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
    const resolvedPolicy = resolveSchemaMismatchPolicy(schemaMismatchPolicy, mode);
    const cacheKey = createAdapterCacheKey(resolvedPolicy, schemaVersion);
    const cached = adapterCache.get(cacheKey);
    if (cached) return cached;
    const adapter = createSQLiteCorePersistenceAdapter({
      ...adapterBaseOptions,
      driver,
      schemaMismatchPolicy: resolvedPolicy,
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

export async function opSqlitePersistence(
  options: OpSqlitePersistenceOptions,
): Promise<NizhalSQLitePersistence> {
  const driver = new OpSQLiteMigrationDriver(options.database);
  await migrateClientStore(driver, {
    targetVersion: NIZHAL_CLIENT_STORE_VERSION,
    migrations: mergeClientStoreMigrations(options.migrations),
  });

  const whenIdle = () => driver.whenIdle();
  const outboxStorage = createSQLiteOutboxStorage(driver, whenIdle);
  const clientIdStorage = createSQLiteClientIdStorage(driver);
  const metaStorage = createSQLiteMetaStorage(driver);
  const deadLetterStorage = createSQLiteDeadLetterStorage(driver, whenIdle);
  const clientId = await clientIdStorage.getClientId();

  return {
    persistence: createNizhalOpSqlitePersistence(driver, { schemaMismatchPolicy: "throw" }),
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
