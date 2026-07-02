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
import { afterAll, describe, expect, it } from "vitest";
import {
  type NizhalPushRequest,
  NizhalSyncTargetError,
  createNizhalClient,
  httpSyncTarget,
  manualOnlineDetector,
  openNizhalStore,
} from "../src/index.js";

// P4 (T15): the fleet-version gate. A client whose contractVersion is older than the server's
// minClientVersion is blocked on push with a typed 426 (`code: "upgrade_required"`); its durable
// outbox is untouched so it flushes once the app updates. Current/newer clients are unaffected.

const notes = pgTable("vg_notes", {
  id: text("id").primaryKey(),
  owner_id: text("owner_id").notNull(),
  body: text("body").notNull(),
});
const schema = { notes };
const syncRules = defineSyncRules((b) => ({
  ownerBucket: b.bucket({
    parameters: () => b.params({ ownerId: "owner_id" }),
    data: (bucket) => [b.table("vg_notes").where(b.eq("owner_id", bucket.ownerId))],
  }),
}));
const auth: NizhalAuth = {
  async resolve() {
    return { userId: "vg-user", ownerId: "vg-owner" };
  },
};
const id = z.string().min(1);
const noteMutators = defineMutators({
  addNote: defineMutator(z.object({ id, body: z.string().min(1) }), async ({ tx, actor }, args) => {
    await tx.insert(notes).values({ id: args.id, owner_id: actor.ownerId, body: args.body });
    return { serverId: args.id, affectedBuckets: [actor.ownerId] };
  }),
});

const cleanups: Array<() => void | Promise<void>> = [];
afterAll(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

async function createHarness(minClientVersion: string) {
  const pg = new PGlite();
  cleanups.push(() => pg.close());
  const storage = postgresStorage({ connectionString: "postgres://unused", client: pg });
  await pg.exec(
    "create table vg_notes (id text primary key, owner_id text not null, body text not null)",
  );
  await storage.provision({ schema: {}, syncRules });
  const server = createNizhalServer({
    db: "postgres://unused",
    schema: {},
    mutators: noteMutators,
    syncRules,
    auth,
    storage,
    contractVersion: "2.0.0",
    minClientVersion,
  });
  const listener = await serveFetch(server.app.fetch as unknown as typeof fetch);
  cleanups.push(listener.close);
  const dir = mkdtempSync(join(tmpdir(), "nizhal-vg-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

  async function openStore(file: string, contractVersion: string) {
    const echo = createNizhalClient({
      server: listener.baseUrl,
      bucketsForSyncRule: () => ["vg-owner"],
      contractVersion,
    });
    const store = await openNizhalStore({
      echo,
      schema,
      syncRules,
      mutators: noteMutators,
      actor: { userId: "vg-user", ownerId: "vg-owner" },
      database: drizzle(new Database(join(dir, file))),
      onlineDetector: manualOnlineDetector(),
      retryBaseMs: 20,
    });
    cleanups.push(() => store.dispose());
    return store;
  }

  const serverCount = async () =>
    Number(
      (await pg.query<{ c: number }>("select count(*)::int as c from vg_notes")).rows[0]?.c ?? 0,
    );

  return { baseUrl: listener.baseUrl, openStore, serverCount };
}

const dummyPush: NizhalPushRequest = {
  name: "addNote",
  args: { id: "x", body: "x" },
  clientMutationId: "vg-1",
  clientID: "vg-client",
  mutationID: 1,
} as unknown as NizhalPushRequest;

describe("P4 fleet-version gate (T15)", () => {
  it("rejects a push from a client older than minClientVersion with a typed upgrade_required 426", async () => {
    const h = await createHarness("2.0.0");
    const oldTarget = httpSyncTarget(h.baseUrl, undefined, { contractVersion: "1.0.0" });
    const error = await oldTarget.push(dummyPush).then(
      () => null,
      (e) => e,
    );
    expect(error).toBeInstanceOf(NizhalSyncTargetError);
    expect((error as NizhalSyncTargetError).code).toBe("upgrade_required");
    // Retriable so the client's durable write is preserved (flushes after the app updates).
    expect((error as NizhalSyncTargetError).retriable).toBe(true);
  });

  it("accepts a push from a current or newer client", async () => {
    const h = await createHarness("2.0.0");
    const current = httpSyncTarget(h.baseUrl, undefined, { contractVersion: "2.0.0" });
    await expect(current.push(dummyPush)).resolves.toMatchObject({ status: "applied" });
    // A newer client (distinct clientID so the sequence check applies it cleanly) also passes the gate.
    const newer = httpSyncTarget(h.baseUrl, undefined, { contractVersion: "2.5.0" });
    await expect(
      newer.push({
        ...dummyPush,
        clientID: "vg-client-2",
        clientMutationId: "vg-2",
        args: { id: "y", body: "y" },
      } as unknown as NizhalPushRequest),
    ).resolves.toMatchObject({ status: "applied" });
  });

  it("a version with no header is treated as 0.0.0 — blocked when a minimum is set, allowed when it is not", async () => {
    const gated = await createHarness("1.0.0");
    const noHeader = httpSyncTarget(gated.baseUrl); // sends no version → 0.0.0
    const blocked = await noHeader.push(dummyPush).then(
      () => null,
      (e) => e,
    );
    expect((blocked as NizhalSyncTargetError)?.code).toBe("upgrade_required");

    const open = await createHarness("0.0.0"); // default: accept all, incl. pre-versioning clients
    await expect(httpSyncTarget(open.baseUrl).push(dummyPush)).resolves.toMatchObject({
      status: "applied",
    });
  });

  it("store e2e: an old client's write stays pending (durable) while a current client converges", async () => {
    const h = await createHarness("2.0.0");
    const oldStore = await h.openStore("old.db", "1.0.0");
    oldStore.mutate.addNote({ id: "old1", body: "from old client" });
    // The push is rejected (426, retriable) — the write is held in the durable outbox, not on the server.
    await new Promise((r) => setTimeout(r, 300));
    expect(await oldStore.getPendingCount()).toBe(1);
    expect(await h.serverCount()).toBe(0);

    const currentStore = await h.openStore("current.db", "2.0.0");
    currentStore.mutate.addNote({ id: "cur1", body: "from current client" });
    await currentStore.waitForIdle();
    expect(await currentStore.getPendingCount()).toBe(0);
    expect(await h.serverCount()).toBe(1);
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
