---
title: API
description: Public surface for @nizhal/kernel, server, db-collection, and cli.
---

Public surface for the four `@nizhal/*` packages. Types are generated from `GET /nizhal/contract` via `nizhal gen` (planned); do not import server Drizzle schema on the client.

## `@nizhal/kernel`

Schema, mutators, sync rules, and contract emission.

### Schema

Define tables with Drizzle `pgTable` re-exports from `@nizhal/kernel`. Set per-table merge policy via a table source object:

```ts
import { pgTable, text, crdtText, crdtMap } from "@nizhal/kernel";

// Default: last-write-wins (commit-order on server)
const notes = pgTable("notes", { id: text("id").primaryKey(), body: text("body") });

// Field-level merge: each column resolves independently (HLC-ordered scalars)
const docs = {
  table: pgTable("docs", { id: text("id").primaryKey(), title: text("title") }),
  merge: "field" as const,
};

// CRDT columns (Yjs-backed map/text) inside a field-merge table
const collab = {
  table: pgTable("collab_docs", {
    id: text("id").primaryKey(),
    body: crdtText("body"),
    meta: crdtMap("meta"),
  }),
  merge: "field" as const,
};
```

| `merge` | Behavior |
|---------|----------|
| `"lww"` | Whole-row last-write-wins by server commit order (default) |
| `"field"` | Per-column merge; scalars use HLC, CRDT columns merge structurally |
| `"crdt"` | Column-level CRDT mode via `crdtText` / `crdtMap` |

Helpers: `crdtText`, `crdtMap`, `schemaMergeMode`, `schemaMergePolicy`, `emitNizhalContract`.

### Mutators

```ts
import { defineMutator, defineMutators } from "@nizhal/kernel";
import { z } from "zod";

export const mutators = defineMutators({
  addNote: defineMutator(
    z.object({ id: z.string(), body: z.string() }),
    async ({ tx, actor, newId }, args) => {
      const id = args.id || newId();
      await tx.insert(notes).values({ id, body: args.body, owner_id: actor.ownerId });
      return { serverId: id, affectedBuckets: [actor.ownerId] };
    },
  ),
});
```

- One business operation = one mutator = one server transaction.
- `clientMutationId` enables idempotent replay; server returns client-id → server-id reconciliation.

### Sync rules

```ts
import { defineSyncRules } from "@nizhal/kernel";

export const syncRules = defineSyncRules((b) => ({
  myNotes: b.bucket({
    parameters: () => b.params({ ownerId: "owner_id" }),
    data: (bucket) => [
      b.table("notes").where(b.eq("owner_id", bucket.ownerId)),
    ],
  }),
}));
```

`defineSyncRules` is no-leak-linted: predicates must scope every synced row to the actor's buckets.

Builder methods: `b.bucket`, `b.params`, `b.membership`, `b.table`, `b.eq`, `b.raw` (parameters only).

### Contract

`emitNizhalContract({ schema, mutators, syncRules })` produces the OpenAPI/JSON-Schema artifact served at `GET /nizhal/contract`.

---

## `@nizhal/server`

Hono sync server, storage, realtime, auth, jobs, and observability.

### `createNizhalServer`

```ts
import { createNizhalServer } from "@nizhal/server";

const server = createNizhalServer({
  db: process.env.DATABASE_URL!,
  schema,
  mutators,
  syncRules,
  auth,
  storage,   // optional; defaults to postgresStorage(db)
  realtime,  // optional; defaults to inProcessRealtime()
  blob,      // optional BlobAdapter
  observer,  // optional NizhalObserver hooks
  jobs,      // optional durable job registry
  limits,    // body size + per-actor rate limit
  presence,  // heartbeat timeout
});

server.listen(4000);
```

Endpoints: `POST /sync/pull`, `POST /sync/push`, `GET /sync/stream` (WebSocket), `GET /nizhal/contract`, `GET /nizhal/stats` (admin).

### Storage — `postgresStorage`

```ts
import { postgresStorage } from "@nizhal/server/adapters";

const storage = postgresStorage({ connectionString: process.env.DATABASE_URL! });
```

`StorageAdapter` interface (implemented by `postgresStorage`):

- `getChanges` — cursor pull with bucket scope, tombstones, `removedBuckets`
- `transaction` — atomic mutator execution
- `authorizeMutatorTx` — transaction-local write authorization from sync-rule membership
- `claimMutation` / `recordApplied` — idempotent push + client-id reconciliation
- `provision` — no-WAL DDL (columns, triggers, indexes) from schema + sync rules

`buildPostgresProvisionPlan` returns the raw SQL statements for inspection.

### Realtime adapters

