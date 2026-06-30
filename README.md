# Nizhal

**A toolkit that generates a bespoke, domain-coupled offline-sync engine from a declarative spec — so apps like a POS or a credit-ledger get offline-first without hand-rolling a sync engine.**

> **Code name "Nizhal"** — Greek nymph *Ἠχώ* / English *echo*: keeping every replica in agreement is echoing each change across all of them. (Codename; swappable.)

## The one-line thesis
The hard, reusable 80% of offline-first — local SQLite store, durable outbox, convergence, realtime, change-tracking — is the **kernel**. The easy, unique 20% — your tables, your synced subset, your mutators, your invariants — is **all you write**. Commerce is one *optional profile*, not a tax on everyone. Generality lives at **build time** (an emitter host); the **output is coupled** per consumer (the property Linear/Figma say makes sync good).

**Built by extraction, not greenfield:** ship one coupled engine first, *then* extract the toolkit. Building the generator first is the Amplify-DataStore mistake.

## What it is / isn't
- ✅ A toolkit + opinionated generator; output is a bespoke engine. Self-host-first, no logical replication, developer owns the write path, store inspectable, data exportable.
- ❌ A general runtime engine competing with Zero/Electric. ❌ A full compiler that generates conflict resolution or owns the write path (the graveyard: Realm Device Sync EOL 2025-09-30, AWS dropped Amplify DataStore in Gen 2).

## Status — Phase 0 built ✅
The Phase-0 engine is implemented and integration-tested (self-host, **no logical replication**). All green: `pnpm install && pnpm build && pnpm check-types && pnpm test && pnpm lint` (23 tests).
- `packages/kernel` — `defineMutator`/`defineMutators`/`defineSyncRules` (typed, **no-leak-linted**) + the `/nizhal/contract` emitter.
- `packages/server` — `createNizhalServer` (`/sync/pull`, `/sync/push`, `/sync/stream`, `/nizhal/contract`), `postgresStorage` (any Postgres: columns + triggers, **no WAL**), `inProcessRealtime` default (+ `listenNotifyRealtime`, Cloudflare/PartyKit adapter on the roadmap), durable jobs, `bearerTokenAuth`.
- `packages/db-collection` — TanStack DB `SyncConfig` adapter, offline mutators (idempotent push, **poison-quarantine**), **revocation eviction**, reconnecting-WebSocket transport (`createWebSocketSource` factory: native `WebSocket`/`NitroWebSocket`/`ws`).
- `apps/credit-ledger` — reference app; the `A-E2E` fitness test proves **offline record-credit → reconnect → balance = fold(ledger)**.

### Quickstart
```ts
// server.ts
import { createNizhalServer } from "@nizhal/server";
import { bearerTokenAuth } from "@nizhal/server/adapters";
import { schema, mutators, syncRules } from "./shared";
createNizhalServer({
  db: process.env.DATABASE_URL!, schema, mutators, syncRules,
  auth: bearerTokenAuth({ secret: process.env.JWT_SECRET! }),
}).listen(4000);

// client.ts — types via `nizhal gen` over GET /nizhal/contract; no server/Drizzle import
import { createNizhalClient, nizhalCollectionOptions, createNizhalMutators } from "@nizhal/db-collection";
const echo = createNizhalClient({ server: "http://localhost:4000", auth });
// nizhalCollectionOptions(...) → TanStack DB collections (live folds); createNizhalMutators(...) → optimistic, offline-durable writes.
```
Full wiring: [`apps/credit-ledger`](./apps/credit-ledger). Should you use Nizhal? [`docs/when-to-use-nizhal.md`](./docs/when-to-use-nizhal.md). API reference: [`docs/api.md`](./docs/api.md).

