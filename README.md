# Nizhal

**A self-host, no-WAL offline-sync toolkit for Postgres.** You declare your tables, the synced
subset, and your mutators; Nizhal gives you a local-first SQLite store with a durable outbox,
idempotent convergence, and realtime — without a replication slot, a `wal_level` change, or vendor
lock-in. It provisions plain columns + triggers on any Postgres you already run.

> **Code name "Nizhal"** — the shadow/echo of your data: keeping every replica in agreement is
> echoing each change across all of them. (Codename; swappable.)

## The thesis

The hard, reusable 80% of offline-first — a local SQLite store, a durable outbox, convergence,
realtime, change-tracking — is the **engine**. The unique 20% — your tables, your synced subset,
your mutators, your invariants — is **all you write**. One business operation = one mutator = one
server transaction = your consistency boundary. Balances/stock/totals are **folds of an append-only
movement ledger**, so concurrent writes merge conflict-free.

## What it is / isn't

- ✅ Self-host-first, **no logical replication**. You own the write path (mutators run server-side).
  The store is real SQLite (inspectable), your data is exportable, and the server is a boring
  single Node/Bun process + your Postgres.
- ❌ Not a hosted WAL-tailing engine (Zero/Electric/PowerSync/InstantDB) — if you want *lowest
  setup* and don't value self-host, those host it for you. ❌ Not a black-box conflict resolver or a
  rich-text CRDT editor (default is LWW + tombstones + append-only folds).

Should you use it at all? Read the honest gate: [`docs/when-to-use-nizhal.md`](./docs/when-to-use-nizhal.md).

## Status — 0.1.0 (early)

`0.x` semver: **breaking changes are allowed** and the API is still moving. Proven so far: a
client end-to-end suite against a real server, live multi-device and multi-tab convergence, iOS on
op-sqlite, and a brownfield REST integration ([`playground/pos`](./playground/pos)). Production
hardening (resync/epoch, tombstone GC, chaos rig, schema evolution, load) is tracked in
[`rfcs/rfc-production-readiness.md`](./rfcs/rfc-production-readiness.md). Not yet battle-tested at
scale — adopt with that in mind.

Gates (all green): `pnpm install && pnpm build && pnpm check-types && pnpm lint && pnpm test`.

## Three ways to use it

Pick the entry path by how much you need. There is **one standard** underneath; the paths differ
only in the transport.

### 1. Local-only — no server, no sync (`@nizhal/local`)

WatermelonDB-class DX with the Drizzle toolkit exposed natively: a `sqliteTable` schema,
drizzle-kit migrations applied on-device, the real Drizzle query builder, and cross-platform live
queries (expo-sqlite / op-sqlite / browser wa-sqlite). Zero dependency on the sync engine.

```ts
import { openLocalDb } from "@nizhal/local";
import { expoSqliteChanges } from "@nizhal/local/expo-sqlite";
import { useLiveQuery } from "@nizhal/local/react";
import { drizzle } from "drizzle-orm/expo-sqlite";
import * as SQLite from "expo-sqlite";
import migrations from "./drizzle/migrations";
import * as schema from "./schema";

const expo = SQLite.openDatabaseSync("app.db", { enableChangeListener: true });
const local = await openLocalDb({ db: drizzle(expo, { schema }), migrations, changes: expoSqliteChanges(SQLite) });
// in a component: const { data } = useLiveQuery(local, local.db.select().from(schema.notes));
```

Full guide: [`docs/local.md`](./docs/local.md) · working app: [`playground/local-notes`](./playground/local-notes).

### 2. Greenfield sync — you build the server too (`openNizhalStore` + `@nizhal/server`)

Define the domain once (schema + sync rules + mutators), stand up the server, and open a
drizzle-native store that syncs it. One SQLite file holds the derived real tables plus the
`nizhal_outbox` / `nizhal_meta` / `nizhal_dead_letter` control tables.

```ts
// domain.ts — shared, transport-free
import { defineMutator, defineMutators, defineSyncRules, z } from "@nizhal/kernel";
import { pgTable, text } from "drizzle-orm/pg-core";

export const notes = pgTable("notes", { id: text("id").primaryKey(), body: text("body"), shopId: text("shop_id") });
export const mutators = defineMutators({
  addNote: defineMutator(z.object({ id: z.string(), body: z.string() }), async ({ tx, actor }, input) => {
    await tx.insert(notes).values({ ...input, shopId: actor.ownerId });
  }),
});
export const syncRules = defineSyncRules((b) => ({
  mine: b.bucket({
    parameters: () => b.params({ ownerId: "shop_id" }),
    data: (bucket) => [b.table("notes").where(b.eq("shop_id", bucket.ownerId))],
  }),
}));
```

