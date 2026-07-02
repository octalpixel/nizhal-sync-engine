import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { defineMutator, defineMutators, defineSyncRules, z } from "@nizhal/kernel";
import {
  DEFAULT_TOMBSTONE_RETENTION_MS,
  type NizhalAuth,
  createNizhalServer,
  runTombstoneGc,
  toNizhalDb,
} from "@nizhal/server";
import { postgresStorage } from "@nizhal/server/adapters";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { pgTable, text } from "drizzle-orm/pg-core";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  type NizhalStore,
  createNizhalClient,
  manualOnlineDetector,
  openNizhalStore,
} from "../src/index.js";

// P2 (rfc-production-readiness T8/T9): the two resync triggers on the drizzle-native plane vs the
// REAL server on PGlite — server epoch (restore-from-backup detection) and the tombstone GC horizon
// (offline-past-GC re-bootstrap). Both must WIPE the client's tables so a deletion whose tombstone
// no longer exists does not resurrect, while a pending offline write survives via outbox replay.

const notes = pgTable("rz_notes", {
  id: text("id").primaryKey(),
  owner_id: text("owner_id").notNull(),
  body: text("body").notNull(),
});
const schema = { notes };

const syncRules = defineSyncRules((b) => ({
  ownerBucket: b.bucket({
    parameters: () => b.params({ ownerId: "owner_id" }),
    data: (bucket) => [b.table("rz_notes").where(b.eq("owner_id", bucket.ownerId))],
  }),
}));

const auth: NizhalAuth = {
  async resolve() {
    return { userId: "rz-user", ownerId: "rz-owner" };
  },
};

const id = z.string().min(1);
const noteMutators = defineMutators({
  addNote: defineMutator(z.object({ id, body: z.string().min(1) }), async ({ tx, actor }, args) => {
    await tx.insert(notes).values({ id: args.id, owner_id: actor.ownerId, body: args.body });
    return { serverId: args.id, affectedBuckets: [actor.ownerId] };
  }),
  removeNote: defineMutator(z.object({ id }), async ({ tx }, args) => {
    await tx.delete(notes, { id: args.id });
    return { serverId: args.id, affectedBuckets: ["rz-owner"] };
  }),
});

