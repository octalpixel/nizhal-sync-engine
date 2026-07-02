import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { defineMutator, defineMutators, defineSyncRules, z } from "@nizhal/kernel";
import { type NizhalAuth, createNizhalServer } from "@nizhal/server";
import { postgresStorage } from "@nizhal/server/adapters";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { pgTable, text } from "drizzle-orm/pg-core";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createNizhalClient, manualOnlineDetector, openNizhalStore } from "../src/index.js";

// P4 (T17): on-device derived-schema migration. On app update the store diffs the derived tables
// against the last-seen shape: additive columns migrate in place (data preserved); a breaking change
// drops + recreates the tables and clears the cursor so the next pull re-hydrates — with the durable
// outbox replayed so pending writes survive.

// Server shape is fixed at sm_notes(id, owner_id, body); the CLIENT schema is what changes per open.
const serverNotes = pgTable("sm_notes", {
  id: text("id").primaryKey(),
  owner_id: text("owner_id").notNull(),
  body: text("body"),
});
const syncRules = defineSyncRules((b) => ({
  ownerBucket: b.bucket({
    parameters: () => b.params({ ownerId: "owner_id" }),
    data: (bucket) => [b.table("sm_notes").where(b.eq("owner_id", bucket.ownerId))],
  }),
}));
const auth: NizhalAuth = {
  async resolve() {
    return { userId: "sm-user", ownerId: "sm-owner" };
  },
};
const id = z.string().min(1);
const serverMutators = defineMutators({
  addNote: defineMutator(z.object({ id, body: z.string() }), async ({ tx, actor }, args) => {
    await tx.insert(serverNotes).values({ id: args.id, owner_id: actor.ownerId, body: args.body });
    return { serverId: args.id, affectedBuckets: [actor.ownerId] };
  }),
});

// --- client schema variants (same file, different shape) ---
const v1 = pgTable("sm_notes", {
  id: text("id").primaryKey(),
  owner_id: text("owner_id").notNull(),
  body: text("body"),
});
const v2Additive = pgTable("sm_notes", {
  id: text("id").primaryKey(),
  owner_id: text("owner_id").notNull(),
  body: text("body"),
  tag: text("tag"), // NEW nullable column — additive
});
const v2Breaking = pgTable("sm_notes", {
  id: text("id").primaryKey(),
  owner_id: text("owner_id").notNull(), // body DROPPED — breaking
});

const clientMutators = (notes: typeof v1 | typeof v2Additive | typeof v2Breaking) =>
  defineMutators({
    addNote: defineMutator(z.object({ id, body: z.string() }), async ({ tx, actor }, args) => {
      const values: Record<string, unknown> = { id: args.id, owner_id: actor.ownerId };
      if ("body" in notes) values.body = args.body; // omit when the client no longer has the column
      await tx.insert(notes).values(values as never);
      return { serverId: args.id, affectedBuckets: [actor.ownerId] };
    }),
  });

const cleanups: Array<() => void | Promise<void>> = [];
afterAll(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

async function createHarness() {
  const pg = new PGlite();
  cleanups.push(() => pg.close());
  const storage = postgresStorage({ connectionString: "postgres://unused", client: pg });
  await pg.exec("create table sm_notes (id text primary key, owner_id text not null, body text)");
  await storage.provision({ schema: {}, syncRules });
  const server = createNizhalServer({
    db: "postgres://unused",
    schema: {},
    mutators: serverMutators,
    syncRules,
    auth,
    storage,
  });
  const listener = await serveFetch(server.app.fetch as unknown as typeof fetch);
  cleanups.push(listener.close);
  const dir = mkdtempSync(join(tmpdir(), "nizhal-sm-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

  async function open(file: string, notes: never, online: boolean) {
    const detector = manualOnlineDetector();
    if (!online) detector.setOnline(false);
    const store = await openNizhalStore({
      echo: createNizhalClient({
        server: listener.baseUrl,
        bucketsForSyncRule: () => ["sm-owner"],
      }),
      schema: { notes },
      syncRules,
      mutators: clientMutators(notes),
      actor: { userId: "sm-user", ownerId: "sm-owner" },
      database: drizzle(new Database(join(dir, file))),
      onlineDetector: detector,
      retryBaseMs: 20,
    });
    cleanups.push(() => store.dispose());
    return { store, detector };
  }
  return { open };
}

describe("P4 on-device schema migration (T17)", () => {
  it("additive: a new column migrates in place and preserves existing local data", async () => {
    const h = await createHarness();
    const first = await h.open("add.db", v1 as never, false);
    first.store.mutate.addNote({ id: "a1", body: "kept" });
    await vi.waitFor(async () => expect(await first.store.getPendingCount()).toBe(1));
    await first.store.dispose();

    // Reopen with the additive schema (offline, so nothing comes from the server).
    const second = await h.open("add.db", v2Additive as never, false);
    const rows = await second.store.db.select().from(second.store.tables.notes);
    expect(rows).toHaveLength(1);
    // existing row survived in place, with the new column present and null
    expect(rows[0]).toMatchObject({ id: "a1", body: "kept", tag: null });
  });

  it("breaking: a dropped column drops+recreates the tables and re-hydrates from the server", async () => {
    const h = await createHarness();
    const first = await h.open("break.db", v1 as never, true);
    first.store.mutate.addNote({ id: "b1", body: "on server" });
    await first.store.waitForIdle();
    await first.store.dispose();

    // Reopen with a breaking schema (body dropped). The tables reset; the pull re-hydrates b1.
    const second = await h.open("break.db", v2Breaking as never, true);
    await second.store.pullNow();
    const rows = await second.store.db.select().from(second.store.tables.notes);
    expect(rows.map((r) => r.id)).toEqual(["b1"]); // re-hydrated into the new (bodyless) schema
    expect(rows[0]).not.toHaveProperty("body");
  });

  it("breaking: a pending offline write survives the reset via outbox replay", async () => {
    const h = await createHarness();
    const first = await h.open("break-outbox.db", v1 as never, false);
    first.store.mutate.addNote({ id: "b2", body: "pending" });
    await vi.waitFor(async () => expect(await first.store.getPendingCount()).toBe(1));
    await first.store.dispose();

    // Reopen breaking + offline: the table is wiped, but the durable outbox replays b2 back in.
    const second = await h.open("break-outbox.db", v2Breaking as never, false);
    const rows = await second.store.db.select().from(second.store.tables.notes);
    expect(rows.map((r) => r.id)).toEqual(["b2"]); // optimistic row re-established from the outbox
    expect(await second.store.getPendingCount()).toBe(1); // still pending (offline)
  });
});

function serveFetch(fetchFn: typeof fetch): Promise<{ baseUrl: string; close: () => void }> {
  const server = createServer((req, res) => {
    const url = `http://${req.headers.host ?? "127.0.0.1"}${req.url ?? "/"}`;
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const init: RequestInit = {
        method: req.method ?? "GET",
        headers: req.headers as unknown as HeadersInit,
      };
      if (chunks.length > 0) init.body = Buffer.concat(chunks);
      fetchFn(new Request(url, init)).then(async (response) => {
        res.statusCode = response.status;
        response.headers.forEach((value, key) => res.setHeader(key, value));
        res.end(Buffer.from(await response.arrayBuffer()));
      });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ baseUrl: `http://127.0.0.1:${port}`, close: () => server.close() });
    });
  });
}
