---
title: "Nizhal vs Zero, LiveStore, Electric, PowerSync"
description: An honest comparison of local-first sync engines — what each actually does, how realtime works, where each wins, and when to pick which.
---

These tools all solve a version of "keep a local store in sync with a backend so the app works
offline and updates live." They differ on five axes that actually matter:

1. **Source of truth / write model** — is the device authoritative, or the server?
2. **CDC mechanism** — how do server-side changes get detected? (log-based replication vs triggers vs an event log)
3. **What syncs** — rows, query results, events, or shapes?
4. **Deployment** — does it need an always-on stateful service, or does it run on plain serverless?
5. **Realtime** — is the live connection foundational, or an optional latency optimization?

We've tried to be fair — every tool here is good, and each is *better than Nizhal* for some use case.
Claims are grounded in each project's own docs (linked at the bottom); versions: Zero 1.0, LiveStore
0.4, PowerSync 1.x, Electric current.

## At a glance

| | **Nizhal** | **Zero** (Rocicorp) | **LiveStore** | **Electric** | **PowerSync** |
|---|---|---|---|---|---|
| Source of truth | **device or server** (per-collection mode) | server (Postgres) | the event log (local-first) | server (Postgres) | server DB |
| Writes | optimistic; durable outbox; local-first **or** server-authoritative | optimistic, server-authoritative (rebase) | event-sourced, rebase | **read-path only** — you build writes | client **upload queue** → your backend |
| CDC source | **triggers** (Postgres **and** libSQL/SQLite, no WAL) | Postgres **logical replication** | the event log itself | Postgres **logical replication** | logical replication (Postgres) / change streams |
| Unit of sync | rows in **buckets** + mutation commands | **query results** (ZQL, dynamic) | **events** (eventlog) | **Shapes** (live row sets) | rows by **Sync Rules** |
| Backend DBs | Postgres, libSQL/Turso | Postgres only | any (events stored by a sync backend) | Postgres only | **Postgres, MongoDB, MySQL** |
| Needs always-on stateful service? | **No** (HTTP runs serverless) | **Yes** (`zero-cache` + replication slot) | a sync backend (pluggable, CF-able) | a sync service (replication consumer) | their **sync service** |
| Realtime | **yes, but optional** (pull-interval backstop) | yes (streaming, core) | yes (notify→pull events) | yes (streaming shapes) | yes (live) |
| Conflict | LWW / field-level / CRDT, per mode | rebase, server wins | LWW (+ custom merge) | optimistic, reconcile by txid | LWW-ish; you own write logic |
| Maturity | young | **1.0, mature** | 0.4, active | mature | **mature, commercial** |

## The tools, briefly

**Zero (Rocicorp)** — a `zero-client` + a stateful `zero-cache` that keeps a **read-only replica** of
your Postgres via logical replication. You write **normal queries (ZQL)** and Zero syncs *exactly the
data those queries need* — dynamic, no static sync rules. Writes are optimistic + server-authoritative.
**Best for:** Postgres apps that want "just write live queries," and can run an always-on `zero-cache`.
**Weakness:** Postgres-only; that stateful cache isn't serverless.

**LiveStore** — **event sourcing**: every mutation is an immutable event; local reactive SQLite is a
*projection* of the eventlog; sync is git-style pull-then-**push-with-rebase** of events. **Best for:**
apps that want auditability, time-travel, and custom merge semantics, and are happy thinking in events.
**Weakness:** event-sourcing is a bigger mental model than rows.

**Electric (ElectricSQL)** — consumes the Postgres logical-replication stream and fans rows into
**Shapes** that clients subscribe to. Deliberately **read-path only**: writes go through *your* server
functions and reconcile optimistically via a Postgres transaction id. **Best for:** scaling
*read* sync over Postgres with minimal lock-in; you keep full control of writes. **Weakness:** you build
the entire write path yourself.