```ts
// server.ts
import { createNizhalServer } from "@nizhal/server";
import { bearerTokenAuth } from "@nizhal/server";
import { mutators, notes, syncRules } from "./domain";
createNizhalServer({
  db: process.env.DATABASE_URL!, schema: { notes }, mutators, syncRules,
  auth: bearerTokenAuth({ secret: process.env.JWT_SECRET! }),
}).listen(4000);
```

```ts
// client.ts
import { createNizhalClient, openNizhalStore } from "@nizhal/db-collection";
import { mutators, notes, syncRules } from "./domain";

const store = await openNizhalStore({
  echo: createNizhalClient({ server: "http://localhost:4000", bucketsForSyncRule: (rule) => [ownerId] }),
  schema: { notes }, syncRules, mutators,
  actor: { userId, ownerId },
  database,   // a drizzle db over op-sqlite / expo-sqlite / wa-sqlite (see docs/platforms.md)
  changes,    // the matching change feed from @nizhal/local
});
store.mutate.addNote({ id, body });                 // optimistic + durable, one transaction
store.db.select().from(store.tables.notes);         // real drizzle SQL over synced data
```

Provision the engine onto your Postgres with `nizhal migrate`. Reference app:
[`apps/tabkeep-expo`](./apps/tabkeep-expo).

### 3. Brownfield — sync against an API you already have (`NizhalSyncTarget`)

Keep your existing REST/RPC backend. Implement a `NizhalSyncTarget` (a `pull` + `push` pair) that
speaks your API, and pass it as the client's transport — the rest of the stack is stock Nizhal.

```ts
import { type NizhalSyncTarget, NizhalSyncTargetError, createNizhalClient, openNizhalStore } from "@nizhal/db-collection";

const restSyncTarget: NizhalSyncTarget = {
  async pull(req) { /* GET your API, map to { changes, cursor, removedBuckets, hasMore } */ },
  async push(mutation) { /* POST your API, return { status: "applied" | "duplicate" | ... } */ },
};

const echo = createNizhalClient({ syncTarget: restSyncTarget, bucketsForSyncRule: () => [shopId], pull: { intervalMs: 2000 } });
const store = await openNizhalStore({ echo, schema, syncRules, mutators, actor, database, changes });
```

Working example (offline-first POS over a plain Hono REST API):
[`playground/pos/web/src/adapter.ts`](./playground/pos/web/src/adapter.ts).

## Packages

| Package | What it is |
|---------|------------|
| [`@nizhal/kernel`](./packages/kernel) | Schema helpers, `defineMutator(s)`, `defineSyncRules`, contract emission (no-leak-linted). |
| [`@nizhal/server`](./packages/server) | `createNizhalServer` (Hono) + `postgresStorage` (no-WAL) + realtime/auth/jobs adapters. |
| [`@nizhal/db-collection`](./packages/db-collection) | The sync client: `openNizhalStore` (drizzle-native), `createNizhalClient`, `NizhalSyncTarget`. |
| [`@nizhal/local`](./packages/local) | Purely-local native-Drizzle store (no sync): `openLocalDb`, cross-platform `useLiveQuery`. |
| [`@nizhal/cli`](./packages/cli) | `nizhal migrate` — provisions the no-WAL DDL onto your existing tables. |

## Docs

- [`docs/api.md`](./docs/api.md) — full public API reference for all five packages.
- [`docs/when-to-use-nizhal.md`](./docs/when-to-use-nizhal.md) — the honest adoption gate.
- [`docs/local.md`](./docs/local.md) — the local-only (`@nizhal/local`) guide.
- [`docs/platforms.md`](./docs/platforms.md) — platform/bundler recipes (Expo native & web, Vite, Next.js, TanStack Start).
- [`docs/local-sync-architecture.md`](./docs/local-sync-architecture.md) — how convergence works under the hood.
- [`rfcs/rfc-drizzle-native-sync-client.md`](./rfcs/rfc-drizzle-native-sync-client.md) — the store's design.
- [`rfcs/rfc-local-sync-convergence.md`](./rfcs/rfc-local-sync-convergence.md) — the convergence protocol.
- [`rfcs/rfc-production-readiness.md`](./rfcs/rfc-production-readiness.md) — the path from pilot-proven to a production release.

## License

[MIT](./LICENSE).
