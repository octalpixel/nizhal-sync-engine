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

describe("@nizhal/db-collection integration", () => {
  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(openDbs.splice(0).map((db) => db.close()));
    for (const harness of openHarnesses.splice(0)) harness.close();
  });

  it("test:offline-write — optimistic insert appears and push reconciles client-id→server-id", async () => {
    const harness = await createHarness();
    const { collection, mutate, executor } = createClientStack(harness, "owner-1");

    await collection.preload();
    await executor.waitForInit();

    mutate.addNote({ clientId: "client-note-1", body: "hello offline" });
    expect(collection.toArray.some((n) => n.client_id === "client-note-1")).toBe(true);

    await waitFor(async () => {
      const notes = await harness.db.query<{ id: number; client_id: string }>(
        "select id, client_id from notes",
      );
      return notes.rows.some((n) => n.client_id === "client-note-1");
    });

    const applied = await harness.db.query<{ client_id: string; server_id: string }>(
      "select client_id, server_id from _nizhal_mutations",
    );
    expect(applied.rows).toEqual([{ client_id: "client-note-1", server_id: "1" }]);
  });

  it("test:converge — second client converges after realtime ping", async () => {
    const harness = await createHarness();
    const clientA = createClientStack(harness, "owner-1");
    const clientB = createClientStack(harness, "owner-1");

    await Promise.all([clientA.collection.preload(), clientB.collection.preload()]);
    await Promise.all([clientA.executor.waitForInit(), clientB.executor.waitForInit()]);

    const started = Date.now();
    clientA.mutate.addNote({ clientId: "shared-note", body: "from A" });

    await waitFor(
      () => clientB.collection.toArray.some((n) => n.client_id === "shared-note"),
      5_000,
    );
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("test:no-loop — applying pulled rows does not re-enqueue push", async () => {
    const harness = await createHarness();
    const { collection, mutate, executor, echo } = createClientStack(harness, "owner-1");

    await collection.preload();
    await executor.waitForInit();

    let pushCalls = 0;
    const originalPush = echo.push.bind(echo);
    echo.push = async (mutation) => {
      pushCalls += 1;
      await originalPush(mutation);
    };

    mutate.addNote({ clientId: "loop-note", body: "once" });
    await waitFor(async () => {
      const notes = await harness.db.query("select * from notes where client_id = $1", [
        "loop-note",
      ]);
      return notes.rows.length === 1;
    });

    const pushesAfterWrite = pushCalls;

    await harness.db.query("update notes set body = $1, updated_at = now() where client_id = $2", [
      "server edit",
      "loop-note",
    ]);
    harness.realtime.publish("owner-1");

    await waitFor(() =>
      collection.toArray.some((n) => n.client_id === "loop-note" && n.body === "server edit"),
    );

    expect(pushCalls).toBe(pushesAfterWrite);
  });

  it("test:revocation-evicts — removedBuckets purges bucket rows locally", async () => {
    const harness = await createHarness();
    const { collection, echo } = createClientStack(harness, "owner-1");

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
                  body: "evict",
                  client_id: "evict-1",
                },
              ],
            },
          ],
          tombstoned: [],
          cursor: "",
        };
      }
      const result = await originalPull(input);
      return { ...result, removedBuckets: ["owner-2"] };
    };

    await collection.preload();
    await waitFor(() => collection.toArray.some((n) => n.client_id === "evict-1"));

    harness.realtime.publish("owner-1");
    await waitFor(() => !collection.toArray.some((n) => n.client_id === "evict-1"));

    expect(collection.toArray.some((n) => n.client_id === "keep-1")).toBe(true);
    expect(collection.toArray.some((n) => n.client_id === "evict-1")).toBe(false);
  });

  it("does not blind-purge a no-bucketField collection on removedBuckets (F1)", async () => {
    const harness = await createHarness();
    const { collection, echo } = createClientStack(harness, "owner-1", { noBucketField: true });

    let pulls = 0;
    const originalPull = echo.pull.bind(echo);
    echo.pull = async (input) => {
      pulls += 1;
      if (pulls === 1) {
        return {
          changed: [
            {
              table: "notes",
              rows: [{ id: 10, owner_id: "owner-1", body: "keep", client_id: "keep-1" }],
            },
          ],
          tombstoned: [],
          cursor: "",
        };
      }
      const result = await originalPull(input);
      return { ...result, removedBuckets: ["owner-2"] };
    };

    await collection.preload();
    await waitFor(() => collection.toArray.some((n) => n.client_id === "keep-1"));

    harness.realtime.publish("owner-1");
    await waitFor(() => pulls >= 2);
    await new Promise((resolve) => setTimeout(resolve, 100));

    // F1: a still-visible row must survive a revocation it doesn't belong to — no whole-collection wipe.
    expect(collection.toArray.some((n) => n.client_id === "keep-1")).toBe(true);
  });

  it("removes rows locally after bucket exit, soft delete, and hard delete", async () => {
    const harness = await createHarness();
    const { collection } = createClientStack(harness, "owner-1");

    await harness.db.query(
      "insert into notes (id, owner_id, body, client_id) values ($1, $2, $3, $4)",
      [30, "owner-1", "bucket exit", "remove-bucket"],
    );
    await harness.db.query(
      "insert into notes (id, owner_id, body, client_id) values ($1, $2, $3, $4)",
      [31, "owner-1", "soft delete", "remove-soft"],
    );
    await harness.db.query(
      "insert into notes (id, owner_id, body, client_id) values ($1, $2, $3, $4)",
      [32, "owner-1", "hard delete", "remove-hard"],
    );

    await collection.preload();
    await waitFor(
      () =>
        collection.toArray.some((row) => row.client_id === "remove-bucket") &&
        collection.toArray.some((row) => row.client_id === "remove-soft") &&
        collection.toArray.some((row) => row.client_id === "remove-hard"),
    );

    await harness.db.query("update notes set owner_id = $1 where id = $2", ["owner-2", 30]);
    await harness.db.query("update notes set deleted_at = now() where id = $1", [31]);
    await harness.db.query("delete from notes where id = $1", [32]);
    harness.realtime.publish("owner-1");

    await waitFor(
      () =>
        !collection.toArray.some((row) => row.client_id === "remove-bucket") &&
        !collection.toArray.some((row) => row.client_id === "remove-soft") &&
        !collection.toArray.some((row) => row.client_id === "remove-hard"),
    );
  });

  it("test:poison-quarantine — failing write parks while later writes drain", async () => {
    const harness = await createHarness({ includePoisonMutator: true });
    const { mutate, deadLetter } = createClientStack(harness, "owner-1", {});

    mutate.poisonNote({ clientId: "poison-1", body: "bad" });
    mutate.addNote({ clientId: "good-1", body: "good" });

    await waitFor(async () => {
      const notes = await harness.db.query("select * from notes where client_id = $1", ["good-1"]);
      return notes.rows.length === 1;
    });
    await waitFor(() => deadLetter.length > 0);

    expect(deadLetter.length).toBeGreaterThanOrEqual(1);
    expect(deadLetter[0]?.mutation.name).toBe("poisonNote");
    const poisonRows = await harness.db.query("select * from notes where client_id = $1", [
      "poison-1",
    ]);
    expect(poisonRows.rows).toEqual([]);
  });
});

function createClientStack(
  harness: TestHarness,
  ownerId: string,
  opts?: { noBucketField?: boolean },
) {
  const echo = createNizhalClient({
    server: harness.baseUrl,
    subscribeSource: {
      subscribe: (buckets, onMessage) => harness.realtime.subscribe(buckets, { send: onMessage }),
    },
    bucketsForSyncRule: () => [ownerId],
  });

  const collection = createCollection(
    nizhalCollectionOptions<NoteRow>({
      name: "notes",
      syncRule: "ownerBucket",
      echo,
      ...(opts?.noBucketField ? {} : { bucketField: "owner_id" as const }),
      getKey: (row) => row.client_id ?? String(row.id),
    }),
  );

  const { mutate, executor, deadLetter } = createNizhalMutators({
    collections: { notes: collection },
    echo,
    actor: { userId: "user-1", ownerId },
    mutators: {
      addNote: testMutators.addNote,
      ...(harness.hasPoison
        ? {
            poisonNote: testMutators.poisonNote,
          }
        : {}),
    },
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
  const storage = postgresStorage({
    connectionString: "postgres://unused",
    client: db,
  });
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
    ...(opts?.includePoisonMutator
      ? {
          poisonNote: testMutators.poisonNote,
        }
      : {}),
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
