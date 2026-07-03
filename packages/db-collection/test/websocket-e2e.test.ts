import { mkdtempSync, rmSync } from "node:fs";
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
  type WebSocketFactory,
  type WebSocketLike,
  createNizhalClient,
  createWebSocketSource,
  manualOnlineDetector,
  openNizhalStore,
} from "../src/index.js";

// The realtime WebSocket path, end to end against a REAL server.listen() (the WS endpoint the
// serveFetch harness never injects). Client B subscribes over a genuine `/sync/stream` socket with NO
// pull interval — so the ONLY way A's write can reach B is a real `repull:` poke driving a pull. This
// is the round-trip that the FakeWebSocket unit tests and the interval-pull demos never exercise.

const PORT = 47123;
const OWNER = "ws-shop";

const notes = pgTable("ws_notes", {
  id: text("id").primaryKey(),
  owner_id: text("owner_id").notNull(),
  body: text("body").notNull(),
});
const schema = { notes };
const syncRules = defineSyncRules((b) => ({
  shop: b.bucket({
    parameters: () => b.params({ ownerId: "owner_id" }),
    data: (bucket) => [b.table("ws_notes").where(b.eq("owner_id", bucket.ownerId))],
  }),
}));
const auth: NizhalAuth = {
  async resolve() {
    return { userId: "u", ownerId: OWNER };
  },
};
const id = z.string().min(1);
const mutators = defineMutators({
  addNote: defineMutator(z.object({ id, body: z.string().min(1) }), async ({ tx, actor }, a) => {
    await tx.insert(notes).values({ id: a.id, owner_id: actor.ownerId, body: a.body });
    return { serverId: a.id, affectedBuckets: [actor.ownerId] };
  }),
});

// Node 22 ships a global WebSocket — a real socket, not a fake.
const nodeWebSocketFactory: WebSocketFactory = (url) =>
  new (globalThis as { WebSocket: new (u: string) => unknown }).WebSocket(url) as WebSocketLike;

const cleanups: Array<() => void | Promise<void>> = [];
afterAll(async () => {
  for (const c of cleanups.reverse()) await c();
});

describe("realtime WebSocket end to end (real /sync/stream poke → pull)", () => {
  it("a write on one client reaches another purely via a WS poke (no interval, no manual pull)", async () => {
    const pg = new PGlite();
    cleanups.push(() => pg.close());
    const storage = postgresStorage({ connectionString: "postgres://unused", client: pg });
    await pg.exec(
      "create table ws_notes (id text primary key, owner_id text not null, body text not null)",
    );
    await storage.provision({ schema: {}, syncRules });
    const server = createNizhalServer({
      db: "postgres://unused",
      schema: {},
      mutators,
      syncRules,
      auth,
      storage,
    });
    const httpServer = server.listen(PORT); // ← real listen: injects the /sync/stream WebSocket
    cleanups.push(() => new Promise<void>((r) => httpServer.close(() => r())));
    await new Promise((r) => setTimeout(r, 200));

    const dir = mkdtempSync(join(tmpdir(), "nizhal-ws-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const open = async (file: string, opts: { ws?: boolean } = {}) => {
      const echo = createNizhalClient({
        server: `http://127.0.0.1:${PORT}`,
        bucketsForSyncRule: () => [OWNER],
        // Client B rides the WS; NO pull interval, so a pull can only be triggered by a real poke.
        ...(opts.ws
          ? {
              subscribeSource: createWebSocketSource({
                getUrl: (buckets) =>
                  `ws://127.0.0.1:${PORT}/sync/stream?${buckets
                    .map((b) => `bucket=${encodeURIComponent(b)}`)
                    .join("&")}`,
                webSocketFactory: nodeWebSocketFactory,
              }),
            }
          : {}),
      });
      const store = await openNizhalStore({
        echo,
        schema,
        syncRules,
        mutators,
        actor: { userId: "u", ownerId: OWNER },
        database: drizzle(new Database(join(dir, file))),
        onlineDetector: manualOnlineDetector(),
        retryBaseMs: 20,
      });
      cleanups.push(() => store.dispose());
      return store as NizhalStore<typeof schema, typeof mutators>;
    };

    const a = await open("ws-a.db");
    const b = await open("ws-b.db", { ws: true });
    await a.ready();
    await b.ready();
    // let B's WebSocket finish its upgrade + subscribe before the write
    await new Promise((r) => setTimeout(r, 500));

    a.mutate.addNote({ id: "n1", body: "delivered by websocket" });
    await a.waitForIdle();

    // B must converge WITHOUT any manual pull — proving the /sync/stream poke drove the pull.
    await vi.waitFor(
      async () => {
        const rows = await b.db.select().from(b.tables.notes);
        expect(rows.map((r) => r.id)).toEqual(["n1"]);
      },
      { timeout: 8000, interval: 100 },
    );
  });
});
