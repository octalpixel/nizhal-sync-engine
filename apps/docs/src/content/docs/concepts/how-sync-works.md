---
title: How sync works
description: Cursor pull, idempotent push, tombstones, and the no-WAL self-host model.
---

Nizhal sync is **pull-authoritative** with **push-notify hints**. No logical replication, no WAL tailing.

## Pull — cursor delta

`POST /sync/pull` returns rows changed since an opaque storage-issued cursor. Postgres orders row
changes, tombstones, and bucket-exit removals with the global `_nizhal_row_version` sequence; wall
clock timestamps are not part of pagination. The server evaluates sync rules server-side, so only
rows matching the actor's bucket scope are included.

Pull responses include:

- `changed` — upserts per table
- `tombstoned` — hard- or soft-deleted row IDs
- `removed` — rows that moved out of the client's buckets
- `removedBuckets` — buckets that left the client's scope (access revocation)
- `cursor` — advance marker for the next pull
- `cursorReset` — when the client sent a garbage/future cursor, force full re-bootstrap

Malformed or impossible cursors reset to the initial cursor and set `cursorReset: true`.

## Push — idempotent mutators

`POST /sync/push` accepts batches of mutations keyed by `clientMutationId`. The server:

1. Claims the mutation (`claimMutation`) — duplicate delivery is a no-op
2. Runs the mutator in one `transaction`
3. Records applied state + client-id → server-id map (`recordApplied`)
4. Publishes bucket pings from the **commit chokepoint** only

Replaying the entire outbox twice yields byte-identical server state.

## Tombstones

Hard deletes and `deleted_at` transitions are tracked in `_nizhal_tombstones`. Bucket-column changes
record a bucket-exit removal for the old scope. Pull includes the row's correlation key so clients
remove the same local key used during optimistic ID reconciliation.

## Change tracking without WAL

`postgresStorage.provision` installs:

- `updated_at` / `deleted_at` on synced tables
- Triggers gated by `_nizhal_sync_control` (loop-free — mutations do not re-trigger themselves)
- `_nizhal_row_version` indexes for cursor scans

This runs on **any** Postgres — RDS, Neon, Supabase — without `wal_level = logical` or replication slots.

## Client collection loop

`nizhalCollectionOptions` implements TanStack DB's `SyncConfig`:

1. `sync()` calls `echo.pull` with cursor + buckets
2. `begin` / `write` / `commit` apply rows into the collection
3. On bucket ping or reconnect, pull again

`pull.intervalMs` on `createNizhalClient` is an opt-in fallback interval when realtime is down — the cursor pull still converges (chaos scenario SYNC-5).

## Contract decoupling

Clients should type rows and mutator inputs from `GET /nizhal/contract` via `nizhal gen` (planned) — not by importing server Drizzle schema. See [The contract](/reference/contract/).

## Next

- [Realtime](/concepts/realtime/) — pings are hints
- [Sync rules & buckets](/concepts/sync-rules-and-buckets/)
