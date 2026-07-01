# Hunt A — Client offline write-path audit (outbox / mutators / mutation-id)

Scope: `packages/db-collection/src/{mutators,mutation-id,push-errors,client,sync-target}.ts`,
`persistence/*`, and `@tanstack/offline-transactions@1.0.37` semantics (read from `node_modules`).
Server contract cross-checked in `packages/server/src/{index,adapters/storage}.ts`.

Method note: the executor (`KeyScheduler.js`) is **strictly FIFO, single-flight** (`isRunning` flag,
`getNext()` returns `pendingTransactions[0]` by `createdAt`, only when idle). `idempotencyKey` is
**persisted** in the serialized outbox row (`TransactionSerializer.serialize` spreads the tx) and
reused on replay; nizhal sets `clientMutationId = idempotencyKey` (`mutators.ts:459`). The server
dedups by `clientMutationId` via `claimMutation` + `isApplied` (`server/index.ts:671,676`). These
three facts kill most naive double-apply / reorder hypotheses (see REFUTED).

---

## CONFIRMED

### C1 — `dependsOn` cascade-cancel is non-functional → dependent ledger op applies without its parked dependency (wrong balance)

**Flaw:** `mutators.ts:219` `if (dependsOn && poison.isPoisoned(dependsOn))`. `poison.isPoisoned`
tests `poisonedKeys`, which **only ever contains `idempotencyKey` values** (`mutators.ts:150`
`this.poisonedKeys.add(idempotencyKey)`). But `dependsOn` is a **domain key** produced by
`def.dependsOn(parsedArgs)` (`mutators.ts:312`), while `idempotencyKey` is an opaque random UUID
minted inside `OfflineTransaction` (`api/OfflineTransaction.js`: `this.idempotencyKey = options.idempotencyKey ?? safeRandomUUID()`)
and nizhal's `mutate()` never passes `options.idempotencyKey` (`mutators.ts:315-321`). The two live
in disjoint namespaces, so `isPoisoned(dependsOn)` is **effectively always false**.

**Server has no backstop:** `dependsOn` is declared (`kernel/src/types.ts:149`) and forwarded
(`mutators.ts:461`) but **never read** anywhere in `packages/server/src` (grep: zero hits). Ordering
is enforced only by client FIFO, and FIFO does not help once the dependency leaves the queue head by
being **parked** (terminal error → removed from outbox, `mutators.ts:254-256`).

