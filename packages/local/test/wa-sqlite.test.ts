import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openLocalDb } from "../src/index.js";
import type { LocalDb } from "../src/index.js";
import { type WaSqliteApiLike, waSqliteChanges, waSqliteDrizzle } from "../src/wa-sqlite.js";
import { migrationsV2, schema, tasks } from "./fixtures.js";

type WaSqliteApi = WaSqliteApiLike & {
  open_v2(name: string, flags?: number, vfsName?: string): Promise<number>;
};

// The real wa-sqlite wasm build running in Node — the same engine the browser uses,
// so this is a true end-to-end proof of the browser local-db path.
let sqlite3: WaSqliteApi;
let database: number;
let local: LocalDb<ReturnType<typeof waSqliteDrizzle<typeof schema>>>;

beforeAll(async () => {
  const [{ default: SQLiteESMFactory }, SQLite] = await Promise.all([
    import("wa-sqlite/dist/wa-sqlite.mjs"),
    import("wa-sqlite"),
  ]);
  const require = createRequire(import.meta.url);
  const wasmBinary = await readFile(require.resolve("wa-sqlite/dist/wa-sqlite.wasm"));
  const module = await SQLiteESMFactory({ wasmBinary });
  sqlite3 = (SQLite as unknown as { Factory: (module: unknown) => WaSqliteApi }).Factory(module);
  database = await sqlite3.open_v2(":memory:");

  local = await openLocalDb({
    db: waSqliteDrizzle({ sqlite3, database, config: { schema } }),
    migrations: migrationsV2,
    changes: waSqliteChanges(sqlite3, database),
    close: () => sqlite3.close(database),
  });
});

afterAll(async () => {
  await local.dispose();
});

describe("wa-sqlite local db (real wasm)", () => {
  it("applies bundled migrations and serves the drizzle query builder", async () => {
    await local.db.insert(tasks).values([
      { id: "a", title: "alpha" },
      { id: "b", title: "beta", done: 1 },
    ]);
    const rows = await local.db.select().from(tasks).where(eq(tasks.done, 0));
    expect(rows).toEqual([{ id: "a", title: "alpha", done: 0, priority: 0 }]);

    const first = await local.db.query.tasks.findFirst({ where: eq(tasks.id, "b") });
    expect(first?.title).toBe("beta");
  });

  it("supports drizzle transactions over the proxy driver", async () => {
    await local.db.transaction(async (tx) => {
      await tx.insert(tasks).values({ id: "tx1", title: "in-tx" });
      await tx.update(tasks).set({ done: 1 }).where(eq(tasks.id, "tx1"));
    });
    const row = await local.db.query.tasks.findFirst({ where: eq(tasks.id, "tx1") });
    expect(row?.done).toBe(1);

    await expect(
      local.db.transaction(async (tx) => {
        await tx.insert(tasks).values({ id: "tx2", title: "rolled back" });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await local.db.query.tasks.findFirst({ where: eq(tasks.id, "tx2") })).toBeUndefined();
  });

  it("watch auto-refreshes from the SQLite update hook — no manual invalidation", async () => {
    const seen: Array<ReadonlyArray<{ id: string }>> = [];
    const stop = local.watch(
      local.db.select().from(tasks).where(eq(tasks.title, "hooked")),
      ({ data, error }) => {
        expect(error).toBeUndefined();
        if (data) seen.push(data);
      },
    );
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).toEqual([]);

    await local.db.insert(tasks).values({ id: "hook1", title: "hooked" });
    await vi.waitFor(() => expect(seen.length).toBeGreaterThanOrEqual(2));
    expect(seen.at(-1)?.map((row) => row.id)).toEqual(["hook1"]);

    await local.db.delete(tasks).where(eq(tasks.id, "hook1"));
    await vi.waitFor(() => expect(seen.at(-1)).toEqual([]));
    stop();
  });

  it("serializes concurrent drizzle calls on one connection (no SQLITE_MISUSE)", async () => {
    await Promise.all(
      Array.from({ length: 25 }, (_, index) =>
        local.db.insert(tasks).values({ id: `burst-${index}`, title: `burst ${index}` }),
      ),
    );
    const rows = await local.db.select().from(tasks);
    expect(rows.filter((row) => row.id.startsWith("burst-"))).toHaveLength(25);
  });
});
