// RFC-011 gate#2/3 — the latency + error-injecting transport harness.
//
// Unlike mutation-id-continuity.test.ts (in-process fake echo, instant, never throws), this drives the
// REAL client (createNizhalMutators + durable outbox + real sync-target HTTP transport) through an
// injecting HTTP layer into a REAL createNizhalServer over PGlite. The injecting layer adds per-push
// latency and transient/terminal faults on the push path — so the client's classifyPushError ->
// poison.park branch and the resync path are actually exercised. This is the loop that can reproduce
// (or rule out) the live multi-offline-batch loss.

import { createServer } from "node:http";
import { PGlite } from "@electric-sql/pglite";
import { defineMutator, defineMutators, defineSyncRules } from "@nizhal/kernel";
import { type NizhalAuth, createNizhalServer } from "@nizhal/server";
import type { RealtimeAdapter } from "@nizhal/server/adapters";
import { postgresStorage } from "@nizhal/server/adapters";
import { createCollection } from "@tanstack/db";
import { bigserial, pgTable, text } from "drizzle-orm/pg-core";
import { afterEach, describe, expect, it } from "vitest";
import {
  createMemoryStorage,
  createNizhalClient,
  createNizhalMutators,
  manualOnlineDetector,
  nizhalCollectionOptions,
} from "../src/index.js";

type Storage = ReturnType<typeof createMemoryStorage>;

// Wrap a storage so its WRITE ops resolve after a delay — models async wa-sqlite/op-sqlite persistence
// (the in-memory default is synchronous, which is why the live batch-strand never reproduced in-process).
function delayedStorage(base: Storage, ms: number): Storage {
  const delay = () => new Promise((r) => setTimeout(r, ms));
  return {
    get: (k) => base.get(k),
    keys: () => base.keys(),
    set: async (k, v) => {
      await delay();
      return base.set(k, v);
    },
    delete: async (k) => {
      await delay();
      return base.delete(k);
    },
    clear: () => base.clear(),
  } as Storage;
}

interface NoteRow {
  id: number;
  owner_id: string;
  body: string;
  client_id: string;
}

const notes = pgTable("notes", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  owner_id: text("owner_id").notNull(),
  body: text("body").notNull(),
  client_id: text("client_id"),
});

const syncRules = defineSyncRules((b) => ({
  ownerBucket: b.bucket({
    parameters: () => b.params({ ownerId: "owner_id" }),
    data: (bucket) => [b.table("notes").where(b.eq("owner_id", bucket.ownerId))],
  }),
}));

const auth: NizhalAuth = {
  async resolve() {
    return { userId: "user-1", ownerId: "owner-1" };
  },
};

const testMutators = defineMutators({
  addNote: defineMutator({ parse: parseAddNote }, async ({ tx, actor, location }, args) => {
    const result = (await tx.insert(notes).values({
      id: location === "client" ? 0 : undefined,
      owner_id: actor.ownerId,
      body: args.body,
      client_id: args.clientId,
    })) as { id: number }[];
    return { serverId: result[0]?.id, affectedBuckets: [actor.ownerId] };
  }),
});

// Per-test fault knob, read by the injecting fetch on every push.
interface Fault {
  latencyMs: number;
  failWhenBodyIncludes: string | null;
  status: number;
  remaining: number; // how many matching pushes to fault before letting through
  hangWhenBodyIncludes?: string | null; // RFC-011 F-C: a push that never responds
  hangRemaining?: number;
  hangPullRemaining?: number; // RFC-011 F-D: pulls that never respond (the ack reconciliation)
}

const openDbs: PGlite[] = [];
const openClosers: Array<() => void> = [];

