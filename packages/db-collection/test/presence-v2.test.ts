import { PGlite } from "@electric-sql/pglite";
import { defineMutators, defineSyncRules } from "@nizhal/kernel";
import { type NizhalAuth, createNizhalServer } from "@nizhal/server";
import { postgresStorage } from "@nizhal/server/adapters";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createNizhalClient } from "../src/client.js";
import type { PresenceEvent } from "../src/types.js";

const syncRules = defineSyncRules((b) => ({
  ownerBucket: b.bucket({
    parameters: () => b.params({ ownerId: "owner_id" }),
    data: (bucket) => [b.table("notes").where(b.eq("owner_id", bucket.ownerId))],
  }),
}));

const auth: NizhalAuth = {
  async resolve(req) {
    const userId = req.headers.get("x-user-id") ?? "user-1";
    return { userId, ownerId: "owner-1" };
  },
};

const openDbs: PGlite[] = [];

describe("presence v2", () => {
  afterEach(async () => {
    await Promise.all(openDbs.splice(0).map((db) => db.close()));
  });

  it("shows metas-per-key when the same user has two connections", async () => {
    const harness = await createHarness();
    const eventsA: PresenceEvent[] = [];
    const eventsB: PresenceEvent[] = [];

    const clientA = createNizhalClient({
      server: harness.url,
      auth: { headers: { "x-user-id": "user-1" } },
      bucketsForSyncRule: () => ["owner-1"],
      subscribeSource: harness.subscribeSource("user-1"),
    });
    const clientB = createNizhalClient({
      server: harness.url,
      auth: { headers: { "x-user-id": "user-1" } },
      bucketsForSyncRule: () => ["owner-1"],
      subscribeSource: harness.subscribeSource("user-1"),
    });

    clientA.onPresence("ownerBucket", (event) => eventsA.push(event));
    clientB.onPresence("ownerBucket", (event) => eventsB.push(event));
    clientA.track("ownerBucket", { tab: "a" });
    clientB.track("ownerBucket", { tab: "b" });

    await waitFor(() => clientA.presenceState("ownerBucket")["user-1"]?.length === 2);
    const metas = clientA.presenceState("ownerBucket")["user-1"] ?? [];
    expect(metas).toHaveLength(2);
    expect(metas.map((meta) => meta.tab).sort()).toEqual(["a", "b"]);
    expect(eventsA.some((event) => event.event === "join")).toBe(true);
    expect(eventsB.some((event) => event.event === "sync")).toBe(true);

    await harness.close();
  });

  it("emits leave on disconnect and uses diffs instead of full rebroadcast", async () => {
    const harness = await createHarness();
    const events: PresenceEvent[] = [];
    const clientA = createNizhalClient({
      server: harness.url,
      auth: { headers: { "x-user-id": "user-a" } },
      bucketsForSyncRule: () => ["owner-1"],
      subscribeSource: harness.subscribeSource("user-a"),
    });
    const clientB = createNizhalClient({
      server: harness.url,
      auth: { headers: { "x-user-id": "user-b" } },
      bucketsForSyncRule: () => ["owner-1"],
      subscribeSource: harness.subscribeSource("user-b"),
    });

    clientA.onPresence("ownerBucket", (event) => events.push(event));
    clientA.track("ownerBucket", { displayName: "A" });
    clientB.track("ownerBucket", { displayName: "B" });
    await waitFor(() => Object.keys(clientA.presenceState("ownerBucket")).length === 2);

    const diffJoins = events.filter((event) => event.event === "join");
    const fullSyncs = events.filter((event) => event.event === "sync");
    expect(diffJoins.length).toBeGreaterThan(0);
    expect(fullSyncs.length).toBeGreaterThan(0);

    harness.closeSocket("user-b");
    await waitFor(() => clientA.presenceState("ownerBucket")["user-b"] === undefined);
    expect(events.some((event) => event.event === "leave" && event.key === "user-b")).toBe(true);

    await harness.close();
  });

  it("evicts stale presence after heartbeat timeout", async () => {
    const harness = await createHarness({ heartbeatTimeoutMs: 400 });
    const clientA = createNizhalClient({
      server: harness.url,
      auth: { headers: { "x-user-id": "user-a" } },
      bucketsForSyncRule: () => ["owner-1"],
      subscribeSource: harness.subscribeSource("user-a"),
      presence: { heartbeatIntervalMs: 100 },
    });
    const clientB = createNizhalClient({
      server: harness.url,
      auth: { headers: { "x-user-id": "user-b" } },
      bucketsForSyncRule: () => ["owner-1"],
      subscribeSource: harness.subscribeSource("user-b", { heartbeat: false }),
    });

    clientA.onPresence("ownerBucket", () => {});
    clientA.track("ownerBucket", { displayName: "A" });
    clientB.track("ownerBucket", { displayName: "B" });
    await waitFor(() => Object.keys(clientA.presenceState("ownerBucket")).length === 2);

    await waitFor(() => clientA.presenceState("ownerBucket")["user-b"] === undefined, 30);
    expect(clientA.presenceState("ownerBucket")["user-a"]).toHaveLength(1);

    await harness.close();
  });
});

