import { PGlite } from "@electric-sql/pglite";
import type { Mutation } from "@nizhal/kernel";
import { issueBearerToken } from "@nizhal/server";
import { inProcessRealtime, postgresStorage } from "@nizhal/server/adapters";
import { createTabkeepClient, foldLedgerBalance } from "../src/client.js";
import { TABKEEP_DDL, tabkeepSchema } from "../src/schema.js";
import { createTabkeepServer } from "../src/server.js";
import { tabkeepSyncRules } from "../src/sync-rules.js";

const SECRET = "tabkeep-e2e-secret";
const SHOP_ID = "shop-1";
const USER_ID = "user-1";
const CUSTOMER_ID = "customer-1";

export async function runTabkeepE2e(): Promise<void> {
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
    const baseUrl = await baseUrlFor(listener);
    const token = issueBearerToken({
      secret: SECRET,
      userId: USER_ID,
      ownerId: SHOP_ID,
    });
    const subscribeSource = {
      subscribe: (buckets: string[], onMessage: (message: string) => void) =>
        realtime.subscribe(buckets, { send: onMessage }),
    };

    const deviceA = await createTabkeepClient({
      server: baseUrl,
      token,
      shopId: SHOP_ID,
      userId: USER_ID,
      subscribeSource,
    });
    const deviceB = await createTabkeepClient({
      server: baseUrl,
      token,
      shopId: SHOP_ID,
      userId: USER_ID,
      subscribeSource,
    });

    deviceA.mutate.addCustomer({ id: CUSTOMER_ID, name: "Maya", phone: "+94 77 123 4567" });
    await waitFor(() => deviceB.customers.toArray.some((row) => row.id === CUSTOMER_ID));

    let releaseOfflinePush!: () => void;
    const offlineGate = new Promise<void>((resolve) => {
      releaseOfflinePush = resolve;
    });
    const push = deviceA.echo.push.bind(deviceA.echo);
    let capturedCredit: Mutation | null = null;
    deviceA.echo.push = async (mutation) => {
      if (mutation.name === "recordCredit") {
        capturedCredit = mutation;
        await offlineGate;
      }
      return push(mutation);
    };

    const creditAmount = 100_001;
    deviceA.mutate.recordCredit({
      id: "credit-1",
      customerId: CUSTOMER_ID,
      amount: creditAmount,
      note: "Monthly provisions",
    });

    await waitFor(() => capturedCredit !== null);
    assert(
      foldLedgerBalance(deviceA.ledgerEntries.toArray, CUSTOMER_ID) === creditAmount,
      "offline credit is immediately visible on device A",
    );
    const beforeReconnect = await db.query<{ count: number }>(
      "select count(*)::int as count from ledger_entries where id = $1",
      ["credit-1"],
    );
    assert(beforeReconnect.rows[0]?.count === 0, "offline credit has not reached the server");

    releaseOfflinePush();
    await waitFor(() => deviceB.ledgerEntries.toArray.some((row) => row.id === "credit-1"));
    assert(
      foldLedgerBalance(deviceB.ledgerEntries.toArray, CUSTOMER_ID) === creditAmount,
      "offline credit syncs and device B converges",
    );

    deviceA.mutate.recordPayment({
      id: "payment-1",
      customerId: CUSTOMER_ID,
      amount: 33_333,
      note: "Part payment",
    });
    const expectedBalance = 66_668;
    await waitFor(
      () => foldLedgerBalance(deviceB.ledgerEntries.toArray, CUSTOMER_ID) === expectedBalance,
    );

    if (!capturedCredit) throw new Error("credit mutation was not captured");
    await push(capturedCredit);
    const creditRows = await db.query<{ count: number }>(
      "select count(*)::int as count from ledger_entries where id = $1",
      ["credit-1"],
    );
    assert(creditRows.rows[0]?.count === 1, "idempotent replay creates no double-entry");

    const serverFold = await db.query<{ balance: number }>(
      `select coalesce(sum(case when kind = 'credit' then amount else -amount end), 0)::int as balance
       from ledger_entries where customer_id = $1`,
      [CUSTOMER_ID],
    );
    const clientFold = foldLedgerBalance(deviceB.ledgerEntries.toArray, CUSTOMER_ID);
    assert(
      Number.isSafeInteger(clientFold) &&
        clientFold === expectedBalance &&
        serverFold.rows[0]?.balance === expectedBalance,
      "balance is integer-exact: Σcredit − Σpayment",
    );

    const audit = await db.query<{ mutation_name: string; client_mutation_id: string }>(
      `select mutation_name, client_mutation_id from _nizhal_audit_log
       where mutation_name = 'recordCredit'`,
    );
    assert(
      audit.rows.some((row) => row.client_mutation_id === capturedCredit?.clientMutationId),
      "audit row exists for the credit mutation",
    );

    await Promise.all([deviceA.dispose(), deviceB.dispose()]);
    console.log("\nTABKEEP E2E PASSED ✅");
  } finally {
    if (listener) await closeServer(listener);
    await db.close();
  }
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
  console.log(`✅ ${message}`);
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out waiting for Tabkeep convergence");
}

async function baseUrlFor(
  listener: ReturnType<ReturnType<typeof createTabkeepServer>["listen"]>,
): Promise<string> {
  if (!listener.listening)
    await new Promise<void>((resolve) => listener.once("listening", resolve));
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("server did not expose a TCP port");
  return `http://127.0.0.1:${address.port}`;
}

function closeServer(listener: ReturnType<ReturnType<typeof createTabkeepServer>["listen"]>) {
  return new Promise<void>((resolve, reject) => {
    listener.close((error?: Error) => (error ? reject(error) : resolve()));
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runTabkeepE2e().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
