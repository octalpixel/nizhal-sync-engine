# Hunt B — server mutation-apply + realtime publish (DATA-LOSS / DOUBLE-APPLY / MISSED-LIVE-UPDATE)

Scope: `packages/server/src/index.ts`, `adapters/storage.ts`, `adapters/realtime.ts`, `jobs.ts`.
Verdict legend: CONFIRMED = code-evident + no test covers it; PLAUSIBLE = real but needs a precondition; REFUTED = looked exploitable, isn't.

---

## CONFIRMED-1 — Publish throws after commit ⇒ retry never republishes ⇒ permanent missed live update (chat/ledger critical)

**Where:** `index.ts:386` push handler. `applyMutation` (its DB tx) commits inside the `try` at `index.ts:400-443`. The realtime publish loop is OUTSIDE that try/catch:
```
453  if (didApply) {
454-456  mutationBuckets = pushed.affectedBuckets ?? await affectedBuckets(...)
457    for (const bucket of mutationBuckets) {
458      await realtime.publish(bucket);   // <-- not guarded
459    }
460  }
461  if (acknowledged) applied.push(mutation.clientMutationId);
```
**Interleaving:** mutator tx commits → `realtime.publish(bucket)` throws (it is *designed* to throw on failure — see `cloudflare-realtime.test.ts:138` "a failed publish is never silent", and `inProcessRealtime.publish` does `Promise.all(... socket.send)` at `realtime.ts:196`, and the per-socket `send` wrapper at `index.ts:519-536` re-validates auth and can throw/reject). The throw escapes the loop → `app.onError` (`index.ts:219`) → 500. The row is committed, but `applied.push` (line 461) never runs.

The client retries the same push. Second pass of `applyMutation`: `claimMutation` returns false (row already in `_nizhal_mutations`) → `didApply = false` (`index.ts:677-684`); for a sequenced mutation `checkMutationSequence` returns `alreadyApplied` → `didApply = false` (`index.ts:665-673`). Either way the `if (didApply)` guard at `index.ts:453` is false → **publish is skipped forever**. Write is in the DB; other connected clients are never sent `repull:<bucket>` and won't see it until they reconnect/manually pull. For chat this is a message that lands but never appears live; for a ledger, a posted entry counterparties never get pinged on.

**Test gap:** `recordingRealtime` (`security-regression.test.ts:509`) and `inProcessRealtime` in tests never throw from `publish`. `cloudflare-realtime.test.ts:138` asserts the *adapter* rejects, but no test drives that rejection through the push handler to assert the committed-but-unpublished + retry-skips-republish consequence. Uncovered.

**Fix direction:** publish must be retried out-of-band/idempotently (e.g. derive repull buckets from the committed row_version / an outbox), not gated on `didApply` of the *current* request.

---

## CONFIRMED-2 — Job-driven writes to synced tables emit no realtime under the default adapter

**Where:** `jobs.ts` — `runDueJob`/`task.run` (`jobs.ts:141-164`) get a `JobTaskContext` with no realtime handle and never call `realtime.publish`. The only NOTIFY triggers are provisioned by `listenNotifyRealtime` (`realtime.ts:288-315`); the DEFAULT adapter `inProcessRealtime` (`index.ts:185-187`, `realtime.ts:77`) installs **no** DB triggers at all.
**Consequence:** any background job that mutates a synced table (scheduled interest/settlement posting on a ledger, async chat fan-out) commits with zero live notification under the default in-process realtime — connected clients only see it on the next manual pull or reconnect. Even under `listenNotifyRealtime`, if the job's connection has `echo.suppress_notify='on'` or `_nizhal_sync_control.suppress_notify=true` (`realtime.ts:303-305`) the trigger is also suppressed → silent.
**Test gap:** `sync-core.test.ts:442` exercises job execution + retry/dead-letter but never asserts realtime propagation of a job write. Uncovered.

---

## CONFIRMED-3 — `affectedBuckets` filters explicit buckets against POST-COMMIT actor membership ⇒ self-membership-changing writes drop the notification

**Where:** `affectedBuckets` (`index.ts:1244-1255`):
```
allowed = new Set(await actorBucketKeys(storage, actor, syncRules, tx))   // fresh read
explicit = explicitAffectedBuckets(result)
if (explicit.length>0) return explicit.filter(b => allowed.has(b))        // <-- drops non-member buckets
return Array.from(allowed)
```
When audit is OFF this runs **after commit, with no tx** (`index.ts:456`), so `actorBucketKeys` reflects state *after* the mutator ran. A mutator that removes the actor from a bucket (leave channel, transfer/close a shared ledger, revoke membership) and returns that bucket in `affectedBuckets` has it filtered out (no longer in `allowed`) → the remaining members of the bucket the actor just left are never sent `repull` → they keep showing the actor as present / miss the final state change.
**Test gap:** `security-regression.test.ts:209` only asserts the *negative* (a spoofed foreign bucket is filtered) — it never tests a legitimate own-bucket the actor exited. Uncovered.

---

## PLAUSIBLE-4 — Same `clientMutationId` reused for a NEW higher `mutationID` wedges the sequence / drops a write

