import { createServer } from "node:net";
import { PGlite } from "@electric-sql/pglite";
import {
  type ContractSchemaSource,
  type SyncRules,
  defineMutator,
  defineMutators,
  defineSyncRules,
  formatHlc,
} from "@nizhal/kernel";
import { eq } from "drizzle-orm";
import { bigserial, pgTable, text } from "drizzle-orm/pg-core";
import type { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { RealtimeAdapter } from "../src/adapters/realtime.js";
import { postgresStorage } from "../src/adapters/storage.js";
import { type NizhalAuth, createNizhalServer } from "../src/index.js";
import { createJobWorker } from "../src/jobs.js";

const openDbs: PGlite[] = [];

const notes = pgTable("notes", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  owner_id: text("owner_id").notNull(),
  body: text("body").notNull(),
  client_id: text("client_id"),
});

const cascadeParents = pgTable("cascade_parents", {
  id: text("id").primaryKey(),
  owner_id: text("owner_id").notNull(),
});

const cascadeChildren = pgTable("cascade_children", {
  id: text("id").primaryKey(),
  parent_id: text("parent_id").notNull(),
  owner_id: text("owner_id").notNull(),
});

const cascadeAudits = pgTable("cascade_audits", {
  id: text("id").primaryKey(),
  parent_id: text("parent_id").notNull(),
  owner_id: text("owner_id").notNull(),
});

const customers = pgTable("customers", {
  id: text("id").primaryKey(),
  owner_id: text("owner_id").notNull(),
  name: text("name").notNull(),
  phone: text("phone").notNull(),
});

const syncRules = defineSyncRules((b) => ({
  ownerBucket: b.bucket({
    parameters: () => b.params({ ownerId: "owner_id" }),
    data: (bucket) => [b.table("notes").where(b.eq("owner_id", bucket.ownerId))],
  }),
}));

const auth: NizhalAuth = {
  async resolve() {
    return { userId: "user-1", ownerId: "owner-1" };
  },
};

