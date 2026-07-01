# Nizhal — Documented Fixes for the Confirmed Findings

> For each runtime-confirmed bug ([`nizhal-bug-hunt-findings.md`](./nizhal-bug-hunt-findings.md)): root cause → **the fix** (concrete, `file:line`, end-state shape + minimal increment) → the test that proves it. Ordered by priority. Each fix is framed against the **product thesis** (the kernel owns the hard 80%; the dev writes tables/mutators) — a data-loss bug in the kernel is a thesis-level failure, because "don't lose my data" is the kernel's whole job.

Priority: **P0** = silent missing-data on a common path · **P1** = data-loss/divergence on a plausible path · **PERF** = latency/scale.

---

## P0 · G1 — Gaining bucket access never backfills history

**Confirmed:** PGlite + local PG + hosted Neon (relationship-heavy: dave joins a workspace, sees an empty tracker).
**Root cause:** a **single global cursor** per syncRule; pull filters `_nizhal_row_version > cursor` (`storage.ts:664`). A newly-added bucket shares that cursor, so its pre-existing rows (`version ≤ cursor`) are never sent. `reconcileClientBuckets` computes only *removed* buckets (`storage.ts:854`); `_nizhal_client_buckets.last_seen_cursor` is **written but never read** (`storage.ts:863,868`) — an **unfinished per-bucket-cursor primitive**.

**The fix — finish the per-bucket cursor primitive.**

*End-state shape (the "1"):* the watermark is **per-bucket**, not global. Each bucket the device syncs has its own `last_seen_cursor` in `_nizhal_client_buckets` (the column that already exists). A newly-granted bucket starts at `0` → its first pull backfills full history; established buckets advance independently. The pull request carries (or the server derives) per-bucket cursors.

*Minimal increment (server-only, no wire change):* in `getPostgresChanges`, read the device's stored buckets from `_nizhal_client_buckets`; compute `addedBuckets = currentBuckets − storedBuckets`. Build the data query as a **union of two ranges**:
```sql
-- established buckets: incremental
(_nizhal_row_version > :globalCursor AND bucket IN :establishedBuckets)
-- newly-added buckets: full backfill
OR (_nizhal_row_version > 0 AND bucket IN :addedBuckets)
```
Page the union by `row_version`; advance `last_seen_cursor` per bucket. The client keeps sending one cursor; the server backfills added buckets transparently. This **reads** the `last_seen_cursor` the schema already writes.

*Stopgap (1 line, correctness-over-efficiency):* if `addedBuckets` is non-empty, set `cursorReset: true` (`storage.ts:574`) → the client re-bootstraps the whole syncRule from `0`. Correct but re-pulls everything; ship only if the proper fix slips.

