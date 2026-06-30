import { afterEach, describe, expect, it, vi } from "vitest";
import { createNizhalClient } from "../src/client.js";

describe("device-specific pull identity", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the configured persisted device id on every pull", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)) as unknown);
        return Response.json({
          changed: [],
          tombstoned: [],
          removedBuckets: [],
          cursor: "cursor-1",
        });
      }),
    );
    const client = createNizhalClient({
      server: "https://nizhal.test",
      deviceId: "persisted-device-a",
      subscribeSource: { subscribe: () => () => {} },
    });

    await client.pull({ cursor: "", syncRule: "shops" });
    await client.pull({ cursor: "cursor-1", syncRule: "shops" });

    expect(bodies).toEqual([
      { cursor: "", syncRule: "shops", deviceId: "persisted-device-a" },
      { cursor: "cursor-1", syncRule: "shops", deviceId: "persisted-device-a" },
    ]);
  });
});