describe("sync core", () => {
  afterEach(async () => {
    await Promise.all(openDbs.splice(0).map((db) => db.close()));
  });

  it("returns only in-bucket changes and tombstones from /sync/pull", async () => {
    const { db, storage } = await createProvisionedStorage();
    const server = createNizhalServer({
      db: "postgres://unused",
      schema: {},
      mutators: defineMutators({}),
      syncRules,
      auth,
      storage,
    });

    await db.query("insert into notes (id, owner_id, body) values ($1, $2, $3)", [
      10,
      "owner-1",
      "visible",
    ]);
    await db.query("insert into notes (id, owner_id, body) values ($1, $2, $3)", [
      20,
      "owner-2",
      "hidden",
    ]);
    await db.query("delete from notes where id in ($1, $2)", [10, 20]);
    await db.query("insert into notes (id, owner_id, body) values ($1, $2, $3)", [
      30,
      "owner-1",
      "visible-new",
    ]);

    const response = await server.app.request("/sync/pull", {
      method: "POST",
      body: JSON.stringify({ cursor: "" }),
      headers: { "content-type": "application/json" },
    });
    const body = (await response.json()) as {
      changed: { table: string; rows: { id: number; body: string }[] }[];
      tombstoned: { table: string; id: string }[];
      cursor: string;
    };

    expect(response.status).toBe(200);
    expect(body.changed).toEqual([
      { table: "notes", rows: [expect.objectContaining({ id: 30, body: "visible-new" })] },
    ]);
    expect(body.tombstoned).toEqual([{ table: "notes", id: "10" }]);
    expect(body.cursor).not.toBe("");
  }, 30_000);

  it("pages equal-timestamp rows without skipping across a page boundary", async () => {
    const { db, storage } = await createProvisionedStorage();
    const server = createNizhalServer({
      db: "postgres://unused",
      schema: {},
      mutators: defineMutators({}),
      syncRules,
      auth,
      storage,
    });

    const writtenAt = Date.now();
    for (let i = 0; i < 5; i += 1) {
      await db.query(
        "insert into notes (id, owner_id, body, updated_at) values ($1, $2, $3, to_timestamp($4 / 1000.0))",
        [100 + i, "owner-1", `row-${i}`, writtenAt],
      );
    }

    const ids: number[] = [];
    let cursor: string | number = 0;
    let hasMore = true;
    while (hasMore) {
      const response = await postJson(server.app, "/sync/pull", { cursor, limit: 2 });
      const body = (await response.json()) as {
        changed: { table: string; rows: { id: number }[] }[];
        hasMore?: boolean;
        cursor: string;
      };
      expect(response.status).toBe(200);
      ids.push(...body.changed.flatMap((batch) => batch.rows.map((row) => row.id)));
      cursor = body.cursor;
      hasMore = body.hasMore === true;
    }

    expect(ids).toEqual([100, 101, 102, 103, 104]);
    expect(typeof cursor).toBe("string");
  }, 10_000);

  it("emits soft-delete tombstones and bucket-exit removals", async () => {
    const { db, storage } = await createProvisionedStorage();

    await db.query("insert into notes (id, owner_id, body, client_id) values ($1, $2, $3, $4)", [
      200,
      "owner-1",
      "soft-delete",
      "client-soft",
    ]);
    await db.query("insert into notes (id, owner_id, body, client_id) values ($1, $2, $3, $4)", [
      201,
      "owner-1",
      "bucket-move",
      "client-move",
    ]);
    const baseline = await storage.getChanges({
      actor: { userId: "user-1", ownerId: "owner-1" },
      syncRules,
      cursor: "",
    });

    await db.query("update notes set deleted_at = now() where id = $1", [200]);
    await db.query("update notes set owner_id = $1 where id = $2", ["owner-2", 201]);

    const result = await storage.getChanges({
      actor: { userId: "user-1", ownerId: "owner-1" },
      syncRules,
      cursor: baseline.cursor,
    });

    expect(result.tombstoned).toEqual([{ table: "notes", id: "200", key: "client-soft" }]);
    expect(result.removed).toEqual([{ table: "notes", id: "201", key: "client-move" }]);
  });

  it("rejects unauthenticated pull and push requests", async () => {
    const { storage } = await createProvisionedStorage();
    const server = createNizhalServer({
      db: "postgres://unused",
      schema: {},
      mutators: defineMutators({}),
      syncRules,
      auth: {
        async resolve() {
          return null;
        },
      },
      storage,
    });

    const pull = await server.app.request("/sync/pull", { method: "POST" });
    const push = await server.app.request("/sync/push", { method: "POST" });

    expect(pull.status).toBe(401);
    expect(push.status).toBe(401);
  });

  it("applies a pushed mutator once and records client-id to server-id reconciliation", async () => {
    const { db, storage } = await createProvisionedStorage();
    const realtime = recordingRealtime();
    const server = createNizhalServer({
      db: "postgres://unused",
      schema: {},
      mutators: defineMutators({
        addNote: defineMutator({ parse: parseAddNote }, async ({ tx, actor }, args) => {
          const result = (await tx.insert(notes).values({
            owner_id: actor.ownerId,
            body: args.body,
            client_id: args.clientId,
          })) as { id: number }[];
          return {
            serverId: result[0]?.id,
            affectedBuckets: [actor.ownerId],
          };
        }),
      }),
      syncRules,
      auth,
      storage,
      realtime,
    });
    const request = {
      mutations: [
        {
          name: "addNote",
          args: { clientId: "client-note-1", body: "hello" },
          clientMutationId: "cmid-1",
        },
      ],
    };

    const first = await postJson(server.app, "/sync/push", request);
    const second = await postJson(server.app, "/sync/push", request);
    const noteRows = await db.query<{ id: number; client_id: string; body: string }>(
      "select id, client_id, body from notes order by id",
    );
    const applied = await db.query<{
      client_mutation_id: string;
      client_id: string;
      server_id: string;
    }>("select client_mutation_id, client_id, server_id from _nizhal_mutations");

    expect(first.status, await first.clone().text()).toBe(200);
    expect(second.status, await second.clone().text()).toBe(200);
    expect(await first.json()).toEqual({ applied: ["cmid-1"] });
    expect(await second.json()).toEqual({ applied: ["cmid-1"] });
    expect(noteRows.rows).toEqual([{ id: 1, client_id: "client-note-1", body: "hello" }]);
    expect(applied.rows).toEqual([
      { client_mutation_id: "cmid-1", client_id: "client-note-1", server_id: "1" },
    ]);
    expect(realtime.published).toEqual(["owner-1"]);
  });

  it("does not fail a durably-committed push when realtime publish throws (B1)", async () => {
    const { db, storage } = await createProvisionedStorage();
    const throwingRealtime: RealtimeAdapter = {
      publish() {
        throw new Error("simulated transient realtime publish failure");
      },
      subscribe() {
        return () => {};
      },
    };
    const server = createNizhalServer({
      db: "postgres://unused",
      schema: {},
      mutators: defineMutators({
        addNote: defineMutator({ parse: parseAddNote }, async ({ tx, actor }, args) => {
          const result = (await tx.insert(notes).values({
            owner_id: actor.ownerId,
            body: args.body,
            client_id: args.clientId,
          })) as { id: number }[];
          return { serverId: result[0]?.id, affectedBuckets: [actor.ownerId] };
        }),
      }),
      syncRules,
      auth,
      storage,
      realtime: throwingRealtime,
    });
    const request = {
      mutations: [
        {
          name: "addNote",
          args: { clientId: "client-b1", body: "hi" },
          clientMutationId: "cmid-b1",
        },
      ],
    };

    const res = await postJson(server.app, "/sync/push", request);
    const noteRows = await db.query<{ id: number }>("select id from notes");

    // The mutation commits; a post-commit publish failure must NOT fail the push nor drop the ack.
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toEqual({ applied: ["cmid-b1"] });
    expect(noteRows.rows.length).toBe(1);
  });

  it("delivers bucket-scoped repull pings over /sync/stream after a push", async () => {
    const { storage } = await createProvisionedStorage();
    const server = createNizhalServer({
      db: "postgres://unused",
      schema: {},
      mutators: defineMutators({
        addNote: defineMutator({ parse: parseAddNote }, async ({ tx, actor }, args) => {
          await tx.insert(notes).values({
            owner_id: actor.ownerId,
            body: args.body,
            client_id: args.clientId,
          });
          return { affectedBuckets: [actor.ownerId] };
        }),
      }),
      syncRules,
      auth,
      storage,
    });
    const port = await freePort();
    const listener = server.listen(port);
    const socket = new WebSocket(`ws://127.0.0.1:${port}/sync/stream`);

    try {
      await waitForOpen(socket);
      const message = waitForRepullMessage(socket);
      const response = await fetch(`http://127.0.0.1:${port}/sync/push`, {
        method: "POST",
        body: JSON.stringify({
          mutations: [
            {
              name: "addNote",
              args: { clientId: "client-note-ws", body: "hello ws" },
              clientMutationId: "cmid-ws",
            },
          ],
        }),
        headers: { "content-type": "application/json" },
      });

      expect(response.status).toBe(200);
      await expect(message).resolves.toBe("repull:owner-1");
    } finally {
      socket.close();
      await closeListener(listener);
    }
  });

  it("broadcasts ephemeral presence v2 state/diff frames over /sync/stream", async () => {
    const { storage } = await createProvisionedStorage();
    const dynamicAuth: NizhalAuth = {
      async resolve(req) {
        const userId = req.headers.get("x-user-id") ?? "user-1";
        return { userId, ownerId: "owner-1", displayName: `User ${userId}` };
      },
    };
    const server = createNizhalServer({
      db: "postgres://unused",
      schema: {},
      mutators: defineMutators({}),
      syncRules,
      auth: dynamicAuth,
      storage,
    });
    const port = await freePort();
    const listener = server.listen(port);
    const socketA = new WebSocket(`ws://127.0.0.1:${port}/sync/stream`, {
      headers: { "x-user-id": "user-a" },
    });

    try {
      const framesA = collectPresenceFrames(socketA, 4);
      await waitForOpen(socketA);
      const [stateA] = await framesA.next(1);
      expect(stateA.type).toBe("state");
      expect(stateA.state).toEqual({});

      socketA.send(
        `presence:track:${JSON.stringify({ bucket: "owner-1", payload: { displayName: "User user-a" } })}`,
      );
      const [, joinA] = await framesA.next(2);
      expect(joinA.type).toBe("diff");
      expect(joinA.joins["user-a"]).toEqual([
        expect.objectContaining({ displayName: "User user-a" }),
      ]);

      const socketB = new WebSocket(`ws://127.0.0.1:${port}/sync/stream`, {
        headers: { "x-user-id": "user-b" },
      });
      const framesB = collectPresenceFrames(socketB, 2);
      await waitForOpen(socketB);
      const [stateB] = await framesB.next(1);
      expect(stateB.type).toBe("state");
      expect(stateB.state["user-a"]).toEqual([
        expect.objectContaining({ displayName: "User user-a" }),
      ]);

      socketB.send(
        `presence:track:${JSON.stringify({ bucket: "owner-1", payload: { displayName: "User user-b" } })}`,
      );
      const [, joinB] = await framesB.next(2);
      expect(joinB.joins["user-b"]).toEqual([
        expect.objectContaining({ displayName: "User user-b" }),
      ]);

      const [, , joinAB] = await framesA.next(3);
      expect(joinAB.joins["user-b"]).toEqual([
        expect.objectContaining({ displayName: "User user-b" }),
      ]);

      socketB.close();
      const [, , , leaveAB] = await framesA.next(4);
      expect(leaveAB.leaves["user-b"]).toEqual([
        expect.objectContaining({ displayName: "User user-b" }),
      ]);
      expect(leaveAB.joins).toEqual({});

      const rows = await storage.getChanges({
        actor: { userId: "x", ownerId: "owner-1" },
        syncRules,
        cursor: "",
      });
      expect(rows.changed).toEqual([]);
    } finally {
      socketA.close();
      await closeListener(listener);
    }
  });

  it("emits removedBuckets when a client loses its previous bucket scope", async () => {
    const { db, storage } = await createProvisionedStorage();
    await db.exec("create table memberships (user_id text not null, owner_id text not null)");
    await db.query("insert into memberships (user_id, owner_id) values ($1, $2)", [
      "user-1",
      "owner-1",
    ]);
    const revocationRules = defineSyncRules((b) => ({
      ownerBucket: b.bucket({
        parameters: (actor) =>
          b.membership({
            table: "memberships",
            where: { user_id: actor.userId },
            select: { ownerId: "owner_id" },
          }),
        data: (bucket) => [b.table("notes").where(b.eq("owner_id", bucket.ownerId))],
      }),
    }));
    const server = createNizhalServer({
      db: "postgres://unused",
      schema: {},
      mutators: defineMutators({}),
      syncRules: revocationRules,
      auth: {
        async resolve() {
          return { userId: "user-1", ownerId: "owner-1" };
        },
      },
      storage,
    });

    const first = await postJson(server.app, "/sync/pull", { cursor: "", deviceId: "client-1" });
    await db.query("delete from memberships where user_id = $1", ["user-1"]);
    const second = await postJson(server.app, "/sync/pull", { cursor: "", deviceId: "client-1" });

    expect(first.status).toBe(200);
    expect(((await first.json()) as { removedBuckets?: string[] }).removedBuckets).toEqual([]);
    expect(second.status).toBe(200);
    expect(((await second.json()) as { removedBuckets?: string[] }).removedBuckets).toEqual([
      "owner-1",
    ]);
  });

  it("persists mutator-enqueued jobs and workers retry before dead-lettering failures", async () => {
    const { db, storage } = await createProvisionedStorage();
    const server = createNizhalServer({
      db: "postgres://unused",
      schema: {},
      mutators: defineMutators({
        enqueueReminder: defineMutator({ parse: (input) => input }, async ({ jobs }) => {
          jobs.enqueue("record-reminder", { customerId: "customer-1" });
          return { affectedBuckets: ["owner-1"] };
        }),
      }),
      syncRules,
      auth,
      storage,
    });
    const ran: unknown[] = [];
    const worker = createJobWorker({
      connectionString: "postgres://unused",
      client: db,
      tasks: {
        "record-reminder": ({ input }) => {
          ran.push(input);
        },
        fail: () => {
          throw new Error("still broken");
        },
      },
      backoffMs: () => 0,
    });

    const push = await postJson(server.app, "/sync/push", {
      mutations: [{ name: "enqueueReminder", args: {}, clientMutationId: "cmid-job" }],
    });
    await db.query(
      "insert into _nizhal_jobs (task_slug, input, max_attempts) values ($1, $2::jsonb, $3)",
      ["fail", JSON.stringify({ kind: "retry" }), 2],
    );

    expect(push.status).toBe(200);
    expect(await worker.runOnce()).toBe(1);
    expect(ran).toEqual([{ customerId: "customer-1" }]);
    expect(await worker.runOnce()).toBe(1);
    expect(await worker.runOnce()).toBe(1);

    const jobs = await db.query<{
      task_slug: string;
      status: string;
      attempts: number;
      last_error: string | null;
    }>("select task_slug, status, attempts, last_error from _nizhal_jobs order by id");
    expect(jobs.rows).toEqual([
      { task_slug: "record-reminder", status: "succeeded", attempts: 1, last_error: null },
      { task_slug: "fail", status: "dead_letter", attempts: 2, last_error: "still broken" },
    ]);
  });

  it("rolls back a multi-table mutator when the cascade fails", async () => {
    const { db, storage } = await createProvisionedStorage();
    await db.exec(`
      create table cascade_parents (id text primary key, owner_id text not null);
      create table cascade_children (id text primary key, parent_id text not null, owner_id text not null);
      create table cascade_audits (id text primary key, parent_id text not null, owner_id text not null);
    `);
    const cascadeRules = defineSyncRules((b) => ({
      ownerBucket: b.bucket({
        parameters: () => b.params({ ownerId: "owner_id" }),
        data: (bucket) => [
          b.table("cascade_parents").where(b.eq("owner_id", bucket.ownerId)),
          b.table("cascade_children").where(b.eq("owner_id", bucket.ownerId)),
          b.table("cascade_audits").where(b.eq("owner_id", bucket.ownerId)),
        ],
      }),
    }));
    await storage.provision({ schema: {}, syncRules: cascadeRules });
    const server = createNizhalServer({
      db: "postgres://unused",
      schema: {},
      mutators: defineMutators({
        cascade: defineMutator({ parse: (input) => input }, async ({ tx }) => {
          await tx.insert(cascadeParents).values({ id: "parent-1", owner_id: "owner-1" });
          await tx.insert(cascadeChildren).values({
            id: "child-1",
            parent_id: "parent-1",
            owner_id: "owner-1",
          });
          await tx.insert(cascadeAudits).values({
            id: "audit-1",
            parent_id: "parent-1",
            owner_id: "owner-1",
          });
          throw new Error("cascade failed");
        }),
      }),
      syncRules: cascadeRules,
      auth,
      storage,
    });

    const response = await postJson(server.app, "/sync/push", {
      mutations: [{ name: "cascade", args: {}, clientMutationId: "cmid-cascade" }],
    });
    const parents = await db.query("select * from cascade_parents");
    const children = await db.query("select * from cascade_children");
    const audits = await db.query("select * from cascade_audits");
    const applied = await db.query("select * from _nizhal_mutations");

    expect(response.status).toBe(500);
    expect(parents.rows).toEqual([]);
    expect(children.rows).toEqual([]);
    expect(audits.rows).toEqual([]);
    expect(applied.rows).toEqual([]);
  });

  it("enforces per-client mutation order and burns poison mutations without wedging LMID", async () => {
    const { db, storage } = await createProvisionedStorage();
    const server = createNizhalServer({
      db: "postgres://unused",
      schema: {},
      mutators: defineMutators({
        addNote: defineMutator({ parse: parseAddNote }, async ({ tx, actor }, args) => {
          await tx.insert(notes).values({
            owner_id: actor.ownerId,
            body: args.body,
            client_id: args.clientId,
          });
          return { affectedBuckets: [actor.ownerId] };
        }),
        poison: defineMutator({ parse: (input) => input }, async () => {
          throw new Error("deterministic poison");
        }),
      }),
      syncRules,
      auth,
      storage,
    });

    const outOfOrder = await postJson(server.app, "/sync/push", {
      mutations: [
        sequencedMutation("addNote", { clientId: "skip", body: "skip" }, "client-seq", 2, "cmid-2"),
      ],
    });
    expect(outOfOrder.status).toBe(409);
    expect(await outOfOrder.json()).toMatchObject({ lastMutationId: 0 });

    const poison = await postJson(server.app, "/sync/push", {
      mutations: [sequencedMutation("poison", {}, "client-seq", 1, "cmid-1")],
    });
    expect(poison.status).toBe(422);

    const good = await postJson(server.app, "/sync/push", {
      mutations: [
        sequencedMutation(
          "addNote",
          { clientId: "after-poison", body: "good" },
          "client-seq",
          2,
          "cmid-2",
        ),
      ],
    });
    const notesAfter = await db.query<{ client_id: string }>(
      "select client_id from notes order by id",
    );
    const clients = await db.query<{ client_id: string; last_mutation_id: number }>(
      "select client_id, last_mutation_id from _nizhal_clients",
    );

    expect(good.status, await good.clone().text()).toBe(200);
    expect(await good.clone().json()).toEqual({ applied: ["cmid-2"], lastMutationId: 2 });
    expect(notesAfter.rows).toEqual([{ client_id: "after-poison" }]);
    expect(clients.rows).toEqual([{ client_id: "client-seq", last_mutation_id: 2 }]);

    const pull = await postJson(server.app, "/sync/pull", {
      cursor: "",
      deviceId: "client-seq",
    });
    expect(await pull.json()).toMatchObject({ lastMutationId: 2 });

    const stale = await postJson(server.app, "/sync/push", {
      mutations: [
        sequencedMutation(
          "addNote",
          { clientId: "post-upgrade", body: "upgrade" },
          "client-seq",
          1,
          "cmid-upgrade",
        ),
      ],
    });
    expect(await stale.json()).toEqual({ applied: [], lastMutationId: 2 });

    const recovered = await postJson(server.app, "/sync/push", {
      mutations: [
        sequencedMutation(
          "addNote",
          { clientId: "post-upgrade", body: "upgrade" },
          "client-seq",
          3,
          "cmid-upgrade",
        ),
      ],
    });
    expect(await recovered.json()).toEqual({ applied: ["cmid-upgrade"], lastMutationId: 3 });
  });

  it("applies duplicate sequenced pushes once and increments row versions monotonically", async () => {
    const { db, storage } = await createProvisionedStorage();
    const server = createNizhalServer({
      db: "postgres://unused",
      schema: {},
      mutators: defineMutators({
        addNote: defineMutator({ parse: parseAddNote }, async ({ tx, actor }, args) => {
          await tx.insert(notes).values({
            owner_id: actor.ownerId,
            body: args.body,
            client_id: args.clientId,
          });
          return { affectedBuckets: [actor.ownerId] };
        }),
        updateNote: defineMutator({ parse: parseAddNote }, async ({ tx }, args) => {
          await tx.update(notes).set({ body: args.body }).where(eq(notes.client_id, args.clientId));
          return { affectedBuckets: ["owner-1"] };
        }),
      }),
      syncRules,
      auth,
      storage,
    });
    const firstMutation = sequencedMutation(
      "addNote",
      { clientId: "dup-note", body: "first" },
      "client-dup",
      1,
      "cmid-dup",
    );

    const [first, duplicate] = await Promise.all([
      postJson(server.app, "/sync/push", { mutations: [firstMutation] }),
      postJson(server.app, "/sync/push", { mutations: [firstMutation] }),
    ]);
    const inserted = await db.query<{ client_id: string; _nizhal_row_version: number }>(
      "select client_id, _nizhal_row_version from notes",
    );

    const update = await postJson(server.app, "/sync/push", {
      mutations: [
        sequencedMutation(
          "updateNote",
          { clientId: "dup-note", body: "second" },
          "client-dup",
          2,
          "cmid-update",
        ),
      ],
    });
    const updated = await db.query<{ body: string; _nizhal_row_version: number }>(
      "select body, _nizhal_row_version from notes where client_id = $1",
      ["dup-note"],
    );

    expect(first.status).toBe(200);
    expect(duplicate.status).toBe(200);
    expect(await first.clone().json()).toEqual({ applied: ["cmid-dup"], lastMutationId: 1 });
    expect(await duplicate.clone().json()).toEqual({
      applied: ["cmid-dup"],
      lastMutationId: 1,
    });
    expect(update.status).toBe(200);
    expect(inserted.rows).toHaveLength(1);
    expect(updated.rows).toEqual([expect.objectContaining({ body: "second" })]);
    expect(updated.rows[0]?._nizhal_row_version).toBeGreaterThan(
      inserted.rows[0]?._nizhal_row_version ?? 0,
    );
  });

  it("merges field-merge tables per field while default tables stay commit-order LWW", async () => {
    const fieldSyncRules = defineSyncRules((b) => ({
      ownerBucket: b.bucket({
        parameters: () => b.params({ ownerId: "owner_id" }),
        data: (bucket) => [
          b.table("notes").where(b.eq("owner_id", bucket.ownerId)),
          b.table("customers").where(b.eq("owner_id", bucket.ownerId)),
        ],
      }),
    }));
    const { db, storage } = await createProvisionedStorage({
      schema: { customers: { table: customers, merge: "field" } },
      syncRules: fieldSyncRules,
      extraSql: `
        create table customers (
          id text primary key,
          owner_id text not null,
          name text not null,
          phone text not null
        );
      `,
    });
    await db.query("insert into customers (id, owner_id, name, phone) values ($1, $2, $3, $4)", [
      "customer-1",
      "owner-1",
      "Alice",
      "111",
    ]);
    await db.query("insert into notes (id, owner_id, body, client_id) values ($1, $2, $3, $4)", [
      50,
      "owner-1",
      "original",
      "ledger-1",
    ]);
    const server = createNizhalServer({
      db: "postgres://unused",
      schema: { customers: { table: customers, merge: "field" } },
      mutators: defineMutators({
        updateName: defineMutator({ parse: parseCustomerPatch }, async ({ tx }, args) => {
          await tx.update(customers).set({ name: args.value }).where(eq(customers.id, args.id));
          return { affectedBuckets: ["owner-1"] };
        }),
        updatePhone: defineMutator({ parse: parseCustomerPatch }, async ({ tx }, args) => {
          await tx.update(customers).set({ phone: args.value }).where(eq(customers.id, args.id));
          return { affectedBuckets: ["owner-1"] };
        }),
        updateNote: defineMutator({ parse: parseAddNote }, async ({ tx }, args) => {
          await tx.update(notes).set({ body: args.body }).where(eq(notes.client_id, args.clientId));
          return { affectedBuckets: ["owner-1"] };
        }),
      }),
      syncRules: fieldSyncRules,
      auth,
      storage,
    });
    const low = formatHlc({
      wallTime: Date.UTC(2026, 0, 1),
      counter: 0,
      nodeId: "0000000000000001",
    });
    const high = formatHlc({
      wallTime: Date.UTC(2026, 0, 2),
      counter: 0,
      nodeId: "0000000000000002",
    });

    await postJson(server.app, "/sync/push", {
      mutations: [
        sequencedMutation(
          "updateName",
          { id: "customer-1", value: "Bob" },
          "field-a",
          1,
          "f1",
          low,
        ),
        sequencedMutation(
          "updatePhone",
          { id: "customer-1", value: "222" },
          "field-b",
          1,
          "f2",
          high,
        ),
      ],
    });
    await postJson(server.app, "/sync/push", {
      mutations: [
        sequencedMutation(
          "updateName",
          { id: "customer-1", value: "High" },
          "field-c",
          1,
          "f3",
          high,
        ),
        sequencedMutation(
          "updateName",
          { id: "customer-1", value: "Low" },
          "field-d",
          1,
          "f4",
          low,
        ),
        sequencedMutation(
          "updateNote",
          { clientId: "ledger-1", body: "high" },
          "ledger-a",
          1,
          "l1",
          high,
        ),
        sequencedMutation(
          "updateNote",
          { clientId: "ledger-1", body: "low" },
          "ledger-b",
          1,
          "l2",
          low,
        ),
      ],
    });

    const customerRows = await db.query<{
      name: string;
      phone: string;
      _meta: Record<string, string>;
    }>("select name, phone, _meta from customers where id = $1", ["customer-1"]);
    const noteRows = await db.query<{ body: string }>(
      "select body from notes where client_id = $1",
      ["ledger-1"],
    );

    expect(customerRows.rows).toEqual([
      { name: "High", phone: "222", _meta: { name: high, phone: high } },
    ]);
    expect(noteRows.rows).toEqual([{ body: "low" }]);
  });
});

