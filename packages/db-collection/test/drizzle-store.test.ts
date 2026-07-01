import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { defineMutator, defineMutators, defineSyncRules, z } from "@nizhal/kernel";
import { type NizhalAuth, createNizhalServer } from "@nizhal/server";
import { postgresStorage } from "@nizhal/server/adapters";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { boolean, pgTable, text } from "drizzle-orm/pg-core";
import { afterAll, describe, expect, it, vi } from "vitest";
import { nizhalOutbox } from "../src/drizzle/control-schema.js";
import {
  type NizhalStore,
  createNizhalClient,
  manualOnlineDetector,
  openNizhalStore,
} from "../src/index.js";

// The drizzle-native sync client (rfc-drizzle-native-sync-client T8/T9) against the REAL server
// on PGlite: convergence, offline durability across restart, 409 resync, tombstones, and the
// replay-rebase — the loss scenarios the legacy suite guards, re-targeted at the new plane.

const tasks = pgTable("dz_tasks", {
  id: text("id").primaryKey(),
  owner_id: text("owner_id").notNull(),
  title: text("title").notNull(),
  done: boolean("done").notNull(),
});
const schema = { tasks };

const syncRules = defineSyncRules((b) => ({
  ownerBucket: b.bucket({
    parameters: () => b.params({ ownerId: "owner_id" }),
    data: (bucket) => [b.table("dz_tasks").where(b.eq("owner_id", bucket.ownerId))],
  }),
}));

const auth: NizhalAuth = {
  async resolve() {
    return { userId: "dz-user", ownerId: "dz-owner" };
  },
};

