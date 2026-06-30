import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type WaSqliteCoreApi, createSerializedWaSqliteDatabase } from "@nizhal/db-collection";
import type { BrowserWASQLiteDatabase } from "@tanstack/browser-db-sqlite-persistence";
import { NodeFileVFS } from "./node-file-vfs.js";

export interface WaSqliteEnv {
  openDatabase(name: string): Promise<BrowserWASQLiteDatabase & { close(): Promise<void> }>;
  close(): Promise<void>;
  rootDir: string;
}

export async function createWaSqliteEnv(prefix = "echo-chaos-"): Promise<WaSqliteEnv> {
  const rootDir = await mkdtemp(join(tmpdir(), prefix));

  const [{ default: SQLiteESMFactory }, SQLite] = await Promise.all([
    import("wa-sqlite/dist/wa-sqlite.mjs"),
    import("wa-sqlite"),
  ]);

  const require = createRequire(import.meta.url);
  const wasmBinary = await readFile(require.resolve("wa-sqlite/dist/wa-sqlite.wasm"));
  const module = await SQLiteESMFactory({ wasmBinary });
  const sqliteModule = SQLite as unknown as {
    Factory: (
      module: unknown,
    ) => WaSqliteCoreApi & { vfs_register(vfs: unknown, makeDefault: boolean): void };
    SQLITE_ROW: number;
    SQLITE_DONE: number;
  };
  const sqlite3 = sqliteModule.Factory(module);
  const vfs = new NodeFileVFS(rootDir);
  sqlite3.vfs_register(vfs, false);
  const openFlags = 0x2 | 0x4;

  return {
    async openDatabase(name) {
      const dbId = await sqlite3.open_v2(name, openFlags, vfs.name);
      return createSerializedWaSqliteDatabase({
        sqlite3,
        dbId,
        sqliteRow: sqliteModule.SQLITE_ROW,
        sqliteDone: sqliteModule.SQLITE_DONE,
      });
    },
    async close() {
      vfs.close();
    },
    rootDir,
  };
}

export async function destroyWaSqliteEnv(env: WaSqliteEnv): Promise<void> {
  await env.close();
  await rm(env.rootDir, { recursive: true, force: true });
}
