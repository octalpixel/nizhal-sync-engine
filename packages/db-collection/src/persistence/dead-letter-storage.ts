import type { Mutation } from "@nizhal/kernel";
import type { SQLiteDriver } from "@tanstack/db-sqlite-persistence-core";
import type { NizhalPoisonEntry } from "../types.js";

export interface DeadLetterStorage {
  list(): Promise<readonly NizhalPoisonEntry[]>;
  park(entry: NizhalPoisonEntry): Promise<void>;
  remove(idempotencyKey: string): Promise<void>;
  dispose(): Promise<void>;
}

interface StoredDeadLetter {
  idempotencyKey: string;
  mutation: Mutation;
  error: { name: string; message: string; stack?: string };
  parkedAt: number;
}

export function createSQLiteDeadLetterStorage(
  driver: SQLiteDriver,
  whenIdle: () => Promise<void>,
): DeadLetterStorage {
  let disposed = false;
  let closing = false;
  let disposePromise: Promise<void> | null = null;

  function assertOpen(): void {
    if (disposed || closing) {
      throw new Error("[@nizhal/db-collection] dead-letter storage is disposed");
    }
  }

  return {
    async list() {
      assertOpen();
      return driver.transaction(async (transactionDriver) => {
        const rows = await transactionDriver.query<{ value: string }>(
          "SELECT value FROM _nizhal_dead_letter ORDER BY parked_at ASC",
        );
        return rows.map((row) => deserializeDeadLetter(row.value));
      });
    },

    async park(entry) {
      assertOpen();
      await driver.transaction(async (transactionDriver) => {
        await transactionDriver.run(
          "INSERT INTO _nizhal_dead_letter (idempotency_key, value, parked_at) VALUES (?, ?, ?) ON CONFLICT(idempotency_key) DO UPDATE SET value = excluded.value, parked_at = excluded.parked_at",
          [entry.idempotencyKey, serializeDeadLetter(entry), entry.parkedAt],
        );
      });
    },

    async remove(idempotencyKey) {
      assertOpen();
      await driver.transaction(async (transactionDriver) => {
        await transactionDriver.run("DELETE FROM _nizhal_dead_letter WHERE idempotency_key = ?", [
          idempotencyKey,
        ]);
      });
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

function serializeDeadLetter(entry: NizhalPoisonEntry): string {
  const stored: StoredDeadLetter = {
    idempotencyKey: entry.idempotencyKey,
    mutation: entry.mutation,
    error: {
      name: entry.error.name,
      message: entry.error.message,
      stack: entry.error.stack,
    },
    parkedAt: entry.parkedAt,
  };
  return JSON.stringify(stored);
}

function deserializeDeadLetter(value: string): NizhalPoisonEntry {
  const stored = JSON.parse(value) as StoredDeadLetter;
  const error = new Error(stored.error.message);
  error.name = stored.error.name;
  error.stack = stored.error.stack;
  return {
    idempotencyKey: stored.idempotencyKey,
    mutation: stored.mutation,
    error,
    parkedAt: stored.parkedAt,
  };
}
