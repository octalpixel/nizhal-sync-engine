# RFC: Nizhal multi-tab ClientGroup coordinator

**Status:** Draft (planning) · **Slug:** `multitab-clientgroup` · **Author:** autonomous session

---

## 1. Problem & the "1" (end state)

**The "1":** A user with the same Nizhal app open in several browser tabs never loses a write and never
double-applies one, no matter which tab made the write or which tab is closed. A write made in tab B is
durable the instant it is accepted, and reaches the server even if tab B is closed a millisecond later —
flushed by whichever tab is currently elected leader.

This is the guarantee the skipped test asserts:
`repro-offline-loss-codex.test.ts` → *"keeps an offline follower-tab write durable until its elected
leader can flush it."* Delivering the "1" is what lets us **un-skip** it (and drop the `it.skip`).

**Prior art — Replicache ClientGroup** (`research/replicache-sync-engine.md` §6): a *ClientGroup* is shared
by all tabs with the same mutators; it stores per-client `mutationIDs` + `lastServerAckdMutationIDs` in a
**shared perdag (IndexedDB)**; each tab has a memdag cache; `persist()`/`refresh()` rebase a tab's local
work into/out of the shared store. Because pending work lives in ONE shared, coordinated store with
per-client sequence tracking, any live tab can push — or recover — another (dead) tab's pending mutations.

---

## 2. Current state (grounded)

| Concern | Today | Evidence |
|---|---|---|
| Leader election | `nodeLeaderElection()` — `isLeader: () => true`, no-op change events. Every instance is its own sole leader. | `packages/db-collection/src/mutators.ts:785`, default at `:283` |
| Web durable persistence (framework) | **Built + tested.** `waSqlitePersistence()` (wa-sqlite over OPFS) + `createSerializedWaSqliteDatabase` are public API; `local-first.test.ts` cold-restart durability passes through it. Real deps: `@journeyapps/wa-sqlite`, `@tanstack/browser-db-sqlite-persistence`. | `packages/db-collection/src/persistence/wa-sqlite.ts:215`, index `:86-99` |
| Web durable outbox (tabkeep app) | Not wired — `openTabkeepPersistence()` returns `undefined` → in-memory per tab. The framework capability just isn't plugged into the web app yet. | `apps/tabkeep-expo/src/persistence.ts:7` |
| Cross-tab coordination | None wired. | grep: only `nodeLeaderElection` referenced |
| Follower writes | **Not durably queued.** The executor persists a write only when `isOfflineEnabled = mode==='offline' && isLeader`; a non-leader's mutation runs as a plain, non-persisted optimistic transaction. | `@tanstack/offline-transactions` `OfflineExecutor.js:225,239-247` |
| Leader adoption of a peer's write | Storage is re-scanned only on **init** or a **leadership change** (`loadAndReplayTransactions`); `BroadcastChannelLeader` broadcasts *leadership*, not *writes*. | `OfflineExecutor.js:129,198,211`; `coordination/BroadcastChannelLeader.js` |

**This is correct for the shipping target** — React Native mobile is single-process, no tabs — and it is
why nothing is lost today: on web each tab is fully independent (its own in-memory queue, its own
always-leader), so there is no shared state to lose. The only cross-tab exposure is duplicate/racing
pushes, already neutralized server-side by the idempotent `clientMutationId` PK + the per-client
contiguous-sequence check.

---

## 3. The decisive finding (why this is bigger than "wire the primitives")

The dependency (`@tanstack/offline-transactions@1.0.37`) ships the primitives we'd want — `WebLocksLeader`,
`BroadcastChannelLeader`, `IndexedDBAdapter` — but its **durability model is leader-only**: a follower tab
does not persist its writes to the shared outbox at all (they are ephemeral optimistic transactions). So a
follower cannot "park a durable write for the leader to flush." There is also **no write-level cross-tab
signal** — even the leader only re-scans the shared queue on a leadership change, not when a peer enqueues.

Therefore the ClientGroup guarantee **cannot** be achieved by configuration alone. It needs one of the two
architectures in §5.

---

## 4. Requirements

- **R1 Durability:** an accepted write in ANY tab is in a shared durable store before the call returns.
- **R2 Single-flusher:** exactly one tab (the elected leader) pushes at a time — no duplicate pushes.
- **R3 Adoption:** the leader flushes ALL entries in the shared store, including peers' and closed tabs'.
- **R4 No-loss on transient failure:** a 5xx/network error during a flush retries; it is never dropped
  (this is the exact silent loss the skipped test found).
- **R5 Per-client sequence coherence:** one monotonic `mutationID` stream per logical client across tabs
  (a shared, durable high-water), so the server's contiguous-sequence check is satisfied.
- **R6 Failover:** if the leader tab dies mid-flush, a new leader adopts the shared store and continues.
- **R7 Regression-safe:** single-process (RN/Node) behavior is byte-for-byte unchanged.

---

## 5. Design options

### Option A — Shared-outbox coordination layer ABOVE the library *(recommended)*

Keep the library for the single-active-executor mechanics, but move durability + adoption into a Nizhal
`ClientGroup` that owns a shared IndexedDB store, and make **followers passive**:

- One shared IndexedDB outbox + meta store per (origin, clientGroup). All tabs read/write it directly for
  the durable record (R1), independent of who is leader.
- Real cross-tab election via `WebLocksLeader` (preferred; `BroadcastChannelLeader` fallback) — the tab
  holding the lock is the sole flusher (R2).