async function createProvisionedStorage(opts?: {
  schema?: Record<string, ContractSchemaSource>;
  extraSql?: string;
  syncRules?: SyncRules;
}) {
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
    ${opts?.extraSql ?? ""}
  `);
  await storage.provision({ schema: opts?.schema ?? {}, syncRules: opts?.syncRules ?? syncRules });
  return { db, storage };
}

function parseAddNote(input: unknown): { clientId: string; body: string } {
  if (
    typeof input === "object" &&
    input !== null &&
    typeof (input as { clientId?: unknown }).clientId === "string" &&
    typeof (input as { body?: unknown }).body === "string"
  ) {
    return input as { clientId: string; body: string };
  }
  throw new Error("invalid addNote input");
}

function parseCustomerPatch(input: unknown): { id: string; value: string } {
  if (
    typeof input === "object" &&
    input !== null &&
    typeof (input as { id?: unknown }).id === "string" &&
    typeof (input as { value?: unknown }).value === "string"
  ) {
    return input as { id: string; value: string };
  }
  throw new Error("invalid customer patch input");
}

function sequencedMutation(
  name: string,
  args: unknown,
  clientID: string,
  mutationID: number,
  clientMutationId: string,
  hlc = formatHlc({ wallTime: Date.UTC(2026, 0, 1), counter: mutationID, nodeId: clientID }),
) {
  return { name, args, clientID, mutationID, clientMutationId, hlc };
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

async function postJson(app: Hono, path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

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

function waitForOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
}

function waitForRepullMessage(socket: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for repull message")), 2000);
    const handler = (data: WebSocket.RawData) => {
      const text = data.toString();
      if (!text.startsWith("repull:")) return;
      clearTimeout(timer);
      socket.off("message", handler);
      resolve(text);
    };
    socket.on("message", handler);
    socket.once("error", (error) => {
      clearTimeout(timer);
      socket.off("message", handler);
      reject(error);
    });
  });
}

function closeListener(listener: ReturnType<ReturnType<typeof createNizhalServer>["listen"]>) {
  return new Promise<void>((resolve, reject) => {
    listener.close((error?: Error) => (error ? reject(error) : resolve()));
  });
}

function collectPresenceFrames(
  socket: WebSocket,
  max: number,
): {
  next(count: number): Promise<
    Array<
      | { type: "state"; bucket: string; state: Record<string, unknown[]> }
      | {
          type: "diff";
          bucket: string;
          joins: Record<string, unknown[]>;
          leaves: Record<string, unknown[]>;
        }
    >
  >;
} {
  type Frame =
    | { type: "state"; bucket: string; state: Record<string, unknown[]> }
    | {
        type: "diff";
        bucket: string;
        joins: Record<string, unknown[]>;
        leaves: Record<string, unknown[]>;
      };
  const frames: Frame[] = [];
  const waiters: Array<(value: Frame[]) => void> = [];

  const handler = (data: WebSocket.RawData) => {
    const text = data.toString();
    if (text.startsWith("presence:state:")) {
      const body = JSON.parse(text.slice("presence:state:".length)) as {
        bucket: string;
        state: Record<string, unknown[]>;
      };
      frames.push({ type: "state", bucket: body.bucket, state: body.state });
    } else if (text.startsWith("presence:diff:")) {
      const body = JSON.parse(text.slice("presence:diff:".length)) as {
        bucket: string;
        joins: Record<string, unknown[]>;
        leaves: Record<string, unknown[]>;
      };
      frames.push({
        type: "diff",
        bucket: body.bucket,
        joins: body.joins,
        leaves: body.leaves,
      });
    } else {
      return;
    }
    if (frames.length >= max) socket.off("message", handler);
    for (const waiter of waiters.splice(0)) waiter(frames);
  };
  socket.on("message", handler);

  return {
    next(count) {
      if (frames.length >= count) return Promise.resolve(frames.slice(0, count));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          socket.off("message", handler);
          reject(new Error(`timed out waiting for ${count} presence frame(s)`));
        }, 3000);
        waiters.push((value) => {
          clearTimeout(timer);
          resolve(value.slice(0, count));
        });
      });
    },
  };
}
