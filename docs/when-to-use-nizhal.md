# Do you need Nizhal? (the honest adoption gate)

Nizhal is a self-host, no-WAL offline-sync engine. It is the right tool for a specific shape of problem and the wrong tool for several adjacent ones. Read this before adopting — choosing Nizhal when you didn't need it is a real cost.

## Use Nizhal when
- **Offline-first is a hard requirement** — the app must keep working (read *and* write) with no network, and converge on reconnect. POS terminals, field apps, low-connectivity markets.
- **You want to self-host on your own/managed Postgres** — no replication slot, no `wal_level` change, no vendor lock. Nizhal provisions plain columns + triggers; it runs on RDS/Supabase/Neon/managed PG you don't control.
- **You own the write path** — your business invariants run server-side in mutators (one mutator = one transaction = your consistency boundary), not in a black-box conflict resolver.
- **Multi-device / multi-user per tenant** — several devices share a synced subset (a shop, a workspace) and must converge.
- **Your domain fits append-only movement ledgers** — balances/stock/totals as folds of immutable movements → conflict-free merge (see [`blueprints/pos.md`](../blueprints/pos.md), [`blueprints/shopbook.md`](../blueprints/shopbook.md)).

## Do NOT use Nizhal when
- **You don't actually need offline writes.** If online-optimistic (TanStack Query / a normal API) is enough, use that. Sync engines add real complexity (outbox, cursors, convergence, eviction) — don't pay for it speculatively.
- **You need realtime collaborative *editing* of shared rich documents** (cursors, char-level merge). That's a CRDT/Yjs problem; Nizhal's default is LWW + tombstones + append-only ledgers. (Per-field CRDT is a Phase-1 backlog item, not the core.)
- **You're willing to be fully hosted and want the absolute lowest setup.** Then a WAL-tailing hosted engine (Zero, Electric, PowerSync, InstantDB) may be less work — *because they host it*. The trade you make for Nizhal's self-host freedom is that you run the server. If you don't value self-host, that trade isn't worth it. (See [`research/instantdb-comparison.md`](../research/instantdb-comparison.md): "WAL is the fork.")
- **A brownfield app with a hand-rolled or ORM-coupled sync already working.** Migrate incrementally (strangler-fig) or not at all; don't rip-and-replace. (See [`research/brownfield-orpc-case-and-nizhal-lessons.md`](../research/brownfield-orpc-case-and-nizhal-lessons.md) and [`blueprints/brownfield-adoption.md`](../blueprints/brownfield-adoption.md).)

## The one-sentence test
> **If "works offline and converges across the user's own devices, on a database I control" is a requirement — Nizhal. If any of those three clauses is optional for you, reach for something lighter first.**

## What you accept by choosing Nizhal
- You run a server (one Node/Bun process + one Postgres; deployment is deliberately boring — auto-stop, single machine).
- Conflict handling is LWW + tombstones + append-only folds by default (rich-text CRDT, presence, field-merge are Phase-1).
- You model your domain as movement ledgers + mutators (a different discipline than CRUD-with-stored-balances — but the one that makes offline merge conflict-free).