describe("RFC-011 offline-batch transport harness (real client -> real server, injected faults)", () => {
  afterEach(async () => {
    for (const close of openClosers.splice(0)) close();
    await Promise.all(openDbs.splice(0).map((db) => db.close()));
  });

  // T1 — pure latency, NO error. If a message is lost here, the bug needs no error at all (worst case).
  it("T1: 3 offline writes flush with push latency, none lost", async () => {
    const fault: Fault = { latencyMs: 40, failWhenBodyIncludes: null, status: 0, remaining: 0 };
    const h = await createHarness(fault);
    const { mutate, detector } = h.stack;

    detector.setOnline(false);
    mutate.addNote({ clientId: "lat-1", body: "a" });
    mutate.addNote({ clientId: "lat-2", body: "b" });
    mutate.addNote({ clientId: "lat-3", body: "c" });
    detector.setOnline(true);

    await waitFor(async () => (await serverClientIds(h.db)).length >= 3);
    expect(await serverClientIds(h.db)).toEqual(["lat-1", "lat-2", "lat-3"]);
  });

  // T2 — transient (503) on the 2nd message's first push attempt. Must retry, not park; all 3 land.
  it("T2: transient 503 on the 2nd offline write retries; none lost", async () => {
    const fault: Fault = {
      latencyMs: 5,
      failWhenBodyIncludes: "tr-2",
      status: 503,
      remaining: 1,
    };
    const h = await createHarness(fault);
    const { mutate, detector } = h.stack;

    detector.setOnline(false);
    mutate.addNote({ clientId: "tr-1", body: "a" });
    mutate.addNote({ clientId: "tr-2", body: "b" });
    mutate.addNote({ clientId: "tr-3", body: "c" });
    detector.setOnline(true);

    await waitFor(async () => (await serverClientIds(h.db)).length >= 3, 8000);
    expect((await serverClientIds(h.db)).sort()).toEqual(["tr-1", "tr-2", "tr-3"]);
    expect(h.stack.deadLetter.length).toBe(0);
  });

  // T3 — terminal (400) on the 2nd message's push, forever. Characterize the loss: parked (observable in
  // deadLetter) or silently gone? And do the other two still converge?
  it("T3: terminal 400 on the 2nd offline write — characterize the loss", async () => {
    const fault: Fault = {
      latencyMs: 5,
      failWhenBodyIncludes: "term-2",
      status: 400,
      remaining: Number.MAX_SAFE_INTEGER,
    };
    const h = await createHarness(fault);
    const { mutate, detector } = h.stack;

    detector.setOnline(false);
    mutate.addNote({ clientId: "term-1", body: "a" });
    mutate.addNote({ clientId: "term-2", body: "b" });
    mutate.addNote({ clientId: "term-3", body: "c" });
    detector.setOnline(true);

    // give the batch time to flush + the terminal one to be parked
    await waitFor(async () => (await serverClientIds(h.db)).length >= 2, 8000).catch(() => {});
    const onServer = await serverClientIds(h.db);
    const parked = h.stack.deadLetter.map((d) => d.mutation.name);

    // Findings asserted as the harness observes them (these document the real behavior):
    // term-2 must NOT silently vanish — it is either still pending/parked, never "applied & gone".
    expect(onServer).not.toContain("term-2");
    // the other two must still converge despite the terminal one (resync past the gap)
    expect(onServer).toContain("term-1");
    expect(onServer).toContain("term-3");
    // surface where term-2 went for the report
    console.log(
      `[T3] on server: ${JSON.stringify(onServer)} | deadLetter: ${JSON.stringify(parked)}`,
    );
  });

  // T4 (RFC-011 F-B) — a parked write is recoverable: once the fault clears, retryDeadLetter lands it
  // and empties the dead-letter. Proves a parked write is never a permanent loss.
  it("T4: retryDeadLetter recovers a parked write once the fault clears", async () => {
    const fault: Fault = {
      latencyMs: 5,
      failWhenBodyIncludes: "rec-2",
      status: 400,
      remaining: Number.MAX_SAFE_INTEGER,
    };
    const h = await createHarness(fault);
    const { mutate, detector, retryDeadLetter, deadLetter } = h.stack;

    detector.setOnline(false);
    mutate.addNote({ clientId: "rec-1", body: "a" });
    mutate.addNote({ clientId: "rec-2", body: "b" });
    detector.setOnline(true);

    // rec-2 parks (terminal 400); rec-1 converges
    await waitFor(async () => deadLetter.length >= 1, 8000);
    expect(await serverClientIds(h.db)).toContain("rec-1");
    expect(await serverClientIds(h.db)).not.toContain("rec-2");

    // fault clears, user retries → rec-2 lands, dead-letter empties
    h.fault.remaining = 0;
    const recovered = await retryDeadLetter();
    expect(recovered).toBe(1);
    await waitFor(async () => (await serverClientIds(h.db)).includes("rec-2"), 8000);
    expect(deadLetter.length).toBe(0);
  });

  // T6 — does a SLOW-but-completing first push (the live cold-start: ~10s) strand the rest of the batch?
  // This probes the executor drain (executeAll/KeyScheduler) under latency, the live mechanism.
  it("T6: a slow (not hung) push must not strand the rest of the batch", async () => {
    const fault: Fault = { latencyMs: 2500, failWhenBodyIncludes: null, status: 0, remaining: 0 };
    const h = await createHarness(fault);
    const { mutate, detector } = h.stack;
    detector.setOnline(false);
    mutate.addNote({ clientId: "slow-1", body: "a" });
    mutate.addNote({ clientId: "slow-2", body: "b" });
    mutate.addNote({ clientId: "slow-3", body: "c" });
    detector.setOnline(true);
    await waitFor(async () => (await serverClientIds(h.db)).length >= 3, 30000);
    expect((await serverClientIds(h.db)).sort()).toEqual(["slow-1", "slow-2", "slow-3"]);
  });

  // T7 — the LIVE repro: ASYNC outbox persistence (wa-sqlite/op-sqlite) + a rapid offline batch + going
  // online. The optimistic commits persist async; if the online flush snapshots before they finish, the
  // late-persisted writes are stranded (never pushed, no error, no deadLetter) — the live silent loss.
  it("T7: async-persisted offline batch must all flush on online (no stranded tail)", async () => {
    const fault: Fault = { latencyMs: 30, failWhenBodyIncludes: null, status: 0, remaining: 0 };
    const h = await createHarness(fault, {
      outboxStorage: delayedStorage(createMemoryStorage(), 60),
    });
    const { mutate, detector } = h.stack;
    detector.setOnline(false);
    // rapid-fire, no await between sends — commits race the online flush, like the live web batch
    mutate.addNote({ clientId: "async-1", body: "a" });
    mutate.addNote({ clientId: "async-2", body: "b" });
    mutate.addNote({ clientId: "async-3", body: "c" });
    mutate.addNote({ clientId: "async-4", body: "d" });
    detector.setOnline(true);
    await waitFor(async () => (await serverClientIds(h.db)).length >= 4, 30000);
    expect((await serverClientIds(h.db)).sort()).toEqual([
      "async-1",
      "async-2",
      "async-3",
      "async-4",
    ]);
  });

  // T8 — async outbox + a SLOW first push together (the live combo). Probes the executor drain race
  // where getNext() transiently returns null while transactions are still pending and the loop breaks.
  it("T8: async outbox + slow first push must still drain the whole batch", async () => {
    const fault: Fault = { latencyMs: 1500, failWhenBodyIncludes: null, status: 0, remaining: 0 };
    const h = await createHarness(fault, {
      outboxStorage: delayedStorage(createMemoryStorage(), 90),
    });
    const { mutate, detector } = h.stack;
    detector.setOnline(false);
    for (let i = 1; i <= 5; i++) mutate.addNote({ clientId: `combo-${i}`, body: `m${i}` });
    detector.setOnline(true);
    await waitFor(async () => (await serverClientIds(h.db)).length >= 5, 40000);
    expect((await serverClientIds(h.db)).filter((id) => id.startsWith("combo-")).length).toBe(5);
  });

  // T9 (RFC-011 F-D) — the LIVE root cause: the post-push acknowledgement pull hangs, which left the
  // executor's single isRunning flag stuck true and stranded every later offline write. With the bounded
  // ack reconciliation the transaction completes anyway and the whole batch drains.
  it("T9: a hung acknowledgement pull must not strand the batch", async () => {
    const prevAck = process.env.NIZHAL_ACK_TIMEOUT_MS;
    const prevFetch = process.env.NIZHAL_FETCH_TIMEOUT_MS;
    process.env.NIZHAL_ACK_TIMEOUT_MS = "500"; // F-D bound
    process.env.NIZHAL_FETCH_TIMEOUT_MS = "20000"; // keep F-C from masking it
    try {
      const fault: Fault = { latencyMs: 5, failWhenBodyIncludes: null, status: 0, remaining: 0 };
      const h = await createHarness(fault); // preload pulls succeed (hang not yet armed)
      h.fault.hangPullRemaining = 100; // now hang every pull, including the ack reconciliation
      const { mutate, detector } = h.stack;
      detector.setOnline(false);
      for (let i = 1; i <= 3; i++) mutate.addNote({ clientId: `ack-${i}`, body: `m${i}` });
      detector.setOnline(true);
      await waitFor(async () => (await serverClientIds(h.db)).length >= 3, 15000);
      expect((await serverClientIds(h.db)).filter((id) => id.startsWith("ack-")).length).toBe(3);
    } finally {
      // biome-ignore lint/performance/noDelete: delete unsets the env var; assigning undefined stores the string "undefined"
      if (prevAck === undefined) delete process.env.NIZHAL_ACK_TIMEOUT_MS;
      else process.env.NIZHAL_ACK_TIMEOUT_MS = prevAck;
      // biome-ignore lint/performance/noDelete: delete unsets the env var; assigning undefined stores the string "undefined"
      if (prevFetch === undefined) delete process.env.NIZHAL_FETCH_TIMEOUT_MS;
      else process.env.NIZHAL_FETCH_TIMEOUT_MS = prevFetch;
    }
  });

  // T5 (RFC-011 F-C) — the live repro: a push whose response NEVER arrives must not wedge the batch.
  // Without the fetch timeout, hang-2's push never settles, holds withSequenceLock forever, and hang-3
  // is stuck behind it (silent loss). With the timeout it aborts -> retriable -> retries -> all land.
  it("T5: a hung push times out and retries instead of wedging the whole batch", async () => {
    const prev = process.env.NIZHAL_FETCH_TIMEOUT_MS;
    process.env.NIZHAL_FETCH_TIMEOUT_MS = "800";
    try {
      const fault: Fault = {
        latencyMs: 2,
        failWhenBodyIncludes: null,
        status: 0,
        remaining: 0,
        hangWhenBodyIncludes: "hang-2",
        hangRemaining: 1, // hang ONLY the first push of hang-2; the retry succeeds
      };
      const h = await createHarness(fault);
      const { mutate, detector, deadLetter } = h.stack;

      detector.setOnline(false);
      mutate.addNote({ clientId: "hang-1", body: "a" });
      mutate.addNote({ clientId: "hang-2", body: "b" });
      mutate.addNote({ clientId: "hang-3", body: "c" });
      detector.setOnline(true);

      // hang-3 must NOT be permanently wedged behind the hung hang-2
      await waitFor(async () => (await serverClientIds(h.db)).length >= 3, 15000);
      expect((await serverClientIds(h.db)).sort()).toEqual(["hang-1", "hang-2", "hang-3"]);
      expect(deadLetter.length).toBe(0);
    } finally {
      // biome-ignore lint/performance/noDelete: delete unsets the env var; assigning undefined stores the string "undefined"
      if (prev === undefined) delete process.env.NIZHAL_FETCH_TIMEOUT_MS;
      else process.env.NIZHAL_FETCH_TIMEOUT_MS = prev;
    }
  });
});

