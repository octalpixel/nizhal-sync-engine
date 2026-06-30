// Deterministic Nizhal correctness probe against a hosted (or local) Tabkeep server.
// Drives a REAL createNizhalClient: addCustomer -> recordCredit -> pull, asserting the
// cursor-stamped rows come back. Proves the sync engine works on the target deployment
// (exercises the interactive push transaction against the real Postgres behind it).
import { createNizhalClient } from "@nizhal/db-collection";

const URL = process.env.TARGET_URL;
if (!URL) throw new Error("TARGET_URL required");

const sessionRes = await fetch(`${URL}/demo/session`);
if (!sessionRes.ok) throw new Error(`session ${sessionRes.status}`);
const { token } = (await sessionRes.json()) as { token: string };

const client = createNizhalClient({
  server: URL,
  auth: { headers: { authorization: `Bearer ${token}` } },
  bucketsForSyncRule: (rule) => (rule === "myShop" ? ["shop-1"] : []),
});

const stamp = Date.now();
const cid = `cust-${stamp}`;
const eid = `entry-${stamp}`;
const device = `h-${stamp}`; // unique client per run — Nizhal dedups by (clientID, mutationID)

try {
  await client.push({
    name: "addCustomer",
    args: { id: cid, name: `E2E ${stamp}` },
    clientMutationId: `m1-${stamp}`,
    clientID: device,
    mutationID: 1,
  });
  await client.push({
    name: "recordCredit",
    args: { id: eid, customerId: cid, amount: 4200, note: "hosted push" },
    clientMutationId: `m2-${stamp}`,
    clientID: device,
    mutationID: 2,
  });
  console.log("PUSH OK");
} catch (e) {
  console.log("PUSH FAILED:", e instanceof Error ? e.message : String(e));
  process.exit(2);
}

const pulled = await client.pull({ syncRule: "myShop", cursor: "" });
const ledger = pulled.changed.find((c) => c.table === "ledger_entries");
const mine = ledger?.rows.find((r) => (r as { id?: string }).id === eid);
console.log("cursor:", pulled.cursor);
console.log("tables:", pulled.changed.map((c) => `${c.table}:${c.rows.length}`).join(", "));
console.log(mine ? `PULL OK — found ${eid} amount=${(mine as { amount?: number }).amount}` : `PULL MISSING ${eid}`);
process.exit(mine ? 0 : 3);
