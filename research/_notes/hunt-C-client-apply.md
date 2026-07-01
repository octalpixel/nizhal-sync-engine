# Hunt C — Client pull-apply + optimistic-reconciliation (data-loss / divergence)

Scope: `packages/db-collection/src/{sync,local-write-barrier,client,mutators,collection,crdt}.ts`.
Method: read every apply/ack/evict path; ran `local-first.test.ts` to ground the field-merge
semantics empirically (see C-REF-1). Read-only.

Mental model established first (load-bearing for every finding below):
- Local-first optimistic write lifecycle: `mutate[name]()` applies optimistic rows to the
  collection, then `localCommits.register` + `echo.registerLocalWrite(txId, rows)` register a
  **LocalWriteBarrier** entry in phase `pending` (mutators.ts:341-343), then `offlineTx.commit()`
  runs the executor → mutationFn `attemptPush` (server push) → `reconcileLocalWrite(txId)`
  (mutators.ts:242-243).
- The barrier defers authoritative pulls for any `(collectionId,key)` that has a `pending` write
  (sync.ts `stageUpsert`/`stageDelete` :209-242 call `echo.isLocalWriteBlocked`).
- `reconcileLocalWrite` (mutators.ts:421-440) calls `acknowledgeLocalWrite` (client.ts:511-533):
  `beginAcknowledgement` flips phase `pending → acknowledging` (barrier STOPS blocking that row,
  local-write-barrier.ts:38 skips non-pending), runs a **fresh ack pull** per collection, then
  `completeAcknowledgement` deletes the entry. On any throw → `failAcknowledgement` resets to
  `pending`. `reconcileLocalWrite` is **one-shot**; nothing ever re-runs it.

Empirically grounded note (C-REF-1): in `test:pull-as-merge-ack-barrier` an `updateNote({body})`
keeps `tag:null` through an interleaved pull that carried `tag:"server-tag"`. So the offline
executor records the optimistic update with `changedFields` ≈ **all** columns, and the merge in
`stageUpsert` (sync.ts:228-233) overlays every local field → effectively **whole-row-local-wins**
while pending, not a true per-field merge. Consequence: Mode-1 "same field" and "multi-field" are
not divergence sources (local row wins wholesale until ack); the real risk is the `acknowledging`
window and ack failure. The per-field merge code at sync.ts:229-232 is largely dead for updates.

---

## CONFIRMED

### C1 — A single failed ack pull permanently strands the barrier → row frozen + whole-collection cursor freeze (DIVERGENCE)
**Files:** client.ts:511-533, local-write-barrier.ts:36-44 / :65-72, mutators.ts:421-440,
sync.ts:100-124 / :160-163.

Sequence:
1. Optimistic local-first write to row R (barrier entry `pending`).
2. `attemptPush` **succeeds** (server now durably has the write).
3. `reconcileLocalWrite` → `acknowledgeLocalWrite`: `beginAcknowledgement` (phase→acknowledging),
   then `puller.pull()` (the post-push reconcile pull).
4. That reconcile pull **fails** — network blips right after a successful push (the common mobile
   case: push completes, connection drops). `runPull` catches and returns `false`
   (sync.ts:133-136); `acknowledgeLocalWrite` throws "acknowledgement pull failed" (client.ts:524).
5. `catch` → `failAcknowledgement(txId)` resets phase to **`pending`** (client.ts:530). The thrown
   error is swallowed by `ack.catch(...)` in `reconcileLocalWrite` (mutators.ts:424); the bounded
   race returns and the executor transaction completes normally.

Result: the barrier entry for R stays `pending` **for the entire process lifetime** — there is no
retry of `reconcileLocalWrite` (one-shot, mutators.ts:242/255) and nothing else clears the entry.
Two compounding harms, both divergence:
- **Row R frozen:** every subsequent authoritative pull defers R (`stageUpsert`/`stageDelete`
  see `isLocalWriteBlocked=true`, sync.ts:210-211/224). Server-side updates to R **and a server
  delete/tombstone of R are ignored forever** this session. For a ledger/chat row this is silent
  divergence (e.g. another participant edits/deletes the message; this client never sees it).
- **Whole-collection cursor freeze:** a deferred row makes `applyLocalFirstPullResult` return
  `blocked=true`, which skips the cursor-advance block (sync.ts:100-104, guarded by `!blocked`)
  and stops paging (sync.ts:121-123). Every later pull re-pulls from the same stale cursor and
  re-defers R → cursor **never advances/persists** for that sync rule for the rest of the session,
  plus endless `reportError("conflict")` spam. (New non-R rows still land because they re-apply
  each full re-pull, so this is staleness/divergence on R, not a clean drop of others.)

Self-heals only on restart (barrier bootstraps from `executor.peekOutbox()`, client.ts:296 /
local-write-barrier.ts:19-25, and the pushed tx is gone from the outbox), so it is a within-session
divergence. The optimistic value survives for the writer, but the client and server diverge until
relaunch.

