import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { defineMutator, defineMutators, defineSyncRules, z } from "@nizhal/kernel";
import { type NizhalAuth, createNizhalServer } from "@nizhal/server";
import { postgresStorage } from "@nizhal/server/adapters";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { pgTable, text } from "drizzle-orm/pg-core";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  type NizhalStore,
  createNizhalClient,
  httpSyncTarget,
  manualOnlineDetector,
  openNizhalStore,
} from "../../src/index.js";
import { type ChaosConfig, chaosSyncTarget, makeRng } from "./chaos-target.js";

// P3 (T13): the fault-injection scenarios on the drizzle-native plane vs the real server on PGlite.
// Every scenario is deterministic (seeded) so a failure is replayable. The invariant across all of
// them: under dropped / duplicated / delayed / 5xx transport, the fleet still converges with no
// duplicate and no loss — the engine's idempotency + contiguous-sequence resync + one-tx apply hold.

const items = pgTable("cx_items", {
  id: text("id").primaryKey(),
  owner_id: text("owner_id").notNull(),
  label: text("label").notNull(),
});
const schema = { items };
const syncRules = defineSyncRules((b) => ({
  ownerBucket: b.bucket({
    parameters: () => b.params({ ownerId: "owner_id" }),
    data: (bucket) => [b.table("cx_items").where(b.eq("owner_id", bucket.ownerId))],
  }),
}));
const auth: NizhalAuth = {
  async resolve() {
    return { userId: "cx-user", ownerId: "cx-owner" };
  },
};
const id = z.string().min(1);
const itemMutators = defineMutators({
  addItem: defineMutator(
    z.object({ id, label: z.string().min(1) }),
    async ({ tx, actor }, args) => {
      await tx.insert(items).values({ id: args.id, owner_id: actor.ownerId, label: args.label });
      return { serverId: args.id, affectedBuckets: [actor.ownerId] };
    },
  ),
  removeItem: defineMutator(z.object({ id }), async ({ tx }, args) => {
    await tx.delete(items, { id: args.id });
    return { serverId: args.id, affectedBuckets: ["cx-owner"] };
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
  await pg.exec(
    "create table cx_items (id text primary key, owner_id text not null, label text not null)",
  );
  await storage.provision({ schema: {}, syncRules });
  const server = createNizhalServer({
    db: "postgres://unused",
    schema: {},
    mutators: itemMutators,
    syncRules,
    auth,
    storage,
  });
  const listener = await serveFetch(server.app.fetch as unknown as typeof fetch);
  cleanups.push(listener.close);
  const dir = mkdtempSync(join(tmpdir(), "nizhal-cx-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

  async function openStore(options: { file: string; chaos: ChaosConfig }): Promise<{
    store: NizhalStore<typeof schema, typeof itemMutators>;
    detector: ReturnType<typeof manualOnlineDetector>;
    target: ReturnType<typeof chaosSyncTarget>;
  }> {
    const sqlite = new Database(join(dir, options.file));
    const detector = manualOnlineDetector();
    const target = chaosSyncTarget(httpSyncTarget(listener.baseUrl), options.chaos);
    const echo = createNizhalClient({
      syncTarget: target,
      bucketsForSyncRule: () => ["cx-owner"],
    });
    const store = await openNizhalStore({
      echo,
      schema,
      syncRules,
      mutators: itemMutators,
      actor: { userId: "cx-user", ownerId: "cx-owner" },
      database: drizzle(sqlite),
      onlineDetector: detector,
      retryBaseMs: 10,
    });
    cleanups.push(() => store.dispose());
    return { store, detector, target };
  }

  const serverIds = async () =>
    (await pg.query<{ id: string }>("select id from cx_items order by id")).rows.map((r) => r.id);

  return { openStore, serverIds };
}

const localIds = async (store: NizhalStore<typeof schema, typeof itemMutators>) =>
  (await store.db.select().from(store.tables.items)).map((r) => r.id).sort();

describe("P3 chaos — convergence under transport faults (real server on pglite)", () => {
  it("no loss and no duplicate under a lost-ack push storm (retry hits server idempotency)", async () => {
    const harness = await createHarness();
    const chaos: ChaosConfig = { rng: makeRng(1), pushFailRate: 0.8, pushFailMode: "after" };
    const a = await harness.openStore({ file: "storm.db", chaos });

    for (let i = 0; i < 6; i += 1) a.store.mutate.addItem({ id: `s${i}`, label: `s${i}` });
    // Faults are transient — quiesce, then everything must have flushed exactly once.
    await vi.waitFor(async () => expect(await a.store.getPendingCount()).toBe(0), {
      timeout: 15_000,
    });

    const expected = ["s0", "s1", "s2", "s3", "s4", "s5"];
    expect(await harness.serverIds()).toEqual(expected); // no duplicate rows on the server
    expect(await localIds(a.store)).toEqual(expected);
    expect(a.target.stats.pushFailures).toBeGreaterThan(0); // the storm really happened
  });

  it("deduplicates when the transport delivers every push twice", async () => {
    const harness = await createHarness();
    const chaos: ChaosConfig = { rng: makeRng(7), duplicateRate: 1 };
    const a = await harness.openStore({ file: "dup.db", chaos });

    for (let i = 0; i < 5; i += 1) a.store.mutate.addItem({ id: `d${i}`, label: `d${i}` });
    await vi.waitFor(async () => expect(await a.store.getPendingCount()).toBe(0), {
      timeout: 15_000,
    });

    expect(a.target.stats.duplicates).toBeGreaterThan(0);
    expect(await harness.serverIds()).toEqual(["d0", "d1", "d2", "d3", "d4"]); // each exactly once
  });

  it("an interrupted pull is atomic — a dropped pull never advances the cursor or applies a partial page", async () => {
    const harness = await createHarness();
    const writer = await harness.openStore({ file: "atom-w.db", chaos: { rng: makeRng(3) } });
    for (let i = 0; i < 4; i += 1) writer.store.mutate.addItem({ id: `p${i}`, label: `p${i}` });
    await writer.store.waitForIdle();

    // Reader whose pulls always fail: the pull throws before the client tx, so nothing is applied and
    // the cursor stays put — the reader is empty and consistent, never a half-applied page.
    const readerChaos: ChaosConfig = { rng: makeRng(3), pullFailRate: 1 };
    const reader = await harness.openStore({ file: "atom-r.db", chaos: readerChaos });
    await reader.store.pullNow();
    expect(await localIds(reader.store)).toEqual([]);
    expect(reader.target.stats.pullFailures).toBeGreaterThan(0);

    // Heal the partition: one clean pull applies the whole set atomically.
    readerChaos.pullFailRate = 0;
    await reader.store.pullNow();
    expect(await localIds(reader.store)).toEqual(["p0", "p1", "p2", "p3"]);
  });

  it("crash-during-flush: a write mid-flush survives store close/re-open and lands exactly once", async () => {
    const harness = await createHarness();
    // Push always fails after apply — so the write is delivered but the outbox never clears.
    const chaos: ChaosConfig = { rng: makeRng(5), pushFailRate: 1, pushFailMode: "after" };
    const first = await harness.openStore({ file: "crash.db", chaos });
    first.store.mutate.addItem({ id: "c1", label: "survivor" });
    await vi.waitFor(async () => expect(await first.store.getPendingCount()).toBe(1));
    await first.store.dispose(); // "crash" mid-flush — outbox entry still pending on disk

    // Re-open the same file with a healthy transport: the durable outbox flushes exactly once.
    const second = await harness.openStore({ file: "crash.db", chaos: { rng: makeRng(6) } });
    await vi.waitFor(async () => expect(await second.store.getPendingCount()).toBe(0), {
      timeout: 15_000,
    });
    expect(await harness.serverIds()).toEqual(["c1"]); // delivered once despite the pre-crash apply
  });

  it("seeded soak: two clients under mixed faults converge with no loss or duplicate", async () => {
    const harness = await createHarness();
    const chaosA: ChaosConfig = {
      rng: makeRng(42),
      pushFailRate: 0.4,
      pullFailRate: 0.3,
      duplicateRate: 0.25,
      delayMaxMs: 5,
      pushFailMode: "mix",
    };
    const chaosB: ChaosConfig = {
      rng: makeRng(99),
      pushFailRate: 0.4,
      pullFailRate: 0.3,
      duplicateRate: 0.25,
      delayMaxMs: 5,
      pushFailMode: "mix",
    };
    const a = await harness.openStore({ file: "soak-a.db", chaos: chaosA });
    const b = await harness.openStore({ file: "soak-b.db", chaos: chaosB });

    const rng = makeRng(2024);
    const live = new Set<string>();
    // A client only removes keys IT added: same-client add→remove is ordered by the outbox ordinal +
    // the server's contiguous-sequence check, so the expected set stays deterministic (cross-client
    // add/remove of one key could legitimately reorder — that's a harness ambiguity, not an engine bug).
    const owned: [string[], string[]] = [[], []];
    for (let step = 0; step < 24; step += 1) {
      const whoIdx = rng() < 0.5 ? 0 : 1;
      const who = whoIdx === 0 ? a : b;
      const mine = owned[whoIdx];
      if (rng() < 0.7 || mine.length === 0) {
        const key = `k${step}`;
        who.store.mutate.addItem({ id: key, label: key });
        mine.push(key);
        live.add(key);
      } else {
        const victim = mine.splice(Math.floor(rng() * mine.length), 1)[0];
        if (victim) {
          who.store.mutate.removeItem({ id: victim });
          live.delete(victim);
        }
      }
      if (rng() < 0.4) await who.store.pullNow().catch(() => {});
    }

    // Quiesce: faults off, drain both outboxes, cross-pull until everyone agrees.
    for (const c of [chaosA, chaosB]) {
      c.pushFailRate = 0;
      c.pullFailRate = 0;
      c.duplicateRate = 0;
      c.delayMaxMs = 0;
    }
    await a.store.waitForIdle();
    await b.store.waitForIdle();
    for (let round = 0; round < 3; round += 1) {
      await a.store.pullNow();
      await b.store.pullNow();
      await a.store.waitForIdle();
      await b.store.waitForIdle();
    }

    const expected = [...live].sort();
    expect(await harness.serverIds()).toEqual(expected);
    expect(await localIds(a.store)).toEqual(expected);
    expect(await localIds(b.store)).toEqual(expected);
    expect(await a.store.getPendingCount()).toBe(0);
    expect(await b.store.getPendingCount()).toBe(0);
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
