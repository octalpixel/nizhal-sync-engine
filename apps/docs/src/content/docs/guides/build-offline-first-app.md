---
title: Build an offline-first app
description: End-to-end checklist for shipping with Nizhal and TanStack DB.
---

## 1. Gate the requirement

Confirm offline writes are a hard requirement — not speculative. See [Introduction](/introduction/).

## 2. Model the domain

Prefer **append-only facts** and **derived folds** over mutable aggregates. If you need shared counters, use ledger entries or server-side mutator invariants.

## 3. Schema + merge policy

Declare tables with `@nizhal/kernel` Drizzle re-exports. Set `merge: "field"` or CRDT columns only where LWW is insufficient.

## 4. Mutators as the write API

Every user action maps to exactly one mutator. Server `fn` enforces invariants; return `{ serverId, affectedBuckets }` when client IDs reconcile.

## 5. Sync rules before UI

Write rules that scope every synced table to actor buckets. Run tests that assert `assertSyncRulesNoLeak` passes. Use `b.membership` for dynamic tenancy.

## 6. Provision + migrate

`nizhal migrate` against your Postgres (local or managed). Commit the provision plan in CI for drift detection if needed.

## 7. Server deployment

`createNizhalServer` with `bearerTokenAuth`, `postgresStorage`, and `inProcessRealtime` (single instance) or `listenNotifyRealtime` (multi-instance). See [Self-hosting](/self-hosting/node/).

## 8. Client collections

One `nizhalCollectionOptions` per synced table/sync-rule pair. Wire `createNizhalMutators` once; UI calls `mutate.*`.

## 9. Persistence from day one

Enable `waSqlitePersistence` or `opSqlitePersistence` before testing offline — otherwise refresh loses the outbox.

## 10. Validate convergence

Run `pnpm chaos` emulation scenarios against your domain or extend `apps/emulation`. See [Production validation](/production/validation/).

## Anti-patterns

- Storing mutable `balance` without ledger backing
- Raw SQL in sync-rule data queries
- Importing server Drizzle types on the client
- Relying on WS payloads for row data (pull is authoritative)
