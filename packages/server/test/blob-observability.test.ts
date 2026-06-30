import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { defineMutator, defineMutators, defineSyncRules, formatHlc } from "@nizhal/kernel";
import { eq } from "drizzle-orm";
import { integer, pgTable, text } from "drizzle-orm/pg-core";
import { afterEach, describe, expect, it } from "vitest";
import { localFsBlobStore } from "../src/adapters/blob.js";
import { postgresStorage } from "../src/adapters/storage.js";
import { createNizhalServer } from "../src/index.js";
import type { NizhalObserver } from "../src/observer.js";

const openDbs: PGlite[] = [];
const openDirs: string[] = [];

const blobRefs = pgTable("blob_refs", {
  id: text("id").primaryKey(),
  owner_id: text("owner_id").notNull(),
  mime: text("mime").notNull(),
  size: integer("size").notNull(),
  status: text("status").notNull(),
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
    data: (bucket) => [
      b.table("blob_refs").where(b.eq("owner_id", bucket.ownerId)),
      b.table("customers").where(b.eq("owner_id", bucket.ownerId)),
    ],
  }),
}));

const auth = {
  async resolve() {
    return { userId: "user-1", ownerId: "owner-1" };
  },
};

async function createProvisionedStorage() {
  const db = new PGlite();
  openDbs.push(db);
  const storage = postgresStorage({ connectionString: "postgres://unused", client: db });
  await db.exec(`
    create table blob_refs (
      id text primary key,
      owner_id text not null,
      mime text not null,
      size integer not null,
      status text not null
    );
    create table customers (
      id text primary key,
      owner_id text not null,
      name text not null,
      phone text not null
    );
  `);
  await storage.provision({
    schema: { customers: { table: customers, merge: "field" } },
    syncRules,
  });
  return { db, storage };
}

function makeBlobDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "echo-blob-"));
  openDirs.push(dir);
  return dir;
}

