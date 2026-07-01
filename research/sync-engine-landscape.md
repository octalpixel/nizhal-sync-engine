# The Sync-Engine Landscape — A Comprehensive Study

> Synthesizes three first-hand code deep-dives ([lunora](./lunora-sync-engine.md), [Replicache](./replicache-sync-engine.md), [Zero](./zero-sync-engine.md)) with primary-source design rationale (10 engines + 12 conference talks) into one map — positioned so it can drive a code review of **Nizhal** (this repo).
> Inputs: [`_notes/web-landscape.md`](./_notes/web-landscape.md) (engine docs + quotes), [`_notes/youtube/SYNTHESIS.md`](./_notes/youtube/SYNTHESIS.md) (12 talks, ~90 primitives), [`_notes/nizhal-inventory.md`](./_notes/nizhal-inventory.md), and the three engine reverse-engineering notes.

---

## 0. The one-paragraph map

Every sync engine answers the same four questions, and they only differ in the answers:

1. **Where does authority live?** Device (CRDT, P2P) vs a central server (LWW/OT). *The production winners that feel local-first — Figma, Linear — are centralized + server-authoritative with per-property LWW, deliberately refusing CRDT/OT.* Ink & Switch's own field finding is the permission slip: *"conflicts are not as significant a problem as we feared."*
2. **Who computes the synced slice (partial replication)?** Hand-written (Replicache) → queries (Zero, Convex) → shapes (Electric, lunora) → buckets (PowerSync, **Nizhal**) → schema-coupled load strategies (Linear). Zero's framing: *"syncing just the slice the user wants and **has access to** is much more difficult"* — partial sync and fine-grained auth are the **same** problem.
3. **How is a live query kept fresh?** Full re-run (Replicache subscriptions) → coarse rerun-on-read-set-overlap (Convex) → WAL→topics match (InstantDB) → **membership diff over changed rows** (lunora) → **full IVM dataflow** (Zero) → **delegated to the client store** (Nizhal → TanStack DB; repull-on-hint).
4. **Who owns the write path / conflict policy?** CRDT merge (Automerge/Yjs) vs **the mutator function as the policy** (Replicache/Zero/lunora/Nizhal) vs serializable OCC (Convex) vs punt-to-your-API (Electric).

The recurring lesson, in the authors' words: **the hard part is not merging data — it is partial sync + permissions + keeping a query live, done simply enough to be bulletproof in production** (Electric's demo-vs-production post-mortem is the meta-lesson; Gall's Law + Worse-is-Better).

---

## 1. Master comparison matrix (incl. lunora + Nizhal)

| Engine | Authority | Partial-sync unit | Live-query mechanism | Conflict / write path | Client store | Server / transport | Offline writes |
|---|---|---|---|---|---|---|---|
| **Replicache** | Server | hand-written client-view | re-run subscription on key-diff | **rebase = re-run mutator** | IndexedDB (JSON KV, prolly tree) | BYO server; HTTP push/pull + poke | ✅ queued |
| **WatermelonDB** | Server (you write it) | **none built-in** (filter in `pullChanges`) | **lazy observable queries** (no sync IVM; you poll/trigger) | **column-LWW + local bias** (`_changed` re-overlay); BYO backend | **real SQLite** (native) / LokiJS+IDB (web) | BYO server; HTTP pull/push, `last_pulled_at` watermark | ✅ (`_status`/`_changed`) |
| **Zero** | Server | **ZQL queries** | **end-to-end IVM** | rebase/replay (inherited); custom mutators | IndexedDB via Replicache + client IVM | zero-cache (PG→SQLite replica); WS pokes | ❌ read-only |
| **lunora** | Server (per-shard DO) | **shapes** (table+where+cols) | **membership diff over changed ids** (CDC × probe) | serialized DO; **per-column LWW** (object spread); custom mutators | **in-memory** cache + IndexedDB outbox | Cloudflare DO + D1; WS pokes + HTTP /rpc | ✅ queued |
| **Nizhal** | Server (any Postgres) | **buckets** (no-leak-linted sync rules) | **repull-on-hint** (no server IVM); client = TanStack DB | **per-table merge policy: lww / field-HLC / crdt(Yjs)**; custom mutators (1 txn) | **real SQLite** (op-/wa-sqlite) outbox + TanStack DB | any Postgres, **no WAL**; WS hint + HTTP pull/push | ✅ durable outbox |
| **Electric** | Server (read) + your API (write) | **shapes** (HTTP) | shape log (cacheable HTTP) | **punted to your API** (tentative) | none mandated (+TanStack DB) | Elixir; **stateless HTTP** log | via your write path |
| **PowerSync** | Server | **buckets** (sync rules) | checkpoint + checksum diff | LWW; checkpoint barrier (no client merge) | **mandated SQLite** | sync svc; bucket ops; upload queue | ✅ upload queue |
| **Convex** | Server | **reactive queries** | rerun on read-set overlap | **serializable OCC** + deterministic retry | query cache + OptimisticLocalStore | custom DB; WS deltas | ❌ live connection |
| **InstantDB** | Server | InstaQL queries → topics | **WAL→topics** match | **LWW per triple** | triple store + Datalog (IndexedDB) | Clojure; multi-tenant PG triples; WS | ✅ founding constraint |
| **Linear** | Server | per-model **load strategies** + partial indexes | global `lastSyncId` deltas → MobX graph | LWW via **transaction rebasing** | Object Pool + IndexedDB | `/sync/*`; WS SyncActions | ✅ bounded |
| **Figma** | Server (1 proc/doc) | whole doc tree | server pushes property deltas | **per-property LWW** (server orders) | in-memory tree | WS, one proc/doc | ✅ replay on reconnect |
| **Automerge / Yjs** | **Device** | n/a (full doc) | CRDT observers | **CRDT commutative merge** | in-memory CRDT | transport-agnostic | ✅ symmetric |

