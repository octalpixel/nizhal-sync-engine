import type { DurableObjectNamespace } from "@cloudflare/workers-types";
import { describe, expect, it } from "vitest";
import {
  authorizeRealtimeRoom,
  repullAuthorizedConnections,
} from "../src/adapters/cloudflare/authorization.js";
import { EPHEMERAL_RATE_LIMIT, relayEphemeralFrame } from "../src/adapters/cloudflare/ephemeral.js";
import {
  type CloudflareRealtimeEnv,
  cloudflareHttpRealtime,
  cloudflareRealtime,
} from "../src/adapters/cloudflare/realtime.js";
import {
  NIZHAL_BUCKET_OPTIONS,
  NIZHAL_PING,
  NIZHAL_PONG,
  configureWebSocketAutoResponse,
  createSocketAttachment,
  restoreSocketAttachment,
} from "../src/adapters/cloudflare/socket-state.js";
import { issueBearerToken } from "../src/auth.js";

interface MockId {
  name: string;
}

class MockStub {
  readonly broadcasts: string[] = [];
  private readonly name: string;

  constructor(name: string) {
    this.name = name;
  }

  async setName(name: string) {
    if (name !== this.name) throw new Error("unexpected name change");
  }

  async repull(bucket: string) {
    this.broadcasts.push(`repull:${bucket}`);
  }
}

function createMockNamespace(): DurableObjectNamespace {
  const stubs = new Map<string, MockStub>();
  return {
    idFromName(name: string) {
      return { name } as unknown as DurableObjectId;
    },
    get(id: DurableObjectId) {
      const mockId = id as unknown as MockId;
      let stub = stubs.get(mockId.name);
      if (!stub) {
        stub = new MockStub(mockId.name);
        stubs.set(mockId.name, stub);
      }
      return stub as unknown as DurableObjectStub;
    },
    jurisdiction(): never {
      throw new Error("not implemented");
    },
    idFromString(): never {
      throw new Error("not implemented");
    },
    newUniqueId(): never {
      throw new Error("not implemented");
    },
  };
}

function asMockStub(stub: DurableObjectStub): MockStub {
  return stub as unknown as MockStub;
}

describe("cloudflareRealtime adapter", () => {
  it("publishes by RPC into the bucket DO, which broadcasts repull:<bucket>", async () => {
    const namespace = createMockNamespace();
    const env: CloudflareRealtimeEnv = { NizhalBucket: namespace };
    const adapter = cloudflareRealtime(env, {
      async getServerByName(ns, name) {
        const stub = asMockStub(ns.get(ns.idFromName(name)));
        await stub.setName(name);
        return stub;
      },
    });

    await adapter.publish("owner-1");
    await adapter.publish("owner-1");
    await adapter.publish("owner-2");

    const owner1Stub = asMockStub(namespace.get(namespace.idFromName("owner-1")));
    const owner2Stub = asMockStub(namespace.get(namespace.idFromName("owner-2")));

    expect(owner1Stub.broadcasts).toEqual(["repull:owner-1", "repull:owner-1"]);
    expect(owner2Stub.broadcasts).toEqual(["repull:owner-2"]);
  });

  it("subscribe is a no-op and returns a cleanup function", () => {
    const adapter = cloudflareRealtime(
      { NizhalBucket: createMockNamespace() },
      {
        getServerByName: async () => ({ repull: async () => {} }),
      },
    );
    const cleanup = adapter.subscribe(["owner-1"], { send: () => {} });
    expect(typeof cleanup).toBe("function");
    cleanup();
  });
});