async function serverClientIds(db: PGlite): Promise<string[]> {
  const rows = await db.query<{ client_id: string }>(
    "select client_id from notes where client_id is not null order by id",
  );
  return rows.rows.map((r) => r.client_id);
}

function injectingFetch(realFetch: typeof fetch, fault: Fault): typeof fetch {
  return (async (input: Request | string | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname.includes("push")) {
      if (fault.latencyMs > 0) await new Promise((r) => setTimeout(r, fault.latencyMs));
      if (fault.hangWhenBodyIncludes && (fault.hangRemaining ?? 0) > 0) {
        const body = await request.clone().text();
        if (body.includes(fault.hangWhenBodyIncludes)) {
          fault.hangRemaining = (fault.hangRemaining ?? 0) - 1;
          return new Promise<Response>(() => {}); // never settles -> client must time out
        }
      }
      if (fault.failWhenBodyIncludes && fault.remaining > 0) {
        const body = await request.clone().text();
        if (body.includes(fault.failWhenBodyIncludes)) {
          fault.remaining -= 1;
          return new Response(`injected fault ${fault.status}`, { status: fault.status });
        }
      }
    }
    // RFC-011 F-D: hang the acknowledgement pull so it never settles — models the live ack reconciliation
    // that wedged the executor's isRunning flag and stranded the batch tail.
    if (url.pathname.includes("pull") && (fault.hangPullRemaining ?? 0) > 0) {
      fault.hangPullRemaining = (fault.hangPullRemaining ?? 0) - 1;
      return new Promise<Response>(() => {});
    }
    return realFetch(request);
  }) as typeof fetch;
}

