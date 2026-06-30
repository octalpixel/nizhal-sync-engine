import { defineMutator, defineMutators, z } from "@nizhal/kernel";
import { createCollection } from "@tanstack/db";
import type { LeaderElection } from "@tanstack/offline-transactions";
import { pgTable, text } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  type NizhalClient,
  type NizhalCollection,
  createMemoryStorage,
  createNizhalMutators,
  manualOnlineDetector,
  nizhalCollectionOptions,
} from "../src/index.js";
import { MUTATION_ID_KEY } from "../src/mutation-id.js";

// Regression for the offline-first data-loss bug: nextMutationID reset to 1 each session, but the
// server enforces a contiguous per-clientID sequence (mutationID == last + 1) across sessions — so a
// restarted client re-emitted already-applied ids and the writes were silently dropped. With the same
// clientID + the same durable outboxStorage, the sequence MUST continue, not reset.

const items = pgTable("items", { id: text("id").primaryKey(), shop_id: text("shop_id").notNull() });
type ItemRow = typeof items.$inferSelect;

const itemMutators = defineMutators({
  addItem: defineMutator(z.object({ id: z.string(), shopId: z.string() }), async ({ tx }, a) => {
    await tx.insert(items).values({ id: a.id, shop_id: a.shopId });
    return { serverId: a.id, affectedBuckets: [a.shopId] };
  }),
});

function recordingEcho(
  pushed: Array<{ clientMutationId?: string; mutationID?: number }>,
  serverSequence?: { lastMutationID: number },
): NizhalClient {
  const accepted = new Set<string>();
  let observedServerSequence = 0;
  return {
    pull: async () => {
      observedServerSequence = serverSequence?.lastMutationID ?? 0;
      return {
        changed: [],
        tombstoned: [],
        removed: [],
        removedBuckets: [],
        cursor: "",
        ...(serverSequence ? { lastMutationId: observedServerSequence } : {}),
      };
    },
    push: async (mutation) => {
      pushed.push({
        clientMutationId: mutation.clientMutationId,
        mutationID: mutation.mutationID,
      });
      if (serverSequence && mutation.mutationID !== undefined) {
        if (accepted.has(mutation.clientMutationId)) {
          observedServerSequence = serverSequence.lastMutationID;
          return { accepted: true, lastMutationId: serverSequence.lastMutationID };
        }
        if (mutation.mutationID <= serverSequence.lastMutationID) {
          observedServerSequence = serverSequence.lastMutationID;
          return { accepted: false, lastMutationId: serverSequence.lastMutationID };
        }
        if (mutation.mutationID > serverSequence.lastMutationID + 1) {
          observedServerSequence = serverSequence.lastMutationID;
          return {
            accepted: false,
            outOfOrder: true,
            lastMutationId: serverSequence.lastMutationID,
          };
        }
        serverSequence.lastMutationID = mutation.mutationID;
        observedServerSequence = serverSequence.lastMutationID;
        accepted.add(mutation.clientMutationId);
        return { accepted: true, lastMutationId: serverSequence.lastMutationID };
      }
      return {};
    },
    getLastMutationId: () => observedServerSequence,
    subscribe: () => () => {},
    subscribePresence: () => () => {},
    onPresence: () => () => {},
    track: () => {},
    untrack: () => {},
    presenceState: () => ({}),
    presence: () => [],
    getCursor: () => "",
    setCursor: () => {},
    getScopeBuckets: () => [],
    getPullPageSize: () => undefined,
    getBucketTtlMs: () => undefined,
    getPullIntervalMs: () => undefined,
    setDeviceId: () => {},
    reportError: () => {},
    syncStatus: () => ({
      connectivity: "online",
      pendingMutations: 0,
      deadLettered: 0,
      lastPullCursor: "",
      lastPulledAt: null,
      lastError: null,
    }),
    onSyncStatus: () => () => {},
    outbox: { list: async () => [], deadLetter: () => [] },
  } as unknown as NizhalClient;
}