**Reading the matrix for Nizhal:** Nizhal is the only row that combines **buckets** (PowerSync-style partial sync) with a **real on-device SQLite store** (PowerSync-style) *and* a **three-mode merge policy including a true CRDT (Yjs)** (which PowerSync/Figma/Linear deliberately avoid) *and* **no-WAL/any-Postgres** (which neither Zero, PowerSync, Electric, nor InstantDB achieve — they all tail the WAL/logical replication). That combination is genuinely novel. The cost it pays for "no WAL" is **no server-side IVM** — it cannot compute incremental query deltas, so realtime is "repull on hint." That is *the* defining trade and the spine of the review.

---

## 2. The three conflict-resolution families (and where each engine bets)

| Family | Mechanism | Who uses it |
|---|---|---|
| **CRDT** | merge is a math property; no central authority | Automerge, Yjs, old Electric; **Nizhal `crdt` columns (Yjs)** for rich text/maps |
| **Server-authoritative / LWW** | central server imposes total order; last value per (object, property) wins | **Figma, Linear, InstantDB, Convex, PowerSync, Replicache, Zero, lunora (per-column), Nizhal (`lww`/`field`)** |
| **OT** | transform ops to preserve intent | Google Docs; *rejected* by Figma, routed-around by Linear |

The striking pattern: **the most-admired "feels-instant" apps chose server-authoritative LWW**, and Nizhal's default (`lww`) + per-field-HLC (`field`) sits squarely in the mainstream — while its optional Yjs `crdt` mode lets it reach into the CRDT family *per column* where text actually needs it. This is a more granular position than any single competitor: **lunora is LWW-only (no CRDT); PowerSync/Figma/Linear are LWW-only; Zero is LWW-flavored; only Nizhal offers per-column choice across all three families.**

> Cross-check for the review: the **`field` (per-field HLC)** mode is Nizhal's analog of Figma/Instant's "store properties as separate rows so there's no conflict." Verify the HLC tiebreak is *causally* correct (not just wall-clock) and that the `_meta jsonb` write is atomic with the column write.

---

## 3. Partial replication — "who computes the slice", lined up

```
manual ───────────────────────────────────────────────────────► declarative
Replicache        Zero/Convex        Electric/lunora      PowerSync/Nizhal       Linear
hand-written      queries (IVM)      shapes (where)       buckets (sync rules)   schema-coupled
client view                          + read-permission    row→buckets;           load strategies
                                     fused (lunora)       user→buckets           + partial indexes
```

Two engines fuse the synced slice with the **auth boundary** explicitly, and it's worth comparing to Nizhal:
- **Zero:** permissions by **AST rewrite** — `where' = AND(originalWhere, OR(allow-rules))`, recursing into correlated subqueries (closes the existence-oracle), default-deny.
- **lunora:** one `WHERE` compiler serves query + RLS + shape, so a shape predicate *is* a read-permission (`composeShapeReadWhere`), fail-closed under `.rls("required")`.
- **Nizhal:** the **no-leak lint** (`assertSyncRulesNoLeak`) guarantees every synced row is bucket-scoped (rejects raw SQL, zero-scope queries) + **server-side write authorization** (`rowMatchesScope` → 403). This is a *structural* guarantee (lint + scope check) rather than a *composed-predicate* one.