**Test gap:** `offline-batch-harness` T9 (offline-batch-harness.test.ts:268-289) injects a **hung**
ack pull (never settles → phase stays `acknowledging`, block OFF — see C2) and only asserts the
executor batch drains. No test injects an ack pull that **fails/returns false** (→ phase `pending`
forever), and none asserts that a later authoritative update/delete to the just-written row still
applies after the ack. `local-first.test.ts` only exercises the happy path where the push resolves
and the ack pull succeeds.

### C2 — Hung/slow ack pull leaves phase `acknowledging` → barrier protection silently OFF
**Files:** client.ts:513 (`beginAcknowledgement` before the pull), local-write-barrier.ts:38,
mutators.ts:425-439 (timeout race), sync.ts:160-163.

`beginAcknowledgement` flips to `acknowledging` **before** the ack pull runs, and
`isBlocked`/`pendingFields` ignore non-`pending` entries (local-write-barrier.ts:38,48). If the ack
pull hangs (T9's exact fault) the bounded race in `reconcileLocalWrite` times out at
`NIZHAL_ACK_TIMEOUT_MS` (mutators.ts:427) and the transaction completes, but the ack promise is
left running and the entry sits in `acknowledging` **indefinitely** with the block disabled. From
that point any concurrent/interval/`repull:` pull may overwrite the still-unconfirmed optimistic row
with whatever server snapshot it carries. Usually benign (push succeeded → server has the value),
but it removes the safety net during an unbounded window. T9 asserts only that the batch drains —
it never asserts the optimistic value is protected after the timeout, so this is uncovered.

---

## PLAUSIBLE

### P1 — Stale in-flight pull clobbers the optimistic row inside the `acknowledging` window
**Files:** sync.ts:160-163 (`acknowledgementPull` = `while (activePull) await activePull; startPull()`),
sync.ts:222-242, client.ts:513.

`acknowledgementPull` first **awaits any pull already in flight** before starting the fresh one. By
that point `beginAcknowledgement` has already lifted the block (phase `acknowledging`). If an
interval/`repull:` pull P1 started before the push and its **server snapshot predates the push**,
P1's result is applied with the block OFF: if a concurrent writer changed row R since the cursor,
P1 carries R at a version lacking our just-pushed field and `stageUpsert` overwrites the optimistic
value (sync.ts:240-241). The subsequent fresh ack pull normally re-fetches R-with-our-write and
heals it — but if the ack pull then fails (C1) or the cursor has already advanced past our version,
the overwrite is permanent. Needs a concurrent same-row writer + precise interleave; not
reproduced. No test drives a pull in flight at the moment `beginAcknowledgement` runs.

### P2 — Ack against a not-yet-preloaded / cleaned-up collection strands the barrier (same end-state as C1)
**Files:** client.ts:517-523, sync.ts:172/189.

`acknowledgeLocalWrite` throws "acknowledgement pull unavailable" when `pullers.get(collectionId)`
is missing — i.e. the collection's `sync()` has not registered a puller yet (not preloaded) or was
torn down (`unregisterPuller`, sync.ts:189) between the write and the ack. That throw → `catch` →
`failAcknowledgement` → entry stuck `pending` forever (the C1 frozen-row + cursor-freeze state).
Mutating before `collection.preload()` is plausible app behaviour; the error string even warns
"preload it before mutating". Untested.

### P3 — Multi-collection ack is non-atomic; partial failure strands the whole transaction
**Files:** client.ts:516-528.

For a write spanning collections A and B, `beginAcknowledgement` lifts blocks for both, then the
loop pulls A then B. If pull A succeeds (authoritative A rows applied with block off) but pull B
throws, `failAcknowledgement` re-blocks **both** and never retries → A may have been reconciled
mid-flight while B is frozen per C1, and the transaction's barrier entry is stranded. Cross-table
mutators (ledger entry + chat notification) are the realistic trigger. Untested.

---

## REFUTED / LOW

- **Mode 1 (same-field / multi-field clobber):** covered and correct. `test:pull-as-merge-ack-barrier`
  shows the pending row wins wholesale (C-REF-1); same-field local value is preserved until ack.
  Not a loss path. The per-field overlay (sync.ts:229-232) is effectively dead for updates but
  harmless.
- **Mode 4 (server-authoritative discards optimistic before push):** `applyPullResult`
  (sync.ts:379-429) writes via the `begin/write/commit` *synced* channel; TanStack DB layers the
  un-pushed optimistic mutation on top of synced state until the offline tx completes, so a sync
  write does not drop it. No barrier is used (registerLocalWrite filters to local-first,
  client.ts:497-500) and none is needed here. Did not find a concrete loss; would need context7 on
  `acceptMutations`/optimistic-state to fully close, but no evidence of loss in client code.
- **Echo loop (Mode 6):** pulled rows are applied through `acceptMutations` (sync.ts:277-312), which
  marks them synced rather than re-enqueuing as optimistic writes — no echo.
- **Local-first TTL state in-memory only:** `evictTtlBucketsLocalFirst` keeps `bucketScopeState` in
  a closure (sync.ts:329, not persisted to metadata unlike the server-auth variant). On restart the
  "since" timestamps reset, which only **delays** eviction (safe direction). Optimistic rows are
  guarded from eviction (sync.ts:363). Not a loss. (Overlapping-bucket case excluded per brief.)
