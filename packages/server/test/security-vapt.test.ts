import { createServer } from "node:net";
import { PGlite } from "@electric-sql/pglite";
import { defineMutator, defineMutators, defineSyncRules } from "@nizhal/kernel";
import { eq } from "drizzle-orm";
import { pgTable, text } from "drizzle-orm/pg-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { inProcessRealtime } from "../src/adapters/realtime.js";
import { postgresStorage } from "../src/adapters/storage.js";
import { bearerTokenAuth, issueBearerToken } from "../src/auth.js";
import { createNizhalServer } from "../src/index.js";

const openDbs: PGlite[] = [];

const records = pgTable("records", {
  id: text("id").primaryKey(),
  shop_id: text("shop_id").notNull(),
  value: text("value").notNull(),
});

const membershipRules = defineSyncRules((b) => ({
  shops: b.bucket({
    parameters: (actor) =>
      b.membership({
        table: "shop_members",
        where: { user_id: actor.userId },
        select: { shopId: "shop_id" },
      }),
    data: (bucket) => [b.table("records").where(b.eq("shop_id", bucket.shopId))],
  }),
}));

describe("Wave-0 VAPT security contract", () => {
  afterEach(async () => {
    await Promise.all(openDbs.splice(0).map((db) => db.close()));
  });

  it("rejects and rolls back foreign-bucket inserts, updates, and deletes inside the mutator transaction", async () => {
    const { db, server } = await createHarness();

    const insert = await push(server, "insert", {
      id: "foreign-insert",
      shopId: "shop-b",
      value: "PWNED",
    });
    const update = await push(server, "update", { id: "foreign-update", value: "PWNED" });
    const remove = await push(server, "delete", { id: "foreign-delete" });
    const legitimate = await push(server, "update", { id: "own-update", value: "allowed" });

    expect([insert.status, update.status, remove.status]).toEqual([403, 403, 403]);
    expect(legitimate.status, await legitimate.clone().text()).toBe(200);
    const rows = await db.query<{ id: string; shop_id: string; value: string }>(
      "select id, shop_id, value from records order by id",
    );
    expect(rows.rows).toEqual([
      { id: "foreign-delete", shop_id: "shop-b", value: "safe" },
      { id: "foreign-update", shop_id: "shop-b", value: "safe" },
      { id: "own-update", shop_id: "shop-a", value: "allowed" },
    ]);
  });

  it("rejects unauthorized Node rooms and re-authorizes an accepted subscription before each ping", async () => {
    const { db, server, realtime } = await createHarness();
    const port = await freePort();
    const listener = server.listen(port);
    const unauthorized = new WebSocket(`ws://127.0.0.1:${port}/sync/stream?bucket=shop-b`);
    const authorized = new WebSocket(`ws://127.0.0.1:${port}/sync/stream?bucket=shop-a`);

    try {
      await expectUpgradeStatus(unauthorized, 403);
      await waitForOpen(authorized);
      const beforeRevocation = nextRepull(authorized);
      await realtime.publish("shop-a");
      await expect(beforeRevocation).resolves.toBe("repull:shop-a");

      await db.query("delete from shop_members where user_id = $1 and shop_id = $2", [
        "user-a",
        "shop-a",
      ]);
      const received: string[] = [];
      authorized.on("message", (data) => received.push(data.toString()));
      await realtime.publish("shop-a");
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(received).toEqual([]);
    } finally {
      unauthorized.close();
      authorized.close();
      await closeListener(listener);
    }
  });

  it("drops an expired Node credential before an outbound realtime ping", async () => {
    const secret = "node-expiry-secret";
    const token = issueBearerToken({
      secret,
      userId: "user-a",
      ownerId: "owner-a",
      expiresInSec: 60,
    });
    const { server, realtime } = await createHarness(bearerTokenAuth({ secret }));
    const port = await freePort();
    const listener = server.listen(port);
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/sync/stream?bucket=shop-a&token=${encodeURIComponent(token)}`,
    );
    const repulls: string[] = [];
    socket.on("message", (data) => {
      const message = data.toString();
      if (message.startsWith("repull:")) repulls.push(message);
    });

    try {
      await waitForOpen(socket);
      const closed = nextClose(socket);
      const now = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(now + 120_000);
      await realtime.publish("shop-a");
      await expect(closed).resolves.toEqual([1008, "credential expired"]);
      expect(repulls).toEqual([]);
    } finally {
      vi.restoreAllMocks();
      socket.close();
      await closeListener(listener);
    }
  });

  it("tracks revocation independently for two devices of the same actor", async () => {
    const { db, server } = await createHarness();
    const firstA = await pull(server, "device-a");
    const firstB = await pull(server, "device-b");
    expect(firstA.removedBuckets).toEqual([]);
    expect(firstB.removedBuckets).toEqual([]);

    await db.query("delete from shop_members where user_id = $1 and shop_id = $2", [
      "user-a",
      "shop-a",
    ]);
    const revokedA = await pull(server, "device-a");
    const repeatedA = await pull(server, "device-a");
    const revokedB = await pull(server, "device-b");
    const repeatedB = await pull(server, "device-b");

    expect(revokedA.removedBuckets).toEqual(["shop-a"]);
    expect(repeatedA.removedBuckets).toEqual([]);
    expect(revokedB.removedBuckets).toEqual(["shop-a"]);
    expect(repeatedB.removedBuckets).toEqual([]);
  });
});

async function createHarness(
  auth = {
    async resolve() {
      return { userId: "user-a", ownerId: "owner-a", shopId: "shop-a" };
    },
  },
) {
  const db = new PGlite();
  openDbs.push(db);
  const storage = postgresStorage({ connectionString: "postgres://unused", client: db });
  await db.exec(`
    create table shop_members (user_id text not null, shop_id text not null);
    create table records (id text primary key, shop_id text not null, value text not null);
  `);
  await storage.provision({ schema: {}, syncRules: membershipRules });
  await db.exec(`
    insert into shop_members (user_id, shop_id) values ('user-a', 'shop-a');
    insert into records (id, shop_id, value) values
      ('foreign-update', 'shop-b', 'safe'),
      ('foreign-delete', 'shop-b', 'safe'),
      ('own-update', 'shop-a', 'safe');
  `);
  const realtime = inProcessRealtime();
  const server = createNizhalServer({
    db: "postgres://unused",
    schema: {},
    syncRules: membershipRules,
    auth,
    storage,
    realtime,
    mutators: defineMutators({
      insert: defineMutator({ parse: parseRecord }, async ({ tx }, args) => {
        await tx.insert(records).values({ id: args.id, shop_id: args.shopId, value: args.value });
      }),
      update: defineMutator({ parse: parseRecordPatch }, async ({ tx }, args) => {
        await tx.update(records, { id: args.id }).set({ value: args.value });
      }),
      delete: defineMutator({ parse: parseRecordId }, async ({ tx }, args) => {
        await tx.delete(records, { id: args.id });
      }),
    }),
  });
  return { db, server, realtime };
}

async function pull(server: Awaited<ReturnType<typeof createHarness>>["server"], deviceId: string) {
  const response = await server.app.request("/sync/pull", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cursor: "", deviceId }),
  });
  expect(response.status, await response.clone().text()).toBe(200);
  return response.json() as Promise<{ removedBuckets: string[] }>;
}

function push(
  server: Awaited<ReturnType<typeof createHarness>>["server"],
  name: string,
  args: unknown,
) {
  return server.app.request("/sync/push", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      mutations: [{ name, args, clientMutationId: `${name}-${JSON.stringify(args)}` }],
    }),
  });
}

function parseRecord(value: unknown): { id: string; shopId: string; value: string } {
  const input = value as { id?: unknown; shopId?: unknown; value?: unknown };
  if (
    typeof input.id !== "string" ||
    typeof input.shopId !== "string" ||
    typeof input.value !== "string"
  )
    throw new Error("invalid record");
  return { id: input.id, shopId: input.shopId, value: input.value };
}

function parseRecordPatch(value: unknown): { id: string; value: string } {
  const input = value as { id?: unknown; value?: unknown };
  if (typeof input.id !== "string" || typeof input.value !== "string")
    throw new Error("invalid record patch");
  return { id: input.id, value: input.value };
}

function parseRecordId(value: unknown): { id: string } {
  const input = value as { id?: unknown };
  if (typeof input.id !== "string") throw new Error("invalid record id");
  return { id: input.id };
}

async function freePort(): Promise<number> {
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const address = socket.address();
  await new Promise<void>((resolve, reject) =>
    socket.close((error) => (error ? reject(error) : resolve())),
  );
  if (!address || typeof address === "string") throw new Error("missing port");
  return address.port;
}

function waitForOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
}

function expectUpgradeStatus(socket: WebSocket, status: number): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("unexpected-response", (_request, response) => {
      if (response.statusCode === status) resolve();
      else reject(new Error(`expected ${status}, received ${response.statusCode}`));
    });
    socket.once("open", () => reject(new Error("unexpected websocket upgrade")));
    socket.once("error", reject);
  });
}

function nextRepull(socket: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for repull")), 2_000);
    socket.once("message", (data) => {
      clearTimeout(timer);
      resolve(data.toString());
    });
  });
}

function nextClose(socket: WebSocket): Promise<[number, string]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for close")), 2_000);
    socket.once("close", (code, reason) => {
      clearTimeout(timer);
      resolve([code, reason.toString()]);
    });
  });
}

function closeListener(listener: ReturnType<ReturnType<typeof createNizhalServer>["listen"]>) {
  return new Promise<void>((resolve, reject) => {
    listener.close((error?: Error) => (error ? reject(error) : resolve()));
  });
}