describe("cloudflareHttpRealtime adapter (Node server → DO publish bridge)", () => {
  it("POSTs the bucket to the worker bridge with the shared-secret bearer", async () => {
    const calls: { url: string; method?: string; auth: string | null }[] = [];
    const adapter = cloudflareHttpRealtime({
      publishUrl: "https://nizhal-realtime.acme.workers.dev/_nizhal/publish",
      publishSecret: "pub-secret",
      fetch: async (input, init) => {
        calls.push({
          url: String(input),
          method: init?.method,
          auth: new Headers(init?.headers).get("authorization"),
        });
        return new Response(null, { status: 204 });
      },
    });

    await adapter.publish("shop-1");

    expect(calls).toEqual([
      {
        url: "https://nizhal-realtime.acme.workers.dev/_nizhal/publish?bucket=shop-1",
        method: "POST",
        auth: "Bearer pub-secret",
      },
    ]);
  });

  it("throws when the bridge rejects (so a failed publish is never silent)", async () => {
    const adapter = cloudflareHttpRealtime({
      publishUrl: "https://nizhal-realtime.acme.workers.dev/_nizhal/publish",
      publishSecret: "pub-secret",
      fetch: async () => new Response("forbidden", { status: 403 }),
    });
    await expect(adapter.publish("shop-1")).rejects.toThrow(/cloudflare publish failed: 403/);
  });
});

describe("Cloudflare room authorization", () => {
  it("fails loud with 500 (not a silent 403) when no authorization backend is configured", async () => {
    const response = await authorizeRealtimeRoom(
      "valid-token",
      "shop-a",
      {}, // neither NIZHAL_AUTHORIZATION_URL nor NIZHAL_AUTHORIZATION_SERVICE set
      async () => ({ userId: "user-a" }),
    );
    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(500);
    expect(await (response as Response).text()).toMatch(/NIZHAL_AUTHORIZATION_URL/);
  });

  it("rejects a valid identity token when storage-backed membership denies the requested room", async () => {
    const secret = "cf-room-secret";
    const token = issueBearerToken({
      secret,
      userId: "user-a",
      ownerId: "owner-a",
    });
    const env = {
      NIZHAL_AUTHORIZATION_SERVICE: {
        async fetch(request) {
          expect(new URL(request.url).searchParams.get("bucket")).toBe("shop-b");
          expect(request.headers.get("authorization")).toBe(`Bearer ${token}`);
          return new Response("forbidden", { status: 403 });
        },
      },
    };

    const response = await authorizeRealtimeRoom(token, "shop-b", env, async (value) =>
      value === token ? { userId: "user-a" } : null,
    );

    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(403);
  });

  it("accepts a room when identity and storage-backed membership both authorize it", async () => {
    const result = await authorizeRealtimeRoom(
      "valid-token",
      "shop-a",
      {
        NIZHAL_AUTHORIZATION_SERVICE: {
          async fetch() {
            return new Response(null, { status: 204 });
          },
        },
      },
      async () => ({ userId: "user-a" }),
    );

    expect(result).toEqual({ authorization: "Bearer valid-token", identity: { userId: "user-a" } });
  });

  it("re-authorizes Durable Object connections before broadcasting and closes revoked members", async () => {
    const sent: string[] = [];
    const closed: Array<[number, string]> = [];
    const connection = {
      deserializeAttachment: () =>
        createSocketAttachment({
          authorization: "Bearer actor-token",
          bucket: "shop-a",
          cursor: null,
          identity: { userId: "user-a", ownerId: "owner-a" },
          tokenExpiresAt: Date.now() + 60_000,
        }),
      send: (message: string) => sent.push(message),
      close: (code: number, reason: string) => closed.push([code, reason]),
    };
    let allowed = true;
    const env = {
      NIZHAL_AUTHORIZATION_SERVICE: {
        async fetch() {
          return new Response(null, { status: allowed ? 204 : 403 });
        },
      },
    };

    await repullAuthorizedConnections([connection], env, "shop-a");
    allowed = false;
    await repullAuthorizedConnections([connection], env, "shop-a");

    expect(sent).toEqual(["repull:shop-a"]);
    expect(closed).toEqual([[1008, "bucket access revoked"]]);
  });

  it("drops an expired credential before an outbound Durable Object ping", async () => {
    const sent: string[] = [];
    const closed: Array<[number, string]> = [];
    let authorizationChecks = 0;
    const connection = {
      deserializeAttachment: () =>
        createSocketAttachment({
          authorization: "Bearer expired-token",
          bucket: "shop-a",
          cursor: "cursor-9",
          identity: { userId: "user-a", ownerId: "owner-a" },
          tokenExpiresAt: 999,
        }),
      send: (message: string) => sent.push(message),
      close: (code: number, reason: string) => closed.push([code, reason]),
    };

    await repullAuthorizedConnections(
      [connection],
      {
        NIZHAL_AUTHORIZATION_SERVICE: {
          async fetch() {
            authorizationChecks += 1;
            return new Response(null, { status: 204 });
          },
        },
      },
      "shop-a",
      1_000,
    );

    expect(sent).toEqual([]);
    expect(closed).toEqual([[1008, "credential expired"]]);
    expect(authorizationChecks).toBe(0);
  });
});

