# Nizhal — Build for One (the product thesis, the primitive, and where the capital goes)

> Founder/investor-altitude synthesis of the whole engagement (landscape study, code-understanding, runtime-confirmed bugs, fixes, hacks audit). Method: [build-for-one]. The job here is not to list tasks — it's to name the **one thing Nizhal is becoming**, check that every increment points at it, and allocate scarce capital by opportunity cost.
> Sources woven in: [`nizhal-bug-hunt-findings.md`](./nizhal-bug-hunt-findings.md) · [`nizhal-fixes.md`](./nizhal-fixes.md) · [`sync-engine-landscape.md`](./sync-engine-landscape.md) · [`_notes/watermelondb.md`](./_notes/watermelondb.md) · [`_notes/hacks-audit.md`](./_notes/hacks-audit.md) · [`nizhal-code-review-brief.md`](./nizhal-code-review-brief.md).

---

## 1. The "1" — name the end state

**Nizhal is the offline-first sync engine you self-host on *any* Postgres — `add the package`, declare your tables + buckets + mutators, and ship an app where the user's data is instant, offline-durable, live, and *never silently goes missing* — with no SaaS, no logical-replication/WAL, and no hand-rolled sync engine.** The kernel owns the hard, reusable 80% (on-device SQLite store, durable outbox, convergence, realtime, change-tracking — **and the recurring primitives like server-authoritative per-bucket sequences and partial-sync-on-membership-change**). You write only the 20% that is yours: your schema, your synced subset, your mutators, your invariants. Generality lives at build time; the **output is coupled** per app — the property Linear and Figma say makes sync feel good.

**The forcing function (PR-FAQ).** The launch sentence: *"Local-first, on infra you own — point Nizhal at your Postgres, define your data, and get Linear-grade instant UX without becoming a distributed-systems team."* The skeptic's questions are not hypothetical — **they are exactly the bugs this engagement found**, which is the tell that they sit on the product's critical path:
- *"I join a shared channel — do I see its history?"* → today **no** (G1). The end state: **yes, always.**
- *"The network blips right after my write — is it lost? Does my teammate see it live?"* → today the write survives but the **live update is silently dropped** (B1). End state: **delivered, at-least-once.**
- *"Two of us are offline and both create invoice #1 — what happens?"* → today **two invoice #1s** (number-collision). End state: **the kernel assigns it; impossible to collide.**
- *"I lose access to one of two shared projects — does the other vanish?"* → today it can (F1). End state: **only what you truly lost.**

If the answer to any of those is "you, the app developer, must handle that," **the thesis has leaked**: the kernel didn't own the 80% it promised to. **The "1" is a kernel whose partial-sync boundary never loses data.** That — not the merge modes, not the CLI, not the generator — is Rome.

---

## 2. The core primitive (and the one it's missing)

**Have:** *one business operation = one mutator = one server transaction* over **bucket-scoped** rows (no-leak-linted), converging via a **per-table merge policy** (`lww` / per-field-HLC / Yjs-CRDT) with an **HLC** tiebreak, over **append-only movement ledgers** where `balance = fold(entries)` so the dominant write is a conflict-free insert. This is sound and, per the audit, **cleanly implemented** (near-zero debt).

**Missing (the number-collision exposed it):** **server-authoritative, per-bucket monotonic assignment.** A human-facing sequence per tenant — invoice #, message ordinal, issue # — is a *recurring* need across every target domain, and computing it client-side offline collides. The right move is not "tell every app to solve it" — it is to **make `ctx.nextInBucket(...)` a kernel primitive**, because *that recurring, hard-to-get-right need is precisely the 80% the kernel exists to own.* Adding it is the most thesis-defining single move available.

---

## 3. All roads lead to Rome — the coherent increment sequence

Every fix below points at the *same* end state ("the partial-sync boundary never loses data, on any Postgres"). They are coordinated, not a pile of locally-reasonable patches:

