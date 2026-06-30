import { createServer } from "node:http";
import { PGlite } from "@electric-sql/pglite";
import { defineMutator, defineMutators, defineSyncRules } from "@nizhal/kernel";
import { type NizhalAuth, createNizhalServer } from "@nizhal/server";
import type { RealtimeAdapter } from "@nizhal/server/adapters";
import { postgresStorage } from "@nizhal/server/adapters";
import { createCollection } from "@tanstack/db";
import { bigserial, pgTable, text } from "drizzle-orm/pg-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNizhalClient, createNizhalMutators, nizhalCollectionOptions } from "../src/index.js";

interface NoteRow {
  id: number;
  owner_id: string;
  body: string;
  client_id: string;
  updated_at?: string | Date;
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

const openDbs: PGlite[] = [];
const openHarnesses: TestHarness[] = [];

const notes = pgTable("notes", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  owner_id: text("owner_id").notNull(),
  body: text("body").notNull(),
  client_id: text("client_id"),
});

describe("reconnect + bootstrap + TTL (REQ-25)", () => {
  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(openDbs.splice(0).map((db) => db.close()));
    for (const harness of openHarnesses.splice(0)) harness.close();
  });

  it("test:reconnect-catchup — server edit while disconnected converges on reconnect", async () => {
    const harness = await createHarness();
    const { collection, mutate, executor } = createClientStack(harness, "owner-1");

    await collection.preload();
    await executor.waitForInit();

    mutate.addNote({ clientId: "reconnect-note", body: "before disconnect" });
    await waitFor(async () => {
      const rows = await harness.db.query("select * from notes where client_id = $1", [
        "reconnect-note",
      ]);
      return rows.rows.length === 1;
    });

    harness.realtime.disconnect();
    await harness.db.query("update notes set body = $1, updated_at = now() where client_id = $2", [
      "edited while down",
      "reconnect-note",
    ]);

    harness.realtime.reconnect();
    await waitFor(() =>
      collection.toArray.some(
        (n) => n.client_id === "reconnect-note" && n.body === "edited while down",
      ),
    );
  });

  it("test:reconnect-jitter — rapid reconnects coalesce catch-up pulls", async () => {
    vi.useFakeTimers();
    const harness = await createHarness();
    const { collection, executor, echo } = createClientStack(harness, "owner-1", {
      reconnect: { jitterMs: false },
    });

    let pulls = 0;
    const originalPull = echo.pull.bind(echo);
    echo.pull = async (input) => {
      pulls += 1;
      return originalPull(input);
    };

    await collection.preload();
    await executor.waitForInit();
    const pullsAfterInit = pulls;

    harness.realtime.disconnect();
    for (let i = 0; i < 8; i += 1) {
      harness.realtime.reconnect();
      harness.realtime.disconnect();
    }
    harness.realtime.reconnect();
    await vi.runAllTimersAsync();

    await waitFor(() => pulls > pullsAfterInit, 5_000);
    expect(pulls - pullsAfterInit).toBeLessThanOrEqual(2);
  });

  it("test:ttl-evict — out-of-scope bucket evicted after TTL; in-scope bucket kept", async () => {
    const harness = await createHarness();
    let scopeBuckets = ["owner-1", "owner-2"];
    const { collection, echo } = createClientStack(harness, "owner-1", {
      bucketsForSyncRule: () => scopeBuckets,
      ttl: { bucketTtlMs: 100 },
    });

    let pulls = 0;
    const originalPull = echo.pull.bind(echo);
    echo.pull = async (input) => {
      pulls += 1;
      if (pulls === 1) {
        return {
          changed: [
            {
              table: "notes",
              rows: [
                {
                  id: 10,
                  owner_id: "owner-1",
                  body: "keep",
                  client_id: "keep-1",
                },
                {
                  id: 20,
                  owner_id: "owner-2",
                  body: "stale",
                  client_id: "stale-1",
                },
              ],
            },
          ],
          tombstoned: [],
          cursor: "",
        };
      }
      return originalPull(input);
    };

    await collection.preload();
    await waitFor(() => collection.toArray.some((n) => n.client_id === "stale-1"));

    scopeBuckets = ["owner-1"];
    harness.realtime.publish("owner-1");
    await waitFor(() => pulls >= 2);

    expect(collection.toArray.some((n) => n.client_id === "stale-1")).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 150));
    harness.realtime.publish("owner-1");
    await waitFor(() => !collection.toArray.some((n) => n.client_id === "stale-1"));

    expect(collection.toArray.some((n) => n.client_id === "keep-1")).toBe(true);
  });

  it("test:bootstrap — large initial pull pages until fully caught up", async () => {
    const harness = await createHarness();
    const { collection, executor, echo } = createClientStack(harness, "owner-1", {
      pull: { pageSize: 3 },
    });

    const now = Date.now();
    for (let i = 0; i < 7; i += 1) {
      await harness.db.query(
        "insert into notes (id, owner_id, body, client_id, updated_at) values ($1, $2, $3, $4, to_timestamp($5 / 1000.0))",
        [100 + i, "owner-1", `row-${i}`, `bootstrap-${i}`, now + i * 1_000],
      );
    }

    let pulls = 0;
    const originalPull = echo.pull.bind(echo);
    echo.pull = async (input) => {
      pulls += 1;
      return originalPull(input);
    };

    await collection.preload();
    await executor.waitForInit();

    expect(pulls).toBeGreaterThanOrEqual(3);
    expect(collection.toArray.filter((n) => n.client_id?.startsWith("bootstrap-"))).toHaveLength(7);
  });
});

