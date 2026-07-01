import { sql } from "drizzle-orm";
import type { AnyDrizzleSqliteDb } from "./types.js";

/**
 * Serializes every Nizhal-initiated write sequence (mutations, pull-apply, rebase) on one promise
 * chain, and wraps each in an explicit BEGIN IMMEDIATE … COMMIT. Driver-generic on purpose:
 * drizzle's own `db.transaction` is sync-only on better-sqlite3 and async elsewhere; our mutator
 * functions are async, so we own the transaction envelope + the mutex that keeps two Nizhal write
 * sequences from interleaving statements on the shared connection.
 */
export interface WriteGate {
  run<T>(db: AnyDrizzleSqliteDb, fn: () => Promise<T>): Promise<T>;
}

export function createWriteGate(): WriteGate {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    run(db, fn) {
      const next = tail.then(async () => {
        await db.run(sql`begin immediate`);
        try {
          const result = await fn();
          await db.run(sql`commit`);
          return result;
        } catch (error) {
          try {
            await db.run(sql`rollback`);
          } catch {
            // the connection may already have rolled back (e.g. on I/O error) — surfacing the
            // original error matters more than the rollback's
          }
          throw error;
        }
      });
      tail = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    },
  };
}
