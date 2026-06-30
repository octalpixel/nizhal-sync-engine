import { createServer } from "node:http";
import { PGlite } from "@electric-sql/pglite";
import { defineMutators, defineSyncRules } from "@nizhal/kernel";
import { bearerTokenAuth, createNizhalServer, issueBearerToken } from "@nizhal/server";
import { postgresStorage } from "@nizhal/server/adapters";
import { afterEach, describe, expect, it } from "vitest";
import { createNizhalClient } from "../src/client.js";
import { createNizhalStatus } from "../src/status.js";

const syncRules = defineSyncRules((b) => ({
  ownerBucket: b.bucket({
    parameters: () => b.params({ ownerId: "owner_id" }),
    data: (bucket) => [b.table("notes").where(b.eq("owner_id", bucket.ownerId))],
  }),
}));

const SECRET = "refresh-test-secret";
const openDbs: PGlite[] = [];

describe("auth refresh on 401", () => {
  afterEach(async () => {
    await Promise.all(openDbs.splice(0).map((db) => db.close()));
  });

  it("refreshes an expired token and retries pull once", async () => {
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

    let currentToken = issueBearerToken({
      secret: SECRET,
      userId: "user-1",
      ownerId: "owner-1",
      expiresInSec: -1,
    });
    let refreshCalls = 0;

    const server = createNizhalServer({
      db: "postgres://unused",
      schema: {},
      mutators: defineMutators({}),
      syncRules,
      auth: bearerTokenAuth({ secret: SECRET }),
      storage,
    });
    const port = await freePort();
    const listener = server.listen(port);

    try {
      const status = createNizhalStatus({});
      const client = createNizhalClient({
        server: `http://127.0.0.1:${port}`,
        auth: {
          headers: { authorization: `Bearer ${currentToken}` },
          refresh: async () => {
            refreshCalls += 1;
            currentToken = issueBearerToken({
              secret: SECRET,
              userId: "user-1",
              ownerId: "owner-1",
              expiresInSec: 3600,
            });
            return { authorization: `Bearer ${currentToken}` };
          },
        },
        status,
      });

      const result = await client.pull({ cursor: "", syncRule: "ownerBucket" });
      expect(result.changed).toEqual([]);
      expect(refreshCalls).toBe(1);
    } finally {
      await closeListener(listener);
    }
  });

  it("surfaces a non-refreshable 401 without infinite retry", async () => {
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
      auth: bearerTokenAuth({ secret: SECRET }),
      storage,
    });
    const port = await freePort();
    const listener = server.listen(port);

    try {
      const status = createNizhalStatus({});
      const client = createNizhalClient({
        server: `http://127.0.0.1:${port}`,
        auth: {
          headers: { authorization: "Bearer invalid-token" },
        },
        status,
      });

      await expect(client.pull({ cursor: "", syncRule: "ownerBucket" })).rejects.toThrow(
        /pull failed: 401/,
      );
      expect(status.syncStatus().lastError?.phase).toBe("pull");
    } finally {
      await closeListener(listener);
    }
  });
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  if (!address || typeof address === "string") throw new Error("missing test port");
  return address.port;
}

function closeListener(listener: ReturnType<ReturnType<typeof createNizhalServer>["listen"]>) {
  return new Promise<void>((resolve, reject) => {
    listener.close((error?: Error) => (error ? reject(error) : resolve()));
  });
}