## Repo map
- [`docs/api.md`](./docs/api.md) — public API reference for `@nizhal/kernel`, `@nizhal/server`, `@nizhal/db-collection`, `@nizhal/cli`.
- [`rfcs/RFC-001-nizhal.md`](./rfcs/RFC-001-nizhal.md) — the implementation-ready RFC.
- [`rfcs/sprints/`](./rfcs/sprints/) — the RFC broken into sprints/WBS.
- [`research/strategy-and-running-map.md`](./research/strategy-and-running-map.md) — locked decisions Q1–Q10, de-risked phasing, non-goals.
- [`research/prior-art.md`](./research/prior-art.md) — the graveyard, what-to-steal, 18 primary sources.
- [`research/client-store-decision.md`](./research/client-store-decision.md) — **real SQLite everywhere, not WatermelonDB** (Notion/antoine/Zero/LiveStore evidence).
- [`research/tanstack-db-evaluation.md`](./research/tanstack-db-evaluation.md) — **adopt TanStack DB as the client substrate**; Nizhal = server + `@nizhal/db-collection` adapter.
- [`research/brownfield-orpc-case-and-nizhal-lessons.md`](./research/brownfield-orpc-case-and-nizhal-lessons.md) — real oRPC/Prisma/React-Query app: **when NOT to use Nizhal** (the honest gate) + the staged adoption model + roadmap requirements (Prisma support, procedure-as-mutator, client-id reconciliation).
- [`research/instantdb-comparison.md`](./research/instantdb-comparison.md) — InstantDB deep-dive: triples + WAL-tailing (hosted) vs Nizhal's relational + no-WAL (self-host); **WAL is the fork**. Borrow: CEL-style read+write permissions (B16).
- [`research/contract-and-coupling.md`](./research/contract-and-coupling.md) — **don't be tRPC**: server emits a contract artifact (`/nizhal/contract` OpenAPI), client generates types (`nizhal gen`); decoupled, no monorepo/Drizzle on client. Type-import opt-in for monorepos.
- [`research/sync-blindspots.md`](./research/sync-blindspots.md) — gap analysis vs the canonical "hard things about sync" (Figma/Ink&Switch/PowerSync/Zero/Ditto). The overlooked: **revocation→eviction (B19)** & **poison-mutation outbox (B20)** = now Phase-0 (REQ-13/14); client schema migration, blob sync, observability = Phase 1 (B22–B26).
- [`research/invoice-cascade-greenfield.md`](./research/invoice-cascade-greenfield.md) — deep read of shopbook's invoice cascade (inventory/cash/credit/supplier/payment) → how a greenfield Nizhal app models it: **one mutator = one transaction** + **append-only movement ledgers (balance = fold)**. Validates both core bets; solves FK/causal ordering.

## Blueprints (both worked examples)
- [`blueprints/shopbook.md`](./blueprints/shopbook.md) — a **credit-ledger** (shopbook.lk) on the kernel with **no commerce profile** — proves the kernel is general. ~4 files.
- [`blueprints/pos.md`](./blueprints/pos.md) — a **multi-store retail POS** (movement-ledger model): schema + sync rule + **4 mutators** (`ringSale`/`recordPayment`/`receiveStock`/`voidSale`) — atomic invoice cascade, conflict-free stock/cash/credit as folds, accept-always.
- [`blueprints/brownfield-adoption.md`](./blueprints/brownfield-adoption.md) — Strangler-Fig adoption into an existing app; shopbook Case B = migrating *off* a hand-rolled engine (subtractive).

## The stack (decided)
Store: **SQLite everywhere** off-thread (op-sqlite/expo-sqlite native; wa-sqlite+OPFS+Worker/SharedWorker web). Query/types: **Drizzle** (shared client+server). Reactivity: trigger→change-log→BroadcastChannel→re-query. Sync: opaque total-order version cursor + push-notify (WS/`LISTEN-NOTIFY`) + `sync_control`-gated change-tracking + tombstones + idempotent replay. Server: self-host Node/Bun+PG default (Cloudflare DO optional).
