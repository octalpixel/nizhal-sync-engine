import { type NizhalClient, createNizhalClient } from "@nizhal/db-collection";

// Multi-device cross-platform sync probe (MOBILE side). Talks to the real server run by
// `apps/credit-ledger/examples/multi-device-host.ts` over real HTTP (the iOS sim reaches it at
// http://localhost:4555): pulls the web device's credit (web→mobile), pushes a payment (mobile→web),
// and confirms the converged balance = fold. Realtime push on RN is the native nitroWebSocketSource
// (`@nizhal/react-native`) + NetInfo reconnect-pull; see rfcs/RFC-005-rn-realtime.md for the device
// verification status. This harness covers the authoritative pull-convergence path.
const SERVER = "http://localhost:4555";
// Long-lived dev token (HS256, secret "multi-device-secret", user-1 / owner-1 / shop-1).
const TOKEN =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiJ1c2VyLTEiLCJvd25lcklkIjoib3duZXItMSIsInNob3BJZCI6InNob3AtMSIsImV4cCI6MTg5MzQ1NjAwMH0.tThiGQRipA0rBnoSZUMm2jCTtRpZJyOh-ujtcsz8wUA";

type Pull = { changed: { table: string; rows: Record<string, unknown>[] }[] };
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function createClient(): NizhalClient {
  return createNizhalClient({
    server: SERVER,
    auth: { headers: { authorization: `Bearer ${TOKEN}` } },
    bucketsForSyncRule: (rule) => (rule === "myShops" ? ["shop-1"] : []),
  });
}

async function ledgerRows(client: NizhalClient): Promise<Record<string, unknown>[]> {
  const result = (await client.pull({ cursor: "", syncRule: "myShops" })) as Pull;
  return result.changed.find((c) => c.table === "ledger_entries")?.rows ?? [];
}

async function waitForRow(client: NizhalClient, clientId: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await ledgerRows(client)).some((row) => row.client_id === clientId)) return true;
    await delay(1000);
  }
  return false;
}

export async function runMultiDeviceSyncProbe(): Promise<void> {
  const client = createClient();

  // WEB → MOBILE: the web device's credit must arrive.
  if (!(await waitForRow(client, "web-credit-1", 30_000))) {
    throw new Error("did not receive the web device's credit (web→mobile sync failed)");
  }

  // MOBILE → WEB: record a payment; the host verifies it converges back.
  await client.push({
    name: "recordPayment",
    args: { clientId: "mobile-payment-1", customerId: "cust-1", amount: 200 },
    clientMutationId: "mobile-payment-1",
  });

  // Confirm the mobile sees the converged ledger (web credit + its own payment).
  const total = (await ledgerRows(client)).reduce((s, row) => s + Number(row.amount), 0);
  if (total !== 300) {
    throw new Error(`mobile converged balance ${total}, expected 300 (500 credit − 200 payment)`);
  }
}
