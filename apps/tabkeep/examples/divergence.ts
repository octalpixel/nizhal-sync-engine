import { PGlite } from "@electric-sql/pglite";
import { issueBearerToken } from "@nizhal/server";
import { inProcessRealtime, postgresStorage } from "@nizhal/server/adapters";
import { createTabkeepClient, foldLedgerBalance } from "../src/client.js";
import { TABKEEP_DDL, tabkeepSchema } from "../src/schema.js";
import { createTabkeepServer } from "../src/server.js";
import { tabkeepSyncRules } from "../src/sync-rules.js";

// Proves the two devices hold SEPARATE local stores — matching values come from real network sync,
// NOT a shared database. With the sync path cut, a write on A is invisible to B (they DIVERGE);
// restore the path and B converges. If they shared one local DB, B would mirror A with no server.

const SECRET = "tabkeep-divergence-secret";
const SHOP_ID = "shop-1";
const USER_ID = "user-1";
const CUSTOMER_ID = "customer-1";

async function main(): Promise<void> {
  const db = new PGlite();
  const storage = postgresStorage({ connectionString: "postgres://unused", client: db });
  const realtime = inProcessRealtime();
  let listener: ReturnType<ReturnType<typeof createTabkeepServer>["listen"]> | null = null;

  try {
    await db.exec(TABKEEP_DDL);
    await storage.provision({ schema: tabkeepSchema, syncRules: tabkeepSyncRules });
    const server = createTabkeepServer({
      db: "postgres://unused",
      secret: SECRET,
      storage,
      realtime,
    });
    listener = server.listen(0);
    if (!listener.listening) await new Promise<void>((r) => listener?.once("listening", r));
    const addr = listener.address();
    if (!addr || typeof addr === "string") throw new Error("no port");
    const baseUrl = `http://127.0.0.1:${addr.port}`;
    const token = issueBearerToken({ secret: SECRET, userId: USER_ID, ownerId: SHOP_ID });
    const subscribeSource = {
      subscribe: (buckets: string[], onMessage: (m: string) => void) =>
        realtime.subscribe(buckets, { send: onMessage }),
    };

    const a = await createTabkeepClient({
      server: baseUrl,
      token,
      shopId: SHOP_ID,
      userId: USER_ID,
      subscribeSource,
    });
    const b = await createTabkeepClient({
      server: baseUrl,
      token,
      shopId: SHOP_ID,
      userId: USER_ID,
      subscribeSource,
    });

    // Baseline: with the path open, two SEPARATE stores DO sync.
    a.mutate.addCustomer({ id: CUSTOMER_ID, name: "Zara", phone: "+94 77 555 0000" });
    await waitFor(() => b.customers.toArray.some((r) => r.id === CUSTOMER_ID));
    console.log("✅ baseline: B synced the customer (separate stores, sync path open)");

    // Cut the sync path: gate A's push so the write cannot leave A's device.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const push = a.echo.push.bind(a.echo);
    a.echo.push = async (mutation) => {
      await gate;
      return push(mutation);
    };

    const amount = 50_000; // Rs 500.00
    a.mutate.recordCredit({
      id: "credit-1",
      customerId: CUSTOMER_ID,
      amount,
      note: "written while the path is cut",
    });

    // A applies it locally (local-first). Give realtime + the pull interval time to (fail to) propagate.
    await waitFor(() => foldLedgerBalance(a.ledgerEntries.toArray, CUSTOMER_ID) === amount);
    await new Promise((r) => setTimeout(r, 400));

    // THE PROOF: A diverges from B because they are different databases.
    assert(
      foldLedgerBalance(a.ledgerEntries.toArray, CUSTOMER_ID) === amount,
      "A shows the credit locally (local-first)",
    );
    assert(
      foldLedgerBalance(b.ledgerEntries.toArray, CUSTOMER_ID) === 0,
      "B does NOT see A's un-synced write — separate local stores (a shared DB would mirror it instantly)",
    );
    const onServer = await db.query<{ count: number }>(
      "select count(*)::int as count from ledger_entries where id = $1",
      ["credit-1"],
    );
    assert(
      onServer.rows[0]?.count === 0,
      "the credit never reached the server while the path was cut",
    );

    // Restore the path → B converges. The matching values were sync all along.
    release();
    await waitFor(() => foldLedgerBalance(b.ledgerEntries.toArray, CUSTOMER_ID) === amount);
    console.log(
      "✅ path restored: B converged via sync — the matching values are not shared storage",
    );

    await Promise.all([a.dispose(), b.dispose()]);
    console.log("\nTABKEEP DIVERGENCE (separate local stores, real sync) PROVEN ✅");
  } finally {
    if (listener)
      await new Promise<void>((res, rej) => listener?.close((e?: Error) => (e ? rej(e) : res())));
    await db.close();
  }
}

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(`❌ ${msg}`);
  console.log(`✅ ${msg}`);
}
async function waitFor(p: () => boolean | Promise<boolean>, timeoutMs = 5_000) {
  const s = Date.now();
  while (Date.now() - s < timeoutMs) {
    if (await p()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("timed out waiting for Tabkeep convergence");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
