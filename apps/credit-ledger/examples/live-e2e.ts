// Live over-the-wire E2E: boots the REAL server (createNizhalServer().listen()) on a TCP port,
// talks to it with the REAL client (fetch + PartySocket WS), and verifies sync end-to-end.
// Run: pnpm --filter credit-ledger example:live
import { createHmac } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { createNizhalClient } from "@nizhal/db-collection";
import { bearerTokenAuth, createNizhalServer } from "@nizhal/server";
import { postgresStorage } from "@nizhal/server/adapters";
import { smsReminderHandler } from "../src/jobs.js";
import { creditLedgerMutators } from "../src/mutators.js";
import { CREDIT_LEDGER_DDL, creditLedgerSchema } from "../src/schema.js";
import { creditLedgerSyncRules } from "../src/sync-rules.js";

const SECRET = "dev-secret-please-change";
const PORT = 4517;

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
function mint(payload: Record<string, unknown>): string {
  const h = b64({ alg: "HS256", typ: "JWT" });
  const p = b64({ ...payload, exp: Math.floor(Date.now() / 1000) + 3600 });
  const s = createHmac("sha256", SECRET).update(`${h}.${p}`).digest("base64url");
  return `${h}.${p}.${s}`;
}

type Pull = { changed: { table: string; rows: Record<string, unknown>[] }[] };
function balance(r: Pull): number {
  const t = r.changed.find((c) => c.table === "ledger_entries");
  return t ? t.rows.reduce((s, row) => s + Number(row.amount), 0) : 0;
}

export interface LiveE2eOptions {
  port?: number;
  log?: (line: string) => void;
}

export interface LiveE2eResult {
  passed: boolean;
  baseUrl: string;
}

export async function runLiveE2e(options: LiveE2eOptions = {}): Promise<LiveE2eResult> {
  let pass = true;
  const log = options.log ?? console.log;
  const ok = (name: string, cond: boolean) => {
    log(`${cond ? "✅" : "❌"} ${name}`);
    if (!cond) pass = false;
  };
  const db = new PGlite();
  const storage = postgresStorage({ connectionString: "postgres://unused", client: db });
  let http: ReturnType<ReturnType<typeof createNizhalServer>["listen"]> | null = null;
  try {
    await db.exec(CREDIT_LEDGER_DDL);
    await storage.provision({ schema: creditLedgerSchema, syncRules: creditLedgerSyncRules });
    await db.exec(`
      insert into shops (id, name, owner_id) values ('shop-1', 'Live Shop', 'owner-1');
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
      jobs: { "sms-reminder": smsReminderHandler },
    });
    http = server.listen(options.port ?? PORT);
    const baseUrl = await baseUrlFor(http);
    log(`server listening on ${baseUrl}\n`);

    const token = mint({ userId: "user-1", ownerId: "owner-1", shopId: "shop-1" });
    const auth = { headers: { authorization: `Bearer ${token}` } };
    const buckets = (rule: string) => (rule === "myShops" ? ["shop-1"] : []);
    const A = createNizhalClient({ server: baseUrl, auth, bucketsForSyncRule: buckets });
    const B = createNizhalClient({ server: baseUrl, auth, bucketsForSyncRule: buckets });

    try {
      await createNizhalClient({ server: baseUrl, auth: { headers: {} } }).pull({
        cursor: "",
        syncRule: "myShops",
      });
      ok("rejects unauthenticated pull (401)", false);
    } catch {
      ok("rejects unauthenticated pull (401)", true);
    }

    await A.push({
      name: "recordCredit",
      args: { clientId: "e1", customerId: "cust-1", amount: 500 },
      clientMutationId: "m1",
    });
    ok(
      "device B converges: balance = 500",
      balance(await B.pull({ cursor: "", syncRule: "myShops" })) === 500,
    );

    const jobs = await db.query<{ count: number }>(
      "select count(*)::int as count from _nizhal_jobs where task_slug = $1",
      ["sms-reminder"],
    );
    ok("listen boots with jobs; sms-reminder row lands in _nizhal_jobs", jobs.rows[0]?.count === 1);

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
      "idempotent replay (still 300)",
      balance(await B.pull({ cursor: "", syncRule: "myShops" })) === 300,
    );

    let pinged = false;
    const unsub = B.subscribe("myShops", () => {
      pinged = true;
    });
    await delay(400);
    await A.push({
      name: "recordCredit",
      args: { clientId: "e3", customerId: "cust-1", amount: 100 },
      clientMutationId: "m3",
    });
    await delay(1200);
    ok("realtime ping received over WS", pinged);
    unsub();

    log(`\n${pass ? "LIVE E2E PASSED ✅" : "LIVE E2E FAILED ❌"}`);
    return { passed: pass, baseUrl };
  } finally {
    if (http) await closeServer(http);
    await db.close();
  }
}

async function baseUrlFor(
  http: ReturnType<ReturnType<typeof createNizhalServer>["listen"]>,
): Promise<string> {
  if (!http.listening) await new Promise<void>((resolve) => http.once("listening", resolve));
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("server did not expose a TCP port");
  return `http://127.0.0.1:${address.port}`;
}

function closeServer(http: ReturnType<ReturnType<typeof createNizhalServer>["listen"]>) {
  return new Promise<void>((resolve, reject) => {
    http.close((error?: Error) => (error ? reject(error) : resolve()));
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runLiveE2e().then(
    (result) => {
      process.exit(result.passed ? 0 : 1);
    },
    (error) => {
      console.error(error);
      process.exit(1);
    },
  );
}
