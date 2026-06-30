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
  type NizhalPoisonEntry,
  createNizhalClient,
  createNizhalMutators,
  createNizhalStatus,
  keyForBlob,
  memoryBlobStore,
  nizhalCollectionOptions,
} from "../src/index.js";

interface NoteRow {
  id: number;
  owner_id: string;
  body: string;
  client_id: string;
}

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

const notes = pgTable("notes", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  owner_id: text("owner_id").notNull(),
  body: text("body").notNull(),
  client_id: text("client_id"),
});

const openDbs: PGlite[] = [];
const openHarnesses: TestHarness[] = [];

describe("@nizhal/db-collection status + blob helpers", () => {
  afterEach(async () => {
    await Promise.all(openDbs.splice(0).map((db) => db.close()));
    for (const harness of openHarnesses.splice(0)) harness.close();
  });

  it("exposes SyncStatus + outbox inspection wired to the offline executor", async () => {
    const harness = await createHarness({ includePoisonMutator: true });
    const { collection, mutate, executor, echo, deadLetter } = createClientStack(
      harness,
      "owner-1",
    );

    await collection.preload();
    await executor.waitForInit();

    const statuses: ReturnType<typeof echo.syncStatus>[] = [];
    const unsub = echo.onSyncStatus((status) => statuses.push(status));

    mutate.addNote({ clientId: "status-note", body: "hello" });
    await waitFor(() => echo.syncStatus().pendingMutations === 0);

    mutate.poisonNote({ clientId: "poison-1", body: "bad" });
    await waitFor(() => deadLetter.length > 0);

    const snapshot = echo.syncStatus();
    expect(snapshot.connectivity).toBe("online");
    expect(snapshot.pendingMutations).toBe(0);
    expect(snapshot.deadLettered).toBeGreaterThanOrEqual(1);
    expect(snapshot.lastPullCursor).not.toBe("");
    expect(snapshot.lastPulledAt).not.toBeNull();
    expect(echo.outbox.deadLetter().length).toBeGreaterThanOrEqual(1);

    const list = await echo.outbox.list();
    expect(list.every((entry) => typeof entry.id === "string")).toBe(true);

    unsub();
    expect(statuses.length).toBeGreaterThanOrEqual(1);
  });

  it("content-addresses blob keys and stores pending uploads offline", async () => {
    const file = new Blob(["hello"], { type: "text/plain" });
    const key = await keyForBlob(file);
    expect(key).toMatch(/^[a-f0-9]{64}$/);

    const store = memoryBlobStore();
    await store.put("cmid-1", file);
    const stored = await store.get("cmid-1");
    expect(stored).not.toBeUndefined();
    expect(await stored?.text()).toBe("hello");
    expect(await store.list()).toEqual(["cmid-1"]);
    await store.delete("cmid-1");
    expect(await store.list()).toEqual([]);
  });
});

function createClientStack(harness: TestHarness, ownerId: string) {
  const sharedDeadLetter: NizhalPoisonEntry[] = [];
  const status = createNizhalStatus({ deadLetter: sharedDeadLetter });
  const echo = createNizhalClient({
    server: harness.baseUrl,
    subscribeSource: {
      subscribe: (buckets, onMessage) => harness.realtime.subscribe(buckets, { send: onMessage }),
    },
    bucketsForSyncRule: () => [ownerId],
    status,
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

  const { mutate, executor, deadLetter } = createNizhalMutators({
    collections: { notes: collection },
    echo,
    actor: { userId: "user-1", ownerId },
    mutators: {
      addNote: testMutators.addNote,
      ...(harness.hasPoison ? { poisonNote: testMutators.poisonNote } : {}),
    },
    onPoison: (entry) => sharedDeadLetter.push(entry),
  });

  return { collection, mutate, executor, echo, deadLetter };
}

interface TestHarness {
  baseUrl: string;
  db: PGlite;
  realtime: RealtimeAdapter;
  hasPoison: boolean;
  close: () => void;
}

async function createHarness(opts?: { includePoisonMutator?: boolean }): Promise<TestHarness> {
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
  const mutators = defineMutators({
    addNote: testMutators.addNote,
    ...(opts?.includePoisonMutator ? { poisonNote: testMutators.poisonNote } : {}),
  });

  const server = createNizhalServer({
    db: "postgres://unused",
    schema: {},
    mutators,
    syncRules,
    auth,
    storage,
    realtime,
  });

  const listener = await serveFetch(server.app.fetch);
  const harness: TestHarness = {
    baseUrl: listener.baseUrl,
    db,
    realtime,
    hasPoison: opts?.includePoisonMutator === true,
    close: listener.close,
  };
  openHarnesses.push(harness);
  return harness;
}

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
  poisonNote: defineMutator({ parse: parseAddNote }, async ({ tx, actor, location }, args) => {
    if (location === "client") {
      await tx.insert(notes).values({
        id: 0,
        owner_id: actor.ownerId,
        body: args.body,
        client_id: args.clientId,
      });
      return { affectedBuckets: [actor.ownerId] };
    }
    throw new Error("deterministic poison failure");
  }),
});

function inProcessRealtime(): RealtimeAdapter {
  const registry = new Map<string, Set<{ send: (data: string) => void }>>();
  return {
    publish(bucket) {
      const subs = registry.get(bucket);
      if (!subs) return;
      for (const socket of subs) socket.send(`repull:${bucket}`);
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
      const init: RequestInit = { method, headers: req.headers as HeadersInit };
      if (chunks.length > 0) init.body = Buffer.concat(chunks);
      fetchFn(new Request(url, init))
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
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => server.close(),
      });
    });
  });
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
  throw new Error("invalid addNote input");
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 20_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out waiting for condition");
}