async function createHarness(options?: { heartbeatTimeoutMs?: number }) {
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

  const server = createNizhalServer({
    db: "postgres://unused",
    schema: {},
    mutators: defineMutators({}),
    syncRules,
    auth,
    storage,
    presence: { heartbeatTimeoutMs: options?.heartbeatTimeoutMs },
  });
  const listener = server.listen(0);
  await new Promise<void>((resolve) => listener.once("listening", resolve));
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("missing test port");
  const port = address.port;
  const url = `http://127.0.0.1:${port}`;
  const sockets = new Map<string, Set<WebSocket>>();

  return {
    url,
    subscribeSource(userId: string, opts?: { heartbeat?: boolean }) {
      const wsUrl = `ws://127.0.0.1:${port}/sync/stream`;
      let socket: WebSocket | null = null;
      const pending: string[] = [];
      let open = false;

      const flush = () => {
        if (!socket || !open) return;
        for (const data of pending.splice(0)) {
          if (opts?.heartbeat === false && data.startsWith("presence:heartbeat:")) continue;
          socket.send(data);
        }
      };

      return {
        subscribe(_buckets: string[], onMessage: (data: string) => void, onReconnect?: () => void) {
          socket = new WebSocket(wsUrl, { headers: { "x-user-id": userId } });
          const userSockets = sockets.get(userId) ?? new Set<WebSocket>();
          userSockets.add(socket);
          sockets.set(userId, userSockets);
          let hasConnected = false;
          socket.on("message", (data) => onMessage(data.toString()));
          socket.on("open", () => {
            open = true;
            flush();
            if (hasConnected) onReconnect?.();
            else hasConnected = true;
          });
          socket.on("close", () => {
            open = false;
          });
          return () => {
            socket?.close();
            if (socket) userSockets.delete(socket);
            if (userSockets.size === 0) sockets.delete(userId);
            socket = null;
            open = false;
            pending.length = 0;
          };
        },
        send(data: string) {
          if (opts?.heartbeat === false && data.startsWith("presence:heartbeat:")) return;
          pending.push(data);
          flush();
        },
      };
    },
    closeSocket(userId: string) {
      for (const socket of sockets.get(userId) ?? []) socket.terminate();
      sockets.delete(userId);
    },
    async close() {
      for (const userSockets of sockets.values()) {
        for (const socket of userSockets) socket.terminate();
      }
      sockets.clear();
      await closeListener(listener);
    },
  };
}

function closeListener(listener: ReturnType<ReturnType<typeof createNizhalServer>["listen"]>) {
  return new Promise<void>((resolve, reject) => {
    listener.close((error?: Error) => (error ? reject(error) : resolve()));
  });
}

async function waitFor(predicate: () => boolean, attempts = 50): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("condition not met");
}
