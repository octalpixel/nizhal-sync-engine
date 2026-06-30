import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { inProcessRealtime, localFsBlobStore, postgresStorage } from "@nizhal/server/adapters";
import { createChainClient } from "../src/chain/client.js";
import { CHAIN_DDL, chainSchema } from "../src/chain/schema.js";
import { createTabkeepChainServer, mintChainToken } from "../src/chain/server.js";
import { chainSyncRules } from "../src/chain/sync-rules.js";

// Receipts on Tabkeep Chain — proves attachment / blob sync end-to-end:
//   upload bytes (presigned) → the branch-scoped ref row syncs → another device of the SAME branch
//   downloads the exact bytes → a device of ANOTHER branch is denied (branch-scoped blob authz).

const SECRET = "tabkeep-chain-receipts-secret";
const BLOB_SECRET = "tabkeep-blob-secret";
const PORT = 47331;
const BASE_URL = `http://127.0.0.1:${PORT}`;

async function main(): Promise<void> {
  const db = new PGlite();
  const storage = postgresStorage({ connectionString: "postgres://unused", client: db });
  const realtime = inProcessRealtime();
  const blobRoot = mkdtempSync(path.join(tmpdir(), "tabkeep-receipts-"));
  const blob = localFsBlobStore({ root: blobRoot, publicBaseUrl: BASE_URL, secret: BLOB_SECRET });
  let listener: ReturnType<ReturnType<typeof createTabkeepChainServer>["listen"]> | null = null;

  try {
    await db.exec(CHAIN_DDL);
    await storage.provision({ schema: chainSchema, syncRules: chainSyncRules });
    await db.exec(`
      insert into branches (id, chain_id, name) values
        ('branch-a','chain-1','Downtown'), ('branch-b','chain-1','Uptown');
      insert into branch_members (user_id, branch_id, role) values
        ('manager-a','branch-a','manager'), ('cashier-a','branch-a','cashier'),
        ('cashier-b','branch-b','cashier');
    `);

    const server = createTabkeepChainServer({ db: "postgres://unused", secret: SECRET, storage, realtime, blob });
    listener = server.listen(PORT);
    if (!listener.listening) await new Promise<void>((r) => listener!.once("listening", r));
    const subscribeSource = {
      subscribe: (buckets: string[], onMessage: (m: string) => void) =>
        realtime.subscribe(buckets, { send: onMessage }),
    };
    const tok = (userId: string, branchId: string, role: "owner" | "manager" | "cashier") =>
      mintChainToken({ secret: SECRET, userId, branchId, role });
    const client = (userId: string, branchId: string, role: "owner" | "manager" | "cashier", branches: string[]) =>
      createChainClient({ server: BASE_URL, token: tok(userId, branchId, role), userId, branchId, role, branches, subscribeSource });

    const cashierA = await client("cashier-a", "branch-a", "cashier", ["branch-a"]);
    const managerA = await client("manager-a", "branch-a", "manager", ["branch-a"]);
    const cashierB = await client("cashier-b", "branch-b", "cashier", ["branch-b"]);

    // A product + a sale on branch A to attach the receipt to.
    managerA.mutate.addProduct({ id: "p-a1", name: "Rice", price: 10_000, stock: 10 });
    await waitFor(() => cashierA.products.toArray.some((p) => p.id === "p-a1"));
    cashierA.mutate.recordSale({ id: "s-a1", productId: "p-a1", qty: 1, amount: 10_000 });
    await waitFor(() => managerA.sales.toArray.some((s) => s.id === "s-a1"));

    // Upload a receipt image (bytes → presigned PUT → branch-scoped ref row).
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]);
    const file = new Blob([bytes], { type: "image/png" });
    const { key } = await cashierA.uploadReceipt({ saleId: "s-a1", file });
    assert(typeof key === "string" && key.length > 0, "receipt uploaded; content-addressed blob key returned");

    // The ref row syncs to another device of the SAME branch.
    await waitFor(() => managerA.receipts.toArray.some((r) => r.id === key && r.status === "synced"));
    assert(
      managerA.receipts.toArray.some((r) => r.id === key && r.sale_id === "s-a1"),
      "manager (same branch, different device) sees the receipt ref via sync",
    );

    // Same-branch device downloads the exact bytes through the presigned URL.
    const url = await managerA.receiptUrl(key);
    const downloaded = new Uint8Array(await (await fetch(url)).arrayBuffer());
    assert(
      downloaded.length === bytes.length && downloaded.every((b, i) => b === bytes[i]),
      "manager downloads the exact receipt bytes (blob round-trip across devices)",
    );

    // Branch isolation: the other branch never even sees the ref.
    await new Promise((r) => setTimeout(r, 200));
    assert(!cashierB.receipts.toArray.some((r) => r.id === key), "cashier B (other branch) cannot see the receipt ref (bucket isolation)");

    // Branch-scoped blob authz: the other branch is denied a download URL (server is the authority).
    const denied = await fetch(`${BASE_URL}/nizhal/blob/${encodeURIComponent(key)}/url`, {
      headers: { authorization: `Bearer ${tok("cashier-b", "branch-b", "cashier")}` },
    });
    assert(denied.status === 404, "cashier B is denied a download URL for branch A's receipt (branch-scoped blob authz)");

    await Promise.all([cashierA.dispose(), managerA.dispose(), cashierB.dispose()]);
    console.log("\nTABKEEP CHAIN RECEIPTS (blob upload + ref sync + cross-device download + branch-scoped authz) PROVEN ✅");
  } finally {
    if (listener) await new Promise<void>((res, rej) => listener!.close((e?: Error) => (e ? rej(e) : res())));
    await db.close();
    rmSync(blobRoot, { recursive: true, force: true });
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
  throw new Error("timed out waiting for chain receipt sync");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
