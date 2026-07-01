import type { TableChangeSource } from "./types.js";

/**
 * The slice of the `expo-sqlite` module this adapter needs. Passed in (rather than imported)
 * so this package carries no expo dependency — the app already imports `expo-sqlite` to open
 * the database.
 */
export interface ExpoSqliteModuleLike {
  addDatabaseChangeListener(
    listener: (event: { databaseName: string; tableName: string }) => void,
  ): { remove(): void };
}

/**
 * Change feed for expo-sqlite. The database must be opened with
 * `{ enableChangeListener: true }` or no events fire.
 *
 * ```ts
 * import * as SQLite from "expo-sqlite";
 * const changes = expoSqliteChanges(SQLite, { databaseName: "app.db" });
 * ```
 */
export function expoSqliteChanges(
  sqlite: ExpoSqliteModuleLike,
  options?: { databaseName?: string },
): TableChangeSource {
  return {
    subscribe(listener) {
      const subscription = sqlite.addDatabaseChangeListener((event) => {
        if (options?.databaseName && event.databaseName !== options.databaseName) return;
        listener(event.tableName);
      });
      return () => subscription.remove();
    },
  };
}
