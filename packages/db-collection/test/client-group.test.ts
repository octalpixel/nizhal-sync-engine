import type { Mutation } from "@nizhal/kernel";
import { afterEach, describe, expect, it } from "vitest";
import {
  type NizhalCoordinator,
  type NizhalOnlineGate,
  type SharedMutation,
  openNizhalClientGroup,
} from "../src/client-group.js";
import { type NizhalClient, type NizhalPushResult, createMemoryStorage } from "../src/index.js";
import type { MutationIdStorage } from "../src/mutation-id.js";

// A minimal server: idempotent by clientMutationId, enforces a contiguous per-client mutation-id
// sequence (out-of-order ⇒ 409 with the true lastMutationId), and can fail a given write's body once
// (transient 503) — the transport throws on a 503, exactly like the real client.
function fakeServer(opts: { failOnce?: Set<string> } = {}) {
  const failOnce = opts.failOnce ?? new Set<string>();
  const failed = new Set<string>();
  const applied = new Map<string, number>();
  let last = 0;
  const push = async (m: Mutation): Promise<NizhalPushResult> => {
    const tag = String(m.args);
    if (failOnce.has(tag) && !failed.has(tag)) {
      failed.add(tag);
      throw new Error("push failed: 503 injected");
    }
    if (applied.has(m.clientMutationId)) return { accepted: true, lastMutationId: last };
    if (m.mutationID !== last + 1)
      return { accepted: false, outOfOrder: true, lastMutationId: last };
    applied.set(m.clientMutationId, m.mutationID);
    last = m.mutationID;
    return { accepted: true, lastMutationId: last };
  };
  return {
    client: { push, getLastMutationId: () => last } as unknown as NizhalClient,
    order: () => [...applied.entries()].sort((a, b) => a[1] - b[1]).map(([k]) => k),
  };
}

function memMeta(): MutationIdStorage {
  const values = new Map<string, string>();
  return {
    get: async (key) => values.get(key) ?? null,
    set: async (key, value) => void values.set(key, value),
  };
}

const alwaysOnline: NizhalOnlineGate = { isOnline: () => true, subscribe: () => () => {} };

// A shared cross-tab bus: signalWrite() broadcasts to EVERY tab's onWriteSignal (like BroadcastChannel);
// each tab has its own leadership state + promote().
function tabFactory() {
  const writeListeners = new Set<() => void>();
  const broadcast = () => {
    for (const listener of [...writeListeners]) listener();
  };
  return function makeTab(initialLeader: boolean) {
    const state = { leader: initialLeader };
    const leaderListeners = new Set<(value: boolean) => void>();
    const coord: NizhalCoordinator = {
      isLeader: () => state.leader,
      onLeadershipChange: (listener) => {
        leaderListeners.add(listener);
        return () => leaderListeners.delete(listener);
      },
      signalWrite: () => broadcast(),
      onWriteSignal: (listener) => {
        writeListeners.add(listener);
        return () => writeListeners.delete(listener);
      },
    };
    return {
      coord,
      promote() {
        if (state.leader) return;
        state.leader = true;
        for (const listener of leaderListeners) listener(true);
      },
    };
  };
}

