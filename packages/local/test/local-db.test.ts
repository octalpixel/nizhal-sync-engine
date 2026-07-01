import Database from "better-sqlite3";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { describe, expect, it, vi } from "vitest";
import { applyBundledMigrations, openLocalDb } from "../src/index.js";
import type { TableChangeSource } from "../src/index.js";
import { migrationsV1, migrationsV2, notes, schema, tasks } from "./fixtures.js";

function manualChanges(): TableChangeSource & { emit(table: string): void } {
  const listeners = new Set<(table: string) => void>();
  return {
    emit(table) {
      for (const fn of listeners) fn(table);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const flushWatchers = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("applyBundledMigrations", () => {
  it("applies a bundle, is idempotent, and applies later entries incrementally", async () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite, { schema });

    await applyBundledMigrations(db, migrationsV1);
    // Raw SQL here — the drizzle `tasks` def is v2-shaped (has `priority`) and the DB is at v1.
    await db.run(sql`INSERT INTO tasks (id, title) VALUES ('t1', 'first')`);
    expect(await db.select({ id: tasks.id }).from(tasks)).toHaveLength(1);

    // Re-running the same bundle must not re-execute anything (CREATE TABLE would throw).
    await applyBundledMigrations(db, migrationsV1);

    // The v2 bundle applies only the new entry — data survives, new column + table appear.
    await applyBundledMigrations(db, migrationsV2);
    await db.insert(notes).values({ id: "n1", body: "hello" });
    const rows = await db.select().from(tasks);
    expect(rows).toEqual([{ id: "t1", title: "first", done: 0, priority: 0 }]);

    await applyBundledMigrations(db, migrationsV2);
    sqlite.close();
  });

  it("rejects a bundle whose journal references a missing migration", async () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite, { schema });
    await expect(
      applyBundledMigrations(db, {
        journal: { entries: [{ idx: 7, when: 700, tag: "0007_ghost", breakpoints: true }] },
        migrations: {},
      }),
    ).rejects.toThrow(/missing migration/);
    sqlite.close();
  });

  it("rejects a non-drizzle database", async () => {
    await expect(applyBundledMigrations({}, migrationsV1)).rejects.toThrow(
      /expects a drizzle SQLite database/,
    );
  });
});

describe("openLocalDb", () => {
  async function openFixture() {
    const sqlite = new Database(":memory:");
    const changes = manualChanges();
    const local = await openLocalDb({
      db: drizzle(sqlite, { schema }),
      migrations: migrationsV2,
      changes,
      close: () => sqlite.close(),
    });
    return { local, changes };
  }

  it("exposes the real drizzle query builder", async () => {
    const { local } = await openFixture();
    await local.db.insert(tasks).values([
      { id: "a", title: "alpha" },
      { id: "b", title: "beta", done: 1 },
    ]);
    const open = await local.db.select().from(tasks).where(eq(tasks.done, 0));
    expect(open.map((row) => row.id)).toEqual(["a"]);
    const first = await local.db.query.tasks.findFirst({ where: eq(tasks.id, "b") });
    expect(first?.title).toBe("beta");
    await local.dispose();
  });

  it("watch runs immediately and re-runs when its table changes", async () => {
    const { local, changes } = await openFixture();
    await local.db.insert(tasks).values({ id: "a", title: "alpha" });

    const results: Array<ReadonlyArray<{ id: string }>> = [];
    const stop = local.watch(local.db.select().from(tasks), ({ data, error }) => {
      expect(error).toBeUndefined();
      if (data) results.push(data);
    });
    await vi.waitFor(() => expect(results).toHaveLength(1));

    await local.db.insert(tasks).values({ id: "b", title: "beta" });
    changes.emit("tasks");
    await vi.waitFor(() => expect(results).toHaveLength(2));
    expect(results[1]?.map((row) => row.id)).toEqual(["a", "b"]);

    // A change on an unrelated table must not re-run the query (primary table derived).
    changes.emit("notes");
    await flushWatchers();
    expect(results).toHaveLength(2);

    stop();
    changes.emit("tasks");
    await flushWatchers();
    expect(results).toHaveLength(2);
    await local.dispose();
  });

  it("watch honors an explicit tables override (joins)", async () => {
    const { local, changes } = await openFixture();
    let runs = 0;
    local.watch(
      local.db.select().from(tasks),
      () => {
        runs += 1;
      },
      { tables: ["tasks", "notes"] },
    );
    await vi.waitFor(() => expect(runs).toBe(1));
    changes.emit("notes");
    await vi.waitFor(() => expect(runs).toBe(2));
    await local.dispose();
  });

  it("coalesces a burst of changes into one re-run", async () => {
    const { local, changes } = await openFixture();
    let runs = 0;
    local.watch(local.db.select().from(tasks), () => {
      runs += 1;
    });
    await vi.waitFor(() => expect(runs).toBe(1));
    changes.emit("tasks");
    changes.emit("tasks");
    changes.emit("tasks");
    await flushWatchers();
    await vi.waitFor(() => expect(runs).toBe(2));
    await local.dispose();
  });

  it("surfaces query errors through the error field", async () => {
    const { local } = await openFixture();
    // A table that exists in the drizzle schema but was never migrated into the DB.
    const ghost = sqliteTable("ghost", { id: text("id").primaryKey() });
    const errors: Error[] = [];
    local.watch(local.db.select().from(ghost), ({ error }) => {
      if (error) errors.push(error);
    });
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(errors[0]?.message).toMatch(/ghost/);
    await local.dispose();
  });

  it("dispose stops the change feed", async () => {
    const { local, changes } = await openFixture();
    let runs = 0;
    local.watch(local.db.select().from(tasks), () => {
      runs += 1;
    });
    await vi.waitFor(() => expect(runs).toBe(1));
    await local.dispose();
    changes.emit("tasks");
    await flushWatchers();
    expect(runs).toBe(1);
  });
});