1. **G1 — per-bucket cursor backfill.** Finish the `last_seen_cursor` primitive the schema already half-built. *Most common-path data loss (every join/grant).* → Rome: partial sync that doesn't lose rows.
2. **The server-authoritative sequence primitive** (`ctx.nextInBucket`). Fixes the number-collision *and* adds the missing kernel capability. → Rome: kernel owns the hard 80%.
3. **B1 — publish isolation + at-least-once delivery.** A committed write must never fail on a post-commit poke; a dropped poke must self-heal. → Rome: live sync is a kernel guarantee.
4. **F1 — row-level eviction** (mirror the tombstone visibility guard). → Rome: you lose only what you truly lost.
5. **Chattiness rework** — `nextval` instead of the singleton `FOR UPDATE`; batch cascade inserts; collapse the N+1 pull; fold the bookkeeping. → Rome: the substrate compounds — every app gets faster and more concurrent for free.

**The incoherent moves to refuse (they build *away* from Rome):**
- **Building the generator/toolkit first.** The README already names this as the *Amplify-DataStore mistake*; "build by extraction, not greenfield." Ship one bulletproof coupled engine, *then* extract. Building the emitter before the engine is provably loss-free is direction-violation.
- **Adding merge-mode/config surface "for flexibility."** No current consumer needs a fourth merge mode or a config flag; that's capability over-engineering (YAGNI) that starves the data-loss work.
- **`nizhal gen`/`introspect` right now.** Real decoupling tooling, but no consumer is blocked on it yet; capitalize it when a real brownfield adopter needs the typed client — not before.

---

## 4. 0 → 1 — the genuinely new thing (the whole landscape, incl. WatermelonDB)

The landscape splits on **where authority lives** and **what you must run**. Nizhal occupies a cell **no one else does**:

| | Needs WAL / logical-repl | Needs a hosted SaaS / special DB | Real on-device SQLite | Server-side partial-sync + auth | Realtime | Self-host any Postgres |
|---|---|---|---|---|---|---|
| **Zero** | ✅ (Postgres→SQLite replica) | runs heavy `zero-cache` | ✅ | ✅ (queries + AST-rewrite perms) | ✅ IVM | ⚠️ heavy |
| **Electric** | ✅ logical-repl | Elixir service | — (BYO) | shapes (read-only) | HTTP log | ⚠️ |
| **PowerSync** | ✅ WAL | hosted/self-host service | ✅ | buckets | checkpoints | ⚠️ |
| **lunora** | — | **Cloudflare DO + D1** | ✗ (in-memory) | shapes (DO) | ✅ pokes | ✗ (CF only) |
| **Convex / InstantDB** | (Instant tails WAL) | **hosted** | ✗ / triple-store | queries / triples | ✅ | ✗ |
| **Replicache** | — | BYO server (you write sync) | ✗ (IDB KV) | hand-rolled | poke | ✅ but you build it |
| **WatermelonDB** | — | BYO server (you write 2 fns) | ✅ (native) / Loki (web) | **none** (filter in `pullChanges`) | ✗ (you poll) | ✅ but no server primitives |
| **Nizhal** | **✗ (no WAL)** | **✗ (any Postgres, self-host)** | **✅** | **✅ buckets + write-auth** | **✅ commit-chokepoint hint** | **✅** |

**The 0→1 reading:** **WatermelonDB proves the demand** — real-SQLite-on-device + a dead-simple BYO-server protocol + column-LWW is enough to be widely loved in production — but it stops at the client and hands you *everything* server-side (no buckets, no auth, no realtime, no sequences). **Replicache proves the protocol model** but you hand-write the sync. **Zero/Electric/PowerSync deliver the server smarts but demand WAL/logical-replication or a special runtime.** **Nizhal is the only one that gives you the server smarts (buckets, write-auth, realtime, HLC, 3 merge modes, movement-ledger) *without WAL*, on *any* Postgres, with a *real* on-device SQLite store and *coupled* output.** That combination is the genuinely-new, last-mover position: *be the last sync engine a self-hosting-Postgres team ever needs.*

