import { safeRandomUUID } from "@tanstack/db";
import type { SQLiteDriver } from "@tanstack/db-sqlite-persistence-core";
import type { MutationIdStorage } from "../mutation-id.js";

const CLIENT_ID_META_KEY = "device_client_id";

export interface ClientIdStorage {
  getClientId(): Promise<string>;
}

export function createSQLiteClientIdStorage(driver: SQLiteDriver): ClientIdStorage {
  return {
    async getClientId() {
      const rows = await driver.query<{ value: string }>(
        "SELECT value FROM _nizhal_meta WHERE key = ?",
        [CLIENT_ID_META_KEY],
      );
      const existing = rows[0]?.value;
      if (existing) {
        return existing;
      }
      const clientId = safeRandomUUID();
      await driver.run(
        "INSERT INTO _nizhal_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [CLIENT_ID_META_KEY, clientId],
      );
      return clientId;
    },
  };
}

/**
 * Generic key/value over the `_nizhal_meta` table — durable per-device client metadata (e.g. the
 * mutation-id high-water). Distinct from the outbox: it is not a transaction store, so it never
 * shows up in outbox listings or counts.
 */
export function createSQLiteMetaStorage(driver: SQLiteDriver): MutationIdStorage {
  return {
    async get(key) {
      const rows = await driver.query<{ value: string }>(
        "SELECT value FROM _nizhal_meta WHERE key = ?",
        [key],
      );
      return rows[0]?.value ?? null;
    },
    async set(key, value) {
      await driver.run(
        "INSERT INTO _nizhal_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [key, value],
      );
    },
  };
}