const cleanups: Array<() => void | Promise<void>> = [];
afterAll(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

async function createHarness() {
  const pg = new PGlite();
  cleanups.push(() => pg.close());
  const storage = postgresStorage({ connectionString: "postgres://unused", client: pg });
  await pg.exec(`
    create table rz_notes (
      id text primary key,
      owner_id text not null,
      body text not null
    )
  `);
  await storage.provision({ schema: {}, syncRules });
  const server = createNizhalServer({
    db: "postgres://unused",
    schema: {},
    mutators: noteMutators,
    syncRules,
    auth,
    storage,
  });
  const listener = await serveFetch(server.app.fetch as unknown as typeof fetch);
  cleanups.push(listener.close);

  const dir = mkdtempSync(join(tmpdir(), "nizhal-rz-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

  async function openStore(options: { file: string; online?: boolean }): Promise<{
    store: NizhalStore<typeof schema, typeof noteMutators>;
    detector: ReturnType<typeof manualOnlineDetector>;
    sqlite: Database.Database;
  }> {
    const sqlite = new Database(join(dir, options.file));
    const db = drizzle(sqlite);
    const detector = manualOnlineDetector();
    if (options.online === false) detector.setOnline(false);
    const echo = createNizhalClient({
      server: listener.baseUrl,
      bucketsForSyncRule: () => ["rz-owner"],
    });
    const store = await openNizhalStore({
      echo,
      schema,
      syncRules,
      mutators: noteMutators,
      actor: { userId: "rz-user", ownerId: "rz-owner" },
      database: db,
      onlineDetector: detector,
      retryBaseMs: 20,
    });
    cleanups.push(() => store.dispose());
    return { store, detector, sqlite };
  }

  async function query<T = Record<string, unknown>>(sql: string): Promise<T[]> {
    const res = await pg.query<T>(sql);
    return res.rows;
  }

  return { openStore, pg, query };
}

const ids = (rows: { id: string }[]) => rows.map((r) => r.id).sort();

describe("P2 resync — server epoch + GC horizon (real server on pglite)", () => {
  it("T8: an epoch change (restore-from-backup) resets the client, drops orphaned rows, replays the pending outbox", async () => {
    const harness = await createHarness();
    const a = await harness.openStore({ file: "epoch-a.db" });
    const b = await harness.openStore({ file: "epoch-b.db" });

    a.store.mutate.addNote({ id: "n1", body: "one" });
    a.store.mutate.addNote({ id: "n2", body: "two" });
    await a.store.waitForIdle();
    await b.store.pullNow();
    expect(ids(await b.store.db.select().from(b.store.tables.notes))).toEqual(["n1", "n2"]);

    // Simulate a restore-from-backup that predates n2: the server no longer has n2 and — because the
    // restore rolled the whole DB back — there is NO tombstone for it. The operator's runbook bumps
    // the epoch (what `nizhal reset` does). B still holds n2 locally: only the wipe can drop it.
    await harness.query("delete from rz_notes where id = 'n2'");
    await harness.query("update _nizhal_sync_control set epoch = 'epoch-after-restore'");

    // B has an unpushed offline write in flight when it returns.
    b.detector.setOnline(false);
    b.store.mutate.addNote({ id: "n3", body: "written while away" });
    await vi.waitFor(async () => expect(await b.store.getPendingCount()).toBe(1));

    b.detector.setOnline(true);
    await b.store.pullNow();
    await b.store.waitForIdle();

    // n1 survives (still authoritative), n2 is GONE (orphan dropped by the wipe — no resurrection),
    // n3 survives (pending write replayed on top of the fresh snapshot).
    expect(ids(await b.store.db.select().from(b.store.tables.notes))).toEqual(["n1", "n3"]);
    expect(await b.store.getPendingCount()).toBe(0);

    // Every device converges: n3 reached the server.
    const reader = await harness.openStore({ file: "epoch-reader.db" });
    await reader.store.pullNow();
    expect(ids(await reader.store.db.select().from(reader.store.tables.notes))).toEqual([
      "n1",
      "n3",
    ]);
  });

  it("T9: a cursor below the tombstone GC horizon triggers a clean re-hydration — GC'd deletes do not resurrect", async () => {
    const harness = await createHarness();
    const a = await harness.openStore({ file: "gc-a.db" });
    const b = await harness.openStore({ file: "gc-b.db" });

    a.store.mutate.addNote({ id: "g1", body: "g1" });
    a.store.mutate.addNote({ id: "g2", body: "g2" });
    await a.store.waitForIdle();
    await b.store.pullNow();
    expect(ids(await b.store.db.select().from(b.store.tables.notes))).toEqual(["g1", "g2"]);

    // g1 was deleted long ago and its tombstone has since been GC'd: the row is gone from the server
    // with NO tombstone left, and the GC horizon is advanced past B's (now stale) cursor.
    await harness.query("delete from rz_notes where id = 'g1'");
    await harness.query("delete from _nizhal_tombstones where row_id = 'g1'");
    await harness.query("update _nizhal_sync_control set tombstone_horizon = pg_current_xact_id()");

    // B pulls with its pre-horizon cursor → server emits cursorReset → B wipes and re-hydrates.
    await b.store.pullNow();
    // g1 does NOT resurrect (upsert-only apply would have kept it); g2 remains.
    expect(ids(await b.store.db.select().from(b.store.tables.notes))).toEqual(["g2"]);
  });

  it("T11: fleet-return — a client offline while its deletions were GC'd returns, re-bootstraps, and replays its pending outbox", async () => {
    const harness = await createHarness();
    const a = await harness.openStore({ file: "fleet-a.db" });
    const b = await harness.openStore({ file: "fleet-b.db" });

    a.store.mutate.addNote({ id: "f1", body: "one" });
    a.store.mutate.addNote({ id: "f2", body: "two" });
    await a.store.waitForIdle();
    await b.store.pullNow();
    expect(ids(await b.store.db.select().from(b.store.tables.notes))).toEqual(["f1", "f2"]);

    // B goes offline "for 3 months" and writes f3 locally; meanwhile A deletes f1 (a real tombstone).
    b.detector.setOnline(false);
    b.store.mutate.addNote({ id: "f3", body: "written while away" });
    await vi.waitFor(async () => expect(await b.store.getPendingCount()).toBe(1));
    a.store.mutate.removeNote({ id: "f1" });
    await a.store.waitForIdle();

    // Age f1's tombstone past the retention window, then run the REAL GC job: it prunes the tombstone
    // and advances the horizon past B's (now stale) cursor.
    await harness.query(
      "update _nizhal_tombstones set deleted_at = now() - interval '90 days' where row_id = 'f1'",
    );
    const gc = await runTombstoneGc(toNizhalDb(harness.pg).db, DEFAULT_TOMBSTONE_RETENTION_MS);
    expect(gc.pruned).toBe(1);
    expect(gc.horizon).not.toBeNull();

    // B returns: its pre-horizon cursor → cursorReset → wipe + re-hydrate (f2 only — f1's tombstone
    // is gone but must NOT resurrect) → outbox replay re-establishes the pending f3.
    b.detector.setOnline(true);
    await b.store.pullNow();
    await b.store.waitForIdle();
    expect(ids(await b.store.db.select().from(b.store.tables.notes))).toEqual(["f2", "f3"]);
    expect(await b.store.getPendingCount()).toBe(0);

    // Whole fleet converges: f3 reached the server, f1 stayed deleted.
    const reader = await harness.openStore({ file: "fleet-reader.db" });
    await reader.store.pullNow();
    expect(ids(await reader.store.db.select().from(reader.store.tables.notes))).toEqual([
      "f2",
      "f3",
    ]);
  });
});

function serveFetch(fetchFn: typeof fetch): Promise<{ baseUrl: string; close: () => void }> {
  const server = createServer((req, res) => {
    const url = `http://${req.headers.host ?? "127.0.0.1"}${req.url ?? "/"}`;
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const init: RequestInit = {
        method: req.method ?? "GET",
        headers: req.headers as unknown as HeadersInit,
      };
      if (chunks.length > 0) init.body = Buffer.concat(chunks);
      fetchFn(new Request(url, init)).then(async (response) => {
        res.statusCode = response.status;
        response.headers.forEach((value, key) => res.setHeader(key, value));
        res.end(Buffer.from(await response.arrayBuffer()));
      });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ baseUrl: `http://127.0.0.1:${port}`, close: () => server.close() });
    });
  });
}
