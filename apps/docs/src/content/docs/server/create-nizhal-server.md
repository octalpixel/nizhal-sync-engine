---
title: createNizhalServer
description: Hono sync server configuration and endpoints.
---

```ts
import { createNizhalServer } from "@nizhal/server";

const server = createNizhalServer({
  db: process.env.DATABASE_URL!,
  schema,
  mutators,
  syncRules,
  auth,
  storage,   // optional — defaults to postgresStorage(db)
  realtime,  // optional — defaults to inProcessRealtime()
  blob,      // optional BlobAdapter
  observer,  // optional NizhalObserver hooks
  jobs,      // optional durable job registry
  limits,    // body size + per-actor rate limit
  presence,  // heartbeat timeout for /sync/stream
});

server.listen(4000);
```

Returns `{ app, listen, fetch }` — `listen` for Node/Bun, `fetch` for Workers.

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/sync/pull` | Cursor delta scoped to buckets |
| `POST` | `/sync/push` | Idempotent mutator batch |
| `GET` | `/sync/stream` | WebSocket bucket pings + presence |
| `GET` | `/nizhal/contract` | OpenAPI/JSON-Schema contract |
| `GET` | `/nizhal/stats` | Admin stats (password-gated) |

## Required config

- `db` — Postgres connection string or Drizzle client
- `schema` — map of table name → `ContractSchemaSource`
- `mutators` — `defineMutators` registry
- `syncRules` — `defineSyncRules` output
- `auth` — `NizhalAuth` (e.g. `bearerTokenAuth`)

## Error semantics

- Unknown mutator → 400
- Auth failure → 401
- Sync-rule violation → row filtered (never leaked)
- Mutator invariant failure → 400, client optimistic revert

## Related

- [Storage](/server/storage/)
- [Realtime](/server/realtime/)
- [Auth](/server/auth/)