**PowerSync** — a **drop-in sync layer** that mirrors your backend DB into in-app SQLite via a sync
service + **Sync Rules**, with a client-side **upload queue** that replays CRUD to your backend.
Supports **Postgres, MongoDB, and MySQL**. **Best for:** production mobile/brownfield apps wanting a
battle-tested, multi-DB, commercially-supported engine. **Weakness:** runs through their sync service;
commercial product.

**Nizhal** — row-based CDC via **triggers** (so it works on Postgres *and* libSQL/SQLite with **no WAL
/ logical replication**), cursor-**pull** + idempotent-**push** of mutation commands, with realtime as
an **optional ping** rather than the data path. Source of truth is **per-collection**: `local-first`
(default) or `server-authoritative`. Includes a **brownfield sync target** to point the client at *your*
existing API.

## The two design choices that set Nizhal apart

**1. Realtime is optional, not foundational.** In Zero, Electric, and PowerSync the live streaming
connection *is* the model. In Nizhal the data path is `pull` (cursor delta) + `push` (idempotent); the
WebSocket only sends a `repull:<bucket>` **ping** that says "pull now." Lose the socket and the app
still converges on the next pull interval — just slower. This is *why* Nizhal runs on plain serverless
(HTTP everywhere; add a realtime hub only if you want instant) and degrades gracefully where the others
assume an always-on connection. See [Realtime](/concepts/realtime/).

**2. Trigger-CDC instead of logical replication.** Zero and Electric require Postgres logical
replication (a replication slot + an always-on consumer). Nizhal detects changes with **triggers**, so
the same engine runs on **libSQL/SQLite** (Turso, embedded) and on Postgres **without WAL config** — at
the cost of not getting replication's zero-app-overhead change capture.

## When to pick which (honest)

- **Pick Zero** if you're all-in on Postgres, want dynamic query-driven sync with the least sync-rule
  ceremony, and can run a stateful `zero-cache`. *Revisit Nizhal if you need libSQL/SQLite, serverless
  deployment, or realtime-optional degradation.*
- **Pick LiveStore** if you want event-sourcing's auditability/time-travel and custom merges. *Revisit
  Nizhal if you'd rather sync rows than model everything as events.*
- **Pick Electric** if you only need fast **read** sync over Postgres and will own the write path.
  *Revisit Nizhal if you want writes, offline durability, and conflict handling built in.*
- **Pick PowerSync** if you need a mature, commercially-supported engine across Postgres/Mongo/MySQL,
  especially on mobile. *Revisit Nizhal if you want to self-host with no dedicated sync service, run on
  libSQL, or pick source-of-truth per collection.*
- **Pick Nizhal** if you want: **realtime that's optional** (so plain serverless works and the app
  survives a dropped socket), **trigger-CDC** that runs on Postgres *and* libSQL/SQLite with no WAL,
  **per-collection** local-first vs server-authoritative, and a **brownfield adapter** to reuse an
  existing backend. *Revisit a competitor if you need Zero's dynamic queries, LiveStore's event log, or
  PowerSync's multi-DB maturity today.*

## What Nizhal does NOT do (yet)

- No dynamic query-driven sync (you define sync rules → buckets, like PowerSync/Electric, not ad-hoc
  queries like Zero).
- No event-log/time-travel model (rows + tombstones, not an eventlog like LiveStore).
- No MongoDB/MySQL backends (Postgres + libSQL/SQLite).
- Younger than all four — fewer production miles.

## Sources

- Zero: [zero.rocicorp.dev/docs](https://zero.rocicorp.dev/docs/introduction) · 1.0 release notes
- LiveStore: [how LiveStore works](https://dev.docs.livestore.dev/overview/how-livestore-works/)
- Electric: [Postgres Sync](https://electric-sql.com/) (logical-replication → Shapes; read-path only)
- PowerSync: [powersync.com](https://powersync.com/) · v1.0 (sync service + Sync Rules + upload queue)