async function postJson(
  app: ReturnType<typeof createNizhalServer>["app"],
  path: string,
  body: unknown,
) {
  return app.request(path, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

describe("blob sync + observability", () => {
  afterEach(async () => {
    await Promise.all(openDbs.splice(0).map((db) => db.close()));
    for (const dir of openDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("presigns, uploads locally, syncs a reference row, and downloads via presigned URL", async () => {
    const { storage } = await createProvisionedStorage();
    const blobDir = makeBlobDir();
    const blob = localFsBlobStore({
      root: blobDir,
      publicBaseUrl: "http://127.0.0.1",
      secret: "blob-secret",
    });

    const server = createNizhalServer({
      db: "postgres://unused",
      schema: {},
      mutators: defineMutators({
        addBlobRef: defineMutator(
          { parse: (input) => input as any },
          async ({ tx, actor }, args) => {
            await tx.insert(blobRefs).values({
              id: args.key,
              owner_id: actor.ownerId,
              mime: args.mime,
              size: args.size,
              status: args.status,
            });
            return { affectedBuckets: [actor.ownerId] };
          },
        ),
      }),
      syncRules,
      auth,
      storage,
      blob,
    });

    const key = "test-key-1";
    const presign = await postJson(server.app, "/nizhal/blob/presign-upload", {
      key,
      mime: "text/plain",
      bucket: "owner-1",
    });
    expect(presign.status).toBe(200);
    const presignBody = (await presign.json()) as {
      url: string;
      method: string;
      key: string;
    };
    expect(presignBody.key).toBe(key);
    expect(presignBody.method).toBe("PUT");

    const content = new TextEncoder().encode("hello blob");
    const uploadPath = new URL(presignBody.url).pathname + new URL(presignBody.url).search;
    const upload = await server.app.request(uploadPath, {
      method: "PUT",
      headers: { "content-type": "text/plain" },
      body: content,
    });
    expect(upload.status).toBe(204);

    const push = await postJson(server.app, "/sync/push", {
      mutations: [
        {
          name: "addBlobRef",
          args: { key, mime: "text/plain", size: content.byteLength, status: "synced" },
          clientMutationId: "cmid-blob-1",
        },
      ],
    });
    expect(push.status).toBe(200);

    const pull = await postJson(server.app, "/sync/pull", { cursor: "" });
    const pullBody = (await pull.json()) as {
      changed: { table: string; rows: { id: string; status: string }[] }[];
    };
    const refs = pullBody.changed.find((c) => c.table === "blob_refs")?.rows ?? [];
    expect(refs).toEqual([expect.objectContaining({ id: key, status: "synced" })]);

    const downloadPresign = await server.app.request(`/nizhal/blob/${key}/url`);
    expect(downloadPresign.status).toBe(200);
    const downloadBody = (await downloadPresign.json()) as { url: string };
    const downloadPath = new URL(downloadBody.url).pathname + new URL(downloadBody.url).search;
    const download = await server.app.request(downloadPath);
    expect(download.status).toBe(200);
    expect(await download.text()).toBe("hello blob");
  });

  it("rejects a download URL request for a blob outside the actor's buckets", async () => {
    const { db, storage } = await createProvisionedStorage();
    const blobDir = makeBlobDir();
    const blob = localFsBlobStore({
      root: blobDir,
      publicBaseUrl: "http://127.0.0.1",
      secret: "blob-secret",
    });

    await db.query(
      "insert into blob_refs (id, owner_id, mime, size, status) values ($1, $2, $3, $4, $5)",
      ["other-key", "owner-2", "text/plain", 5, "synced"],
    );

    const server = createNizhalServer({
      db: "postgres://unused",
      schema: {},
      mutators: defineMutators({}),
      syncRules,
      auth,
      storage,
      blob,
    });

    const response = await server.app.request("/nizhal/blob/other-key/url");
    expect(response.status).toBe(404);
  });

  it("fires observer hooks for pull, push, conflict, and error", async () => {
    const { db, storage } = await createProvisionedStorage();
    const events: {
      pulls: unknown[];
      pushes: unknown[];
      conflicts: unknown[];
      errors: unknown[];
    } = { pulls: [], pushes: [], conflicts: [], errors: [] };

    const observer: NizhalObserver = {
      onPull(e) {
        events.pulls.push(e);
      },
      onPush(e) {
        events.pushes.push(e);
      },
      onConflict(e) {
        events.conflicts.push(e);
      },
      onError(e) {
        events.errors.push(e);
      },
    };

    await db.query("insert into customers (id, owner_id, name, phone) values ($1, $2, $3, $4)", [
      "customer-1",
      "owner-1",
      "Alice",
      "111",
    ]);

    const server = createNizhalServer({
      db: "postgres://unused",
      schema: { customers: { table: customers, merge: "field" } },
      mutators: defineMutators({
        updateName: defineMutator({ parse: (input) => input as any }, async ({ tx }, args) => {
          await tx.update(customers).set({ name: args.value }).where(eq(customers.id, args.id));
          return { affectedBuckets: ["owner-1"] };
        }),
        blowup: defineMutator({ parse: (input) => input }, async () => {
          throw new Error("non-deterministic failure");
        }),
      }),
      syncRules,
      auth,
      storage,
      observer,
    });

    const pull = await postJson(server.app, "/sync/pull", { cursor: "" });
    expect(pull.status).toBe(200);
    expect(events.pulls).toHaveLength(1);
    expect(events.pulls[0]).toMatchObject({ cursor: expect.any(String), rows: 1, tombstones: 0 });

    const push = await postJson(server.app, "/sync/push", {
      mutations: [
        {
          name: "updateName",
          args: { id: "customer-1", value: "Bob" },
          clientMutationId: "cmid-name",
        },
      ],
    });
    expect(push.status).toBe(200);
    expect(events.pushes).toHaveLength(1);
    expect(events.pushes[0]).toMatchObject({
      mutator: "updateName",
      clientMutationId: "cmid-name",
      ok: true,
    });

    const high = formatHlc({
      wallTime: Date.UTC(2026, 0, 2),
      counter: 0,
      nodeId: "0000000000000002",
    });
    await postJson(server.app, "/sync/push", {
      mutations: [
        {
          name: "updateName",
          args: { id: "customer-1", value: "High" },
          clientMutationId: "cmid-high",
          hlc: high,
        },
      ],
    });
    const low = formatHlc({
      wallTime: Date.UTC(2026, 0, 1),
      counter: 0,
      nodeId: "0000000000000001",
    });
    await postJson(server.app, "/sync/push", {
      mutations: [
        {
          name: "updateName",
          args: { id: "customer-1", value: "Low" },
          clientMutationId: "cmid-low",
          hlc: low,
        },
      ],
    });
    expect(events.conflicts.length).toBeGreaterThanOrEqual(1);
    expect(events.conflicts[0]).toMatchObject({
      mutator: "updateName",
      table: "customers",
      rowId: "customer-1",
      resolution: "merge",
    });

    const error = await postJson(server.app, "/sync/push", {
      mutations: [{ name: "blowup", args: {}, clientMutationId: "cmid-blowup" }],
    });
    expect(error.status).toBe(500);
    expect(events.errors.length).toBeGreaterThanOrEqual(1);
    expect(events.errors[0]).toMatchObject({
      phase: "push",
      code: expect.stringContaining("failure"),
    });
  });

  it("returns dead-letter + counts from the admin /nizhal/stats endpoint", async () => {
    const { storage } = await createProvisionedStorage();
    const originalPassword = process.env.NIZHAL_ADMIN_PASSWORD;
    process.env.NIZHAL_ADMIN_PASSWORD = "admin-secret";
    const server = createNizhalServer({
      db: "postgres://unused",
      schema: {},
      mutators: defineMutators({
        poison: defineMutator({ parse: (input) => input }, async () => {
          throw new Error("deterministic poison");
        }),
      }),
      syncRules,
      auth,
      storage,
    });

    try {
      const noAuth = await server.app.request("/nizhal/stats");
      expect(noAuth.status).toBe(401);

      const push = await postJson(server.app, "/sync/push", {
        mutations: [
          {
            name: "poison",
            args: {},
            clientID: "poison-client",
            mutationID: 1,
            clientMutationId: "cmid-poison",
          },
        ],
      });
      expect(push.status).toBe(422);

      const stats = await server.app.request("/nizhal/stats", {
        headers: { authorization: "Bearer admin-secret" },
      });
      expect(stats.status).toBe(200);
      const body = (await stats.json()) as {
        mutations: { appliedTotal: number };
        deadLetter: { count: number; items: unknown[] };
        jobs: { queued: number; running: number; failed: number };
        subscriptions: { activeSubscriptions: number };
      };
      expect(body.mutations.appliedTotal).toBeGreaterThanOrEqual(1);
      expect(body.deadLetter.count).toBeGreaterThanOrEqual(1);
      expect(body.deadLetter.items.length).toBeGreaterThanOrEqual(1);
      expect(body.jobs).toMatchObject({ queued: 0, running: 0, failed: 0 });
      expect(body.subscriptions.activeSubscriptions).toBe(0);
    } finally {
      process.env.NIZHAL_ADMIN_PASSWORD = originalPassword;
    }
  });
});
