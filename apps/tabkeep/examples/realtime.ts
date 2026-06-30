import { PGlite } from "@electric-sql/pglite";
import { issueBearerToken } from "@nizhal/server";
import { inProcessRealtime, postgresStorage } from "@nizhal/server/adapters";
import { createTabkeepClient, foldLedgerBalance } from "../src/client.js";
import { TABKEEP_DDL, tabkeepSchema } from "../src/schema.js";
import { createTabkeepServer } from "../src/server.js";
import { tabkeepSyncRules } from "../src/sync-rules.js";

// Realtime same-shop multi-device sync + reconciliation.
// Two devices of ONE shop, both subscribed to realtime pings. We measure how fast a
// write on one device lands on the other (ping-driven, no explicit pull), and prove that
// CONCURRENT bidirectional writes reconcile to one consistent append-only ledger.

const SECRET = "tabkeep-realtime-secret";
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
    const server = createTabkeepServer({ db: "postgres://unused", secret: SECRET, storage, realtime });
    listener = server.listen(0);
    if (!listener.listening) await new Promise<void>((r) => listener!.once("listening", r));
    const addr = listener.address();
    if (!addr || typeof addr === "string") throw new Error("no port");
    const baseUrl = `http://127.0.0.1:${addr.port}`;
    const token = issueBearerToken({ secret: SECRET, userId: USER_ID, ownerId: SHOP_ID });
    const subscribeSource = {
      subscribe: (buckets: string[], onMessage: (m: string) => void) =>
        realtime.subscribe(buckets, { send: onMessage }),
    };

    const a = await createTabkeepClient({ server: baseUrl, token, shopId: SHOP_ID, userId: USER_ID, subscribeSource });
    const b = await createTabkeepClient({ server: baseUrl, token, shopId: SHOP_ID, userId: USER_ID, subscribeSource });

    // 1) realtime convergence + latency: write on A, time how long until B sees it (ping-driven).
    a.mutate.addCustomer({ id: CUSTOMER_ID, name: "Maya", phone: "+94 77 123 4567" });
    const t0 = Date.now();
    await waitFor(() => b.customers.toArray.some((r) => r.id === CUSTOMER_ID));
    console.log(`✅ device B saw the new customer via realtime in ${Date.now() - t0}ms`);

    a.mutate.recordCredit({ id: "credit-1", customerId: CUSTOMER_ID, amount: 100_000, note: "Provisions" });
    const t1 = Date.now();
    await waitFor(() => b.ledgerEntries.toArray.some((r) => r.id === "credit-1"));
    console.log(`✅ device B converged on A's credit (Rs 1000.00) via realtime in ${Date.now() - t1}ms`);
    assert(foldLedgerBalance(b.ledgerEntries.toArray, CUSTOMER_ID) === 100_000, "B balance = Rs 1000.00");

    // 2) CONCURRENT bidirectional reconciliation: A adds credit, B records payment, at the same time.
    const t2 = Date.now();
    a.mutate.recordCredit({ id: "credit-2", customerId: CUSTOMER_ID, amount: 50_000, note: "More stock" });
    b.mutate.recordPayment({ id: "payment-1", customerId: CUSTOMER_ID, amount: 20_000, note: "Part payment" });
    const expected = 100_000 + 50_000 - 20_000; // 130_000 = Rs 1300.00
    await waitFor(
      () =>
        foldLedgerBalance(a.ledgerEntries.toArray, CUSTOMER_ID) === expected &&
        foldLedgerBalance(b.ledgerEntries.toArray, CUSTOMER_ID) === expected,
    );
    console.log(`✅ concurrent writes from BOTH devices reconciled in ${Date.now() - t2}ms`);

    // both devices hold the identical append-only ledger (3 entries), both folds equal, server agrees.
    const aIds = a.ledgerEntries.toArray.map((r) => r.id).sort();
    const bIds = b.ledgerEntries.toArray.map((r) => r.id).sort();
    assert(JSON.stringify(aIds) === JSON.stringify(bIds), "both devices hold the identical ledger");
    assert(aIds.length === 3, "all 3 independent entries merged (none lost)");
    const serverFold = await db.query<{ balance: number }>(
      `select coalesce(sum(case when kind='credit' then amount else -amount end),0)::int as balance
       from ledger_entries where customer_id=$1`,
      [CUSTOMER_ID],
    );
    assert(
      foldLedgerBalance(a.ledgerEntries.toArray, CUSTOMER_ID) === expected &&
        foldLedgerBalance(b.ledgerEntries.toArray, CUSTOMER_ID) === expected &&
        serverFold.rows[0]?.balance === expected,
      "A, B, and server all agree: Rs 1300.00 (integer-exact)",
    );

    await Promise.all([a.dispose(), b.dispose()]);
    console.log("\nTABKEEP REALTIME MULTI-DEVICE + RECONCILIATION PASSED ✅");
  } finally {
    if (listener) await new Promise<void>((res, rej) => listener!.close((e?: Error) => (e ? rej(e) : res())));
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
  throw new Error("timed out waiting for realtime convergence");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