| Adapter | Import | Use case |
|---------|--------|----------|
| `inProcessRealtime` | `@nizhal/server/adapters` | Default single-process pub/sub from commit chokepoint |
| `listenNotifyRealtime` | `@nizhal/server/adapters` | Multi-instance Postgres via `LISTEN/NOTIFY` |
| `cloudflareRealtime` | `@nizhal/server/adapters/cloudflare` | Cloudflare Workers + Durable Objects (PartyServer) |
| `cloudflareHttpRealtime` | `@nizhal/server/adapters/cloudflare` | HTTP long-poll fallback on Workers |

All implement `RealtimeAdapter`: `publish(bucket)` (commit chokepoint only) + `subscribe(onPing)`.

Presence v2: `track` / `untrack` / heartbeat on `/sync/stream`; state and diffs are bucket-scoped.

### Auth — `bearerTokenAuth`

```ts
import { bearerTokenAuth, issueBearerToken } from "@nizhal/server";

const auth = bearerTokenAuth({ secret: process.env.JWT_SECRET! });
const token = issueBearerToken({ userId, ownerId, secret });
```

`NizhalAuth.resolve(req)` returns `{ userId, ownerId }` or `null`.

### Blob — `BlobAdapter`

```ts
import { localFsBlobStore, s3BlobStore, r2BlobStore, blobDb } from "@nizhal/server/adapters";
```

Presigned upload/download URLs; reference rows sync via `blobDb(storage)`.

### Observability — `NizhalObserver`

Hooks: `onPull`, `onPush`, `onConflict`, `onError`. `gatherStats(db, realtime)` powers `GET /nizhal/stats`.

### Jobs

`createJobScheduler` + `createJobWorker` for durable background tasks enqueued from mutators.

---

## `@nizhal/db-collection`

TanStack DB `SyncConfig` adapter, offline mutators, presence, persistence.

### `createNizhalClient`

```ts
import { createNizhalClient } from "@nizhal/db-collection";

const echo = createNizhalClient({
  server: "http://localhost:4000",
  auth: { getHeaders: () => ({ Authorization: `Bearer ${token}` }), refresh },
  bucketsForSyncRule: (rule) => [...],
  subscribeSource,  // optional; defaults to a reconnecting WebSocket source
  reconnect,        // jitter + catch-up on reconnect
  ttl,              // evict out-of-scope bucket rows locally
  pull,             // intervalMs + page size for bootstrap
  presence,         // heartbeat interval
  status,           // SyncStatus + outbox inspection
});
```

Methods: `pull`, `push`, `subscribe`, `track`/`untrack`, `presenceState`, `onPresence`, cursor/scope helpers.

### `nizhalCollectionOptions`

Returns a TanStack DB `CollectionConfig` wired to Nizhal pull/push:

```ts
import { nizhalCollectionOptions } from "@nizhal/db-collection";

const notesConfig = nizhalCollectionOptions({
  name: "notes",
  syncRule: "myNotes",
  echo,
  persistence: waSqlitePersistence({ ... }),  // optional
});
```

### `createNizhalMutators`

Wraps kernel mutators with offline-durable optimistic writes (TanStack offline-transactions). Poison failures quarantine without wedging the outbox.

### Presence

`track`, `untrack`, `presenceState`, `onPresence`, `subscribePresence`, `presence` — v2 metas-per-key with join/leave diffs.

### Persistence

| Export | Platform |
|--------|----------|
| `waSqlitePersistence` | Web (wa-sqlite + OPFS) |
| `opSqlitePersistence` | React Native (op-sqlite) |
| `migrateClientStore` | Client-store schema migrations |

### CRDT helpers

`createCrdtText`, `createCrdtMap`, `applyCrdtUpdate`, `encodeCrdtUpdate` — client-side Yjs editing before push.

### Blob + status

`createNizhalBlobs`, `memoryBlobStore`, `keyForBlob` — client blob upload/download.
`createNizhalStatus` — exposes sync status and poison-quarantine outbox entries.

### Subscribe sources

`createWebSocketSource` — build a realtime transport from any WHATWG-`WebSocket` factory (native `WebSocket` on web, `NitroWebSocket` on RN, `ws` on Node), with exponential backoff + jitter, a stability gate, connect timeout, heartbeat, and fresh auth on every reconnect. `createPartySocketSource` (default, against `/sync/stream`) and `createCloudflareSubscribeSource` (one partyserver Durable Object per bucket) are built on it — no partysocket client dependency.

---

## `@nizhal/react-native`

`nitroWebSocketSource`, `installNitroFetch`, `nitroFetch`, `createNizhalNitroClient`, `reactNativeOnlineDetector`, `installNizhalNativePolyfills`

---

## `@nizhal/cli`

```bash
nizhal migrate   # provision no-WAL DDL from schema + sync rules
nizhal gen       # (planned) generate client types from /nizhal/contract
nizhal introspect # (planned) brownfield schema introspection
```

`NizhalMigrateConfig`: `{ db, schema, syncRules, storage? }`.

---

## Package versions

All four libraries ship at `0.1.0` with `publishConfig.access: "public"` and `files: ["dist"]` (no source maps in tarballs).
