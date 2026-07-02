import { PGlite } from "@electric-sql/pglite";
import { type SyncRules, defineSyncRules } from "@nizhal/kernel";
import { afterEach, describe, expect, it } from "vitest";
import { postgresStorage } from "../src/adapters/storage.js";
import { toNizhalDb } from "../src/drizzle-db.js";
import { DEFAULT_TOMBSTONE_RETENTION_MS, runTombstoneGc } from "../src/tombstone-gc.js";

// P2 (T10): the tombstone GC job — prune tombstones older than the retention window and advance the
// GC horizon in one transaction; the advance is monotonic. The horizon it sets is what forces a
// straddling client to re-bootstrap (T9), exercised end-to-end in db-collection's resync/fleet suites.

const syncRules: SyncRules = defineSyncRules((b) => ({
  ownerBucket: b.bucket({
    parameters: () => b.params({ ownerId: "owner_id" }),
    data: (bucket) => [b.table("notes").where(b.eq("owner_id", bucket.ownerId))],
  }),
}));

const openDbs: PGlite[] = [];
afterEach(async () => {
  await Promise.all(openDbs.splice(0).map((db) => db.close()));
});

async function harness() {
  const pg = new PGlite();
  openDbs.push(pg);
  const storage = postgresStorage({ connectionString: "postgres://unused", client: pg });
  await pg.exec("create table notes (id text primary key, owner_id text not null, body text)");
  await storage.provision({ schema: {}, syncRules });
  const db = toNizhalDb(pg).db;
  const q = async <T = Record<string, unknown>>(sql: string): Promise<T[]> =>
    (await pg.query<T>(sql)).rows;
  const insertTombstone = (id: string, ageDays: number) =>
    pg.exec(
      `insert into _nizhal_tombstones (table_name, row_id, client_key, bucket_key, deleted_at)
       values ('notes', '${id}', '${id}', 'b', now() - interval '${ageDays} days')`,
    );
  const horizon = async () =>
    (
      await q<{ h: string | null }>("select tombstone_horizon::text as h from _nizhal_sync_control")
    )[0]?.h ?? null;
  const tombstoneCount = async () =>
    Number(
      (await q<{ c: number }>("select count(*)::int as c from _nizhal_tombstones"))[0]?.c ?? 0,
    );
  return { pg, db, q, insertTombstone, horizon, tombstoneCount };
}

describe("tombstone GC job (T10)", () => {
  it("prunes tombstones older than retention and advances the horizon in one step", async () => {
    const h = await harness();
    await h.insertTombstone("a", 40);
    await h.insertTombstone("b", 40);
    await h.insertTombstone("c", 40);
    expect(await h.horizon()).toBeNull();

    const result = await runTombstoneGc(h.db, DEFAULT_TOMBSTONE_RETENTION_MS);

    expect(result.pruned).toBe(3);
    expect(await h.tombstoneCount()).toBe(0);
    // horizon advanced to the max row_version among the pruned tombstones (non-null, matches result).
    expect(result.horizon).not.toBeNull();
    expect(await h.horizon()).toBe(result.horizon);
  });

  it("keeps tombstones within the retention window and prunes only the aged ones", async () => {
    const h = await harness();
    await h.insertTombstone("fresh", 0);
    await h.insertTombstone("aged", 40);

    const result = await runTombstoneGc(h.db, DEFAULT_TOMBSTONE_RETENTION_MS);

    expect(result.pruned).toBe(1);
    expect(await h.tombstoneCount()).toBe(1);
    const remaining = await h.q<{ row_id: string }>("select row_id from _nizhal_tombstones");
    expect(remaining.map((r) => r.row_id)).toEqual(["fresh"]);
  });

  it("no-ops when nothing has aged out (horizon stays put)", async () => {
    const h = await harness();
    await h.insertTombstone("fresh", 1);
    const result = await runTombstoneGc(h.db, DEFAULT_TOMBSTONE_RETENTION_MS);
    expect(result.pruned).toBe(0);
    expect(await h.horizon()).toBeNull();
    expect(await h.tombstoneCount()).toBe(1);
  });

  it("never regresses the horizon (monotonic advance)", async () => {
    const h = await harness();
    await h.insertTombstone("old", 40);
    // Advance the horizon past the aged tombstone's row_version (a later transaction id).
    await h.pg.exec("update _nizhal_sync_control set tombstone_horizon = pg_current_xact_id()");
    const before = await h.horizon();
    expect(before).not.toBeNull();

    const result = await runTombstoneGc(h.db, DEFAULT_TOMBSTONE_RETENTION_MS);

    expect(result.pruned).toBe(1); // the tombstone is still pruned…
    expect(await h.horizon()).toBe(before); // …but the horizon does not move backward
  });
});