**Test (write first, must fail today):** member of bucket X with X-activity advancing the cursor; create bucket Y with old rows (version < cursor); grant access to Y; pull; **assert the Y history rows arrive**. (`relgraph-neon.ts`'s G1-graph section is exactly this — it currently returns `[]`.)

---

## P1 · B1 — A realtime publish failure drops the live broadcast (and 500s the committed push)

**Confirmed:** publish throws after commit → row committed, never delivered live, client silently swallows the 500, no retry.
**Root cause:** the `realtime.publish` loop (`index.ts:457-459`) is **outside** the try/catch that wraps `applyMutation` (`:400-443`), and *inside* the batch `for`. A throw escapes the handler (500), skips `applied.push` (`:461`); on retry the mutation is `alreadyApplied` → `didApply=false` → publish never re-runs.

**The fix — two parts (a committed write must never fail on a post-commit side effect; live delivery must be at-least-once).**

1. **Isolate publish from the request result.** Wrap the publish loop in try/catch; on failure, record the error (observer) but **do not fail the push** — the write is durable:
```ts
if (didApply) {
  try { for (const b of mutationBuckets) await realtime.publish(b); }
  catch (err) { observer.onError?.({ phase: "publish", error: err, clientMutationId: mutation.clientMutationId }); }
}
if (acknowledged) applied.push(mutation.clientMutationId);   // always reached now
```
This also stops a transient realtime hiccup from aborting the rest of the batch.

2. **Make delivery reconcilable (so a dropped poke self-heals).** Pick one:
   - *Minimal increment:* a low-frequency **client safety pull** (e.g. every 20–30s, already supported via `pull.intervalMs`) — a dropped poke is caught within one interval. Cheap, robust, no server change.
   - *End-state:* a durable **poke-outbox** — on commit, record affected buckets in a `_nizhal_pending_pokes` table; a sweeper retries `publish` until acked. Exactly-once-ish live delivery. (Or lean on `listenNotifyRealtime`, where the `NOTIFY` is committed by a trigger and thus atomic with the write — but it's `suppress_notify`-gated; verify that gate.)

**Test:** a realtime adapter whose `publish` throws once after commit; assert (a) the push still returns success / the mutation is in `applied`, (b) the row is committed, (c) a subsequent client converges via the safety pull (not just an explicit pull). (`bug-repro.ts` B1 proves (a)/(b) fail today.)

---

## P1 · NEW — Duplicate server-computed values (issue numbers) under offline

**Confirmed on Neon:** two offline clients each assign issue `number = local max + 1 = 1` → two issues share **ENG-1** (`numberCollisions: [{number:1, count:2}]`); no uniqueness guard.
**Root cause:** a **server-meaningful derived value** (the per-workspace sequence number) is **computed client-side, offline, from possibly-stale state**, and the server trusts the client's value. This is the exact hazard Zero/Linear warn about ("don't generate server-meaningful IDs in mutators / offline").

**The fix — assign server-meaningful sequences authoritatively on the server; the client shows an optimistic placeholder and rebases.**

```ts
// server impl assigns under a per-bucket lock (serialized in the bucket → no collision)
createIssue: defineMutator(args, async ({ tx }, a) => {
  const next = await tx.nextInBucket("issues", "number", a.workspaceId); // max+1 under lock, server-authoritative
  await tx.insert(issues).values({ ...a, number: next });
  return { serverId: a.id, assigned: { number: next } };   // client rebases its optimistic guess to `next`
})
```
- The client's **optimistic** value is a placeholder (a temporary local number, or none); when the server result returns the assigned `number`, the optimistic overlay rebases — the same "server result need not equal client result" property Replicache/Zero rely on.
- **Primitive gap this exposes (thesis-level):** the kernel should make **server-authoritative monotonic assignment per bucket** a first-class primitive (`ctx.nextInBucket(...)` / a per-bucket sequence), because "a human-facing sequence number per tenant" is a *recurring* need across ledger (invoice #), chat (message ordinal), and tracker (issue #). Today every app would hand-roll it and hit this collision. Building this primitive is squarely the kernel's job (the hard, reusable 80%).
- *Do NOT* "fix" it with a `UNIQUE(workspace_id, number)` constraint alone — the second offline write would then fail and get **poison-parked = lost** (worse). Server-side assignment is the correct fix; a unique constraint is a backstop *after* server assignment.

**Test:** two offline clients each create an issue; reconnect; **assert distinct numbers** and both issues converged. (`relgraph-neon.ts` proves the collision today.)

---

## P1 · F1 — Overlapping-bucket revocation evicts in-scope rows

**Confirmed (code, verified):** `removedBuckets` is a pure key set-diff (`storage.ts:854`) with no row-level "still visible elsewhere" guard — unlike the tombstone path's `getVisibleRemovalRows` (`storage.ts:783`); the client purges whole-collection when no `bucketField`, else by single bucket value (`sync.ts:517-537`).
**Root cause:** eviction is computed at **bucket granularity** but membership is **per-row**; a row reachable via two buckets is wrongly dropped when one is revoked, and cursor pull won't re-deliver it.

**The fix — evict by ROW, mirroring the tombstone visibility guard.** Instead of (or in addition to) `removedBuckets`, the server should return the **rows that left ALL of the actor's retained buckets** (compute exactly like `getVisibleRemovalRows`: for each row that would be evicted, check it against the retained-bucket scope; only evict if invisible everywhere). Send those as `removed` row ids. The client then deletes specific rows, never a whole collection, and never a row still in a retained bucket.

*Minimal increment:* reuse `getVisibleRemovalRows`' logic for the revocation path; downgrade `removedBuckets` to a hint and drive client eviction off the row-level `removed` set.

**Test:** a row in buckets {A,B}; revoke A; assert the row survives locally (still visible via B) and a truly-removed row vanishes. (No such test exists today.)

---

## PERF · The engine is latency-bound (chattiness) — confirmed on Neon

**Confirmed:** warm RTT ≈ 47ms; ~6–9 serialized round-trips per mutation; N+1 pull. In-region (~1ms/RT) it's hidden; on any WAN/remote DB it's painfully slow.
**Root causes + fixes (highest-impact first):**

1. **Global singleton `FOR UPDATE` for every row-version** (`storage.ts:1049`). → **Replace with `nextval(_nizhal_row_version_seq)`** (atomic, lock-free, monotonic-with-gaps; gaps are fine for a `> cursor` watermark). Removes the global write-serialization (the Linear-`lastSyncId` bottleneck, O4) *and* a lock round-trip. Handle the version-order-vs-commit-order read-skew separately: either accept that the cursor can momentarily lag the true max (clients re-pull) or gate the pull's high-water on a committed snapshot (`pg_current_snapshot()`/`xmin`) so it never advances past an uncommitted lower version. **Biggest concurrency + latency win.**
2. **Per-row awaited inserts** in a cascade. → **Batch**: collect a mutator's writes and emit **one multi-row `INSERT` / CTE**, or use `postgres`-lib pipelining (today each `tx.insert` is awaited → N round-trips).
3. **N+1 pull** (`storage.ts:507` loops per bucket×table). → **One query per table** `UNION`-ing the bucket scopes (or a single CTE), not per-(bucket×table).
4. **Three sequential bookkeeping statements** (`checkMutationSequence` + `claimMutation` + `recordApplied`). → **Fold** into one `INSERT … ON CONFLICT … RETURNING`.
5. **One mutation per HTTP push** (FIFO). → allow **batched push** (multiple mutations in one request/transaction) for offline-drain throughput.

**Also the deployment answer:** co-locate the server with the DB (same region) + Neon **pooled endpoint** (`-pooler`, `prepare:false`) + one warm pool. Then only client↔server HTTP crosses the WAN. This is Nizhal's actual model and the "ideal connection."

---

## Latent — fix or document (lower urgency, verified)

- **D2 · HLC nodeId truncated 128→64 bits** (`hlc.ts:82-85`) — an exact `wallTime+counter+nodeId` collision silently drops the incoming `field`-merge edit. **Fix:** keep the full 128-bit nodeId (or ≥96 bits) in `normalizeHlcNodeId`; it's the sole tiebreaker on the ledger field-merge path.
- **A1 · `dependsOn` cascade-cancel is non-functional** (`mutators.ts:219` compares a domain string against internal `idempotencyKey`s; server never reads `dependsOn`). **Fix:** make `dependsOn` reference a poisonable identity (expose the dependency's `clientMutationId`/`idempotencyKey` and compare against it) and honor it server-side for ordering — **or** mark it unimplemented until then (don't ship a feature that silently no-ops in a ledger).
- **D1 · `clientID` device-uniqueness assumed, not enforced** — the mutation watermark keys on raw `clientID` (`storage.ts:222`) while buckets key on actor-scoped device id (`:852`). **Fix:** validate/derive `clientID` as device-unique and reconcile the two scoping schemes.
- **C1 · failed-ack barrier freeze** — *not reproduced* on PGlite or real PG; **don't fix blind.** Add a barrier-level unit test for `isLocalWriteBlocked` (collectionId vs tableName match) to settle whether the freeze precondition exists at all.
- **F2 · `lww` orders by commit, not HLC** — *product decision*, not a defect. Since every mutation already carries an HLC, consider HLC-tiebreaking `lww` so a stale offline update can't beat a newer online one; decide intent before changing.

---

## How these fixes serve the "1"

The product thesis is "**the kernel owns the hard, reusable 80% — store, outbox, convergence, realtime, change-tracking — so the dev only writes tables + mutators + invariants.**" Every fix above is the kernel doing its job:
- **G1 / F1** — *partial replication that doesn't lose rows* is the kernel's core promise; a join/revoke that silently drops data breaks the thesis.
- **B1** — *live sync* is one of the five named kernel responsibilities; a dropped, never-retried poke means the kernel isn't delivering what it claims.
- **Number collision** — surfaces a **missing kernel primitive** (server-authoritative per-bucket sequence). The right move isn't "tell every app to handle it" — it's to *add the primitive to the kernel*, because that's exactly the 80% the kernel exists to own.
- **Chattiness** — the kernel's write/read path is the reusable substrate; making it pipelined and lock-free compounds across every app built on it.

Sequence by opportunity cost: **G1 first** (most common-path data loss, on every join/grant), then **B1** (live guarantee) and the **number-assignment primitive** (the thesis-defining "kernel owns the hard part" move), then **F1**, then the **chattiness** rework (the compounding scale investment). The latent items are documented, not yet capitalized.