- The leader runs the existing offline executor over the shared store; **followers do not flush**. A
  `BroadcastChannel('nizhal:<group>')` "write enqueued" ping wakes the leader to re-scan (R3) — closing the
  library's leadership-only-reload gap.
- `mutationID` high-water lives in the shared meta store, allocated under the Web Locks mutex (R5).
- Leader death releases the Web Lock → a follower acquires it → adopts the shared store (R6).
- **Pro:** no dependency fork; uses the library as-is for what it's good at; the shared store is ours to
  make correct (incl. R4). **Con:** we own the shared-store + signal glue.

### Option B — Patch/fork the library

Make `createOfflineTransaction` persist + `BroadcastChannel`-broadcast follower writes to the leader.
- **Pro:** conceptually clean (one code path). **Con:** forking a published dep is a maintenance tax and
  couples us to its internals; upstream may diverge. **Rejected** unless Option A proves infeasible.

**Recommendation: Option A.** It confines the hard part (correctness of the shared store + adoption + R4
no-loss) to Nizhal code we control and test, and treats the dependency as a leader-election + executor
engine only.

---

## 6. Prerequisite (hard dependency) — mostly already done

**Durable web persistence exists in the framework** (`waSqlitePersistence`, wa-sqlite over OPFS, tested).
The prerequisite is therefore a **wiring task, not a build**: plug `waSqlitePersistence` into the web
`openTabkeepPersistence()` (currently returns `undefined`) under Metro-web, replacing the in-memory outbox.
Because wa-sqlite's OPFS database is a per-origin file, two tabs opening the same DB share one durable
store — so R1 (shared durable outbox) can ride wa-sqlite rather than a new IndexedDB adapter. The remaining
*new* work is the cross-tab coordination in §5 Option A (election + single-flusher + write signal + failover
+ no-loss), plus safe concurrent-access handling of the shared wa-sqlite DB under the election mutex.

---

## 7. Incremental task breakdown (each independently verifiable)

1. **Wire durable web persistence** — plug the existing `waSqlitePersistence` (wa-sqlite/OPFS) into web
   `openTabkeepPersistence` under Metro-web (small wiring task; the impl already exists + is tested).
   *Verify:* a web write survives a reload (headless). Standalone value; unblocks the rest.
2. **Shared-store contract + Node harness** — define the `NizhalClientGroup` shared-store interface (outbox
   + meta KV + a `NizhalCoordinator` election/signal port) with an **in-memory + fake-broadcast** impl, so
   the whole coordinator is testable in Node without a browser. *Verify:* new Node tests drive two logical
   tabs over one shared store.
3. **Passive-follower routing + leader single-flush** — followers persist to the shared store but never
   flush; leader flushes all entries; a write-enqueued signal wakes the leader (R2, R3). *Verify:* rebuild
   the skipped test's scenario on the shared-store harness → both writes reach the server.
4. **No-loss on transient failure (R4)** — a 5xx during leader adoption/flush retries, never drops. *Verify:*
   the exact skipped-test fault (`follower-lost` 503 once) converges; a permanent 503 parks in dead-letter,
   never vanishes.
5. **Shared per-client mutationID under the mutex (R5)** + **failover (R6)** — allocate the id high-water in
   the shared meta under the election mutex; leader death hands off. *Verify:* leader "dies" mid-flush → a
   follower adopts and completes; no gap/dup at the server.
6. **Browser election adapter** — `WebLocksLeader` (+ `BroadcastChannel` signal) as the production
   `NizhalCoordinator`; `nodeLeaderElection` stays the RN/Node default (R7). *Verify:* 2-tab headless web
   test (Playwright) — write in tab B, close tab B, tab A flushes it.
7. **Un-skip + convert** — replace `it.skip` with the real multi-tab scenario on the shared-store harness;
   graduate a headless 2-tab flow. *Verify:* `it.skip` removed; suite green.

---

## 8. Acceptance

- The skipped `it.skip("keeps an offline follower-tab write durable until its elected leader can flush it")`
  is **un-skipped and passing** on the real coordinator (task 3–4), plus a headless 2-tab web flow (task 6).
- R1–R7 each have a green test.
- RN/Node single-process paths unchanged (existing suites still green).

---

## 9. Risks, cost, and sequencing (founder-altitude)

- **Cost:** substantial — a new coordination subsystem (shared store + election + signal + failover), ~7
  verifiable chunks, plus a headless-browser test rig. Days, not hours.
- **Opportunity cost (the honest part):** the release target is **tabkeep-expo (mobile, single-process)**,
  where this feature does **nothing** — RN has no tabs. This serves multi-tab **web**, which is currently a
  demo (in-memory persistence). Per build-for-one, spending the next block here starves the mobile-release
  path. Recommended sequence: ship the mobile reference first; do **task 1 (durable web outbox)** next
  because it is a standalone web win and the unavoidable prerequisite; schedule tasks 2–7 (the coordinator)
  as a deliberate follow-up once multi-tab web is actually a target.
- **Decision needed (genuine fork, per autonomous-stand's "ask when a product fork has no default"):**
  (a) proceed now with Option A tasks 1→7; (b) do only task 1 (durable web outbox) now and defer the
  coordinator; or (c) defer the whole thing behind the mobile release. The `it.skip` stands as the honest
  tracking marker until then.

---

## 10. Non-goals

- CRDT/rebase of conflicting optimistic state across tabs (Replicache's memdag rebase) — Nizhal's per-table
  merge policy already resolves server-side; cross-tab optimistic divergence is out of scope here.
- Changing the server protocol — the server's idempotent `clientMutationId` + contiguous-sequence check are
  already sufficient; this is purely client-side coordination.
