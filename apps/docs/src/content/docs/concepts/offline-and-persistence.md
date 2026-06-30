---
title: Offline & persistence
description: TanStack DB live queries, offline-transactions outbox, and SQLite drivers.
---

Nizhal does not implement the client store. **TanStack DB** provides collections, incremental live queries (`db-ivm`), and a durable outbox (`offline-transactions`).

## Write path

1. UI calls `mutate.someMutator(args)` from `createNizhalMutators`
2. TanStack DB applies optimistic local state
3. `offline-transactions` enqueues with `clientMutationId` / idempotency key, without allocating a sequence
4. The elected executor durably allocates `mutationID` immediately before push, after initialization
5. `/sync/pull` and `/sync/push` return the server's authoritative per-client sequence; stale clients
   reallocate to the next contiguous ID
6. Server ack → outbox entry removed; reject → optimistic rebase

Poison mutations (deterministic failures after bounded retries) **dead-letter** without wedging the queue; dependents cascade-cancel (REQ-13).

## Read path

`useLiveQuery` over Nizhal-backed collections updates incrementally as pull applies rows — no manual `refetch()`.

## Persistence

| Export | Platform |
|--------|----------|
| `waSqlitePersistence` | Web — wa-sqlite + OPFS |
| `opSqlitePersistence` | React Native — op-sqlite JSI |
| `migrateClientStore` | Client-store schema migrations |

Pass collection persistence into `nizhalCollectionOptions`, and pass the same store's
`outboxStorage` plus `metaStorage` to `createNizhalMutators`. The meta store holds the local
high-water and per-transaction allocations; it does not add non-transaction rows to the outbox.

Survives refresh and app restart: the outbox and collection state live in SQLite, not memory.

## TTL / eviction

`ttl` on `createNizhalClient` evicts out-of-scope bucket rows locally when the client's sync scope shrinks — pairs with `removedBuckets` from pull.

## Status inspection

`createNizhalStatus` exposes sync status and poison-quarantine outbox entries for UI surfacing.

## Next

- [Persistence](/client/persistence/)
- [Mutators](/client/mutators/)
