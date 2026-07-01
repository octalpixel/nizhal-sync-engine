import type { TableChangeSource } from "./types.js";

/** The slice of an op-sqlite `DB` handle this adapter needs (structural — no op-sqlite dep). */
export interface OpSqliteDatabaseLike {
  updateHook(callback: ((event: { table: string }) => void) | null): void;
}

/**
 * Change feed for op-sqlite, backed by its SQLite update hook.
 *
 * op-sqlite exposes a single hook slot per connection — this adapter owns it and fans out to
 * any number of subscribers. Do not call `db.updateHook` yourself after wiring this.
 */
export function opSqliteChanges(database: OpSqliteDatabaseLike): TableChangeSource {
  const listeners = new Set<(tableName: string) => void>();
  let hooked = false;

  return {
    subscribe(listener) {
      listeners.add(listener);
      if (!hooked) {
        hooked = true;
        database.updateHook((event) => {
          for (const fn of listeners) fn(event.table);
        });
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && hooked) {
          hooked = false;
          database.updateHook(null);
        }
      };
    },
  };
}
