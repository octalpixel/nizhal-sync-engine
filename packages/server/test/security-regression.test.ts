import { PGlite } from "@electric-sql/pglite";
import { SyncRuleLintError, defineMutator, defineMutators, defineSyncRules } from "@nizhal/kernel";
import { afterEach, describe, expect, it } from "vitest";
import type { RealtimeAdapter } from "../src/adapters/realtime.js";
import { type StorageAdapter, postgresStorage } from "../src/adapters/storage.js";
import { bearerTokenAuth, issueBearerToken, signHs256Jwt } from "../src/auth.js";
import { type NizhalAuth, createNizhalServer } from "../src/index.js";

const openDbs: PGlite[] = [];

const ownerSyncRules = defineSyncRules((b) => ({
  ownerBucket: b.bucket({
    parameters: () => b.params({ ownerId: "owner_id" }),
    data: (bucket) => [b.table("notes").where(b.eq("owner_id", bucket.ownerId))],
  }),
}));

describe("security regression probes", () => {
  afterEach(async () => {
    await Promise.all(openDbs.splice(0).map((db) => db.close()));
  });

  it("does not let raw data queries fake bucket scope and leak another owner", async () => {
    expect(() =>
      defineSyncRules((b) => ({
        ownerBucket: b.bucket({
          parameters: () => b.params({ ownerId: "owner_id" }),
          data: () => [
            b.raw(
              `select id, owner_id, body, client_id, updated_at, deleted_at, 'owner-1' as "ownerId" from notes`,
              { table: "notes", bucketScopes: ["ownerId"] as const },
            ),
          ],
        }),
      })),
    ).toThrow(SyncRuleLintError);
  });

  it("rejects an unscoped related-table read in sync rules", async () => {
    expect(() =>
      defineSyncRules((b) => ({
        ownerBucket: b.bucket({
          parameters: () => b.params({ ownerId: "owner_id" }),
          data: (bucket) => [
            b
              .table("notes")
              .related([b.table("comments").where()], b.eq("owner_id", bucket.ownerId)),
          ],
        }),
      })),
    ).toThrow(SyncRuleLintError);
  });

  it("does not return out-of-bucket rows from scoped related-table reads", async () => {
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
      create table comments (
        id text primary key,
        owner_id text not null,
        note_id bigint not null,
        body text not null
      );
    `);
    const nestedRules = defineSyncRules((b) => ({
      ownerBucket: b.bucket({
        parameters: () => b.params({ ownerId: "owner_id" }),
        data: (bucket) => [
          b
            .table("notes")
            .related(
              [b.table("comments").where(b.eq("owner_id", bucket.ownerId))],
              b.eq("owner_id", bucket.ownerId),
            ),
        ],
      }),
    }));
    await storage.provision({ schema: {}, syncRules: nestedRules });
    await db.query("insert into notes (id, owner_id, body, client_id) values ($1, $2, $3, $4)", [
      1,
      "owner-1",
      "visible",
      "n1",
    ]);
    await db.query("insert into notes (id, owner_id, body, client_id) values ($1, $2, $3, $4)", [
      2,
      "owner-2",
      "hidden",
      "n2",
    ]);
    await db.query("insert into comments (id, owner_id, note_id, body) values ($1, $2, $3, $4)", [
      "c1",
      "owner-1",
      1,
      "visible-comment",
    ]);
    await db.query("insert into comments (id, owner_id, note_id, body) values ($1, $2, $3, $4)", [
      "c2",
      "owner-2",
      2,
      "hidden-comment",
    ]);
    const server = createNizhalServer({
      db: "postgres://unused",
      schema: {},
      mutators: defineMutators({}),
      syncRules: nestedRules,
      auth: staticAuth("owner-1"),
      storage,
    });

    const response = await postJson(server.app, "/sync/pull", { cursor: "" });
    const body = (await response.json()) as {
      changed: { table: string; rows: { id: string; body: string }[] }[];
    };
    const comments = body.changed.find((change) => change.table === "comments")?.rows ?? [];

    expect(response.status).toBe(200);
    expect(comments).toEqual([expect.objectContaining({ id: "c1", body: "visible-comment" })]);
    expect(comments).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: "c2" })]));
  }, 30_000);

  it("does not expose another actor's prior bucket via a reused clientId", async () => {
    const { storage } = await createProvisionedStorage();
    const server = createNizhalServer({
      db: "postgres://unused",
      schema: {},
      mutators: defineMutators({}),
      syncRules: ownerSyncRules,
      auth: {
        async resolve(req) {
          return {
            userId: req.headers.get("x-user") ?? "user-1",
            ownerId: req.headers.get("x-owner") ?? "owner-1",
          };
        },
      },
      storage,
    });

    const victim = await postJson(
      server.app,
      "/sync/pull",
      { cursor: "", clientId: "shared-client" },
      { "x-user": "user-2", "x-owner": "owner-2" },
    );
    const attacker = await postJson(
      server.app,
      "/sync/pull",
      { cursor: "", clientId: "shared-client" },
      { "x-user": "user-1", "x-owner": "owner-1" },
    );
    const body = (await attacker.json()) as { removedBuckets?: string[] };

    expect(victim.status).toBe(200);
    expect(attacker.status).toBe(200);
    expect(body.removedBuckets ?? []).not.toContain("owner-2");
  });

  it("runs a duplicate clientMutationId mutator only once under concurrent push", async () => {
    const storage = raceStorage();
    let entered = 0;
    let releaseMutator: (() => void) | null = null;
    let signalEntered: (() => void) | null = null;
    const enteredOnce = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    const mutatorCanFinish = new Promise<void>((resolve) => {
      releaseMutator = resolve;
    });
    const server = createNizhalServer({
      db: "postgres://unused",
      schema: {},
      mutators: defineMutators({
        race: defineMutator({ parse: (input) => input }, async () => {
          entered += 1;
          signalEntered?.();
          await mutatorCanFinish;
          storage.writes.push("write");
          return { affectedBuckets: ["owner-1"] };
        }),
      }),
      syncRules: ownerSyncRules,
      auth: staticAuth("owner-1"),
      storage,
      realtime: recordingRealtime(),
    });
    const body = { mutations: [{ name: "race", args: {}, clientMutationId: "same-cmid" }] };
    const firstRequest = postJson(server.app, "/sync/push", body);
    const secondRequest = postJson(server.app, "/sync/push", body);

    await enteredOnce;
    releaseMutator?.();
    const [first, second] = await Promise.all([firstRequest, secondRequest]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(entered).toBe(1);
    expect(storage.writes).toEqual(["write"]);
  });

  it("does not publish realtime pings outside the authenticated actor's bucket scope", async () => {
    const realtime = recordingRealtime();
    const server = createNizhalServer({
      db: "postgres://unused",
      schema: {},
      mutators: defineMutators({
        spoofPublish: defineMutator({ parse: (input) => input }, async () => ({
          affectedBuckets: ["owner-2"],
        })),
      }),
      syncRules: ownerSyncRules,
      auth: staticAuth("owner-1"),
      storage: raceStorage(),
      realtime,
    });

    const response = await postJson(server.app, "/sync/push", {
      mutations: [{ name: "spoofPublish", args: {}, clientMutationId: "cmid-publish" }],
    });

    expect(response.status).toBe(200);
    expect(realtime.published).not.toContain("owner-2");
  });

  it("rejects HS256 bearer tokens that omit exp", async () => {
    const server = createNizhalServer({
      db: "postgres://unused",
      schema: {},
      mutators: defineMutators({}),
      syncRules: ownerSyncRules,
      auth: bearerTokenAuth({ secret: "test-secret" }),
      storage: raceStorage(),
    });
    const token = signHs256Jwt({ userId: "user-1", ownerId: "owner-1" }, "test-secret");

    const response = await server.app.request("/sync/pull", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ cursor: "" }),
    });

    expect(response.status).toBe(401);
  });

  it("enforces sync body-size and per-actor rate limits", async () => {
    const bodyLimitServer = createNizhalServer({
      db: "postgres://unused",
      schema: {},
      mutators: defineMutators({}),
      syncRules: ownerSyncRules,
      auth: staticAuth("owner-1"),
      storage: raceStorage(),
      limits: { maxBodyBytes: 8, rateLimit: false },
    });
    const oversizedPull = await bodyLimitServer.app.request("/sync/pull", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "x".repeat(64),
    });
    const oversizedPush = await bodyLimitServer.app.request("/sync/push", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "x".repeat(64),
    });

    const pullRateServer = createNizhalServer({
      db: "postgres://unused",
      schema: {},
      mutators: defineMutators({}),
      syncRules: ownerSyncRules,
      auth: headerAuth(),
      storage: raceStorage(),
      limits: { rateLimit: { windowMs: 60_000, maxRequests: 1 } },
    });
    const firstPull = await postJson(
      pullRateServer.app,
      "/sync/pull",
      { cursor: "" },
      { "x-user": "user-1", "x-owner": "owner-1" },
    );
    const secondPull = await postJson(
      pullRateServer.app,
      "/sync/pull",
      { cursor: "" },
      { "x-user": "user-1", "x-owner": "owner-1" },
    );
    const otherActorPull = await postJson(
      pullRateServer.app,
      "/sync/pull",
      { cursor: "" },
      { "x-user": "user-2", "x-owner": "owner-2" },
    );

    const pushRateServer = createNizhalServer({
      db: "postgres://unused",
      schema: {},
      mutators: defineMutators({}),
      syncRules: ownerSyncRules,
      auth: headerAuth(),
      storage: raceStorage(),
      limits: { rateLimit: { windowMs: 60_000, maxRequests: 1 } },
    });
    const firstPush = await postJson(
      pushRateServer.app,
      "/sync/push",
      { mutations: [] },
      { "x-user": "user-1", "x-owner": "owner-1" },
    );
    const secondPush = await postJson(
      pushRateServer.app,
      "/sync/push",
      { mutations: [] },
      { "x-user": "user-1", "x-owner": "owner-1" },
    );

    expect(oversizedPull.status).toBe(413);
    expect(oversizedPush.status).toBe(413);
    expect(firstPull.status).toBe(200);
    expect(secondPull.status).toBe(429);
    expect(otherActorPull.status).toBe(200);
    expect(firstPush.status).toBe(200);
    expect(secondPush.status).toBe(429);
  });

  it("rejects replay of an expired HS256 bearer token", async () => {
    const server = createNizhalServer({
      db: "postgres://unused",
      schema: {},
      mutators: defineMutators({}),
      syncRules: ownerSyncRules,
      auth: bearerTokenAuth({ secret: "test-secret" }),
      storage: raceStorage(),
    });
    const expired = issueBearerToken({
      secret: "test-secret",
      userId: "user-1",
      ownerId: "owner-1",
      expiresInSec: -60,
    });

    const first = await server.app.request("/sync/pull", {
      method: "POST",
      headers: { authorization: `Bearer ${expired}`, "content-type": "application/json" },
      body: JSON.stringify({ cursor: "" }),
    });
    const replay = await server.app.request("/sync/pull", {
      method: "POST",
      headers: { authorization: `Bearer ${expired}`, "content-type": "application/json" },
      body: JSON.stringify({ cursor: "" }),
    });

    expect(first.status).toBe(401);
    expect(replay.status).toBe(401);
  });

  it("does not let a refreshed token escalate ownerId across tenant scope", async () => {
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
    await storage.provision({ schema: {}, syncRules: ownerSyncRules });
    await db.query("insert into notes (id, owner_id, body, client_id) values ($1, $2, $3, $4)", [
      1,
      "owner-1",
      "secret-owner-1",
      "n1",
    ]);
    await db.query("insert into notes (id, owner_id, body, client_id) values ($1, $2, $3, $4)", [
      2,
      "owner-2",
      "secret-owner-2",
      "n2",
    ]);

    const server = createNizhalServer({
      db: "postgres://unused",
      schema: {},
      mutators: defineMutators({}),
      syncRules: ownerSyncRules,
      auth: bearerTokenAuth({ secret: "rotate-secret" }),
      storage,
    });
    const owner1Token = issueBearerToken({
      secret: "rotate-secret",
      userId: "user-1",
      ownerId: "owner-1",
    });
    const escalated = issueBearerToken({
      secret: "rotate-secret",
      userId: "user-1",
      ownerId: "owner-2",
    });

    const owner1Pull = await server.app.request("/sync/pull", {
      method: "POST",
      headers: { authorization: `Bearer ${owner1Token}`, "content-type": "application/json" },
      body: JSON.stringify({ cursor: "" }),
    });
    const escalatedPull = await server.app.request("/sync/pull", {
      method: "POST",
      headers: { authorization: `Bearer ${escalated}`, "content-type": "application/json" },
      body: JSON.stringify({ cursor: "" }),
    });
    const owner1Body = (await owner1Pull.json()) as {
      changed: { rows: { body: string }[] }[];
    };
    const escalatedBody = (await escalatedPull.json()) as {
      changed: { rows: { body: string }[] }[];
    };

    expect(owner1Pull.status).toBe(200);
    expect(escalatedPull.status).toBe(200);
    expect(owner1Body.changed[0]?.rows.map((row) => row.body)).toEqual(["secret-owner-1"]);
    expect(escalatedBody.changed[0]?.rows.map((row) => row.body)).toEqual(["secret-owner-2"]);
    expect(escalatedBody.changed[0]?.rows.map((row) => row.body)).not.toContain("secret-owner-1");
  });

  it("does not bypass per-actor rate limits via header spoofing or route hopping", async () => {
    const server = createNizhalServer({
      db: "postgres://unused",
      schema: {},
      mutators: defineMutators({}),
      syncRules: ownerSyncRules,
      auth: headerAuth(),
      storage: raceStorage(),
      limits: { rateLimit: { windowMs: 60_000, maxRequests: 1 } },
    });
    const headers = { "x-user": "user-1", "x-owner": "owner-1" };
    const firstPull = await postJson(server.app, "/sync/pull", { cursor: "" }, headers);
    const spoofedAgent = await postJson(
      server.app,
      "/sync/pull",
      { cursor: "" },
      { ...headers, "user-agent": "spoofed-bot", "x-forwarded-for": "10.0.0.99" },
    );
    const hopPush = await postJson(server.app, "/sync/push", { mutations: [] }, headers);

    expect(firstPull.status).toBe(200);
    expect(spoofedAgent.status).toBe(429);
    expect(hopPush.status).toBe(429);
  });
});

async function createProvisionedStorage() {
  const db = new PGlite();
  openDbs.push(db);
  const storage = postgresStorage({
    connectionString: "postgres://unused",
    client: db,
  });
  await db.exec(`
    create table notes (
      id bigserial primary key,
      owner_id text not null,
      body text not null,
      client_id text unique
    );
  `);
  await storage.provision({ schema: {}, syncRules: ownerSyncRules });
  return { db, storage };
}

function raceStorage(): StorageAdapter & { writes: string[] } {
  const applied = new Set<string>();
  return {
    writes: [],
    async getChanges() {
      return { changed: [], tombstoned: [], removedBuckets: [], cursor: "" };
    },
    async transaction<T>(fn: (tx: unknown) => Promise<T>) {
      return fn({});
    },
    async authorizeMutatorTx({ mutatorTx }) {
      return mutatorTx;
    },
    async claimMutation(_tx, clientMutationId) {
      if (applied.has(clientMutationId)) return false;
      applied.add(clientMutationId);
      return true;
    },
    async isApplied(clientMutationId) {
      return applied.has(clientMutationId);
    },
    async readLastMutationId() {
      return 0;
    },
    async recordApplied(clientMutationId) {
      applied.add(clientMutationId);
    },
    async provision() {},
  };
}

function recordingRealtime(): RealtimeAdapter & { published: string[] } {
  return {
    published: [],
    publish(bucket) {
      this.published.push(bucket);
    },
    subscribe() {
      return () => {};
    },
  };
}

function staticAuth(ownerId: string): NizhalAuth {
  return {
    async resolve() {
      return { userId: `user-${ownerId}`, ownerId };
    },
  };
}

function headerAuth(): NizhalAuth {
  return {
    async resolve(req) {
      return {
        userId: req.headers.get("x-user") ?? "user-1",
        ownerId: req.headers.get("x-owner") ?? "owner-1",
      };
    },
  };
}

async function postJson(
  app: ReturnType<typeof createNizhalServer>["app"],
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return app.request(path, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
  });
}