**Where:** `applyMutation` order: `checkMutationSequence` (advances `last_mutation_id`, `storage.ts:222-239`) runs BEFORE `claimMutation` (`storage.ts:189-196`).
**Interleaving:** cmid `X` already claimed+applied at mutationID 5 (`_nizhal_mutations` has `X`, LMID=5). Client (buggy) reuses cmid `X` with mutationID 6. `checkMutationSequence`: 6 = 5+1 → `apply` → **advances LMID to 6**. Then `claimMutation(X)` → false (already claimed) → `didApply=false`, returns acknowledged. The body for "mutation 6" never runs, yet LMID is now 6. A later *legitimate* mutationID 6 (cmid `Y`) → `6 <= 6` → `alreadyApplied` → dropped → **lost write**.
**Precondition:** client reuses a `clientMutationId` across different `mutationID`s (contract violation, but server trusts client-supplied IDs and never checks that an `alreadyApplied`/claimed cmid matches the same mutationID).
**Test gap:** `sync-core.test.ts:620-644` tests cmid reuse only where the first use was *never claimed* (stale, returned `alreadyApplied`); it does not cover reuse after the cmid was successfully claimed. Uncovered.

---

## PLAUSIBLE-5 — Transient mutator error misclassified as deterministic ⇒ permanent burn ⇒ lost write

**Where:** `isDeterministicAppError` (`index.ts:764-778`) treats any non-`Error` throw, OR any `Error` lacking `code`/`severity`/`constraint_name`/`table`, as deterministic. On a sequenced mutation this triggers `burnSequencedMutation` (`index.ts:438-441`, `740-750`) which advances LMID and stores the error permanently; future retries of that cmid hit `alreadyApplied` → `appliedMutationError` → 422 forever (`index.ts:665-670`).
**Consequence:** a mutator that throws a plain `new Error("temporarily unavailable")` (external check, transient resource, generic timeout that isn't a pg error object) is permanently poisoned — the logical write is lost even though a retry would have succeeded.
**Precondition:** mutator throws a non-DB Error for a transient reason. `sync-core.test.ts:555` only burns an intentionally-deterministic poison; no test covers a transient-but-misclassified error. Uncovered.

---

## PLAUSIBLE-6 — Partial multi-bucket publish on cascade; remainder never delivered

**Where:** serial `for...await` publish loop `index.ts:457-459`. If a multi-table/multi-bucket mutator yields buckets `[b1,b2,b3]` and `publish(b1)` throws, `b2`/`b3` are never published (loop aborts), and per CONFIRMED-1 the retry sets `didApply=false` so none are republished. Subscribers of `b2`/`b3` miss the live update though the cascade committed atomically.
**Test gap:** no test publishes >1 bucket with a mid-loop failure. Uncovered.

---

## REFUTED

- **row_version skip/duplicate (`storage.ts:1049-1060`):** `_nizhal_next_row_version()` does `perform 1 ... for update` on the `_nizhal_sync_control` singleton, holding the row lock until COMMIT, so version-assignment order == commit order. No two committed rows share a version; rollback gaps are harmless to `_nizhal_row_version > cursor` scans (`storage.ts:664`), and `normalizePullCursor` (`storage.ts:475-488`) uses `last_value` (advanced even on rollback) as a safe high-watermark. A reader at cursor N can never miss a later-committing lower version. (Cost: global write serialization — throughput, not correctness.)
- **Burn crash window wedge:** `checkMutationSequence`'s LMID `update` and the mutator writes share ONE tx in `applyMutation` (`index.ts:657-728`); a deterministic failure rolls back both, so LMID reverts. A crash between rollback and `burnSequencedMutation` just leaves LMID=N-1, cmid unrecorded → client retry re-runs and re-burns. No skipped/wedged sequence.
- **Double-apply under concurrent identical cmid:** real path is serialized by the `_nizhal_mutations` PK (`storage.ts:1031`) with `ON CONFLICT DO NOTHING` (concurrent uncommitted insert blocks the second tx) and, for sequenced, the `FOR UPDATE` on `_nizhal_clients` (`storage.ts:229`). Mutator body runs once. (NB: `security-regression.test.ts:167` "only once under concurrent push" proves this with an in-memory `raceStorage` that models neither tx isolation nor PK blocking — it passes via JS single-threadedness, not real DB semantics; weak test but the real guard holds.)
- **Cascade partial commit:** all writes share one `storage.transaction` and every insert/update/delete row is scope-checked (`storage.ts:334-377`, `assertAuthorizedRows` iterates all rows) → all-or-nothing.

---

## Adjacent (out of this hunt's data-loss lane — flag for the auth auditor, UNVERIFIED)
`createAuthorizedMutatorTx.insert` (`storage.ts:342-350`) authorizes the *result rows* of `mutatorTx.insert(table).values(row)`. If the underlying Drizzle insert resolves without `.returning()` (empty array), `assertAuthorizedResult`→`assertAuthorizedRows` iterates `[]` and passes vacuously — i.e. insert row-scope authz could be a no-op. Not verified against Drizzle's actual return; needs a runtime check.
