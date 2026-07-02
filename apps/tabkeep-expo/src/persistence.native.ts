import type { NizhalKvStore } from "@nizhal/db-collection";
import type { TableChangeSource } from "@nizhal/local";
import { opSqliteChanges } from "@nizhal/local/op-sqlite";
import { open } from "@op-engineering/op-sqlite";
import { drizzle } from "drizzle-orm/op-sqlite";

export interface TabkeepDatabase {
  database: any;
  changes: TableChangeSource;
  /** Durable KV for the cached session (rides the same SQLite file as the store). */
  kv: NizhalKvStore;
}

// Native (iOS + Android): ONE durable SQLite file via op-sqlite — the derived drizzle tables,
// the nizhal outbox/meta, and the session KV all live in it. Writes persist on the device and
// survive restarts; that is the offline-first guarantee.
export async function openTabkeepDatabase(): Promise<TabkeepDatabase | undefined> {
  const raw = open({ name: "tabkeep.db" });
  await raw.execute(
    "CREATE TABLE IF NOT EXISTS tabkeep_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  );
  const kv: NizhalKvStore = {
    async get(key) {
      const result = await raw.execute("SELECT value FROM tabkeep_kv WHERE key = ?", [key]);
      const rows = (result as { rows?: Array<{ value?: string }> }).rows;
      return rows?.[0]?.value ?? null;
    },
    async set(key, value) {
      await raw.execute("INSERT OR REPLACE INTO tabkeep_kv (key, value) VALUES (?, ?)", [
        key,
        value,
      ]);
    },
  };
  return { database: drizzle(raw), changes: opSqliteChanges(raw), kv };
}
