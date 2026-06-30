import type { BrowserWASQLiteDatabase } from "@tanstack/browser-db-sqlite-persistence";
import { isSqliteDuplicateColumnAddError, normalizeWaSqliteParams } from "./sqlite-bind.js";
import {
  type StorageOperationQueue,
  createStorageOperationQueue,
} from "./storage-operation-queue.js";

export interface WaSqliteCoreApi {
  open_v2(name: string, flags?: number, vfsName?: string): Promise<number>;
  close(db: number): Promise<void>;
  statements(db: number, sql: string): AsyncIterable<number>;
  bind_collection(statement: number, params: ReadonlyArray<unknown>): void;
  column_names(statement: number): ReadonlyArray<string>;
  step(statement: number): Promise<number>;
  row(statement: number): ReadonlyArray<unknown>;
}

export type SqliteModuleScheduler = <T>(operation: () => Promise<T>) => Promise<T>;

export interface NizhalSerializedWaSqliteDatabase extends BrowserWASQLiteDatabase {
  close(): Promise<void>;
  runSql<TRow>(sql: string, params?: ReadonlyArray<unknown>): Promise<ReadonlyArray<TRow>>;
  scheduleOperation: SqliteModuleScheduler;
  whenIdle(): Promise<void>;
}

export interface CreateSerializedWaSqliteDatabaseOptions {
  sqlite3: WaSqliteCoreApi;
  dbId: number;
  sqliteRow: number;
  sqliteDone: number;
}

const sqliteModuleQueues = new WeakMap<WaSqliteCoreApi, StorageOperationQueue>();

export function createSqliteModuleScheduler(sqlite3: WaSqliteCoreApi): SqliteModuleScheduler {
  let queue = sqliteModuleQueues.get(sqlite3);
  if (!queue) {
    queue = createStorageOperationQueue();
    sqliteModuleQueues.set(sqlite3, queue);
  }
  return <T>(operation: () => Promise<T>): Promise<T> => queue.enqueue(operation);
}

async function runWaSqliteStatement<TRow>(
  options: CreateSerializedWaSqliteDatabaseOptions,
  sql: string,
  params?: ReadonlyArray<unknown>,
): Promise<ReadonlyArray<TRow>> {
  const { sqlite3, dbId, sqliteRow, sqliteDone } = options;
  const boundParams = normalizeWaSqliteParams(params) ?? [];
  const rows: TRow[] = [];
  let parametersBound = false;

  try {
    for await (const statement of sqlite3.statements(dbId, sql)) {
      if (boundParams.length > 0) {
        if (parametersBound) {
          throw new Error(
            "[@nizhal/db-collection] wa-sqlite only supports parameter binding for a single SQL statement",
          );
        }
        sqlite3.bind_collection(statement, boundParams);
        parametersBound = true;
      }

      let columns = [...sqlite3.column_names(statement)];
      for (;;) {
        const stepResult = await sqlite3.step(statement);
        if (stepResult === sqliteRow) {
          if (columns.length === 0) {
            columns = [...sqlite3.column_names(statement)];
          }
          const values = sqlite3.row(statement);
          const obj: Record<string, unknown> = {};
          for (let i = 0; i < columns.length; i += 1) {
            const column = columns[i];
            if (column === undefined) continue;
            obj[column] = values[i];
          }
          rows.push(obj as TRow);
          continue;
        }
        if (stepResult === sqliteDone) {
          break;
        }
        throw new Error(
          `[@nizhal/db-collection] wa-sqlite step returned unexpected result code: ${String(stepResult)}`,
        );
      }
    }

    if (boundParams.length > 0 && !parametersBound) {
      throw new Error(
        "[@nizhal/db-collection] SQL query parameters were provided but no statement accepted bindings",
      );
    }

    return rows;
  } catch (error) {
    if (isSqliteDuplicateColumnAddError(error, sql)) {
      return [];
    }
    throw new Error(
      `[@nizhal/db-collection] wa-sqlite failed on SQL: ${sql.slice(0, 200)} — ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

export function createSerializedWaSqliteDatabase(
  options: CreateSerializedWaSqliteDatabaseOptions,
): NizhalSerializedWaSqliteDatabase {
  const scheduleOperation = createSqliteModuleScheduler(options.sqlite3);
  const runSql = <TRow>(sql: string, params?: ReadonlyArray<unknown>) =>
    runWaSqliteStatement<TRow>(options, sql, params);

  return {
    runSql,
    scheduleOperation,
    whenIdle: () => {
      const queue = sqliteModuleQueues.get(options.sqlite3);
      return queue?.whenIdle() ?? Promise.resolve();
    },
    execute: async <TRow>(sql: string, params?: ReadonlyArray<unknown>) =>
      scheduleOperation(() => runSql<TRow>(sql, params)),
    close: async () => {
      await scheduleOperation(async () => {
        await options.sqlite3.close(options.dbId);
      });
    },
  };
}