type Kv = {
  get(k: string): Promise<string | null | undefined>;
  set(k: string, v: string): Promise<void>;
};
function memKv(): Kv {
  const map = new Map<string, string>();
  return { get: async (k) => map.get(k) ?? null, set: async (k, v) => void map.set(k, v) };
}

async function runSession(
  clientID: string,
  storage: ReturnType<typeof createMemoryStorage>,
  metaStorage: Kv,
  itemId: string,
  serverSequence?: { lastMutationID: number },
  initializeBeforeMutation = true,
  leaderElection?: LeaderElection,
): Promise<Array<number | undefined>> {
  const pushed: Array<{ clientMutationId?: string; mutationID?: number }> = [];
  const echo = recordingEcho(pushed, serverSequence);
  const collection = createCollection(
    nizhalCollectionOptions<ItemRow>({
      name: "items",
      syncRule: "myShop",
      echo,
      bucketField: "shop_id",
      getKey: (r) => r.id,
    }),
  ) as NizhalCollection<ItemRow>;
  await collection.preload();
  const m = createNizhalMutators({
    collections: { items: collection } as Record<string, NizhalCollection<object>>,
    echo,
    actor: { userId: "u", ownerId: "shop-1" },
    mutators: itemMutators,
    outboxStorage: storage,
    mutationIdStorage: metaStorage,
    clientID,
    leaderElection,
  });
  if (initializeBeforeMutation) await m.executor.waitForInit();
  m.mutate.addItem({ id: itemId, shopId: "shop-1" });
  await m.waitForIdle();
  await m.dispose();
  return pushed.map((p) => p.mutationID);
}

