import { afterEach, describe, expect, it, vi } from "vitest";
import { createNizhalClient } from "../src/client.js";
import type { NizhalPullRequest, NizhalPushRequest, NizhalSyncTarget } from "../src/sync-target.js";

describe("NizhalSyncTarget", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses a custom target for pull and push instead of the default HTTP transport", async () => {
    const pulls: NizhalPullRequest[] = [];
    const pushes: NizhalPushRequest[] = [];
    const target: NizhalSyncTarget = {
      async pull(request) {
        pulls.push(request);
        return {
          changed: [{ table: "notes", rows: [{ id: "note-1" }] }],
          tombstoned: [],
          removedBuckets: [],
          cursor: "opaque-cursor-1",
          hasMore: false,
        };
      },
      async push(request) {
        pushes.push(request);
        return { status: "applied", serverId: "server-note-1" };
      },
    };
    const fetchSpy = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchSpy);
    const client = createNizhalClient({
      server: "https://must-not-be-called.example",
      syncTarget: target,
      deviceId: "device-1",
      bucketsForSyncRule: () => ["owner-1"],
      subscribeSource: { subscribe: () => () => {} },
    });

    const pulled = await client.pull({ cursor: "opaque-cursor-0", syncRule: "myNotes", limit: 25 });
    const pushed = await client.push({
      name: "addNote",
      args: { clientId: "note-1", body: "offline" },
      clientMutationId: "mutation-1",
      clientID: "device-1",
      mutationID: 7,
      hlc: "1000-0-device-1",
      dependsOn: "mutation-0",
    });

    expect(pulled.cursor).toBe("opaque-cursor-1");
    expect(pushed).toEqual({ accepted: true });
    expect(pulls).toEqual([
      {
        cursor: "opaque-cursor-0",
        syncRule: "myNotes",
        buckets: ["owner-1"],
        clientId: "device-1",
        limit: 25,
      },
    ]);
    expect(pushes).toEqual([
      {
        name: "addNote",
        args: { clientId: "note-1", body: "offline" },
        clientMutationId: "mutation-1",
        clientID: "device-1",
        mutationID: 7,
        hlc: "1000-0-device-1",
        dependsOn: "mutation-0",
      },
    ]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("surfaces a target rejection as a terminal sync error", async () => {
    const target: NizhalSyncTarget = {
      async pull() {
        return {
          changed: [],
          tombstoned: [],
          removedBuckets: [],
          cursor: "",
          hasMore: false,
        };
      },
      async push() {
        return { status: "rejected", error: "business rule rejected the command" };
      },
    };
    const client = createNizhalClient({ syncTarget: target });

    await expect(
      client.push({ name: "rejectMe", args: {}, clientMutationId: "mutation-rejected" }),
    ).rejects.toMatchObject({
      name: "NizhalSyncTargetError",
      retriable: false,
      message: "business rule rejected the command",
    });
  });

  it("parses authoritative sequence values from pull, push, and 409 responses", async () => {
    const responses = [
      new Response(
        JSON.stringify({
          changed: [],
          tombstoned: [],
          removedBuckets: [],
          cursor: "cursor-1",
          lastMutationId: 7,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
      new Response(JSON.stringify({ applied: [], lastMutationId: 7 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      new Response(JSON.stringify({ error: "out of order", lastMutationId: 7 }), {
        status: 409,
        headers: { "content-type": "application/json" },
      }),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => responses.shift() as Response),
    );
    const client = createNizhalClient({
      server: "https://sync.example",
      deviceId: "device-1",
      subscribeSource: { subscribe: () => () => {} },
    });

    const pull = await client.pull({ cursor: "", syncRule: "myNotes" });
    const stale = await client.push({
      name: "addNote",
      args: {},
      clientMutationId: "stale",
      clientID: "device-1",
      mutationID: 1,
    });
    const outOfOrder = await client.push({
      name: "addNote",
      args: {},
      clientMutationId: "gap",
      clientID: "device-1",
      mutationID: 9,
    });

    expect(pull.lastMutationId).toBe(7);
    expect(client.getLastMutationId()).toBe(7);
    expect(stale).toEqual({ lastMutationId: 7, accepted: false });
    expect(outOfOrder).toEqual({ lastMutationId: 7, accepted: false, outOfOrder: true });
  });
});