const id = z.string().min(1);
const taskMutators = defineMutators({
  addTask: defineMutator(
    z.object({ id, title: z.string().min(1) }),
    async ({ tx, actor }, args) => {
      await tx
        .insert(tasks)
        .values({ id: args.id, owner_id: actor.ownerId, title: args.title, done: false });
      return { serverId: args.id, affectedBuckets: [actor.ownerId] };
    },
  ),
  completeTask: defineMutator(z.object({ id }), async ({ tx }, args) => {
    await tx.update(tasks, { id: args.id }).set({ done: true });
    return { serverId: args.id, affectedBuckets: ["dz-owner"] };
  }),
  renameTask: defineMutator(z.object({ id, title: z.string().min(1) }), async ({ tx }, args) => {
    await tx.update(tasks, { id: args.id }).set({ title: args.title });
    return { serverId: args.id, affectedBuckets: ["dz-owner"] };
  }),
  removeTask: defineMutator(z.object({ id }), async ({ tx }, args) => {
    await tx.delete(tasks, { id: args.id });
    return { serverId: args.id, affectedBuckets: ["dz-owner"] };
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
    create table dz_tasks (
      id text primary key,
      owner_id text not null,
      title text not null,
      done boolean not null default false
    )
  `);
  await storage.provision({ schema: {}, syncRules });
  const server = createNizhalServer({
    db: "postgres://unused",
    schema: {},
    mutators: taskMutators,
    syncRules,
    auth,
    storage,
  });
  const listener = await serveFetch(server.app.fetch as unknown as typeof fetch);
  cleanups.push(listener.close);

  const dir = mkdtempSync(join(tmpdir(), "nizhal-dz-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

  async function openStore(options: {
    file: string;
    online?: boolean;
    seedClientId?: string;
  }): Promise<{
    store: NizhalStore<typeof schema, typeof taskMutators>;
    detector: ReturnType<typeof manualOnlineDetector>;
    sqlite: Database.Database;
  }> {
    const sqlite = new Database(join(dir, options.file));
    const db = drizzle(sqlite);
    if (options.seedClientId) {
      sqlite
        .prepare(
          "CREATE TABLE IF NOT EXISTS nizhal_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
        )
        .run();
      sqlite
        .prepare("INSERT OR REPLACE INTO nizhal_meta (key, value) VALUES ('client-id', ?)")
        .run(options.seedClientId);
    }
    const detector = manualOnlineDetector();
    if (options.online === false) detector.setOnline(false);
    const echo = createNizhalClient({
      server: listener.baseUrl,
      bucketsForSyncRule: () => ["dz-owner"],
    });
    const store = await openNizhalStore({
      echo,
      schema,
      syncRules,
      mutators: taskMutators,
      actor: { userId: "dz-user", ownerId: "dz-owner" },
      database: db,
      onlineDetector: detector,
      retryBaseMs: 20,
    });
    cleanups.push(() => store.dispose());
    return { store, detector, sqlite };
  }

  return { openStore };
}

describe("drizzle-native sync client (real server on pglite)", () => {
  it("two clients converge through mutate → push → pull; queries are real drizzle SQL", async () => {
    const harness = await createHarness();
    const a = await harness.openStore({ file: "conv-a.db" });
    const b = await harness.openStore({ file: "conv-b.db" });
    await a.store.ready();

    a.store.mutate.addTask({ id: "t1", title: "from A" });
    await a.store.waitForIdle();
    expect(await a.store.getPendingCount()).toBe(0);

    await b.store.pullNow();
    const rows = await b.store.db
      .select()
      .from(b.store.tables.tasks)
      .where(eq(b.store.tables.tasks.done, false));
    expect(rows).toEqual([{ id: "t1", owner_id: "dz-owner", title: "from A", done: false }]);
  });

  it("watch re-runs live on both optimistic writes and pulled authoritative rows", async () => {
    const harness = await createHarness();
    const a = await harness.openStore({ file: "watch-a.db" });
    const b = await harness.openStore({ file: "watch-b.db" });

    const seen: Array<number> = [];
    b.store.watch(b.store.db.select().from(b.store.tables.tasks), ({ data, error }) => {
      expect(error).toBeUndefined();
      if (data) seen.push((data as unknown[]).length);
    });
    await vi.waitFor(() => expect(seen.length).toBeGreaterThanOrEqual(1));

    a.store.mutate.addTask({ id: "w1", title: "watched" });
    await a.store.waitForIdle();
    await b.store.pullNow();
    await vi.waitFor(() => expect(seen.at(-1)).toBe(1));

    // optimistic local write re-renders immediately, before any network
    b.store.mutate.addTask({ id: "w2", title: "local optimistic" });
    await vi.waitFor(() => expect(seen.at(-1)).toBe(2));
  });

  it("offline write survives a full restart and flushes when connectivity returns (the un-skipped loss repro)", async () => {
    const harness = await createHarness();
    const first = await harness.openStore({ file: "offline.db", online: false });

    first.store.mutate.addTask({ id: "off1", title: "written offline" });
    await vi.waitFor(async () => expect(await first.store.getPendingCount()).toBe(1));
    // the optimistic row is durable in the real table, not just in memory
    const localRows = await first.store.db.select().from(first.store.tables.tasks);
    expect(localRows.map((row) => row.id)).toEqual(["off1"]);
    await first.store.dispose();
    first.sqlite.close();

    // restart: same file, new store, still offline — outbox and optimistic row both survived
    const second = await harness.openStore({ file: "offline.db", online: false });
    expect(await second.store.getPendingCount()).toBe(1);
    const survivedRows = await second.store.db.select().from(second.store.tables.tasks);
    expect(survivedRows.map((row) => row.id)).toEqual(["off1"]);

    // connectivity returns → auto-flush → the write lands on the server
    second.detector.setOnline(true);
    await second.store.waitForIdle();
    expect(await second.store.getPendingCount()).toBe(0);

    const reader = await harness.openStore({ file: "offline-reader.db" });
    await reader.store.pullNow();
    const pulled = await reader.store.db.select().from(reader.store.tables.tasks);
    expect(pulled.map((row) => row.title)).toEqual(["written offline"]);
  });

  it("recovers from a 409 out-of-order via authoritative downward resync", async () => {
    const harness = await createHarness();
    const first = await harness.openStore({ file: "seq-1.db" });
    first.store.mutate.addTask({ id: "s1", title: "seq one" });
    await first.store.waitForIdle();

    // A second device seeded with the SAME clientID but a fresh meta store: its local high-water
    // is 0, so it allocates mutationID 1 — the server (at 1) rejects out-of-order and states its
    // position; the client must resync and converge instead of parking or looping.
    const clientId = first.sqlite
      .prepare("SELECT value FROM nizhal_meta WHERE key = 'client-id'")
      .get() as { value: string };
    const second = await harness.openStore({ file: "seq-2.db", seedClientId: clientId.value });
    second.store.mutate.addTask({ id: "s2", title: "seq two" });
    await second.store.waitForIdle();
    expect(await second.store.getPendingCount()).toBe(0);
    expect(second.store.deadLetter).toHaveLength(0);

    const reader = await harness.openStore({ file: "seq-reader.db" });
    await reader.store.pullNow();
    const pulled = await reader.store.db.select().from(reader.store.tables.tasks);
    expect(pulled.map((row) => row.id).sort()).toEqual(["s1", "s2"]);
  });

  it("tombstoned deletes propagate into the client tables", async () => {
    const harness = await createHarness();
    const a = await harness.openStore({ file: "del-a.db" });
    const b = await harness.openStore({ file: "del-b.db" });

    a.store.mutate.addTask({ id: "d1", title: "to delete" });
    await a.store.waitForIdle();
    await b.store.pullNow();
    expect((await b.store.db.select().from(b.store.tables.tasks)).map((r) => r.id)).toEqual(["d1"]);

    a.store.mutate.removeTask({ id: "d1" });
    await a.store.waitForIdle();
    await b.store.pullNow();
    expect(await b.store.db.select().from(b.store.tables.tasks)).toEqual([]);
  });

  it("replay-rebase: a pending offline write survives an authoritative overwrite of the same row", async () => {
    const harness = await createHarness();
    const a = await harness.openStore({ file: "rebase-a.db" });
    const b = await harness.openStore({ file: "rebase-b.db" });

    a.store.mutate.addTask({ id: "r1", title: "original" });
    await a.store.waitForIdle();
    await b.store.pullNow();

    // B goes offline and completes the task (pending in outbox, applied optimistically)
    b.detector.setOnline(false);
    b.store.mutate.completeTask({ id: "r1" });
    await vi.waitFor(async () => expect(await b.store.getPendingCount()).toBe(1));

    // A renames the same row — authoritative on the server
    a.store.mutate.renameTask({ id: "r1", title: "renamed by A" });
    await a.store.waitForIdle();

    // B pulls the authoritative rename; the rebase must re-establish B's pending completion
    await b.store.pullNow();
    const row = (await b.store.db.select().from(b.store.tables.tasks))[0];
    expect(row?.title).toBe("renamed by A");
    expect(row?.done).toBe(true); // ← the pending write survived the overwrite

    // back online: B's completion reaches the server and every device converges
    b.detector.setOnline(true);
    await b.store.waitForIdle();
    await a.store.pullNow();
    const converged = (await a.store.db.select().from(a.store.tables.tasks))[0];
    expect(converged?.title).toBe("renamed by A");
    expect(converged?.done).toBe(true);
  });

  it("outbox rows are drizzle-inspectable (the control plane is just tables)", async () => {
    const harness = await createHarness();
    const a = await harness.openStore({ file: "inspect.db", online: false });
    a.store.mutate.addTask({ id: "i1", title: "inspect me" });
    await vi.waitFor(async () => expect(await a.store.getPendingCount()).toBe(1));
    const outboxRows = await a.store.db.select().from(nizhalOutbox);
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0]?.envelope.name).toBe("addTask");
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
