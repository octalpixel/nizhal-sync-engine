import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { type Actor, defineMutator, defineMutators, defineSyncRules, z } from "@nizhal/kernel";
import { type NizhalAuth, createNizhalServer } from "@nizhal/server";
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

// Motivated by the Couchbase "checkpoints lie" write-up: a cursor and its local data are separate
// state. When a DIFFERENT user opens a store a previous user already synced (shared device / re-login),
// reusing the old cursor would leak the old user's rows and skip the new user's history. The store
// detects the actor-identity change and fully re-bootstraps for the new user.

const notes = pgTable("ai_notes", {
  id: text("id").primaryKey(),
  shop_id: text("shop_id").notNull(),
  body: text("body").notNull(),
});
const schema = { notes };
const syncRules = defineSyncRules((b) => ({
  shop: b.bucket({
    parameters: () => b.params({ ownerId: "shop_id" }),
    data: (bucket) => [b.table("ai_notes").where(b.eq("shop_id", bucket.ownerId))],
  }),
}));
const auth: NizhalAuth = {
  async resolve(req: Request) {
    const shop = req.headers.get("x-shop") ?? "any";
    return { userId: `u-${shop}`, ownerId: shop };
  },
};
const id = z.string().min(1);
const noteMutators = defineMutators({
  addNote: defineMutator(z.object({ id, body: z.string().min(1) }), async ({ tx, actor }, args) => {
    await tx.insert(notes).values({ id: args.id, shop_id: actor.ownerId, body: args.body });
    return { serverId: args.id, affectedBuckets: [actor.ownerId] };
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
    "create table ai_notes (id text primary key, shop_id text not null, body text not null)",
  );
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
  const dir = mkdtempSync(join(tmpdir(), "nizhal-ai-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

  async function open(
    file: string,
    actor: Actor,
    online = true,
  ): Promise<NizhalStore<typeof schema, typeof noteMutators>> {
    const detector = manualOnlineDetector();
    if (!online) detector.setOnline(false);
    const store = await openNizhalStore({
      echo: createNizhalClient({
        server: listener.baseUrl,
        bucketsForSyncRule: () => [actor.ownerId],
        auth: { headers: { "x-shop": actor.ownerId } },
      }),
      schema,
      syncRules,
      mutators: noteMutators,
      actor,
      database: drizzle(new Database(join(dir, file))),
      onlineDetector: detector,
      retryBaseMs: 20,
    });
    cleanups.push(() => store.dispose());
    return store;
  }

  // Seed one note per shop on the server (each via its own throwaway store).
  async function seed(shopId: string, noteId: string) {
    const s = await open(`seed-${noteId}.db`, { userId: `u-${shopId}`, ownerId: shopId });
    s.mutate.addNote({ id: noteId, body: noteId });
    await s.waitForIdle();
    await s.dispose();
  }
  return { open, seed };
}

const ids = (store: NizhalStore<typeof schema, typeof noteMutators>) =>
  store.db
    .select()
    .from(store.tables.notes)
    .then((rows) => rows.map((r) => r.id).sort());

describe("actor-identity guard — shared device / re-login", () => {
  it("re-login as a different user wipes and re-bootstraps: no leak of the previous user's rows", async () => {
    const h = await createHarness();
    await h.seed("shop-A", "a1");
    await h.seed("shop-B", "b1");

    // User A syncs on the shared device.
    const a = await h.open("shared.db", { userId: "u-a", ownerId: "shop-A" });
    await a.pullNow();
    expect(await ids(a)).toEqual(["a1"]);
    await a.dispose();

    // User B logs in on the SAME file. The identity change must drop A's data + reset the cursor, then
    // re-bootstrap B's bucket — B sees b1 and NEVER a1.
    const b = await h.open("shared.db", { userId: "u-b", ownerId: "shop-B" });
    await b.pullNow();
    expect(await ids(b)).toEqual(["b1"]);
  });

  it("reopening as the SAME user does not reset — local data is preserved without a pull", async () => {
    const h = await createHarness();
    await h.seed("shop-A", "a1");
    const first = await h.open("same.db", { userId: "u-a", ownerId: "shop-A" });
    await first.pullNow();
    expect(await ids(first)).toEqual(["a1"]);
    await first.dispose();

    // Same identity, offline: the row is still there (no spurious wipe), no server round-trip needed.
    const again = await h.open("same.db", { userId: "u-a", ownerId: "shop-A" }, false);
    expect(await ids(again)).toEqual(["a1"]);
  });

  it("clears the previous user's un-flushed outbox on identity change (no cross-user flush)", async () => {
    const h = await createHarness();
    // User A writes offline and logs out before syncing.
    const a = await h.open("outbox.db", { userId: "u-a", ownerId: "shop-A" }, false);
    a.mutate.addNote({ id: "a-pending", body: "unsynced" });
    await vi.waitFor(async () => expect(await a.getPendingCount()).toBe(1));
    await a.dispose();

    // User B logs in on the same file: A's pending write must NOT be inherited (it would flush under B).
    const b = await h.open("outbox.db", { userId: "u-b", ownerId: "shop-B" }, false);
    expect(await b.getPendingCount()).toBe(0);
    expect(await ids(b)).toEqual([]);
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
