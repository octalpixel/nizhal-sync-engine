# POS — offline-first against an EXISTING API (brownfield tier B2)

The working demo of `rfcs/rfc-local-sync-convergence.md` §7 **B2**: an offline-first client
syncing with a backend that is **not** a Nizhal server — just a plain Hono + SQLite REST API.

```
server/   the "existing backend": ordinary REST (GET/POST /products, POST /orders).
          Sections marked [SYNC ADDITION] are the honest WatermelonDB tax the backend team
          adds: a monotonic change cursor, tombstones for deletes, idempotent writes keyed
          by the client's mutation id.
web/      a Vite POS on the stock Nizhal client (openNizhalStore — outbox, replay-rebase,
          live drizzle queries). The ONLY custom piece is src/adapter.ts: a NizhalSyncTarget
          mapping pull → GET /sync/changes and named mutations → the backend's own endpoints.
```

## Run it

```bash
pnpm --filter pos-existing-api dev          # http://127.0.0.1:4600
pnpm --filter pos-web dev                   # http://localhost:5180

# seed products through the EXISTING api (the "admin" writes Nizhal never sees):
curl -X POST localhost:4600/products -H 'content-type: application/json' \
  -d '{"id":"p-espresso","name":"Espresso","priceCents":350,"stock":10}'
```

Verified live (2026-07-02): products seeded via the plain API appear in the POS through the
adapter's pull; an online sale POSTs to `/orders` with an idempotency key and the backend's own
business rule decrements stock (authoritative, pulled back); an **offline** sale renders
optimistically, sits durably in the outbox, flushes on reconnect; a full page reload restores
everything from the on-device SQLite.

Honest ceiling (by design, documented in the RFC): correctness is bounded by the backend's
change tracking — a seq counter + tombstones here, not the Nizhal server's xid8 commit-ordered
no-skip guarantees.