async function createHarness(fault: Fault, opts?: { outboxStorage?: Storage }) {
  const db = new PGlite();
  openDbs.push(db);
  const storage = postgresStorage({ connectionString: "postgres://unused", client: db });
  await db.exec(`
    create table notes (
      id bigserial primary key,
      owner_id text not null,
      body text not null,
      client_id text unique
    );
  `);
  await storage.provision({ schema: {}, syncRules });

  const realtime = inProcessRealtime();
  const server = createNizhalServer({
    db: "postgres://unused",
    schema: {},
    mutators: testMutators,
    syncRules,
    auth,
    storage,
    realtime,
  });

  const listener = await serveFetch(injectingFetch(server.app.fetch, fault));
  openClosers.push(listener.close);

  const echo = createNizhalClient({
    server: listener.baseUrl,
    subscribeSource: {
      subscribe: (buckets, onMessage) => realtime.subscribe(buckets, { send: onMessage }),
    },
    bucketsForSyncRule: () => ["owner-1"],
  });
  const collection = createCollection(
    nizhalCollectionOptions<NoteRow>({
      name: "notes",
      syncRule: "ownerBucket",
      echo,
      bucketField: "owner_id",
      getKey: (row) => row.client_id ?? String(row.id),
    }),
  );
  await collection.preload();
  const detector = manualOnlineDetector();
  const { mutate, executor, deadLetter, retryDeadLetter, dispose } = createNizhalMutators({
    collections: { notes: collection },
    echo,
    actor: { userId: "user-1", ownerId: "owner-1" },
    mutators: testMutators,
    onlineDetector: detector,
    ...(opts?.outboxStorage ? { outboxStorage: opts.outboxStorage } : {}),
  });
  await executor.waitForInit();
  openClosers.push(() => void dispose());

  return {
    db,
    fault,
    stack: { collection, mutate, executor, deadLetter, retryDeadLetter, detector },
  };
}

