import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";

/** Any drizzle SQLite database (better-sqlite3 sync, expo/op/proxy async) — result mode erased. */
export type AnyDrizzleSqliteDb = BaseSQLiteDatabase<"sync" | "async", any, any>;

/** SQL table name → derived sqlite table (columns present for query building). */
export type DerivedTableMap = Record<string, SQLiteTable & { [column: string]: unknown }>;
