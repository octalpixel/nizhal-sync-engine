import type { SQLiteDriver } from "@tanstack/db-sqlite-persistence-core";
import type { StorageAdapter } from "@tanstack/offline-transactions";

export interface BufferedSQLiteOutboxStorage extends StorageAdapter {
  flush(): Promise<void>;
  dispose(): Promise<void>;
}

function assertOutboxKey(key: string): void {
  if (typeof key !== "string" || key.length === 0) {
    throw new Error("[@nizhal/db-collection] outbox key must be a non-empty string");
  }
}

export function createSQLiteOutboxStorage(
  driver: SQLiteDriver,
  whenIdle: () => Promise<void>,
): BufferedSQLiteOutboxStorage {
  let disposed = false;
  let closing = false;
  let disposePromise: Promise<void> | null = null;

  function assertOpen(): void {
    if (disposed || closing) {
      throw new Error("[@nizhal/db-collection] outbox storage is disposed");
    }
  }

  return {
    async get(key) {
      assertOpen();
      assertOutboxKey(key);
      return driver.transaction(async (transactionDriver) => {
        const rows = await transactionDriver.query<{ value: string }>(
          "SELECT value FROM _nizhal_outbox WHERE key = ?",
          [key],
        );
        return rows[0]?.value ?? null;
      });
    },

    async set(key, value) {
      assertOpen();
      assertOutboxKey(key);
      await driver.transaction(async (transactionDriver) => {
        await transactionDriver.run(
          "INSERT INTO _nizhal_outbox (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
          [key, value],
        );
      });
    },

    async delete(key) {
      assertOpen();
      assertOutboxKey(key);
      await driver.transaction(async (transactionDriver) => {
        await transactionDriver.run("DELETE FROM _nizhal_outbox WHERE key = ?", [key]);
      });
    },

    async keys() {
      assertOpen();
      return driver.transaction(async (transactionDriver) => {
        const persisted = await transactionDriver.query<{ key: string }>(
          "SELECT key FROM _nizhal_outbox",
        );
        return persisted
          .map((row) => row.key)
          .filter((key): key is string => typeof key === "string" && key.length > 0);
      });
    },

    async clear() {
      assertOpen();
      await driver.transaction(async (transactionDriver) => {
        await transactionDriver.run("DELETE FROM _nizhal_outbox");
      });
    },

    flush() {
      assertOpen();
      return whenIdle();
    },

    dispose() {
      if (disposePromise) {
        return disposePromise;
      }
      closing = true;
      disposePromise = whenIdle().then(() => {
        disposed = true;
      });
      return disposePromise;
    },
  };
}