function createClientStack(
  harness: TestHarness,
  ownerId: string,
  opts?: {
    reconnect?: { jitterMs?: number | false };
    pull?: { pageSize?: number };
    ttl?: { bucketTtlMs?: number };
    bucketsForSyncRule?: () => string[];
  },
) {
  const echo = createNizhalClient({
    server: harness.baseUrl,
    reconnect: opts?.reconnect,
    pull: opts?.pull,
    ttl: opts?.ttl,
    subscribeSource: {
      subscribe: (buckets, onMessage, onReconnect) =>
        harness.realtime.subscribe(buckets, { send: onMessage, onReconnect }),
    },
    bucketsForSyncRule: opts?.bucketsForSyncRule ?? (() => [ownerId]),
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
    },
  });

  return { collection, mutate, executor, echo, deadLetter };
}

interface TestHarness {
  baseUrl: string;
  db: PGlite;
  realtime: ReconnectableRealtime;
  hasPoison: boolean;
  close: () => void;
}

interface ReconnectableRealtime extends RealtimeAdapter {
  disconnect(): void;
  reconnect(): void;
}

async function createHarness(): Promise<TestHarness> {
  const db = new PGlite();
  openDbs.push(db);
  const storage = postgresStorage({
    connectionString: "postgres://unused",
    client: db,
  });
  await db.exec(`
    create table notes (
      id bigserial primary key,
      owner_id text not null,
      body text not null,
      client_id text unique,
      updated_at timestamptz not null default now()
    );
  `);
  await storage.provision({ schema: {}, syncRules });

  const realtime = reconnectableRealtime();
  const mutators = defineMutators({
    addNote: testMutators.addNote,
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
    hasPoison: false,
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
});

function reconnectableRealtime(): ReconnectableRealtime {
  const registry = new Map<
    string,
    Set<{ send: (data: string) => void; onReconnect?: () => void }>
  >();
  let connected = true;

  return {
    publish(bucket) {
      if (!connected) return;
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
    disconnect() {
      connected = false;
    },
    reconnect() {
      if (connected) return;
      connected = true;
      for (const subs of registry.values()) {
        for (const socket of subs) socket.onReconnect?.();
      }
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
