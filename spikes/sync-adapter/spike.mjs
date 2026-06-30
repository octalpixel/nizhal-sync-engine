// Spike B: prove @nizhal/db-collection is buildable against the REAL TanStack DB
// SyncConfig (begin/write/commit). This stands in for nizhalCollectionOptions(...).
// We simulate Nizhal's /sync/pull delivering deltas, then a realtime re-pull, then
// an offline optimistic insert.
import { createCollection } from "@tanstack/db";

const assert = (cond, msg) => { if (!cond) { console.error("FAIL:", msg); process.exit(1); } console.log("PASS:", msg); };

// Two "pulls" from a fake Nizhal server: initial load, then a realtime update.
const pulls = [
  [
    { type: "insert", value: { id: "c1", shopId: "s1", name: "Nimal", phone: "077" } },
    { type: "insert", value: { id: "c2", shopId: "s1", name: "Sara",  phone: "071" } },
  ],
  [
    { type: "update", value: { id: "c1", shopId: "s1", name: "Nimal Perera", phone: "077" } },
  ],
];

let ctl;        // sync controls captured from inside sync()
let nextPull = 0;
const applyPull = () => {                       // == what the adapter does on /sync/pull
  const batch = pulls[nextPull++];
  if (!batch) return;
  ctl.begin();
  for (const m of batch) ctl.write(m);
  ctl.commit();
};

const customers = createCollection({
  id: "customers",
  getKey: (r) => r.id,
  // THIS is the shape @nizhal/db-collection would return from nizhalCollectionOptions()
  sync: {
    sync: ({ begin, write, commit, markReady }) => {
      ctl = { begin, write, commit };
      applyPull();        // initial /sync/pull
      markReady();        // collection ready
      return () => {};    // cleanup (would close the WS subscription)
    },
  },
  // the offline-transactions mutationFn would POST to /sync/push here
  onInsert: async () => { /* pretend: await echo.push(...) */ },
});

await customers.preload();
const namesAfterPull = customers.toArray.map((c) => c.name).sort();
console.log("after initial pull:", namesAfterPull);
assert(namesAfterPull.join(",") === "Nimal,Sara", "adapter begin/write/commit landed pulled rows in the collection");

// reactivity: subscribe like useLiveQuery would
let changeEvents = 0;
const sub = customers.subscribeChanges((changes) => { changeEvents += changes.length; });

// simulate realtime "bucket changed" -> re-pull delivering an update
applyPull();
console.log("after realtime re-pull, c1 =", customers.get("c1").name);
assert(customers.get("c1").name === "Nimal Perera", "realtime re-pull updated an existing row");
assert(changeEvents >= 1, "subscribeChanges fired on the re-pull (reactivity works)");

// offline optimistic write (TanStack DB applies overlay before any server ack)
customers.insert({ id: "c3", shopId: "s1", name: "Kamal", phone: "070" });
const hasOptimistic = customers.toArray.some((c) => c.id === "c3");
console.log("after optimistic insert, names =", customers.toArray.map((c) => c.name).sort());
assert(hasOptimistic, "optimistic insert appears immediately (offline write path)");

sub.unsubscribe?.();
console.log("\nSPIKE B GREEN: the SyncConfig adapter, realtime re-pull, reactivity, and optimistic write all work against @tanstack/db 0.6.10");
