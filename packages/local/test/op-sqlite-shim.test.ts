import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";
import { opSqliteDrizzle } from "../src/op-sqlite.js";

// Contract test for the op-sqlite v17 shim (drizzle-team/drizzle-orm#5928 ×
// OP-Engineering/op-sqlite#424 — "wait until drizzle updates its adapter", i.e. no working
// upstream combination exists). This runs the REAL drizzle-orm/op-sqlite driver against a fake
// v17 client backed by better-sqlite3, so CI breaks loudly if either side of the contract moves:
// if drizzle changes what it calls (their adapter gets fixed) or the shim's mapping regresses.

const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  done: integer("done", { mode: "boolean" }).notNull(),
});

/** A faithful op-sqlite v17 surface (async execute, object-shaped executeRaw — issue #424). */
function fakeOpSqliteV17(sqlite: Database.Database) {
  const run = (sql: string, params: unknown[] = []) => {
    const statement = sqlite.prepare(sql);
    if (statement.reader) {
      const rows = statement.all(params) as Record<string, unknown>[];
      return { rows, rowsAffected: 0 };
    }
    const info = statement.run(params);
    return {
      rows: [] as Record<string, unknown>[],
      rowsAffected: info.changes,
      insertId: Number(info.lastInsertRowid),
    };
  };
  return {
    execute: async (sql: string, params?: unknown[]) => run(sql, params ?? []),
    executeSync: (sql: string, params?: unknown[]) => run(sql, params ?? []),
    // v17.0.0's breaking shape: a RawQueryResult OBJECT, not the array drizzle expects.
    executeRaw: async (sql: string, params?: unknown[]) => {
      const statement = sqlite.prepare(sql);
      const rawRows = statement.reader ? (statement.raw(true).all(params ?? []) as unknown[]) : [];
      return { rawRows };
    },
  };
}

describe("opSqliteDrizzle — the real drizzle op-sqlite driver over a v17 client", () => {
  function open() {
    const sqlite = new Database(":memory:");
    sqlite.exec(
      "CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, done INTEGER NOT NULL)",
    );
    return { sqlite, db: opSqliteDrizzle(fakeOpSqliteV17(sqlite), { schema: { tasks } }) };
  }

  it("insert / select / update / delete round-trip (the #5928 crash path)", async () => {
    const { db, sqlite } = open();
    await db.insert(tasks).values({ id: "a", title: "alpha", done: false });
    await db.insert(tasks).values({ id: "b", title: "beta", done: true });

    // select → values() → executeRawAsync → the exact `rows.map` crash site
    const open_ = await db.select().from(tasks).where(eq(tasks.done, false));
    expect(open_).toEqual([{ id: "a", title: "alpha", done: false }]);

    await db.update(tasks).set({ done: true }).where(eq(tasks.id, "a"));
    await db.delete(tasks).where(eq(tasks.id, "b"));
    const rows = await db.select().from(tasks);
    expect(rows).toEqual([{ id: "a", title: "alpha", done: true }]);
    sqlite.close();
  });

  it("relational query (get path) works through the shim", async () => {
    const { db, sqlite } = open();
    await db.insert(tasks).values({ id: "x", title: "find me", done: false });
    const found = await db.query.tasks.findFirst({ where: eq(tasks.id, "x") });
    expect(found?.title).toBe("find me");
    sqlite.close();
  });

  it("also tolerates 17.1-style array results from executeRaw", async () => {
    const sqlite = new Database(":memory:");
    sqlite.exec(
      "CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, done INTEGER NOT NULL)",
    );
    const client = fakeOpSqliteV17(sqlite);
    const arrayClient = {
      ...client,
      executeRaw: async (sql: string, params?: unknown[]) =>
        (await client.executeRaw(sql, params)).rawRows,
    };
    const db = opSqliteDrizzle(arrayClient, { schema: { tasks } });
    await db.insert(tasks).values({ id: "y", title: "array shape", done: false });
    expect((await db.select().from(tasks))[0]?.title).toBe("array shape");
    sqlite.close();
  });
});