describe("Cloudflare WebSocket hibernation", () => {
  it("round-trips subscription, cursor, and identity state through the socket attachment", () => {
    let serialized: unknown = null;
    const beforeHibernate = {
      serializeAttachment(value: unknown) {
        serialized = structuredClone(value);
      },
      deserializeAttachment() {
        return serialized;
      },
    };
    const attachment = createSocketAttachment({
      authorization: "Bearer valid-token",
      bucket: "shop-a",
      cursor: "cursor-42",
      identity: { userId: "user-a", ownerId: "owner-a" },
      tokenExpiresAt: 50_000,
    });

    beforeHibernate.serializeAttachment(attachment);
    const afterWake = {
      deserializeAttachment() {
        return structuredClone(serialized);
      },
    };

    expect(restoreSocketAttachment(afterWake)).toEqual(attachment);
    expect(restoreSocketAttachment(afterWake)?.subscriptions).toEqual(["shop-a"]);
    expect(NIZHAL_BUCKET_OPTIONS).toEqual({ hibernate: true });
  });

  it("registers ping/pong auto-response on Durable Object state", () => {
    const configured: unknown[] = [];
    const pair = { request: NIZHAL_PING, response: NIZHAL_PONG };
    configureWebSocketAutoResponse(
      { setWebSocketAutoResponse: (value) => configured.push(value) },
      (request, response) => ({ request, response }),
    );

    expect(configured).toEqual([pair]);
  });
});

describe("Cloudflare ephemeral relay", () => {
  it("relays presence, typing, cursor, and whisper frames verbatim without a durable-state input", () => {
    const relayed: string[] = [];
    const sender = ephemeralConnection("sender");
    const peer = ephemeralConnection("peer", relayed);
    const frames = [
      'presence:{"online":true}',
      'typing:{"active":true}',
      'cursor:{"x":12,"y":8}',
      'whisper:{"to":"peer","body":"hi"}',
    ];

    for (const frame of frames) {
      expect(relayEphemeralFrame(sender, [sender, peer], frame, 1_000)).toBe(true);
    }

    expect(relayed).toEqual(frames);
    expect(sender.closed).toEqual([]);
  });

  it("closes a socket that exceeds the ephemeral frame rate", () => {
    const sender = ephemeralConnection("sender");
    const peer = ephemeralConnection("peer");
    for (let index = 0; index < EPHEMERAL_RATE_LIMIT; index += 1) {
      expect(relayEphemeralFrame(sender, [sender, peer], "typing:{}", 1_000)).toBe(true);
    }

    expect(relayEphemeralFrame(sender, [sender, peer], "typing:{}", 1_000)).toBe(false);
    expect(sender.closed).toEqual([[1008, "ephemeral rate limit exceeded"]]);
  });
});

function ephemeralConnection(id: string, sent: string[] = []) {
  let attachment = createSocketAttachment({
    authorization: "Bearer valid-token",
    bucket: "shop-a",
    cursor: null,
    identity: { userId: id, ownerId: "owner-a" },
    tokenExpiresAt: 50_000,
  });
  const closed: Array<[number, string]> = [];
  return {
    id,
    closed,
    send(message: string) {
      sent.push(message);
    },
    close(code: number, reason: string) {
      closed.push([code, reason]);
    },
    serializeAttachment(value: unknown) {
      attachment = structuredClone(value) as typeof attachment;
    },
    deserializeAttachment() {
      return structuredClone(attachment);
    },
  };
}