**The honest 0→1 risk (the graveyard):** Realm Device Sync (EOL 2025-09-30), Amplify DataStore (dropped in Gen 2). They died from "magic that doesn't survive production" (Electric's own post-mortem: the features that make the demo magic prevent it from being bulletproof). Nizhal's defense is the no-WAL/own-the-write-path/exportable-store discipline — *and shipping a partial-sync boundary that is provably loss-free before generalizing.* The bugs found here are not embarrassments; they are **the exact gate between "magic demo" and "bulletproof," and closing them is the moat.**

**Steal-list to compress the path (from the analogs):** WatermelonDB's **`_changed` flat dirty-column tracker** (a cheaper tier between `lww` and `field`-HLC) and **Turbo bulk-import** (fast first-bootstrap — directly relevant to G1/G2's "join a big bucket"); lunora's **membership-diff poke** (incremental deltas *without* WAL — the one new realtime primitive worth building); Zero's **AST-rewrite read permissions recursing into subqueries** (harden `related`); Replicache/Linear's **server-reconciles-the-derived-value** (the rebase that makes the number-assignment primitive flicker-free).

---

## 5. Allocate like an investor — capitalize vs refuse

**The strategic asset the audit surfaced:** the engine is **unusually clean** — zero `@ts-ignore`/`eslint-disable`/`--no-verify`, 1 HIGH / 9 MED / 3 LOW, most marker-hits false positives. *Low debt is runway.* It means capital can go to the **end state**, not to a debt tax. Protect that — don't accrete now.

**Capitalize (compounds toward Rome):**
- **The data-loss boundary** (G1 → sequence-primitive → B1 → F1). This is not "bug fixing" — it *is* the product. Every dollar here buys the one property the whole thesis rests on.
- **The chattiness rework** (`nextval`, batching, N+1 collapse). Compounds across *every* app on the kernel; turns "fine in-region" into "robust anywhere."
- **Observability on the silent paths** (audit H1: the CRDT-merge `undefined`-on-exhaustion drop — `index.ts:1110` — must log/metric, not vanish; same for any "return undefined" write path). Cheap; removes the *shape* that hides future data-loss.

**Pay down (small, but they undermine the thesis's own promises):**
- **`as unknown as SyncRules` in 10 files** (audit MED) — the kernel advertises a *typed, no-leak-linted* sync-rules API, but the call site casts the type away on the **security-critical** surface. Fix the builder's return type so users get real type-safety without the cast. (A thesis promise — "typed" — is currently false at the boundary.)
- **The `legacy` outbox mutationID fallback** (`mutators.ts:285`) and CLI advertising unimplemented `gen`/`introspect` — compat residue / false advertising. Delete or finish (`zero-tech-debt`): the end-state shape has neither.

**Refuse (opportunity cost — these starve the great path to feed a good one):**
- New merge modes, config flags, or adapters with no current consumer.
- The generator/toolkit extraction *before* the coupled engine is loss-free.
- `gen`/`introspect`, presence-v2-on-Cloudflare, bucket priorities — real, but not on the critical path to "data never goes missing." Schedule them *after* Rome is reached, when a consumer pulls them.

---

## 6. Definition of done for the "1", and the lean plan

**Done = a self-hosting dev points Nizhal at any Postgres, and across join, grant, revoke, offline-by-two, network-blip-after-push, and reconnect, _no row is ever silently missing or duplicated_ — proven by a fitness suite that runs those exact journeys (the `bug-repro.ts` / `relgraph-neon.ts` harnesses, now red on G1/B1/number-collision, all green).**

Lean increments, in opportunity-cost order, each shipped behind a failing-first fitness test:
1. **G1** per-bucket-cursor backfill — *(turns the most common data loss off).*
2. **`ctx.nextInBucket`** server-authoritative sequence — *(fills the missing kernel primitive; kills the collision).*
3. **B1** publish isolation + safety-pull — *(makes live sync a guarantee).*
4. **F1** row-level eviction — *(stop over-eviction).*
5. **Chattiness rework** — *(the compounding scale investment).*
6. **Then** harden + tooling: observability on silent paths, the `SyncRules` type fix, delete the `legacy` fallback; *after* that, capitalize `gen`/membership-diff-poke/priorities as consumers pull them.

**The one-line strategy:** *spend everything on making the partial-sync boundary provably loss-free on any Postgres — because that, not the feature surface, is the entire product — and extract the toolkit only once it is.*