function inProcessRealtime(): RealtimeAdapter {
  const registry = new Map<string, Set<{ send: (data: string) => void }>>();
  return {
    publish(bucket) {
      for (const socket of registry.get(bucket) ?? []) socket.send(`repull:${bucket}`);
    },
    subscribe(buckets, socket) {
      for (const bucket of buckets) {
        let set = registry.get(bucket);
        if (!set) {
          set = new Set();
          registry.set(bucket, set);
        }
        set.add(socket);
      }
      return () => {
        for (const bucket of buckets) registry.get(bucket)?.delete(socket);
      };
    },
  };
}

function serveFetch(fetchFn: typeof fetch): Promise<{ baseUrl: string; close: () => void }> {
  const server = createServer((req, res) => {
    const host = req.headers.host ?? "127.0.0.1";
    const url = `http://${host}${req.url ?? "/"}`;
    const method = req.method ?? "GET";
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const reqInit: RequestInit = { method, headers: req.headers as HeadersInit };
      if (chunks.length > 0) reqInit.body = Buffer.concat(chunks);
      fetchFn(new Request(url, reqInit))
        .then(async (response) => {
          res.statusCode = response.status;
          response.headers.forEach((value, key) => res.setHeader(key, value));
          res.end(Buffer.from(await response.arrayBuffer()));
        })
        .catch((error: Error) => {
          res.statusCode = 500;
          res.end(error.message);
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

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 4000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("condition not met before timeout");
    await new Promise((r) => setTimeout(r, 20));
  }
}

function parseAddNote(input: unknown): { clientId: string; body: string } {
  if (
    typeof input === "object" &&
    input !== null &&
    typeof (input as { clientId?: unknown }).clientId === "string" &&
    typeof (input as { body?: unknown }).body === "string"
  ) {
    return input as { clientId: string; body: string };
  }
  throw new Error("invalid addNote args");
}
