import { createSerializedWaSqliteDatabase } from "@nizhal/db-collection";
import * as SQLite from "wa-sqlite";
import SQLiteESMFactory from "wa-sqlite/dist/wa-sqlite-async.mjs";
import wasmUrl from "wa-sqlite/dist/wa-sqlite-async.wasm?url";
import { IDBBatchAtomicVFS } from "wa-sqlite/src/examples/IDBBatchAtomicVFS.js";

// Browser wa-sqlite over an IndexedDB-backed VFS (durable across reloads, no COOP/COEP needed).
export async function openWaSqlite(name: string) {
  const sqliteModule = await SQLiteESMFactory({ locateFile: () => wasmUrl });
  const sqlite3 = SQLite.Factory(sqliteModule);
  const vfs = new IDBBatchAtomicVFS("nizhal-chat-vfs");
  sqlite3.vfs_register(vfs, true);
  const dbId = await sqlite3.open_v2(
    name,
    SQLite.SQLITE_OPEN_READWRITE | SQLite.SQLITE_OPEN_CREATE,
    vfs.name,
  );
  return createSerializedWaSqliteDatabase({
    sqlite3,
    dbId,
    sqliteRow: SQLite.SQLITE_ROW,
    sqliteDone: SQLite.SQLITE_DONE,
  });
}
