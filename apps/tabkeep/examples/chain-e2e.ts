import { PGlite } from "@electric-sql/pglite";
import { inProcessRealtime, postgresStorage } from "@nizhal/server/adapters";
import { createChainClient, foldBranchSales } from "../src/chain/client.js";
import { CHAIN_DDL, chainSchema } from "../src/chain/schema.js";
import { createTabkeepChainServer, mintChainToken } from "../src/chain/server.js";
import { chainSyncRules } from "../src/chain/sync-rules.js";

// Tabkeep Chain — multi-branch flagship proof. Proves the four primitives a real chain / financial
// app needs and that single-shop Tabkeep ducked:
//   1. multi-bucket isolation   2. HQ cross-branch rollup
//   3. mutable per-field merge   4. role enforcement (branch scope + action gate)

const SECRET = "tabkeep-chain-secret";

async function main(): Promise<void> {
  const db = new PGlite();
  const storage = postgresStorage({ connectionString: "postgres://unused", client: db });
  const realtime = inProcessRealtime();
  let listener: ReturnType<ReturnType<typeof createTabkeepChainServer>["listen"]> | null = null;

  try {
    await db.exec(CHAIN_DDL);
    await storage.provision({ schema: chainSchema, syncRules: chainSyncRules });
    // Seed reference + authz (server-side, not synced): two branches of one chain + memberships.
    await db.exec(`
      insert into branches (id, chain_id, name) values
        ('branch-a','chain-1','Downtown'), ('branch-b','chain-1','Uptown');
      insert into branch_members (user_id, branch_id, role) values
        ('owner-1','branch-a','owner'), ('owner-1','branch-b','owner'),
        ('manager-a','branch-a','manager'), ('manager-b','branch-b','manager'),
        ('cashier-a','branch-a','cashier'), ('cashier-b','branch-b','cashier');
    `);

    const server = createTabkeepChainServer({
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
    const subscribeSource = {
      subscribe: (buckets: string[], onMessage: (m: string) => void) =>
        realtime.subscribe(buckets, { send: onMessage }),
    };

    const tok = (userId: string, branchId: string, role: "owner" | "manager" | "cashier") =>
      mintChainToken({ secret: SECRET, userId, branchId, role });
    const client = (
      userId: string,
      branchId: string,
      role: "owner" | "manager" | "cashier",
      branches: string[],
    ) =>
      createChainClient({
        server: baseUrl,
        token: tok(userId, branchId, role),
        userId,
        branchId,
        role,
        branches,
        subscribeSource,
      });

    const managerA = await client("manager-a", "branch-a", "manager", ["branch-a"]);
    const managerB = await client("manager-b", "branch-b", "manager", ["branch-b"]);
    const cashierA = await client("cashier-a", "branch-a", "cashier", ["branch-a"]);
    const cashierB = await client("cashier-b", "branch-b", "cashier", ["branch-b"]);
    const owner = await client("owner-1", "branch-a", "owner", ["branch-a", "branch-b"]);

    // ── 1. Multi-bucket isolation ──────────────────────────────────────────────
    managerA.mutate.addProduct({ id: "p-a1", name: "Rice", price: 10_000, stock: 10 });
    managerB.mutate.addProduct({ id: "p-b1", name: "Flour", price: 20_000, stock: 5 });
    await waitFor(() => cashierA.products.toArray.some((p) => p.id === "p-a1"));
    await waitFor(() => cashierB.products.toArray.some((p) => p.id === "p-b1"));
    assert(
      !cashierA.products.toArray.some((p) => p.id === "p-b1"),
      "cashier A cannot see branch B's product (bucket isolation)",
    );
    assert(
      !cashierB.products.toArray.some((p) => p.id === "p-a1"),
      "cashier B cannot see branch A's product (bucket isolation)",
    );

    // ── 2. HQ cross-branch rollup ──────────────────────────────────────────────
    cashierA.mutate.recordSale({ id: "s-a1", productId: "p-a1", qty: 2, amount: 20_000 });
    cashierB.mutate.recordSale({ id: "s-b1", productId: "p-b1", qty: 1, amount: 20_000 });
    await waitFor(
      () =>
        owner.products.toArray.some((p) => p.id === "p-a1") &&
        owner.products.toArray.some((p) => p.id === "p-b1"),
    );
    await waitFor(
      () =>
        owner.sales.toArray.some((s) => s.id === "s-a1") &&
        owner.sales.toArray.some((s) => s.id === "s-b1"),
    );
    assert(
      foldBranchSales(owner.sales.toArray, "branch-a") === 20_000,
      "owner sees branch A sales",
    );
    assert(
      foldBranchSales(owner.sales.toArray, "branch-b") === 20_000,
      "owner sees branch B sales",
    );
    assert(
      foldBranchSales(owner.sales.toArray) === 40_000,
      "owner rolls up Σ sales across all branches = Rs 400.00",
    );

    // ── 3. Mutable per-field merge ─────────────────────────────────────────────
    // p-a1 is {price 10000, stock 10}. Manager edits price OFFLINE; cashier edits stock ONLINE.
    // The manager's write lands LAST (older HLC, different field) — field merge keeps BOTH.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const push = managerA.echo.push.bind(managerA.echo);
    managerA.echo.push = async (m) => {
      if (m.name === "setPrice") await gate;
      return push(m);
    };
    managerA.mutate.setPrice({ id: "p-a1", price: 15_000 });
    cashierA.mutate.adjustStock({ id: "p-a1", stock: 50 });
    await waitFor(() => owner.products.toArray.find((p) => p.id === "p-a1")?.stock === 50);
    release();
    await waitFor(() => {
      const p = owner.products.toArray.find((r) => r.id === "p-a1");
      return p?.price === 15_000 && p?.stock === 50;
    });
    const merged = owner.products.toArray.find((p) => p.id === "p-a1");
    assert(
      merged?.price === 15_000 && merged?.stock === 50,
      "concurrent edits to DIFFERENT fields both survive (per-field merge — table LWW would lose one)",
    );

    // ── 4. Role: cross-tenant write guard (server is the authority) ─────────────
    // cashier A claims branch B (forged ownerId). Server resolves membership from branch_members
    // (cashier-a → branch-a only) and rejects — the client's claim is not trusted.
    const rogue = await directPush(baseUrl, tok("cashier-a", "branch-b", "cashier"), {
      name: "recordSale",
      args: { id: "rogue-1", productId: "p-b1", qty: 1, amount: 9_999 },
      clientMutationId: "rogue-1",
      clientID: "rogue",
      mutationID: 1,
    });
    assert(!rogue.ok, "cross-branch write is rejected by the server");
    const rogueLanded = await db.query<{ c: number }>(
      "select count(*)::int as c from sales where id = $1",
      ["rogue-1"],
    );
    assert(
      rogueLanded.rows[0]?.c === 0,
      "the cross-branch write never reached the database (membership is the source of truth)",
    );

    // ── 5. Role: action gate (cashier cannot set price; manager can) ────────────
    const forbidden = await directPush(baseUrl, tok("cashier-a", "branch-a", "cashier"), {
      name: "setPrice",
      args: { id: "p-a1", price: 99_999 },
      clientMutationId: "forbidden-1",
      clientID: "cashier-direct",
      mutationID: 1,
    });
    assert(!forbidden.ok, "cashier setPrice is rejected (role action gate)");
    const stillMerged = await db.query<{ price: number }>(
      "select price from products where id = $1",
      ["p-a1"],
    );
    assert(
      stillMerged.rows[0]?.price === 15_000,
      "the forbidden price never applied (still Rs 150.00)",
    );
    const allowed = await directPush(baseUrl, tok("manager-a", "branch-a", "manager"), {
      name: "setPrice",
      args: { id: "p-a1", price: 13_000 },
      clientMutationId: "mgr-price-1",
      clientID: "mgr-direct",
      mutationID: 1,
    });
    assert(allowed.ok, "manager setPrice is allowed (role action gate)");

    await Promise.all([
      managerA.dispose(),
      managerB.dispose(),
      cashierA.dispose(),
      cashierB.dispose(),
      owner.dispose(),
    ]);
    console.log(
      "\nTABKEEP CHAIN (multi-branch isolation + rollup + field-merge + roles) PROVEN ✅",
    );
  } finally {
    if (listener)
      await new Promise<void>((res, rej) => listener?.close((e?: Error) => (e ? rej(e) : res())));
    await db.close();
  }
}

async function directPush(
  baseUrl: string,
  token: string,
  mutation: {
    name: string;
    args: unknown;
    clientMutationId: string;
    clientID: string;
    mutationID: number;
  },
): Promise<Response> {
  return fetch(`${baseUrl}/sync/push`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ mutations: [mutation] }),
  });
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
  throw new Error("timed out waiting for chain convergence");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