**Scenario (credit → payment):**
1. `credit` (clientMutationId=Kc) created, then `payment` (`dependsOn` = credit's row id) created.
2. `credit` reaches push, server returns a terminal status (e.g. 422 burn / 403) → parked to
   dead-letter, removed from outbox.
3. `payment` becomes queue head, runs mutationFn. `isPoisoned(dependsOn=rowId)` → **false** (rowId ≠ Kc).
   It is pushed and applied server-side.
4. Ledger now reflects the payment but not the credit → **wrong balance / overdraft**. The very
   isolation the feature exists to provide does not happen.

**Latent inverse (silent loss):** if anyone ever does wire `idempotencyKey` to a domain key so the
check matches, the branch `return`s as "success" → executor clears the tx from the outbox
(`TransactionExecutor.executeTransaction` → `outbox.remove`), but the row was **already durably
persisted locally at enqueue** (`localCommitStorage.set` fires on the `tx:` write inside
`outbox.add`, `mutators.ts:746-759`), and is **not** added to dead-letter and **not** reconciled.
Result: a durable, locally-visible, server-absent, unrecoverable phantom write (split-brain).

**Test gap:** `dependsOn` appears in tests only as a pass-through field in `sync-target.test.ts:47,69`.
No test wires `def.dependsOn` + a poisoned dependency and asserts the dependent is cancelled (or that
its row never reaches the server). `offline-batch-harness` term-2 (`:169`) checks non-vanishing of an
independent write, not dependency isolation. **Uncovered.**

---

## PLAUSIBLE

### P1 — Phantom `LocalWriteBarrier` entries on every early-return path (no `reconcileLocalWrite`)
`mutators.ts` cascade-cancel (`:219`) and already-poisoned (`:226`) both `return` **without**
`reconcileLocalWrite(transaction.id)` (contrast the park path `:255` and success path `:243`). The
barrier entry registered in `mutate()` (`:343`) stays `phase:"pending"` forever, so
`isLocalWriteBlocked` / `getPendingLocalFields` (`client.ts:503-509`, `local-write-barrier.ts:36-56`)
mask the server's value for those fields **permanently**. Optimistic row never reconciles to truth.
Test gap: barrier-leak on these branches is unasserted.

### P2 — Deterministically-terminal HTTP statuses classified retriable → outbox-wide stall (head-of-line)
`push-errors.ts:15` `TERMINAL_STATUSES` excludes **413** (server returns it for oversized bodies,
`index.ts:390`) and **all 5xx**. A single oversized ledger/chat mutation, or a write that
deterministically 500s (server bug), is classified `retriable` and retried forever by the
`DefaultRetryPolicy(Number.POSITIVE_INFINITY)`. Because the scheduler is strict FIFO and blocks on the
head (`KeyScheduler.getNext` returns undefined while head not ready), **every later write is wedged
behind the poison pill** and never flushes — effective data loss for the tail. Test gap: no
poison-pill-blocks-queue test (existing tests use transient faults that clear).

### P3 — Transient conditions parked as terminal (401/403/404) → silent-ish loss
`TERMINAL_STATUSES` includes 401/403/404. The HTTP target refreshes auth once on 401
(`sync-target.ts:106-112`); if that single refresh fails transiently (refresh endpoint 5xx, brief
network loss) the retried request still 401s → `push failed: 401` → terminal → **parked**. Same for a
404 during a blue/green deploy or a 403 from an edge WAF/rate-limiter. Parked writes leave the
optimistic row visible (masking server state, see P1) and recover only via **manual**
`retryDeadLetter`. For a ledger this is a write the user believes succeeded sitting silently parked.
Test gap: `push-errors.test.ts` checks classification in isolation, not the transient-refresh-fails →
park outcome.

### P4 — Crash in the window between optimistic apply and durable enqueue → silent loss of an "accepted" write
`mutate()` applies optimistically synchronously inside `offlineTx.mutate(cb)` (`mutators.ts:327`) then
fire-and-forgets `offlineTx.commit()` (`:346-351`, added to `pendingCommits` but the public
`mutate.*` returns `void` — the app **cannot await durability**). Durable persistence happens later in
`persistTransaction → outbox.add → storage.set("tx:")`. A crash in that window loses the write with no
durable trace, while the user already saw the row appear. Narrow window, but it contradicts the
"a lost message is unacceptable" bar because the API gives no hook to confirm durability. Inherent to
the optimistic design; flagged because the product claims demand it. Test gap: no crash-injection
between `mutate()` and `outbox.add`.

---

## REFUTED (investigated, dropped)

- **staleSequence → `reallocateFromServer` double-apply / infinite loop** (`mutators.ts:467`,
  `client.ts:333`): I initially flagged staleSequence (mapped to `accepted:false`) re-pushing at a
  higher `mutationID` as a double-credit or livelock. Refuted by the server contract: on
  `alreadyApplied` the server returns `acknowledged = isApplied(clientMutationId)` and puts the id in
  `applied[]` (`index.ts:671,461`), so a genuinely-applied write returns `accepted:true` → loop
  breaks (no loop). A *not-yet-applied* write at a stale slot reallocates to a fresh slot and
  `claimMutation(clientMutationId)` (`index.ts:676`) makes the single apply idempotent (no double).
  Because reallocation **preserves `clientMutationId`**, the server dedup never misses. Covered by
  `repro-offline-loss-deepseek.test.ts` V3b/V4a and B1 (response-lost-after-commit).

- **Restart re-emits a fresh idempotency key → double-apply with different key:** refuted —
  `idempotencyKey` is serialized into the outbox row and restored verbatim
  (`TransactionSerializer`), and `clientMutationId = idempotencyKey`. Same key across restart/replay/
  dead-letter-retry. (`mutation-id-continuity.test.ts` covers sequence continuity.)

- **Reordering of dependent ops:** refuted for a single executor — `KeyScheduler` is strict FIFO,
  single-flight, sorted by `createdAt`; `getNext` blocks on the head. Credit is always *attempted*
  before payment. (The integrity hole is C1's parked-dependency case, not reordering.)

- **mutationIdStorage memory fallback losing allocations on restart:** churns the sequence
  (extra outOfOrder→reallocate round-trips) but does not double-apply or lose, because
  `clientMutationId` dedup holds; `mutators.ts:190-196` warns about it.

---

## Top recommendation for follow-up
C1 is the real, shippable data-integrity bug and the only CONFIRMED one. Two independent defects
compound it: (a) client compares `dependsOn` (domain key) against the wrong key space
(`idempotencyKey` UUIDs), so cascade-cancel never fires; (b) the server ignores `dependsOn` entirely,
so there is no backstop. A repro should: enqueue credit+payment offline, force the credit terminal
(e.g. 422), bring online, and assert the payment is NOT on the server (today it is).
