// Proves the hosted realtime path end-to-end: a real createCloudflareSubscribeSource subscribed to
// the deployed Worker DO must receive a `repull` when a push lands on the Vercel server (server
// commit -> POST /_nizhal/publish -> DO broadcast -> subscriber).
import { createCloudflareSubscribeSource, createNizhalClient } from "@nizhal/db-collection";

const URL = process.env.TARGET_URL;
const WORKER_HOST = process.env.WORKER_HOST; // e.g. nizhal-realtime.mithushancj.workers.dev
if (!URL || !WORKER_HOST) throw new Error("TARGET_URL and WORKER_HOST required");

const token = ((await (await fetch(`${URL}/demo/session`)).json()) as { token: string }).token;

const sub = createCloudflareSubscribeSource(WORKER_HOST, () => Promise.resolve(token));
let hint = "";
const unsub = sub.subscribe(
  ["shop-1"],
  (msg) => {
    hint = String(msg);
  },
  () => {},
);

// give the socket time to connect + authorize
await new Promise((r) => setTimeout(r, 3000));

const stamp = Date.now();
const client = createNizhalClient({
  server: URL,
  auth: { headers: { authorization: `Bearer ${token}` } },
  bucketsForSyncRule: (rule) => (rule === "myShop" ? ["shop-1"] : []),
});
await client.push({
  name: "addCustomer",
  args: { id: `rt-${stamp}`, name: `RT ${stamp}` },
  clientMutationId: `rt1-${stamp}`,
  clientID: `rt-${stamp}`,
  mutationID: 1,
});
console.log("pushed via Vercel; waiting for realtime hint...");

for (let i = 0; i < 80 && !hint; i += 1) await new Promise((r) => setTimeout(r, 100));
unsub();
console.log(hint ? `REALTIME OK — received "${hint}"` : "REALTIME MISSING (no repull within 8s)");
process.exit(hint ? 0 : 4);
