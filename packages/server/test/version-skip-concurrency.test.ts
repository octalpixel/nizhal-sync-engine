import { defineSyncRules } from "@nizhal/kernel";
import { pgTable, text } from "drizzle-orm/pg-core";
import postgres from "postgres";
import { afterEach, describe, expect, it } from "vitest";
import { postgresStorage } from "../src/adapters/storage.js";

// Real-Postgres-only: the version-assignment-order ≠ commit-visibility-order skip can ONLY be
// reproduced with two genuinely-concurrent transactions, which PGlite (single connection) can't do.
// Point NIZHAL_TEST_DATABASE_URL at a local Postgres or a Neon branch to run it.
const URL = process.env.NIZHAL_TEST_DATABASE_URL;

const items = pgTable("items", {
  id: text("id").primaryKey(),
  owner_id: text("owner_id").notNull(),
});

const rules = defineSyncRules((b) => ({
  owner: b.bucket({
    parameters: () => b.params({ ownerId: "owner_id" }),
    data: (bucket) => [b.table("items").where(b.eq("owner_id", bucket.ownerId))],
  }),
}));

const actor = { userId: "u", ownerId: "o1" };

function rowIds(result: { changed: { rows: { id: string }[] }[] }): string[] {
  return result.changed.flatMap((c) => c.rows.map((r) => r.id)).sort();
}

describe.skipIf(!URL)("version-skip under real-Postgres concurrency", () => {
  let sql: postgres.Sql;

  afterEach(async () => {
    if (sql) await sql.end({ timeout: 5 });
  });

  async function freshStorage() {
    sql = postgres(URL as string, { max: 6, onnotice: () => {} });
    // clean slate each run (idempotent against a persistent Neon branch too)
    await sql.unsafe("drop schema if exists public cascade; create schema public;");
    await sql.unsafe("create table items (id text primary key, owner_id text not null)");
    const storage = postgresStorage({ connectionString: URL as string, client: sql });
    await storage.provision({ schema: { items }, syncRules: rules });
    return storage;
  }

  it("never skips a row that commits out-of-order (the root cause)", async () => {
    const storage = await freshStorage();
    const a = await sql.reserve();
    const b = await sql.reserve();
    try {
      // A grabs a LOW xid8 and holds its transaction open; B grabs a HIGHER xid8 and commits first.
      await a.unsafe("begin");
      await a.unsafe("insert into items (id, owner_id) values ('A','o1')");
      await b.unsafe("begin");
      await b.unsafe("insert into items (id, owner_id) values ('B','o1')");
      await b.unsafe("commit");

      // While A is in-flight the settled-prefix horizon = A's xid, so NEITHER A (in-flight) nor B
      // (xid above the horizon) is delivered. The reader never crosses an in-flight transaction.
      const pull1 = await storage.getChanges({
        actor,
        syncRules: rules,
        cursor: "",
        deviceId: "d1",
      });
      expect(rowIds(pull1)).toEqual([]);

      await a.unsafe("commit"); // A commits → horizon advances past both

      const pull2 = await storage.getChanges({
        actor,
        syncRules: rules,
        cursor: pull1.cursor,
        deviceId: "d1",
      });
      // No skip: A is delivered even though it committed AFTER the higher-versioned B.
      expect(rowIds(pull2)).toEqual(["A", "B"]);
    } finally {
      a.release();
      b.release();
    }
  }, 30_000);

  it("delivers every row to multiple devices on independent cursors (multi-device, no skip)", async () => {
    const storage = await freshStorage();
    await sql.unsafe("insert into items (id, owner_id) values ('seed','o1')");

    // Two devices of the same actor catch up independently, each with its own cursor.
    const d1a = await storage.getChanges({ actor, syncRules: rules, cursor: "", deviceId: "d1" });
    const d2a = await storage.getChanges({ actor, syncRules: rules, cursor: "", deviceId: "d2" });
    expect(rowIds(d1a)).toEqual(["seed"]);
    expect(rowIds(d2a)).toEqual(["seed"]);

    const a = await sql.reserve();
    const b = await sql.reserve();
    try {
      await a.unsafe("begin");
      await a.unsafe("insert into items (id, owner_id) values ('A','o1')");
      await b.unsafe("begin");
      await b.unsafe("insert into items (id, owner_id) values ('B','o1')");
      await b.unsafe("commit");

      // Mid-flight: both devices pull from their own cursors → neither crosses the in-flight A.
      const d1mid = await storage.getChanges({
        actor,
        syncRules: rules,
        cursor: d1a.cursor,
        deviceId: "d1",
      });
      const d2mid = await storage.getChanges({
        actor,
        syncRules: rules,
        cursor: d2a.cursor,
        deviceId: "d2",
      });
      expect(rowIds(d1mid)).toEqual([]);
      expect(rowIds(d2mid)).toEqual([]);

      await a.unsafe("commit");

      // Both devices, continuing from their own cursors, receive BOTH rows — no skip for either.
      const d1final = await storage.getChanges({
        actor,
        syncRules: rules,
        cursor: d1mid.cursor,
        deviceId: "d1",
      });
      const d2final = await storage.getChanges({
        actor,
        syncRules: rules,
        cursor: d2mid.cursor,
        deviceId: "d2",
      });
      expect(rowIds(d1final)).toEqual(["A", "B"]);
      expect(rowIds(d2final)).toEqual(["A", "B"]);
    } finally {
      a.release();
      b.release();
    }
  }, 30_000);

  it("writers never block each other — a held-open write does not stall a concurrent committer", async () => {
    await freshStorage();
    const a = await sql.reserve();
    const b = await sql.reserve();
    try {
      await a.unsafe("begin");
      await a.unsafe("insert into items (id, owner_id) values ('A','o1')");
      // The old singleton FOR UPDATE would block B here until A commits (deadlock → timeout).
      await b.unsafe("begin");
      const committed = b
        .unsafe("insert into items (id, owner_id) values ('B','o1')")
        .then(() => b.unsafe("commit"))
        .then(() => "committed");
      const raced = await Promise.race([
        committed,
        new Promise((resolve) => setTimeout(() => resolve("blocked"), 1_500)),
      ]);
      expect(raced).toBe("committed");
      await a.unsafe("commit");
    } finally {
      a.release();
      b.release();
    }
  }, 30_000);
});