describe("mutationID continuity across sessions", () => {
  it("continues the per-client sequence after a restart instead of resetting to 1", async () => {
    const storage = createMemoryStorage(); // durable outbox, shared across both sessions
    const meta = memKv(); // durable meta (mutation-id high-water), shared across both sessions
    const clientID = "device-1"; // persisted clientID — stable across restarts

    const session1 = await runSession(clientID, storage, meta, "item-1");
    expect(session1).toEqual([1]);

    // "Restart": brand-new mutators + collection + echo, same clientID + same durable stores.
    const session2 = await runSession(clientID, storage, meta, "item-2");
    expect(session2).toEqual([2]); // BUG (pre-fix): emitted [1] again → server dedups → write lost
  });

  it("preserves the server sequence on the first launch after upgrading from the pre-fix client", async () => {
    const storage = createMemoryStorage();
    const meta = memKv();
    const serverSequence = { lastMutationID: 7 };

    // A pre-fix install has no local high-water and no pending outbox after its acknowledged writes,
    // while the server still remembers this stable clientID at 7. The first upgraded write must be 8.
    const attempts = await runSession(
      "upgraded-device",
      storage,
      meta,
      "first-post-upgrade-item",
      serverSequence,
    );

    expect(attempts).toEqual([8]);
    expect(serverSequence.lastMutationID).toBe(8);
  });

  it("recovers a pending allocation when the process dies before persisting its high-water", async () => {
    const storage = createMemoryStorage();
    const durableValues = new Map<string, string>();
    let rejectHighWater = true;
    const crashMeta: Kv = {
      get: async (key) => durableValues.get(key) ?? null,
      set: async (key, value) => {
        if (key === MUTATION_ID_KEY && rejectHighWater) throw new Error("injected process death");
        durableValues.set(key, value);
      },
    };
    const serverSequence = { lastMutationID: 0 };

    const pushed: Array<{ clientMutationId?: string; mutationID?: number }> = [];
    const echo = recordingEcho(pushed, serverSequence);
    const collection = createCollection(
      nizhalCollectionOptions<ItemRow>({
        name: "items",
        syncRule: "myShop",
        echo,
        bucketField: "shop_id",
        getKey: (row) => row.id,
      }),
    ) as NizhalCollection<ItemRow>;
    await collection.preload();
    const online = manualOnlineDetector();
    const first = createNizhalMutators({
      collections: { items: collection } as Record<string, NizhalCollection<object>>,
      echo,
      actor: { userId: "u", ownerId: "shop-1" },
      mutators: itemMutators,
      outboxStorage: storage,
      mutationIdStorage: crashMeta,
      clientID: "crash-window-device",
      onlineDetector: online,
    });
    await first.executor.waitForInit();
    first.mutate.addItem({ id: "allocated-before-crash", shopId: "shop-1" });
    await waitFor(
      async () =>
        (await storage.keys()).some((key) => key.startsWith("tx:")) &&
        [...durableValues.keys()].some((key) => key.startsWith(`${MUTATION_ID_KEY}:allocated:`)),
    );
    const pendingKey = (await storage.keys()).find((key) => key.startsWith("tx:"));
    if (!pendingKey) throw new Error("pending transaction was not persisted");
    expect(await storage.get(pendingKey)).not.toContain('"mutationID"');
    online.setOnline(false);
    await waitFor(() => first.executor.getRunningCount() === 0);
    await first.dispose();
    await collection.cleanup();

    expect(pushed).toEqual([]);
    expect(durableValues.has(MUTATION_ID_KEY)).toBe(false);
    rejectHighWater = false;
    const second = await runSession(
      "crash-window-device",
      storage,
      crashMeta,
      "queued-after-restart",
      serverSequence,
    );
    expect(second).toEqual([1, 2]);
    expect(serverSequence.lastMutationID).toBe(2);
  });

  it("serializes two context producers through one shared outbox and elected executor", async () => {
    let leadershipRequests = 0;
    const leaderElection: LeaderElection = {
      requestLeadership: async () => {
        leadershipRequests += 1;
        return true;
      },
      releaseLeadership: () => {},
      isLeader: () => true,
      onLeadershipChange: () => () => {},
    };
    const serverSequence = { lastMutationID: 0 };
    const storage = createMemoryStorage();
    const meta = memKv();
    const pushed: Array<{ clientMutationId?: string; mutationID?: number }> = [];
    const echo = recordingEcho(pushed, serverSequence);
    const collection = createCollection(
      nizhalCollectionOptions<ItemRow>({
        name: "items",
        syncRule: "myShop",
        echo,
        bucketField: "shop_id",
        getKey: (row) => row.id,
      }),
    ) as NizhalCollection<ItemRow>;
    await collection.preload();
    const leader = createNizhalMutators({
      collections: { items: collection } as Record<string, NizhalCollection<object>>,
      echo,
      actor: { userId: "u", ownerId: "shop-1" },
      mutators: itemMutators,
      outboxStorage: storage,
      mutationIdStorage: meta,
      clientID: "shared-device",
      leaderElection,
    });
    await leader.executor.waitForInit();

    const contextA = leader.mutate;
    const contextB = leader.mutate;
    contextA.addItem({ id: "from-context-a", shopId: "shop-1" });
    contextB.addItem({ id: "from-context-b", shopId: "shop-1" });
    await leader.waitForIdle();
    await leader.dispose();
    await collection.cleanup();

    expect(pushed.map((mutation) => mutation.mutationID)).toEqual([1, 2]);
    expect(serverSequence.lastMutationID).toBe(2);
    expect(leadershipRequests).toBe(1);
  });

  it("does not allocate from the default counter when mutate is called before waitForInit", async () => {
    const meta = memKv();
    await meta.set("nizhal:mutation-id", "7");
    const serverSequence = { lastMutationID: 7 };

    const attempts = await runSession(
      "eager-caller",
      createMemoryStorage(),
      meta,
      "written-before-init",
      serverSequence,
      false,
    );

    expect(attempts).toEqual([8]);
    expect(serverSequence.lastMutationID).toBe(8);
  });

  // The live bug: writing MULTIPLE messages while offline, then coming online, must flush ALL of them
  // in contiguous order. (Single offline write already works; the batch is what loses data.)
  it("flushes ALL writes made while offline, in order (multi-message offline batch)", async () => {
    const serverSequence = { lastMutationID: 0 };
    const storage = createMemoryStorage();
    const meta = memKv();
    const pushed: Array<{ mutationID?: number }> = [];
    const echo = recordingEcho(pushed, serverSequence);
    const collection = createCollection(
      nizhalCollectionOptions<ItemRow>({
        name: "items",
        syncRule: "myShop",
        echo,
        bucketField: "shop_id",
        getKey: (row) => row.id,
      }),
    ) as NizhalCollection<ItemRow>;
    await collection.preload();
    const detector = manualOnlineDetector();
    const client = createNizhalMutators({
      collections: { items: collection } as Record<string, NizhalCollection<object>>,
      echo,
      actor: { userId: "u", ownerId: "shop-1" },
      mutators: itemMutators,
      outboxStorage: storage,
      mutationIdStorage: meta,
      clientID: "offline-batch-device",
      onlineDetector: detector,
    });
    await client.executor.waitForInit();

    detector.setOnline(false); // OFFLINE — hold the outbox
    client.mutate.addItem({ id: "off-1", shopId: "shop-1" });
    client.mutate.addItem({ id: "off-2", shopId: "shop-1" });
    client.mutate.addItem({ id: "off-3", shopId: "shop-1" });
    await new Promise((r) => setTimeout(r, 50));
    expect(pushed).toEqual([]); // nothing reached the server while offline

    detector.setOnline(true); // ONLINE — flush the whole batch
    await client.waitForIdle();
    await client.dispose();
    await collection.cleanup();

    expect(pushed.map((p) => p.mutationID)).toEqual([1, 2, 3]); // contiguous, in order, none lost
    expect(serverSequence.lastMutationID).toBe(3);
  });

  // DEVIL'S ADVOCATE: the live network throws. Model a TRANSIENT error on one offline message's first
  // push (Vercel cold start / ECONNRESET / 503). It must RETRY and still land — not be parked + lost.
  it("does not lose an offline message when its first push hits a transient error", async () => {
    const serverSequence = { lastMutationID: 0 };
    const storage = createMemoryStorage();
    const meta = memKv();
    const pushed: Array<{ mutationID?: number }> = [];
    const echo = recordingEcho(pushed, serverSequence);
    const basePush = echo.push.bind(echo);
    let injected = false;
    echo.push = async (m) => {
      if (!injected && (m.args as { id?: string })?.id === "off-2") {
        injected = true;
        throw new Error("fetch failed"); // retriable per classifyPushError
      }
      return basePush(m);
    };
    const collection = createCollection(
      nizhalCollectionOptions<ItemRow>({
        name: "items",
        syncRule: "myShop",
        echo,
        bucketField: "shop_id",
        getKey: (row) => row.id,
      }),
    ) as NizhalCollection<ItemRow>;
    await collection.preload();
    const detector = manualOnlineDetector();
    const client = createNizhalMutators({
      collections: { items: collection } as Record<string, NizhalCollection<object>>,
      echo,
      actor: { userId: "u", ownerId: "shop-1" },
      mutators: itemMutators,
      outboxStorage: storage,
      mutationIdStorage: meta,
      clientID: "transient-device",
      onlineDetector: detector,
    });
    await client.executor.waitForInit();

    detector.setOnline(false);
    client.mutate.addItem({ id: "off-1", shopId: "shop-1" });
    client.mutate.addItem({ id: "off-2", shopId: "shop-1" });
    client.mutate.addItem({ id: "off-3", shopId: "shop-1" });
    detector.setOnline(true);
    // all three MUST eventually reach the server (off-2 after a retry); none silently dropped
    await waitFor(() => serverSequence.lastMutationID >= 3);
    await client.dispose();
    await collection.cleanup();

    expect(injected).toBe(true); // the transient error actually fired
    expect(serverSequence.lastMutationID).toBe(3); // all three landed despite it
  });
});

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("condition not met before timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
