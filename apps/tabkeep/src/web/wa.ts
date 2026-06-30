import {
  type WaSqliteCoreApi,
  type WaSqlitePersistenceOptions,
  createSerializedWaSqliteDatabase,
} from "@nizhal/db-collection";
import * as SQLite from "wa-sqlite";
import SQLiteESMFactory from "wa-sqlite/dist/wa-sqlite-async.mjs";
import wasmUrl from "wa-sqlite/dist/wa-sqlite-async.wasm?url";
import { IDBBatchAtomicVFS } from "wa-sqlite/src/examples/IDBBatchAtomicVFS.js";

export async function openTabkeepDatabase(): Promise<WaSqlitePersistenceOptions["database"]> {
  const sqliteModule = await SQLiteESMFactory({ locateFile: () => wasmUrl });
  const sqlite3 = SQLite.Factory(sqliteModule);
  const vfs = new IDBBatchAtomicVFS("tabkeep-vfs");
  sqlite3.vfs_register(vfs as unknown as Parameters<typeof sqlite3.vfs_register>[0], true);
  const dbId = await sqlite3.open_v2(
    "tabkeep.db",
    SQLite.SQLITE_OPEN_READWRITE | SQLite.SQLITE_OPEN_CREATE,
    vfs.name,
  );
  const core: WaSqliteCoreApi = {
    open_v2: (name, flags, vfsName) => sqlite3.open_v2(name, flags, vfsName),
    close: async (database) => {
      await sqlite3.close(database);
    },
    statements: (database, sql) => sqlite3.statements(database, sql),
    bind_collection: (statement, params) =>
      sqlite3.bind_collection(
        statement,
        params as unknown as Parameters<typeof sqlite3.bind_collection>[1],
      ),
    column_names: (statement) => sqlite3.column_names(statement),
    step: (statement) => sqlite3.step(statement),
    row: (statement) => sqlite3.row(statement),
  };
  return createSerializedWaSqliteDatabase({
    sqlite3: core,
    dbId,
    sqliteRow: SQLite.SQLITE_ROW,
    sqliteDone: SQLite.SQLITE_DONE,
  });
}
