// Multi-device cross-platform sync host: boots the REAL server (credit-ledger), acts as the "web"
// device (Node + the @nizhal/db-collection HTTP sync path), writes a credit, then waits for the
// MOBILE device (op-sqlite on the iOS sim, apps/op-sqlite-probe in sync mode) to pull that credit
// and push its own payment back — proving web↔mobile sync over real HTTP. The iOS simulator reaches
// this server at http://localhost:4555 (shared host loopback).
//
// Run:  pnpm --filter credit-ledger example:multi-device-host
// then launch the mobile sync probe (apps/op-sqlite-probe) pointed at the same server.
import { createHmac } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { createNizhalClient } from "@nizhal/db-collection";
import { bearerTokenAuth, createNizhalServer } from "@nizhal/server";
import { postgresStorage } from "@nizhal/server/adapters";
import { creditLedgerMutators } from "../src/mutators.js";
import { CREDIT_LEDGER_DDL, creditLedgerSchema } from "../src/schema.js";
import { creditLedgerSyncRules } from "../src/sync-rules.js";

const SECRET = "multi-device-secret";
const PORT = 4555;
const MOBILE_PAYMENT_CLIENT_ID = "mobile-payment-1";

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const mint = (p: Record<string, unknown>) => {
  const h = b64({ alg: "HS256", typ: "JWT" });
  const pl = b64({ ...p, exp: Math.floor(Date.now() / 1000) + 3600 });
  return `${h}.${pl}.${createHmac("sha256", SECRET).update(`${h}.${pl}`).digest("base64url")}`;
};
type Pull = { changed: { table: string; rows: Record<string, unknown>[] }[] };
const ledgerRows = (r: Pull) => r.changed.find((c) => c.table === "ledger_entries")?.rows ?? [];
const balance = (r: Pull) => ledgerRows(r).reduce((s, row) => s + Number(row.amount), 0);
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForRow(
  client: ReturnType<typeof createNizhalClient>,
  clientId: string,
  timeoutMs: number,
): Promise<Record<string, unknown>[] | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = ledgerRows(await client.pull({ cursor: "", syncRule: "myShops" }));
    if (rows.some((row) => row.client_id === clientId)) return rows;
    await delay(2000);
  }
  return null;
}

async function main() {
  const db = new PGlite();
  await db.exec(CREDIT_LEDGER_DDL);
  const storage = postgresStorage({ connectionString: "postgres://unused", client: db });
  await storage.provision({ schema: creditLedgerSchema, syncRules: creditLedgerSyncRules });
  await db.exec(`
    insert into shops (id, name, owner_id) values ('shop-1', 'Multi Device Shop', 'owner-1');
    insert into shop_members (shop_id, user_id, role) values ('shop-1', 'user-1', 'owner');
    insert into customers (id, shop_id, name, phone, client_id)
      values ('cust-1', 'shop-1', 'Amara', '+94770000000', 'cust-1');
  `);

  const server = createNizhalServer({
    db: "postgres://unused",
    schema: creditLedgerSchema,
    mutators: creditLedgerMutators,
    syncRules: creditLedgerSyncRules,
    auth: bearerTokenAuth({ secret: SECRET }),
    storage,
  });
  server.listen(PORT);
  await delay(300);
  console.log(`[host] server on http://localhost:${PORT} (iOS sim reaches it via localhost)\n`);

  const token = mint({ userId: "user-1", ownerId: "owner-1", shopId: "shop-1" });
  const auth = { headers: { authorization: `Bearer ${token}` } };
  const web = createNizhalClient({
    server: `http://127.0.0.1:${PORT}`,
    auth,
    bucketsForSyncRule: (r) => (r === "myShops" ? ["shop-1"] : []),
  });

  // WEB device write.
  await web.push({
    name: "recordCredit",
    args: { clientId: "web-credit-1", customerId: "cust-1", amount: 500 },
    clientMutationId: "web-credit-1",
  });
  console.log("[host] 🌐 web device wrote credit 500 — waiting for mobile to sync + pay…");
  console.log(`[host] launch the mobile sync probe now (server: http://localhost:${PORT})\n`);

  // Wait for the MOBILE device's payment to arrive over the wire (mobile → server → web).
  const mobileSynced = (await waitForRow(web, MOBILE_PAYMENT_CLIENT_ID, 120_000)) !== null;

  const finalBalance = balance(await web.pull({ cursor: "", syncRule: "myShops" }));
  console.log("");
  console.log(`[host] mobile payment synced to web: ${mobileSynced ? "✅" : "❌ (timed out)"}`);
  console.log(
    `[host] final shared balance (web view) = ${finalBalance} (expect 300: 500 credit − 200 payment)`,
  );

  const passed = mobileSynced && finalBalance === 300;
  console.log(
    `\n${passed ? "MULTI-DEVICE HOST PASS ✅ (web↔mobile converged + realtime ping)" : "MULTI-DEVICE HOST FAIL ❌"}`,
  );
  process.exit(passed ? 0 : 1);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
