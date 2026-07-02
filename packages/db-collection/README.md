# @nizhal/db-collection

The [Nizhal](https://github.com/octalpixel/nizhal) sync **client** — the drizzle-native store.
One SQLite file holds your derived real tables plus the `nizhal_outbox` / `nizhal_meta` /
`nizhal_dead_letter` control tables; queries are the real Drizzle query builder, writes are
optimistic + durable (one transaction), and convergence is idempotent.

```bash
npm install @nizhal/db-collection
```

```ts
import { createNizhalClient, openNizhalStore } from "@nizhal/db-collection";
import { mutators, notes, syncRules } from "./domain";

const store = await openNizhalStore({
  echo: createNizhalClient({ server: "http://localhost:4000", bucketsForSyncRule: () => [ownerId] }),
  schema: { notes }, syncRules, mutators,
  actor: { userId, ownerId },
  database, // a drizzle db over op-sqlite / expo-sqlite / wa-sqlite
  changes,  // the matching change feed from @nizhal/local
});

store.mutate.addNote({ id, body });           // optimistic + durable outbox
store.db.select().from(store.tables.notes);   // real drizzle SQL over synced data
```

Brownfield (sync against an existing API)? Implement a `NizhalSyncTarget` and pass it as the
client's `syncTarget`. React Native helpers live at `@nizhal/db-collection/react-native`.
Full API: [`docs/api.md`](../../docs/api.md#nizhaldb-collection). MIT licensed.
