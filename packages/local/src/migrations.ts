import type { BundledMigrations } from "./types.js";

interface MigratableDrizzleDb {
  dialect: {
    migrate(
      migrations: Array<{ sql: string[]; bps: boolean; folderMillis: number; hash: string }>,
      session: unknown,
    ): Promise<void>;
  };
  session: unknown;
}

/**
 * Apply a drizzle-kit bundled migration set (`{ journal, migrations }`) to any drizzle SQLite
 * database. Delegates to drizzle's own dialect migrator — identical bookkeeping
 * (`__drizzle_migrations`) and skip logic to the official expo-sqlite / op-sqlite migrators,
 * so it is safe to mix with them and idempotent across restarts.
 */
export async function applyBundledMigrations(
  db: unknown,
  bundle: BundledMigrations,
): Promise<void> {
  const internal = db as Partial<MigratableDrizzleDb>;
  if (typeof internal.dialect?.migrate !== "function" || internal.session === undefined) {
    throw new Error(
      "[@nizhal/local] applyBundledMigrations expects a drizzle SQLite database instance",
    );
  }
  const queries = bundle.journal.entries.map((entry) => {
    const sql = bundle.migrations[`m${entry.idx.toString().padStart(4, "0")}`];
    if (!sql) {
      throw new Error(`[@nizhal/local] missing migration for journal entry '${entry.tag}'`);
    }
    return {
      sql: sql.split("--> statement-breakpoint"),
      bps: entry.breakpoints,
      folderMillis: entry.when,
      hash: "",
    };
  });
  await internal.dialect.migrate(queries, internal.session);
}