const msg = (body: string): SharedMutation => ({ name: "sendMessage", args: body });
async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 2_000) {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

const groups: Array<{ dispose(): void }> = [];
afterEach(() => {
  for (const g of groups.splice(0)) g.dispose();
});

describe("openNizhalClientGroup", () => {
  it("leader drains the shared outbox in order, surviving a transient failure without loss", async () => {
    const server = fakeServer({ failOnce: new Set(["follower-lost"]) });
    const outbox = createMemoryStorage("cg:");
    const meta = memMeta();
    const tab = tabFactory()(true);
    const group = openNizhalClientGroup({
      echo: server.client,
      outbox,
      meta,
      coordinator: tab.coord,
      online: alwaysOnline,
      clientID: "device",
      retryDelayMs: 10,
    });
    groups.push(group);

    await group.enqueue("leader-kept", msg("leader-kept"));
    await group.enqueue("follower-lost", msg("follower-lost"));

    await waitFor(() => server.order().length === 2);
    expect(server.order()).toEqual(["leader-kept", "follower-lost"]);
    expect(await group.pendingCount()).toBe(0);
    expect(group.deadLetter).toEqual([]);
  });

  it("a non-leader durably enqueues; the write is parked until the tab is elected leader", async () => {
    const server = fakeServer();
    const outbox = createMemoryStorage("cg:");
    const tab = tabFactory()(false); // starts as a follower
    const group = openNizhalClientGroup({
      echo: server.client,
      outbox,
      meta: memMeta(),
      coordinator: tab.coord,
      online: alwaysOnline,
      clientID: "device",
      retryDelayMs: 10,
    });
    groups.push(group);

    await group.enqueue("parked", msg("parked"));
    // durably queued, but not flushed — it is not the leader
    expect(await group.pendingCount()).toBe(1);
    expect(server.order()).toEqual([]);

    tab.promote();
    await waitFor(() => server.order().length === 1);
    expect(server.order()).toEqual(["parked"]);
    expect(await group.pendingCount()).toBe(0);
  });

  it("cross-tab: a follower tab's write is flushed by the leader tab over the shared outbox", async () => {
    const server = fakeServer({ failOnce: new Set(["from-follower"]) });
    const outbox = createMemoryStorage("cg:"); // ONE shared durable store
    const meta = memMeta(); // ONE shared meta
    const factory = tabFactory();
    const leaderTab = factory(true);
    const followerTab = factory(false);
    const shared = {
      echo: server.client,
      outbox,
      meta,
      online: alwaysOnline,
      clientID: "device",
      retryDelayMs: 10,
    } as const;
    const leader = openNizhalClientGroup({ ...shared, coordinator: leaderTab.coord });
    const follower = openNizhalClientGroup({ ...shared, coordinator: followerTab.coord });
    groups.push(leader, follower);

    await leader.enqueue("from-leader", msg("from-leader"));
    // The follower enqueues into the SHARED outbox and broadcasts; the LEADER tab picks it up and flushes.
    await follower.enqueue("from-follower", msg("from-follower"));

    await waitFor(() => server.order().length === 2);
    expect(server.order().sort()).toEqual(["from-follower", "from-leader"]);
    expect(await leader.pendingCount()).toBe(0);
    expect(leader.deadLetter).toEqual([]);
    expect(follower.deadLetter).toEqual([]);
  });

  it("converges after an inflated stale sequence via an authoritative 409 resync (no loss)", async () => {
    // Simulate a stale/replayed response that inflates the client's sequence, then a real 409 that pulls
    // it back down — the same failure the mutators.ts fix addresses, now in the shared-outbox flush loop.
    let staleLeft = 3;
    const applied: string[] = [];
    let last = 0;
    const client = {
      getLastMutationId: () => last,
      push: async (m: Mutation): Promise<NizhalPushResult> => {
        if (staleLeft > 0) {
          staleLeft -= 1;
          return { accepted: false, lastMutationId: 3 - staleLeft }; // stale: inflates serverHighWater 1,2,3
        }
        if (m.mutationID !== last + 1)
          return { accepted: false, outOfOrder: true, lastMutationId: last };
        applied.push(m.clientMutationId);
        last = m.mutationID;
        return { accepted: true, lastMutationId: last };
      },
    } as unknown as NizhalClient;
    const tab = tabFactory()(true);
    const group = openNizhalClientGroup({
      echo: client,
      outbox: createMemoryStorage("cg:"),
      meta: memMeta(),
      coordinator: tab.coord,
      online: alwaysOnline,
      clientID: "device",
      retryDelayMs: 10,
    });
    groups.push(group);

    await group.enqueue("resync", msg("resync"));
    await waitFor(() => applied.length === 1);
    expect(applied).toEqual(["resync"]);
    expect(await group.pendingCount()).toBe(0);
  });
});
