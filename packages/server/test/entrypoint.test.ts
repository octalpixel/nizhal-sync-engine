import { PGlite } from "@electric-sql/pglite";
import { createNodeWebSocket } from "@hono/node-ws";
import { type SyncRules, defineSyncRules } from "@nizhal/kernel";
import { describe, expect, it } from "vitest";
import { postgresStorage } from "../src/adapters/storage.js";
import { type NizhalAuth, createNizhalServer } from "../src/index.js";

// The platform-agnostic entrypoint surface (containers/serverless/Bun): app.fetch, an injectable WS
// adapter factory, injectWebSocket/provisionRealtime for custom hosts, and runJobsOnce for serverless
// outbox draining. Node stays the default.

const syncRules: SyncRules = defineSyncRules((b) => ({
  ownerBucket: b.bucket({
    parameters: () => b.params({ ownerId: "owner_id" }),
    data: (bucket) => [b.table("notes").where(b.eq("owner_id", bucket.ownerId))],
  }),
}));
const auth: NizhalAuth = {
  async resolve() {
    return { userId: "u", ownerId: "o" };
  },
};

describe("platform-agnostic entrypoint", () => {
  it("uses the injectable WS factory and exposes injectWebSocket / provisionRealtime / runJobsOnce", async () => {
    const pg = new PGlite();
    const storage = postgresStorage({ connectionString: "postgres://unused", client: pg });
    await pg.exec("create table notes (id text primary key, owner_id text not null)");
    await storage.provision({ schema: {}, syncRules });

    let factoryApp: unknown;
    const server = createNizhalServer({
      db: "postgres://unused",
      schema: {},
      mutators: {},
      syncRules,
      auth,
      storage,
      // Injectable factory — a Bun/Deno host passes its own adapter here instead of the Node default.
      createWebSocket: (app) => {
        factoryApp = app;
        return createNodeWebSocket({ app });
      },
    });

    expect(factoryApp).toBeDefined(); // the factory received the Hono app
    expect(typeof server.app.fetch).toBe("function"); // runs on any fetch-based host
    expect(server.webSocket).toBeDefined();
    expect(typeof server.webSocket.upgradeWebSocket).toBe("function");
    expect(typeof server.injectWebSocket).toBe("function");
    expect(typeof server.provisionRealtime).toBe("function");
    expect(typeof server.runJobsOnce).toBe("function");

    // runJobsOnce drains the built-in outbox once (serverless cron path) — returns a count.
    await server.provisionRealtime();
    const ran = await server.runJobsOnce();
    expect(typeof ran).toBe("number");

    await pg.close();
  });
});
