// Real managed-Postgres smoke: runs the credit-ledger server against a live NEON database
// (no pglite), proving the no-WAL provisioning (columns/triggers) + sync work on real infra.
// Run:  NEON_URL="postgres://..." pnpm --filter credit-ledger example:neon
// (provision a throwaway DB first: `neonctl projects create --name echo-smoke` → connection string)
import { createHmac } from "node:crypto";
import { createNizhalClient } from "@nizhal/db-collection";
import { bearerTokenAuth, createNizhalServer, postgresStorage } from "@nizhal/server";
import { sql } from "drizzle-orm";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { creditLedgerMutators } from "../src/mutators.js";
import { CREDIT_LEDGER_DDL, creditLedgerSchema } from "../src/schema.js";
import { creditLedgerSyncRules } from "../src/sync-rules.js";

const NEON = process.env.NEON_URL ?? "";
const SECRET = "neon-smoke-secret";
const PORT = 4631;
const BASE = `http://127.0.0.1:${PORT}`;

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const mint = (p: Record<string, unknown>) => {
  const h = b64({ alg: "HS256", typ: "JWT" });
  const pl = b64({ ...p, exp: Math.floor(Date.now() / 1000) + 3600 });
  return `${h}.${pl}.${createHmac("sha256", SECRET).update(`${h}.${pl}`).digest("base64url")}`;
};
type Pull = { changed: { table: string; rows: Record<string, unknown>[] }[] };
const balance = (r: Pull) => {
  const t = r.changed.find((c) => c.table === "ledger_entries");
  return t ? t.rows.reduce((s, row) => s + Number(row.amount), 0) : 0;
};

let pass = true;
const ok = (n: string, c: boolean) => {
  console.log(`${c ? "✅" : "❌"} ${n}`);
  if (!c) pass = false;
};

async function main() {
  if (!NEON) {
    console.log(
      "NEON_URL not set — skipping (this is a manual, creds-gated example, not a CI test).",
    );
    return;
  }
  const client = postgres(NEON);
  const db = drizzlePostgres(client);
  await db.execute(sql.raw("drop schema public cascade; create schema public;"));
  await db.execute(sql.raw(CREDIT_LEDGER_DDL));
  const storage = postgresStorage({ connectionString: NEON });
  await storage.provision({ schema: creditLedgerSchema, syncRules: creditLedgerSyncRules });
  await db.execute(
    sql.raw(`
    insert into shops (id, name, owner_id) values ('shop-1', 'Neon Shop', 'owner-1');
    insert into shop_members (shop_id, user_id, role) values ('shop-1', 'user-1', 'owner');
    insert into customers (id, shop_id, name, phone, client_id)
      values ('cust-1', 'shop-1', 'Amara', '+94770000000', 'cust-1');
  `),
  );

  const server = createNizhalServer({
    db: NEON,
    schema: creditLedgerSchema,
    mutators: creditLedgerMutators,
    syncRules: creditLedgerSyncRules,
    auth: bearerTokenAuth({ secret: SECRET }),
    storage,
  });
  const http = server.listen(PORT);
  await new Promise((r) => setTimeout(r, 400));
  console.log(`server on ${BASE} → Neon\n`);

  const token = mint({ userId: "user-1", ownerId: "owner-1", shopId: "shop-1" });
  const auth = { headers: { authorization: `Bearer ${token}` } };
  const buckets = (r: string) => (r === "myShops" ? ["shop-1"] : []);
  const A = createNizhalClient({ server: BASE, auth, bucketsForSyncRule: buckets });
  const B = createNizhalClient({ server: BASE, auth, bucketsForSyncRule: buckets });

  const trigResult = await db.execute(
    sql.raw("select count(*)::int as n from pg_trigger where tgname like '\\_nizhal\\_%'"),
  );
  const trigRows = Array.isArray(trigResult) ? trigResult : trigResult.rows;
  const trigCount = Number((trigRows[0] as { n?: number } | undefined)?.n ?? 0);
  ok(`no-WAL machinery provisioned on Neon (${trigCount} _nizhal triggers)`, trigCount > 0);

  await A.push({
    name: "recordCredit",
    args: { clientId: "e1", customerId: "cust-1", amount: 500 },
    clientMutationId: "m1",
  });
  ok(
    "B converges over Neon: balance = 500",
    balance(await B.pull({ cursor: "", syncRule: "myShops" })) === 500,
  );
  await A.push({
    name: "recordPayment",
    args: { clientId: "e2", customerId: "cust-1", amount: 200 },
    clientMutationId: "m2",
  });
  ok(
    "balance = fold(ledger) = 300 after payment",
    balance(await B.pull({ cursor: "", syncRule: "myShops" })) === 300,
  );
  await A.push({
    name: "recordCredit",
    args: { clientId: "e1", customerId: "cust-1", amount: 500 },
    clientMutationId: "m1",
  });
  ok(
    "idempotent replay over Neon (still 300)",
    balance(await B.pull({ cursor: "", syncRule: "myShops" })) === 300,
  );

  http.close?.();
  await client.end();
  console.log(`\n${pass ? "NEON SMOKE PASSED ✅" : "NEON SMOKE FAILED ❌"}`);
  process.exit(pass ? 0 : 1);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
