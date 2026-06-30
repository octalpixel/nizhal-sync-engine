---
title: libSQL / Turso (non-Postgres)
description: Run Nizhal on libSQL / Turso when you already have a Hono API — implement the StorageAdapter seam or the wire protocol.
---

Nizhal ships **one** storage adapter — `postgresStorage`. But the server is decoupled from the
database behind the `StorageAdapter` interface (the in-code comment is explicit: *"Default impl =
postgresStorage; alternates (d1/sqlite/mysql) are adapters"*). So running on **libSQL / Turso** is a
matter of providing that seam. Nothing about the protocol is Postgres-specific — cursor pull over a
monotonic change sequence, tombstones via `deleted_at`, and idempotent push keyed by `clientMutationId`
all map cleanly onto SQLite.

This guide targets the common case: **you already have a Hono API and a hosted Turso (libSQL) DB.**

> **Honest scope:** a libSQL adapter is *your* code today — Nizhal does not ship or test one. The
> interface is small and SQLite has every primitive it needs (triggers, transactions, integer
> timestamps), so it's a contained job. If you'd rather not, Path B avoids the adapter entirely.

Nizhal does ship and test `libsqlAuditStorage`, the dialect-specific append/query primitive for the
optional [audit log](/server/audit-log/). It is designed to be composed into a complete libSQL
`StorageAdapter`; it does not turn the incomplete sample below into a sync adapter.

## Path A — a libSQL `StorageAdapter`, mounted in your Hono app (recommended)

`createNizhalServer({ storage })` returns `{ app }` — a Hono app. **Mount it inside your existing
API** and you reuse the whole engine (scoped cursor pull, idempotency, sync-rule evaluation, the
`/sync/*` endpoints, realtime):

```ts
import { Hono } from "hono";
import { createNizhalServer, bearerTokenAuth } from "@nizhal/server";
import { libsqlStorage } from "./libsql-storage"; // your adapter (below)
import { schema, mutators, syncRules } from "./model";

const nizhal = createNizhalServer({
  schema, mutators, syncRules,
  auth: bearerTokenAuth({ secret: process.env.JWT_SECRET! }),
  storage: libsqlStorage({ url: process.env.TURSO_URL!, authToken: process.env.TURSO_TOKEN! }),
});

const api = new Hono();
api.get("/healthz", (c) => c.text("ok")); // your existing routes
api.route("/", nizhal.app);                // Nizhal's /sync/pull, /sync/push, /nizhal/contract
export default api;
```

### Implement the seam over `@libsql/client`

`StorageAdapter` also requires `authorizeMutatorTx`: resolve the actor's sync-rule buckets inside the
same write transaction, then validate inserted rows plus update/delete pre-images and post-images.
SQLite translations of the Postgres-isms:

| Postgres | libSQL / SQLite |
|----------|-----------------|
| `_nizhal_row_version_seq` | use an `INTEGER PRIMARY KEY AUTOINCREMENT` change sequence; encode the sequence as an opaque cursor |
| `select … for update` | `BEGIN IMMEDIATE` — libSQL serializes the write transaction |
| tombstones | a `deleted_at` integer column (NULL = live) — identical model |
| change-tracking triggers | SQLite triggers append row changes, tombstones, and bucket exits to the same ordered change log |
| `_nizhal_mutations` / `_nizhal_clients` | same tables, SQLite syntax |

```ts
import { createClient } from "@libsql/client";
import type { StorageAdapter } from "@nizhal/server/adapters";

export function libsqlStorage(opts: { url: string; authToken?: string }): StorageAdapter {
  const db = createClient({ url: opts.url, authToken: opts.authToken });
  return {
    async getChanges({ actor, syncRules, cursor }) {
      // resolve the actor's buckets from syncRules, then per synced table:
      // Read change-log entries with seq > decoded cursor under the actor's bucket scope.
      // Return changed rows, tombstones, and bucket-exit removals, then encode the last seq.
    },
    async transaction(fn) { /* db.transaction("write") → run fn with a StorageTx over the tx */ },
    async authorizeMutatorTx({ tx, mutatorTx, actor, syncRules }) { /* return a fail-closed, bucket-scoped MutatorTx */ },
    async claimMutation(tx, id) { /* insert into _nizhal_mutations(client_mutation_id) … on conflict do nothing; return inserted */ },
    async isApplied(id) { /* select 1 from _nizhal_mutations where client_mutation_id = :id */ },
    async recordApplied(id, map) { /* upsert _nizhal_mutations with result/error */ },
    async provision({ schema, syncRules }) { /* add sync columns plus ordered change/removal triggers and _nizhal_ tables */ },
    // optional: checkMutationSequence (per-client LMID ordering), getActorBuckets, appliedMutationError
  };
}
```

Mirror `postgresStorage` in `@nizhal/server` for the exact query shapes — the logic is identical; only
the dialect changes. Run your `provision()` once at deploy (your equivalent of `nizhal migrate`).

## Path B — implement the wire protocol in your Hono routes (no adapter)

If you'd rather not write a full adapter, the client only needs the **wire protocol**, which you can
serve from your existing Hono routes over Turso however you like:

- `POST /sync/pull` — body `{ cursor, syncRule, deviceId }` → `{ changed: [{table, rows}], tombstoned, removedBuckets, cursor }`.
- `POST /sync/push` — body `{ name, args, clientMutationId }` → apply the mutation **idempotently**
  (dedupe by `clientMutationId`), return the new cursor / result.
- `(optional) /sync/stream` — a WS that emits `repull:<bucket>` on commit (a hint only).

Implement those three against Turso following cursor-pull + idempotent-push + tombstones. You lose
the engine's sync-rule linting and realtime adapters, but you fully own the semantics — good when
your sync rules are bespoke.

## Realtime without Postgres

`listenNotifyRealtime` is Postgres-only. On libSQL/Turso: use `inProcessRealtime` for a single
instance, and rely on the client's **`pull.intervalMs` fallback** for multi-instance — a missed ping
self-heals on the next pull (the cursor pull is authoritative, the ping is only a latency hint). Bring
your own pub/sub (e.g. Redis) only if you want instant cross-instance pushes.

## The client is unchanged

Either path, the client is the same: `createNizhalClient` + `nizhalCollectionOptions` + TanStack DB +
`waSqlitePersistence` / `opSqlitePersistence`. It speaks the protocol; it doesn't care the backend is
Turso. See the [Client](/client/create-nizhal-client/) docs.
