---
title: Introduction
description: What Nizhal is, who it's for, and what it is not.
---

**Nizhal** (நிழல் — "reflection") is a self-host, **offline-first sync engine**: `@nizhal/server` on any Postgres plus `@nizhal/db-collection` as a TanStack DB adapter.

It is **not** a hosted sync service like PowerSync, Electric, or Replicache-as-a-platform. It is a **sync API embedded in your own backend** — one Node/Bun process, one database you control, no logical replication.

## What you get

| Package | Role |
|---------|------|
| `@nizhal/kernel` | Schema helpers, `defineMutators`, `defineSyncRules`, contract emission |
| `@nizhal/server` | Hono server: `/sync/pull`, `/sync/push`, `/sync/stream`, `/nizhal/contract` |
| `@nizhal/db-collection` | TanStack DB `SyncConfig` + offline mutators + persistence glue |
| `@nizhal/cli` | `nizhal migrate` — provisions no-WAL DDL from schema + sync rules |

The client substrate is **TanStack DB** (`@tanstack/db`, `db-ivm`, `offline-transactions`, wa-sqlite/op-sqlite persistence). Nizhal does not build a client store, reactivity layer, or outbox.

## How it differs from hosted sync engines

Hosted engines (Zero, Electric, PowerSync, InstantDB) tail the WAL or run as a managed service. That trades self-host freedom for lower setup.

Nizhal's wedge is **replication-free change tracking**: opaque sequence cursor pull,
`sync_control`-gated triggers, tombstones, and idempotent push keyed by `clientMutationId`. It runs on
**any** managed Postgres — Neon, RDS, Supabase — without `wal_level` changes or replication slots.

Replicache's model (poke/cookie/`lastMutationID`) influenced Nizhal's idempotent push and cursor semantics, but Nizhal keeps writes in **your** mutators and sync scope in **your** declarative rules.

## Who it's for

Use Nizhal when:

- **Offline-first is a hard requirement** — read and write with no network; converge on reconnect.
- **You self-host on your own or managed Postgres** — no vendor replication machinery.
- **You own the write path** — business invariants in server mutators, one op = one transaction.
- **Multi-device per tenant** — several devices share a scoped subset and must converge.
- **Your domain fits append-only movement ledgers** — balances as folds of immutable entries (see [First app](/getting-started/first-app/)).

## Non-goals

Do **not** use Nizhal when:

- You only need online-optimistic CRUD (TanStack Query or a normal API is enough).
- You need realtime collaborative rich-text editing as the core product (use Yjs directly; Nizhal's default is LWW + ledgers, with opt-in field/CRDT merge).
- You want the absolute lowest setup and are fine being fully hosted on someone else's sync infra.
- You have a working hand-rolled sync — migrate incrementally or not at all.

## The one-sentence test

> If "works offline and converges across the user's own devices, on a database I control" is a requirement — Nizhal. If any of those three clauses is optional, reach for something lighter first.

## What you accept

- You run a server (one process + one Postgres).
- Default conflict handling is commit-order LWW + tombstones + append-only folds (field-merge and CRDT columns are opt-in).
- You model writes as mutators and reads as sync-rule-scoped collections.

## Next steps

- [Quickstart](/getting-started/quickstart/) — install, migrate, server, client, first sync
- [First app](/getting-started/first-app/) — credit-ledger movement-ledger pattern
- [How sync works](/concepts/how-sync-works/) — cursor, push, tombstones, no WAL
