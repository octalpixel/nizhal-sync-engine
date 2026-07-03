import { type SyncRules, defineSyncRules } from "@nizhal/kernel";
import postgres from "postgres";
import { afterEach, describe, expect, it, vi } from "vitest";
import { postgresStorage } from "../src/adapters/storage.js";
import { type NizhalAuth, createNizhalServer, listenNotifyRealtime } from "../src/index.js";

// Cross-instance realtime via listenNotifyRealtime, against a REAL multi-connection Postgres (PGlite is
// single-connection and can't model two instances sharing a DB). Regression for a bug found on real
// Neon: NOTHING installed the pg_notify triggers (storage.provision installs touch/remove only), so
// production realtime was silently dead. createNizhalServer.listen() now auto-installs them, and a
// write on instance 1 must reach a subscriber on instance 2. Gated on NIZHAL_TEST_DATABASE_URL — runs
// in the `real-postgres` CI job.

const URL = process.env.NIZHAL_TEST_DATABASE_URL;
const OWNER = "ln-shop";
const syncRules: SyncRules = defineSyncRules((b) => ({
  shop: b.bucket({
    parameters: () => b.params({ ownerId: "owner_id" }),
    data: (bucket) => [b.table("ln_notes").where(b.eq("owner_id", bucket.ownerId))],
  }),
}));
const auth: NizhalAuth = {
  async resolve() {
    return { userId: "u", ownerId: OWNER };
  },
};

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c().catch(() => {});
});

describe.skipIf(!URL)("listenNotifyRealtime — cross-instance (real Postgres)", () => {
  it("auto-installs the notify triggers on listen() and delivers a poke across instances", async () => {
    const sql = postgres(URL as string, { max: 2 });
    cleanups.push(() => sql.end());
    await sql`drop table if exists ln_notes cascade`;
    await sql`create table ln_notes (id text primary key, owner_id text not null, body text)`;

    const storage = postgresStorage({ connectionString: URL as string });
    cleanups.push(() => storage.getClient?.()?.end?.() ?? Promise.resolve());
    await storage.provision({ schema: {}, syncRules }); // installs touch/remove — NOT the notify trigger

    const notifyTrigger = "_nizhal_notify_ln_notes_owner_id_trg";
    const before = await sql`select 1 from pg_trigger where tgname = ${notifyTrigger}`;
    expect(before).toHaveLength(0); // provision alone does not install it

    // Instance 1: server with listenNotifyRealtime. listen() must auto-install the notify trigger.
    const server1 = createNizhalServer({
      db: URL as string,
      schema: {},
      mutators: {},
      syncRules,
      auth,
      storage,
      realtime: listenNotifyRealtime({ connectionString: URL as string }),
      tombstoneRetention: false,
    });
    const http1 = server1.listen(47231);
    cleanups.push(() => new Promise<void>((r) => http1.close(() => r())));
    await vi.waitFor(
      async () => {
        const rows = await sql`select 1 from pg_trigger where tgname = ${notifyTrigger}`;
        expect(rows).toHaveLength(1);
      },
      { timeout: 8000, interval: 200 },
    );

    // Instance 2: a second, independent listenNotifyRealtime with a subscribed socket. A write anywhere
    // must reach it via pg_notify → LISTEN (cross-connection = cross-instance).
    const rt2 = listenNotifyRealtime({ connectionString: URL as string });
    cleanups.push(() => rt2.stop?.() ?? Promise.resolve());
    const pokes: string[] = [];
    rt2.subscribe([OWNER], { send: (data) => void pokes.push(data) });
    await new Promise((r) => setTimeout(r, 1000)); // let instance 2's LISTEN attach

    await sql`insert into ln_notes (id, owner_id, body) values ('n1', ${OWNER}, 'x')`;

    await vi.waitFor(() => expect(pokes).toContain(`repull:${OWNER}`), {
      timeout: 8000,
      interval: 100,
    });
  });
});
