import type { NizhalKvStore } from "@nizhal/db-collection";
import { waSqliteChanges, waSqliteDrizzle } from "@nizhal/local/wa-sqlite";
import { sql } from "drizzle-orm";
import * as SQLite from "wa-sqlite";
import { IDBBatchAtomicVFS } from "wa-sqlite/src/examples/IDBBatchAtomicVFS.js";
import type { TabkeepDatabase } from "./persistence.native";

// The emscripten glue must NOT go through Metro: its `new URL(…, import.meta.url)` breaks under
// the bundler. Loading it with a browser-NATIVE dynamic import (built via Function so Metro can't
// rewrite it) gives real import.meta semantics, and the .wasm resolves next to the .mjs in /public.
const nativeImport = new Function("u", "return import(u)") as (
  url: string,
) => Promise<{ default: () => Promise<unknown> }>;

// Web: the same ONE-SQLite-file story as native, via wa-sqlite over an IndexedDB-backed VFS
// (durable across reloads, no COOP/COEP needed). The wasm binary is fetched from /public so the
// emscripten glue never needs import.meta URL resolution at runtime.
export async function openTabkeepDatabase(): Promise<TabkeepDatabase | undefined> {
  const { default: SQLiteESMFactory } = await nativeImport("/wa-sqlite-async.mjs");
  const module = await SQLiteESMFactory();
  const sqlite3 = SQLite.Factory(module);
  const vfs = new IDBBatchAtomicVFS("tabkeep-vfs");
  sqlite3.vfs_register(vfs, true);
  const dbId = await sqlite3.open_v2(
    "tabkeep.db",
    SQLite.SQLITE_OPEN_READWRITE | SQLite.SQLITE_OPEN_CREATE,
    vfs.name,
  );
  const database = waSqliteDrizzle({ sqlite3, database: dbId });
  await database.run(
    sql`CREATE TABLE IF NOT EXISTS tabkeep_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  );
  const kv: NizhalKvStore = {
    async get(key) {
      const rows = (await database.all(
        sql`SELECT value FROM tabkeep_kv WHERE key = ${key}`,
      )) as Array<{ value?: string }>;
      return rows[0]?.value ?? null;
    },
    async set(key, value) {
      await database.run(
        sql`INSERT OR REPLACE INTO tabkeep_kv (key, value) VALUES (${key}, ${value})`,
      );
    },
  };
  return { database, changes: waSqliteChanges(sqlite3, dbId), kv };
}