> Review question this raises: Nizhal proves "every row is bucket-scoped" at lint time and re-checks writes at runtime — but does it **recurse into `related` sub-queries** the way Zero recurses into correlated subqueries? An unscoped or over-scoped `related` query is the classic partial-sync auth leak (Arc's CVE-2024-45489 is the cautionary tale). This is a concrete thing to verify.

---

## 4. The IVM spectrum (how "live" the queries are)

```
none ──────────────────────────────────────────────────────────► full IVM
re-download   re-run sub      repull-on-hint    membership-diff    coarse rerun    full dataflow IVM
(Figma)       (Replicache)    (Nizhal)          (lunora)           (Convex)        (Zero)
```

- **Nizhal** has **no server IVM**: a write publishes `repull:${bucket}` and the client does an authoritative cursor pull; reactivity on the client is **TanStack DB's** job. This is the deliberate no-WAL consequence.
- **lunora** computes a **membership diff** (CDC op-slice × `selectShapeMemberIds` probe) — *not* full IVM, but more than a repull: it sends only the changed rows' membership delta as poke row-ops. **This is the single most borrowable idea for Nizhal** (see brief).
- **Zero** is full incremental dataflow (join/filter/exists/take operators) on both server and client.

> The axis matters because it sets a ceiling on *bandwidth efficiency*: a Nizhal repull re-reads everything `> cursor` in scope; a lunora poke sends only the membership delta; a Zero poke sends only the IVM-computed row delta. For small per-bucket working sets (Nizhal's target: a shop's ledger) the repull is fine; for large shared buckets it's the scaling edge.

---

## 5. The cross-cutting "hard problems" — as a review lens

Each is a question to ask of *any* sync engine, with the field's consensus answer and a pointer to how Nizhal handles it (verified in [inventory](./_notes/nizhal-inventory.md)).

| # | Hard problem (author) | Field consensus | Nizhal's answer (to verify in review) |
|---|---|---|---|
| 1 | **Partial sync + permissions are the same problem** (Zero) | fuse the synced slice with auth | no-leak lint + bucket-scope write check; **does `related` recurse?** |
| 2 | **RPC-vs-realtime race ⇒ you need a queue** (Artman) | ordered outbox + watermark | durable SQLite outbox + per-client `mutationID` sequence + HLC |
| 3 | **App knowledge must be baked in** (Zero) | couple engine to schema or accept it's hard | Nizhal couples per-app via sync-rules + merge policy (the "coupled output" bet) |
| 4 | **CRDT metadata growth** (Ink & Switch) | engineering-solved (Yjs columnar) | uses Yjs for `crdt` columns; **does it GC/compact CRDT byte history?** |
| 5 | **CRDTs say nothing about networking** | server provides transport | commit-chokepoint publish + reconnecting WS; fine |
| 6 | **Reparenting an eventually-consistent tree** (Figma) | parent-as-property + cycle reject | N/A unless apps model trees; **no tree-move primitive** (likely a gap if needed) |
| 7 | **Multiplayer undo is confusing** (Figma) | per-client undo buffer | not addressed (app concern); note as scope boundary |
| 8 | **Optimism is deceptively hard** (Instant) | queue + ordering + cascade-cancel dependents | ✅ `dependsOn` cascade-cancel + poison quarantine + local-write barrier |
| 9 | **Determinism vs side-effects** (Convex) | exile side-effects from the txn | ✅ durable **jobs** (SMS enqueued in-tx, sent out-of-band) — good pattern |
| 10 | **Demo-vs-production trap** (Electric) | smaller core, fewer magic features | no-WAL + any-Postgres is the "simpler core" bet; **operational weight low** |
| 11 | **Goldilocks bootstrap** (Convex/Linear) | paginate; priorities | ✅ paginated pull (`hasMore`), `cursorReset` re-bootstrap; **no bucket priorities** |
| 12 | **ID generation under replay** (Zero/Linear) | client-generated ids, never in mutator | ✅ `clientMutationId` + client-id→server-id reconciliation |

---

## 6. The union primitives catalog (tag = who has it; ✦ = Nizhal has it)

A consolidated list of every concrete sync-engine primitive surfaced across code + talks, so the review can check Nizhal against the *whole* field, not one competitor. (Full ~90-item version in [`_notes/youtube/SYNTHESIS.md`](./_notes/youtube/SYNTHESIS.md).)

**Bootstrapping / initial load**
- Paginated/cursored bootstrap ✦ (Nizhal `hasMore`/`limit`); line-delimited-JSON bootstrap (Linear); CDN-cacheable bootstrap requests (Linear, Electric); **bucket/data priorities** (PowerSync — ✗ Nizhal); lazy/partial/explicit per-model load strategies (Linear — ✗ Nizhal).

**Partial replication**
- Hand-written client view (Replicache); queries-as-spec (Zero, Convex); shapes (Electric, lunora); **buckets ✦** (PowerSync, Nizhal); parameterized/dynamic buckets ✦ (PowerSync, Nizhal membership); refcounted CVR de-dup across overlapping queries (Zero — ✗ Nizhal); **membership diff** (lunora — ✗ Nizhal, sends full repull).

**Permissions**
- AST rewrite + default-deny (Zero); `WHERE`-compiler-fused read permission (lunora); **no-leak lint ✦** + **server-side write-scope check ✦** (Nizhal); CEL row rules (Instant); `system:'permissions'` non-streamed subtree (Zero); recurse-into-subquery auth (Zero — **✗ verify in Nizhal**).

**Write path / conflict**
- Mutator-as-conflict-policy ✦ (Replicache, Zero, lunora, Nizhal); one-mutator-one-transaction ✦ (Nizhal); serializable OCC (Convex); per-column LWW (lunora, **Nizhal `lww`**); per-field HLC ✦ (Nizhal `field`); CRDT column ✦ (Nizhal `crdt`/Yjs); checkpoint-barrier "no client merge" (PowerSync); append-only movement ledger / balance=fold ✦ (Nizhal's domain pattern).

**Ordering / idempotency**
- Monotonic per-client mutationID + server watermark ✦ (Replicache, Zero, lunora, Nizhal); HLC clock ✦ (Nizhal); global monotonic `lastSyncId` (Linear); opaque cookie/cursor ✦ (Replicache, Nizhal `_nizhal_row_version_seq`); idempotency key claim ✦ (Nizhal `clientMutationId`).

**Offline outbox / resilience**
- Durable FIFO outbox ✦ (lunora, PowerSync, Nizhal); poison-message dead-letter ✦ (Nizhal); cascade-cancel dependent mutations ✦ (Nizhal `dependsOn`); per-item identity guard (lunora — **✗ verify Nizhal token-rotation handling**); at-least-once + idempotency = exactly-once ✦ (lunora, Nizhal).

**Realtime / transport**
- WS pokes (Zero, lunora, Figma); **hibernatable WS + auto-response ping** (lunora — ✗ Nizhal uses app-level heartbeat); stateless HTTP log (Electric); commit-chokepoint publish ✦ (Nizhal); **server-side IVM deltas** (Zero — ✗ Nizhal); membership-diff pokes (lunora — ✗ Nizhal).

**Eviction / lifecycle**
- Tombstones ✦; bucket-exit removal ✦; **access-revocation eviction ✦** (`removedBuckets`); TTL bucket eviction ✦; client-group GC (Replicache — ✗ Nizhal multi-tab story unverified).

**Schema / tooling**
- Client-store migrations ✦ (versioned, downgrade-guarded); contract emitter ✦ (`/nizhal/contract`); **typed client codegen** (`nizhal gen` — ✗ **not implemented**); **brownfield introspection** (`nizhal introspect` — ✗ **not implemented**); schema-evolution lenses (Ink&Switch Cambria — ✗ field-wide gap).

---

## 7. Where this leaves Nizhal (segue to the review brief)

Nizhal's position is **coherent and differentiated**: *buckets + real-SQLite client + three-mode merge + no-WAL any-Postgres*. It has, by code evidence, a **more complete offline-write resilience story than Zero** (durable outbox, dead-letter, cascade-cancel, revocation eviction) and a **richer convergence model than lunora** (three merge modes vs per-column LWW). Its deliberate sacrifices are **server-side IVM** (→ repull, not delta) and **the codegen/introspection tooling** (`gen`/`introspect` unimplemented).

The next document — [`nizhal-code-review-brief.md`](./nizhal-code-review-brief.md) — turns this into a prioritized review checklist: which **missed primitives** to investigate, which **claimed properties** to verify, and where the **landscape says the bodies are buried**.
