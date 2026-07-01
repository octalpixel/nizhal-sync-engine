# RFC: The drizzle-native sync client — X→0 refactor ledger

**Status:** EXECUTED (X→0, 2026-07-02) · **Slug:** `drizzle-native-sync-client` · 2026-07-02 · breaking changes embraced (zero external users)
**Parent:** `rfc-local-sync-convergence.md` (§4 decision, §10 mechanics, D1–D10). This RFC is the
execution plan: **X = 12 tasks**, driven to zero in order.

## The refactor in one paragraph

`openNizhalStore` is rebuilt on the drizzle-native plane: one SQLite file holding the **derived
real tables** (from the kernel pg schema), plus `nizhal_outbox` / `nizhal_meta` /
`nizhal_dead_letter` as **drizzle tables in the same file** — so optimistic apply + outbox enqueue
commit in ONE transaction (H2 by construction), and pull-apply upserts all tables + advances the
cursor in ONE transaction. The push core (mutation-id allocation, 409 downward resync, poison
parking, retry) ports from `mutators.ts` almost verbatim — it was already collection-agnostic. The
`@tanstack/offline-transactions` executor is replaced by a small owned flush loop over the outbox
table (resolving SESSION-HANDOFF caveat 1: one push engine). Reactivity is `@nizhal/local`'s
update-hook watcher — pull-apply and mutator writes both fire it. `NizhalClient` (transport,
session, subscribe) is reused unchanged. The server is untouched.

**D6 decided (don't-play-safe call): direct-apply + replay-rebase.** Optimistic writes land in the
real tables; each pull batch applies authoritative rows then **replays pending outbox mutations in
ordinal order on top** (deterministic mutators make replay the rebase — the Replicache model). All
`MutatorTx` writes use upsert semantics so replay is idempotent.

## Explicit non-goals (recorded, not cowardice)

- **Presence** rides the WS transport, not storage — composes with either plane; untouched.
- **CRDT columns / blob store**: zero app usage; stay on legacy exports until a consumer exists.
- **TTL bucket eviction**: legacy plane keeps it; new plane ports it in a follow-up (not
  loss-safety-critical; tracked below as T12 note).
- **Multi-tab (Arc B)**: the new plane keeps the leader-election seam; the browser coordinator
  lands after this refactor (it gets *simpler*: one WAL file, leader = sole sync writer).
- Legacy plane modules (`nizhalCollectionOptions`, `createNizhalMutators`, `sync.ts`) remain
  exported (renamed entry: `openNizhalCollectionsStore`) so the 109-test legacy suite keeps
  guarding the wire protocol until the new suite fully supersedes it; deletion is the final task.

## The ledger — X = 12 → 0

| # | Task | Done when |
|---|---|---|
| T1 ✅ | Kernel `deriveSqliteSchema` (typed port of Spike C, fail-closed, per-column override) | kernel tests green (12) |
| T2 ✅ | Client control schema as drizzle sqlite tables (`nizhal_outbox`, `nizhal_meta`, `nizhal_dead_letter`) + store bootstrap migrations | unit-covered via T7 store open |
| T3 ✅ | Drizzle `MutatorTx` (upsert-semantics insert / structured-where update / delete against real tables) + client mutator ctx | unit tests green |
| T4 ✅ | Push core extraction: mutation-id alloc + 409 downward resync + PoisonGuard + retryDeadLetter, storage = `nizhal_meta`/`nizhal_dead_letter` rows | ported logic compiles standalone (exercised in T8/T9) |
| T5 ✅ | Owned outbox flush loop (FIFO by ordinal, single-flight, transient retry, terminal park, online-aware, leader seam) — replaces `@tanstack/offline-transactions` on the new plane | exercised by T8/T9 |
| T6 ✅ | Pull-apply: per-rule pull → ONE tx: upserts + tombstones + removedBuckets + cursor advance; `cursorReset` → atomic re-bootstrap; then replay-rebase pending outbox | exercised by T8/T9 |
| T7 ✅ | `openNizhalStore` v2 assembly (schema-once: pg schema in → derived tables; `db`, `mutate`, `watch`, `useLiveQuery` surface; poke subscribe; interval fallback; H1 canary) | typechecks + T8 |
| T8 ✅ | End-to-end Node suite vs REAL in-process server (pglite): two clients converge; offline write survives restart and flushes; poke→pull; tombstone delete propagates | suite green |
| T9 ✅ | Loss-repro ports: offline-write durability across restart (the un-skipped scenario), 409 sequence resync, rebase-overwrite correctness | suite green |
| T10 ✅* | AMENDED to match the parent RFC's stage decision: consumers compile — `store.test.ts` + `apps/tabkeep-expo` stay on the legacy plane via `openNizhalCollectionsStore` (tabkeep ships its release there; migrates after). `playground/pos` migration = first follow-up; the T8/T9 e2e suite is the app-shaped proof of the new plane. | repo typechecks; all suites green |
| T11 ✅ | Full gates: `pnpm check-types`, `pnpm lint`, db-collection (legacy+new), server, local suites all green | CI-clean tree |
| T12 ✅ | Docs + ledger closeout: api.md, local-sync-architecture.md, SESSION-HANDOFF; record follow-ups (TTL port, legacy deletion, Arc B rebase) | this table all ✅ |

## File plan (new modules in `packages/db-collection/src/drizzle/`)

```
drizzle/control-schema.ts   T2  nizhal_outbox / nizhal_meta / nizhal_dead_letter sqliteTables + DDL bundle
drizzle/mutator-tx.ts       T3  MutatorTx over a drizzle sqlite db/tx (upsert semantics)
drizzle/meta.ts             T4  cursor + mutation-id high-water + per-key allocs over nizhal_meta
drizzle/push.ts             T4+T5  push core + flush loop (one engine)
drizzle/pull.ts             T6  pull-apply + replay-rebase
drizzle/store.ts            T7  openNizhalStore v2
```

`@nizhal/db-collection` gains a workspace dep on `@nizhal/local` (watch/table-watcher reuse).

## Closeout (2026-07-02)

X→0 delivered in one autonomous session. Proof: kernel 12 ✓ · db-collection **116 ✓** (legacy 109
+ new-plane 7, together) · server 74 ✓ · local 13 ✓ · check-types 22/22 · lint 0. The new suite
runs against the REAL server on PGlite and covers: two-client convergence, live watch on
optimistic + pulled writes, **offline-write durability across a full restart** (the scenario the
legacy suite kept skipped), 409 out-of-order downward resync, tombstone propagation,
**replay-rebase** (pending offline write survives an authoritative overwrite of the same row),
and the drizzle-inspectable outbox.

Follow-ups (ordered): migrate `playground/pos` (rung-0 → new plane, then flip sync on);
TTL bucket eviction port; tabkeep migration after its release; legacy-plane deletion;
Arc B multi-tab coordinator rebased onto the one push engine this refactor produced.
