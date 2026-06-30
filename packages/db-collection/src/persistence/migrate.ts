import type {
  PersistedCollectionPersistence,
  SQLiteDriver,
} from "@tanstack/db-sqlite-persistence-core";
import type { StorageAdapter } from "@tanstack/offline-transactions";
import type { MutationIdStorage } from "../mutation-id.js";
import type { ClientIdStorage } from "./client-meta.js";
import type { DeadLetterStorage } from "./dead-letter-storage.js";
import type { BufferedSQLiteOutboxStorage } from "./sqlite-storage.js";

export interface NizhalSQLitePersistence {
  persistence: PersistedCollectionPersistence;
  outboxStorage: StorageAdapter;
  flushOutbox(): Promise<void>;
  dispose(): Promise<void>;
  clientId: string;
  clientIdStorage: ClientIdStorage;
  /** Durable per-device key/value (mutation-id high-water lives here, not in the outbox). */
  metaStorage: MutationIdStorage;
  deadLetterStorage: DeadLetterStorage;
}

export interface ClientStoreMigration {
  version: number;
  up(driver: SQLiteDriver): Promise<void>;
}

export interface MigrateClientStoreOptions {
  targetVersion: number;
  migrations: ReadonlyArray<ClientStoreMigration>;
}

export class NizhalClientStoreVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NizhalClientStoreVersionError";
  }
}

export const NIZHAL_CLIENT_STORE_VERSION = 3;

export const NIZHAL_CLIENT_STORE_MIGRATIONS: ReadonlyArray<ClientStoreMigration> = [
  {
    version: 1,
    async up(driver) {
      await driver.exec(
        "CREATE TABLE IF NOT EXISTS _nizhal_outbox (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
      );
    },
  },
  {
    version: 2,
    async up(driver) {
      await driver.exec(
        "CREATE TABLE IF NOT EXISTS _nizhal_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
      );
    },
  },
  {
    version: 3,
    async up(driver) {
      await driver.exec(
        "CREATE TABLE IF NOT EXISTS _nizhal_dead_letter (idempotency_key TEXT PRIMARY KEY, value TEXT NOT NULL, parked_at INTEGER NOT NULL)",
      );
    },
  },
];

export async function migrateClientStore(
  driver: SQLiteDriver,
  options: MigrateClientStoreOptions,
): Promise<void> {
  const { targetVersion, migrations } = options;

  if (targetVersion < 0) {
    throw new NizhalClientStoreVersionError(
      `Invalid target client-store version: ${targetVersion}`,
    );
  }

  await driver.exec(
    "CREATE TABLE IF NOT EXISTS _nizhal_store_version (id INTEGER PRIMARY KEY, version INTEGER NOT NULL)",
  );

  const rows = await driver.query<{ version: number }>(
    "SELECT version FROM _nizhal_store_version WHERE id = 1",
  );
  const currentVersion = rows[0]?.version ?? 0;

  if (currentVersion === targetVersion) {
    return;
  }

  if (currentVersion > targetVersion) {
    throw new NizhalClientStoreVersionError(
      `Client store version ${currentVersion} is ahead of supported version ${targetVersion}. Refusing to start to avoid data corruption.`,
    );
  }

  const byVersion = new Map<number, ClientStoreMigration>();
  for (const migration of migrations) {
    if (byVersion.has(migration.version)) {
      throw new NizhalClientStoreVersionError(
        `Duplicate client-store migration for version ${migration.version}`,
      );
    }
    byVersion.set(migration.version, migration);
  }

  for (let version = currentVersion + 1; version <= targetVersion; version += 1) {
    const migration = byVersion.get(version);
    if (!migration) {
      throw new NizhalClientStoreVersionError(
        `Missing client-store migration for version ${version}`,
      );
    }

    const run = async (migrationDriver: SQLiteDriver) => {
      await migration.up(migrationDriver);
      await migrationDriver.run(
        "INSERT INTO _nizhal_store_version (id, version) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET version = excluded.version",
        [version],
      );
    };

    if (typeof driver.transaction === "function") {
      await driver.transaction(async (transactionDriver) => {
        await run(transactionDriver);
      });
    } else {
      await run(driver);
    }
  }
}

export function mergeClientStoreMigrations(
  userMigrations: ReadonlyArray<ClientStoreMigration> = [],
): ReadonlyArray<ClientStoreMigration> {
  const seen = new Set<number>();
  const merged: ClientStoreMigration[] = [];

  for (const migration of NIZHAL_CLIENT_STORE_MIGRATIONS) {
    if (seen.has(migration.version)) {
      throw new NizhalClientStoreVersionError(
        `Duplicate default client-store migration ${migration.version}`,
      );
    }
    seen.add(migration.version);
    merged.push(migration);
  }

  for (const migration of userMigrations) {
    if (seen.has(migration.version)) {
      throw new NizhalClientStoreVersionError(
        `Client-store migration ${migration.version} conflicts with an Nizhal internal migration`,
      );
    }
    seen.add(migration.version);
    merged.push(migration);
  }

  return merged.sort((a, b) => a.version - b.version);
}
