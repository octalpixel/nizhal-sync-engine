# Understanding: Nizhal sync engine (codename `echo`) — convergence model + sync protocol

> Repo @ `864ce4e` (single squashed commit — history-based evidence is unavailable; all claims are `file:line`).
> Read first-hand (not paraphrased): `packages/kernel/src/{types,sync-rules,hlc}.ts`, `packages/server/src/index.ts` (push/pull/applyMutation/mergeAwareTx/merge fns), `packages/server/src/adapters/storage.ts` (claim/sequence/getChanges/auth/DDL), `packages/db-collection/src/{sync,mutators}.ts`, `apps/credit-ledger/test/e2e.test.ts`. Externals grounded via context7: Yjs (updates commutative+idempotent), TanStack DB (`acceptMutations`).

## Frame
This unlocks safely changing `mergeAwareTx` / the per-table merge policy and the pull/push/realtime path without committing either cardinal sync sin (silent write loss or divergence), and locating "missed primitives." It establishes the exact code reality for three contested questions: lww ordering, overlapping-bucket eviction, and `related` read-auth.

## Primitive (first principles)
**One mutation converges by being assigned a single globally-serialized `_nizhal_row_version` at server-commit, then merged column-wise (`lww` = that commit order · `field` = per-field HLC tiebreak in `_meta` · `crdt` = Yjs byte-merge) into a bucket-scoped row, while idempotency is fenced by `clientMutationId` (claim) + contiguous per-client `mutationID` (sequence).** The row-version sequence is *the* total order; HLC is a *secondary* tiebreak used only by `field` merge.

## Top-down map

**L0 — Product thesis.** Toolkit generates a *coupled* offline engine from a spec; the reusable 80% (store/outbox/convergence/realtime/change-tracking) is the kernel, the 20% (tables/rules/mutators) is all you write. Self-host, **no WAL / no logical replication**. `README.md:3-19,61`.

**L1 — Packages (the seams).**
- `@nizhal/kernel` — shared, I/O-free vocabulary both sides implement against: `types.ts` (`MutatorTx`, `PullResult:126`, `Mutation:142`, `MergeMode/MergePolicy:152`, `NizhalContract:156`), `sync-rules.ts`, `hlc.ts`, `schema.ts`, `contract.ts`. This is **seam #1: the wire/type contract.**
- `@nizhal/server` — `createNizhalServer` Hono app, `postgresStorage`, realtime, jobs, auth. **Seam #2: `StorageAdapter` (`storage.ts:70`) and `RealtimeAdapter` (`realtime.ts:54`) interfaces.**
- `@nizhal/db-collection` — TanStack DB `SyncConfig` adapter + offline mutators. **Seam #3: the TanStack DB `SyncConfig` (`buildNizhalSyncConfig`) and `NizhalSyncTarget` (`httpSyncTarget`).**

**L2 — Server HTTP boundary (`packages/server/src/index.ts`).** `/sync/pull:343` (→ `storage.getChanges` then `encodeCrdtColumnsInPullResult:363`, appends `lastMutationId:372`), `/sync/push:386` (loop over mutations → `applyMutation`, error→status mapping `409/422/403`, post-commit `realtime.publish:458`), `/sync/stream:492` (WS repull + presence), `/nizhal/contract:220`. Rate/body limits + bearer auth gate every route.

**L3 — `applyMutation` (`index.ts:651`)** — the commit chokepoint, one `storage.transaction`:
1. If sequenced: `checkMutationSequence:659` → `outOfOrder`(throw→409) / `alreadyApplied`(replay stored error or ack, return) / `apply`. On apply it also `serverHlc.recv(mutation.hlc):674`.
2. `claimMutation:676` (`INSERT … ON CONFLICT DO NOTHING`) — lost race → ack without re-run.
3. `schema.parse(args)`, compute `mutationHlc = mutation.hlc ?? serverHlc.send():687`, build ctx (`createMutatorCtx:917`), run `def.fn:698`, `jobs.flush:699`, `recordApplied:700` (stores `{clientId,serverId,error}` reconciliation map).
4. If audit: compute `affectedBuckets` + `appendAudit`.
5. Returns `{acknowledged, didApply, mutatorResult, affectedBuckets?}`; handler publishes buckets **after** the tx commits.

**L4 — `mergeAwareTx` (`index.ts:970`)** wraps the storage tx's `update`. INSERT and DELETE pass straight through (`:979-981,1035-1037`) — **inserts never merge** (this is why append-only ledgers are conflict-free). UPDATE splits the patch by column (`:992-1002`): crdt columns → `crdtPatch`, the rest → `scalarPatch`. Then: crdt patch → `crdtMergeUpdate:1005`; scalar patch → `fieldMergeUpdate:1010` iff `policy.table === "field"`, else **plain `tx.update().set().where()` (lww)** `:1021-1026`. `updated_at`/`deleted_at` are stripped from merge (`:993,1167`).
- `crdtMergeUpdate:1041` → locks targets `select … for update:1052`, per row `mergeCrdtRow:1071`: load current bytes, `Y.applyUpdate(doc,current)`+`Y.applyUpdate(doc,incoming)`, write `Y.encodeStateAsUpdate(doc)` under CAS `where … _nizhal_row_version = expected:1106`, ≤5 retries (`MAX_CRDT_MERGE_ATTEMPTS:1069`); on exhaustion returns `undefined` (silently no-ops).
- `fieldMergeUpdate:1151` → one UPDATE per field: `col = case when coalesce(_meta->>col,'') < $hlc then $val else col end`, and `_meta` jsonb is set in the **same statement** (`:1180`) so column+winner-HLC are atomic. Pushes an `onConflict {resolution:"merge"}` event (`:1196`).

**L5 — Storage (`adapters/storage.ts`).**
- Idempotency/sequence: `claimMutation:189`, `checkMutationSequence:222` (`SELECT … FOR UPDATE` on `_nizhal_clients`, requires `mutationID == last+1`, advances LMID *inside* the tx), `recordApplied:240`.
- Pull: `getPostgresChanges:490` → `normalizePullCursor:475` (clamps future/torn cursor → `{0, reset:true}`), per-bucket `buildDataQuery:655` (`_nizhal_row_version > cursor AND deleted_at IS NULL` + `buildBucketScope`), dedup via `seenRows:517`, `getRemovalCandidates:748` (tombstone/bucket_exit), `getVisibleRemovalRows:783` filters bucket_exits still visible elsewhere, sort by version, page by limit, `reconcileClientBuckets:841` computes `removedBuckets`.
- Write-auth: `createAuthorizedMutatorTx:334` wraps every insert/update/delete; `assertAuthorizedRows`/`assertAuthorizedResult` check each affected row against `rowMatchesScope:438` → throws `WriteAuthorizationError` (→403). Updates/deletes also pre-check the *before* image (`selectRowsForWrite:399`, `for update`).
- Total-order source: `_nizhal_next_row_version():1049` takes `FOR UPDATE` on the `_nizhal_sync_control` singleton then `nextval(_nizhal_row_version_seq)`; row_version is set on INSERT via column DEFAULT (`:1119`) and on UPDATE via the BEFORE trigger `_nizhal_touch_updated_at:1101`. Deletes/soft-deletes write `_nizhal_tombstones` via per-bucket-column trigger `bucketStatements:1135`.

**L6 — Realtime (`adapters/realtime.ts`).** `publish(bucket)` is called **only** from the push handler after commit (`index.ts:458`). `inProcessRealtime:77` sends `repull:${bucket}`; `listenNotifyRealtime:224` uses Postgres `LISTEN/NOTIFY` gated by `_nizhal_sync_control.suppress_notify`. No delta — the client repulls everything `> cursor` in the bucket.

**L7 — Client (`packages/db-collection/src`).** `createNizhalClient` (`client.ts:80`) holds per-rule cursors + `LocalWriteBarrier` + in-memory `lastMutationId`. `mutate.x(args)` (`mutators.ts:303`) parses args, stamps `hlc.send():310`, creates a `@tanstack/offline-transactions` durable txn; the mutationFn (`:205`) checks poison/`dependsOn`, persists optimistic rows, then `attemptPush:445`. `attemptPush` allocates `mutationID` under `withSequenceLock:402`, pushes, and on `outOfOrder`/`accepted===false` re-allocates from server `lastMutationId` and retries (`:467-478`). Pull apply: `applyLocalFirstPullResult:196` (field-merges pending optimistic fields over server rows via the barrier, commits with `acceptMutations`) or `applyPullResult:379` (server-wins, `begin/write/commit`). Eviction: `removedBuckets`→`purgeRemovedBuckets:517`; `removed`/`tombstoned`→deletes; TTL→`evictTtlBuckets:431`.

## Bottom-up trace (atomic unit → user-visible edge)

1. **Atomic unit:** `_nizhal_row_version` — a bigint from a singleton-serialized sequence (`storage.ts:1049-1058`). It is simultaneously the lww winner-selector and the pull total order.
2. **`mergeAwareTx.update().set().where()`** is the only place row-merge policy is applied (`index.ts:982-1033`). Reachable solely through `createMutatorCtx` → `authorizeMutatorTx(mergeTx)` (`index.ts:928-934`), i.e. it is wrapped *inside* the write-auth tx.
3. **Caller:** `applyMutation` builds the ctx and runs `def.fn(ctx,args)` (`index.ts:698`); the mutator's `ctx.tx.update(...)` lands in `mergeAwareTx`.
4. **Caller:** `/sync/push` handler (`index.ts:401`) calls `applyMutation`, maps errors to HTTP, and (post-commit) `realtime.publish` (`:458`).
5. **Reaches the server from:** client `attemptPush` → `echo.push(nizhalMutation)` → `httpSyncTarget` POST `/sync/push` (`mutators.ts:463`).
6. **Originates at:** `mutate.recordCredit({...})` in the app (`apps/credit-ledger`), which appends a `ledger_entries` row.
7. **User-visible edge:** `apps/credit-ledger/test/e2e.test.ts` (A-E2E) — offline `recordCredit` shows optimistic `customerBalance===2500` with **no server row** (`:62-68`); on reconnect the push converges, the server row lands with the exact amount and an `sms-reminder` job is enqueued (`:72-89`); a second fresh client bootstraps and converges `<5s` (`:104-113`); a later `recordPayment` settles both fold and computed balance to `2000` across both clients (`:115-138`).

**Invariants the code assumes:**
- *Idempotency:* `clientMutationId` claimed once (`ON CONFLICT DO NOTHING`); re-runs ack without re-applying (`index.ts:676-685`).
- *Ordering:* per-client `mutationID` strictly contiguous (`== last+1`, `storage.ts:232-238`); gap→409, replay→ack.
- *Causality:* HLC monotone, drift≤60s, counter≤0xffff (`hlc.ts:87-97`); server advances on `recv`.
- *Bucket-scope (write):* every affected row matches an actor bucket scope or 403 (`storage.ts:411-452`) — checks **every** row in the result set, not just the first.
- *Bucket-scope (read):* every synced row provably scoped via the no-leak lint (`sync-rules.ts:155`).
- *Convergence:* lww=row-version order; field=HLC per field; crdt=Yjs merge (commutative+idempotent, confirmed via context7).
- *No silent loss:* poison writes are *burned* (`burnSequencedMutation:740`) so a deterministic app error can't wedge the sequence (422), and `mutationID` high-water is persisted in `_nizhal_meta` (survives restart).

## Reconciliation

**Agreements (high confidence).** Top-down (thesis→push→`applyMutation`→`mergeAwareTx`→storage→realtime) and bottom-up (`_nizhal_row_version`/`mergeAwareTx`→callers→A-E2E) meet cleanly on: the commit-chokepoint shape; the claim+sequence idempotency fence; per-column merge split; the singleton row-version sequence as the one total order; inserts bypassing merge (why ledgers are conflict-free). Both passes converge on the A-E2E test as the executable proof of the common path.

**Divergence vs. the brief's primitive hypothesis (medium→high).** The brief stated the order as "claim → sequence → per-column `mergeAwareTx`." The code's order is **sequence → claim → run(merge)** (`index.ts:658-698`): `checkMutationSequence` runs and advances `lastMutationId` *before* `claimMutation`. Consequence: a deterministic mutator error rolls the whole tx back (including the LMID advance), so a *separate* `burnSequencedMutation` tx is required to re-advance past the poison. Not a bug — but the sequencing detail matters for anyone touching the apply path.

**Three contested P0/P1 questions — code reality:**

1. **Does `lww` order by HLC or commit order? → COMMIT ORDER (confirmed).** `mergeAwareTx` routes non-`field` scalar patches to a plain `tx.update().set(scalarPatch).where(predicate)` (`index.ts:1021-1026`); `mutationHlc` is passed *only* to `fieldMergeUpdate`. The winner is whichever UPDATE commits last and thus gets the higher `_nizhal_row_version` (assigned by the trigger at write time, `storage.ts:1107`), **independent of the mutation's HLC**. The client stamps `hlc` on every mutation and the server `recv`s it (advancing its clock + audit), but lww ignores it. Therefore a causally-*older* offline lww update replayed *later* wins over a newer online write — exactly the brief's anomaly. `sync-core.test.ts` asserts this as *intended* ("lww commit-order"); it is a documented semantic, not a covered-as-safe one. A-E2E never exercises an lww update conflict (it is insert-only).

2. **Does client eviction handle a row in two overlapping buckets? → NO (confirmed gap, medium-high).** `removedBuckets` is a pure set-difference of bucket *keys* (`previous − current`) in `reconcileClientBuckets` (`storage.ts:850-874`) with **no row-level "still visible elsewhere" guard.** The client then `purgeRemovedBuckets` deletes every local row whose single `bucketField` value is in the removed set (`sync.ts:531-537`), or — if no `bucketField` — **purges the entire collection** (`sync.ts:524-528`). So a row genuinely reachable via two buckets (one revoked, one retained) is wrongly evicted if its `bucketField` equals the revoked bucket. Note the asymmetry: the *tombstone/bucket_exit* removal path **does** guard this correctly via `getVisibleRemovalRows` (`storage.ts:783-810`, filtered at `:529-533`); only the access-revocation `removedBuckets` path lacks the guard. The model effectively assumes one-row→one-bucket per collection. No test exercises two overlapping buckets (consistent with the brief calling it "likely a real correctness gap").

3. **Does `related` read-auth recurse to bound visibility? → YES, but via flatten-not-correlate; and it is unused (high).** `related` queries are (a) lint-recursed — `collectQueryLintIssues` descends into `query.related` requiring each to have `bucketScopes.length>0` (`sync-rules.ts:223`), and (b) at runtime **flattened** by `flattenDataQueries` (`sync-rules.ts:185`) into *independent* top-level queries, each executed with its own `buildBucketScope` against the actor's resolved bucket rows (`storage.ts:507-515,655`). Crucially **there is no correlated JOIN** — `related` is not a Zero-style correlated subquery, so the "existence-oracle / visibility-widening" risk does not arise: a related table can only be scoped to the same bucket-key values the actor already holds. Visibility is bounded. Caveat: `.related(` is **not used by any Nizhal app or test** — every hit is in the vendored `research/zero-mono/` reference repo. The mechanism is implemented + linted but unexercised.

## Data & control flow

```
WRITE (push):
  app mutate.x(args)
    → stamp hlc, build NizhalEnvelope, durable offline txn (optimistic local rows)
    → mutationFn: poison/dependsOn check → attemptPush
        → withSequenceLock: allocate mutationID → POST /sync/push
  server /sync/push → applyMutation (one tx):
        checkMutationSequence (FOR UPDATE _nizhal_clients, advance LMID)
        → claimMutation (ON CONFLICT DO NOTHING)
        → def.fn(ctx): ctx.tx.{insert|update|delete}
              insert → passthrough (gets row_version via DEFAULT)
              update → mergeAwareTx split: crdt→Yjs CAS · field→HLC/_meta · else lww
              (all wrapped by write-auth rowMatchesScope → 403 on breach)
        → recordApplied → [audit] → COMMIT
  post-commit: realtime.publish(bucket) → "repull:bucket"

READ (pull, also triggered by repull / reconnect):
  client POST /sync/pull {cursor, deviceId, limit}
  server getChanges: normalize cursor → per-bucket buildDataQuery (>cursor, scoped)
        → dedup → removals (tombstone/bucket_exit, visible-elsewhere filtered)
        → sort by row_version → page → reconcileClientBuckets (removedBuckets)
        → encode crdt cols base64 → {changed,tombstoned,removed,removedBuckets,cursor,lastMutationId}
  client apply: local-first (acceptMutations, barrier field-merge) OR server-auth (begin/write/commit)
        + evict removedBuckets / TTL
```

Total order = the `_nizhal_row_version_seq` (one serialized issuance point). Cursor = base64url(bigint) over `last_value`. The realtime hint carries **no payload** — it only says "repull this bucket."

## Coupling & dependencies
- **Schema/contract coupling:** kernel `types.ts` is the shared shape; `MutatorTx` is implemented twice (server `mergeAwareTx`+auth; client `collectionMutatorTx`). Changing `Mutation`/`PullResult` ripples to both sides + the OpenAPI contract.
- **DB coupling:** Postgres-only (`postgresStorage`); engine bookkeeping = `_nizhal_{mutations,clients,tombstones,sync_control,client_buckets,jobs,audit_log}` + `_nizhal_row_version_seq`/`_nizhal_next_row_version()` + per-table `updated_at/deleted_at/_nizhal_row_version/_meta` columns, BEFORE-UPDATE touch trigger, per-bucket removal trigger + index. Alternate backends (D1/SQLite/MySQL) are backlogged behind `StorageAdapter`.
- **Cross-process:** `RealtimeAdapter` (`inProcess` / `listenNotify` / Cloudflare-DO). Publish strictly post-commit.
- **Client persistence:** real SQLite (`op-sqlite` native / `wa-sqlite` web) — `_nizhal_{outbox,meta,dead_letter,store_version}`, versioned migrations (downgrade-guarded), all ops serialized through a `storage-operation-queue` mutex.
- **External libs:** `yjs` (crdt merge — confirmed commutative+idempotent), `@tanstack/db` + `@tanstack/offline-transactions` (optimistic txn lifecycle, `acceptMutations` to persist pulls without rollback — confirmed), `drizzle-orm` (pgTable + raw `sql` template for merge UPDATEs), `zod` (arg validation).
- **Auth:** `bearerTokenAuth` HS256; `Actor{userId,ownerId}` drives bucket resolution.

## Domain vocabulary
- **Bucket** — a sync subset = `(parameters(actor) → bucket rows) × (data(bucket) → scoped queries)`; bucket *key* = a column value (e.g. `shop_id`). `sync-rules.ts`.
- **No-leak lint** — `assertSyncRulesNoLeak`: every data query must be builder-made, bucket-scoped, raw-SQL-free. `sync-rules.ts:155`.
- **Merge policy / mode** — per-table or per-column `lww`/`field`/`crdt`. `types.ts:152`, `schema.ts:49`.
- **`_nizhal_row_version`** — globally-serialized bigint; lww winner + pull total order.
- **HLC** — `ISO-wall-counter(4hex)-nodeId(16hex)`, lexically sortable; field-merge tiebreak only. `hlc.ts`.
- **`_meta`** — jsonb of per-field winning HLC, written atomically with the column in `field` mode.
- **`clientMutationId` / `mutationID`** — idempotency key (claim) / per-client contiguous sequence number.
- **Commit chokepoint** — realtime publishes only after the mutation tx commits.
- **Tombstone / bucket_exit** — soft/hard-delete vs left-bucket-scope removals.
- **`removedBuckets`** — access-revocation eviction set (whole-bucket purge).
- **Poison / burn / dead-letter** — deterministic-error mutation recorded-as-applied (422) so it can't wedge the sequence; client parks it for `retryDeadLetter`.
- **Local-write barrier** — defers authoritative rows for keys with unacked optimistic writes; field-merges pending fields.
- **Append-only movement ledger** — `balance = fold(entries)`; dominant write is a conflict-free insert.

## Tribal knowledge
- **lww deliberately ignores HLC** (`index.ts:1021-1026`); `sync-core.test.ts` enshrines "lww = commit-order." Any move to HLC-tiebreak lww is a semantic change, not a bugfix.
- **`burnSequencedMutation` exists because** `checkMutationSequence` advances LMID *inside* the mutator tx, so a deterministic error rolls the advance back; the burn re-advances in a fresh tx (`index.ts:740-750`). Don't "simplify" the two-tx structure away.
- **Inserts never merge** — `mergeAwareTx` only intercepts `update` (`index.ts:982`). The conflict-free ledger property rides entirely on this.
- **crdt CAS is belt-and-suspenders** — `crdtMergeUpdate` already `select … for update`s the row (`:1052`) so concurrent writers block; the ≤5-retry CAS in `mergeCrdtRow` mostly guards intra-tx version churn, and **silently no-ops on exhaustion** (`:1110` returns undefined).
- **crdt bytes are stored as full state and re-encoded every write** (`Y.encodeStateAsUpdate`, `:1097`) — monotonic growth, no compaction (P2 GC concern is real).
- **Pull dedups overlapping buckets** (`seenRows`, `storage.ts:517`) — a row in two buckets is sent once; the eviction gap (Q2) is the *opposite* path and is **not** symmetric with this.
- **`related` is implemented + linted but unused** in every Nizhal app — treat its runtime semantics as untested-in-practice.
- **Cursor is NOT persisted in `_nizhal_meta`** — it lives in-memory + TanStack DB sync metadata (`cursor:<syncRule>`); only `device_client_id` and the `nizhal:mutation-id` high-water are durable.
- **`reconcileClientBuckets` keys by an actor-scoped device id** (`["actor-device",ownerId,userId,deviceId]`, `storage.ts:887`) so revocation is tracked per device per actor.

## Open questions
- **O1 — lww-vs-HLC semantic:** confirmed commit-order; should durable-offline lww updates be HLC-tiebroken (the engine already stamps every mutation's HLC)? *Would resolve if:* a test "old offline lww update vs newer online update to same field" is written and product intent is decided.
- **O2 — overlapping-bucket eviction:** confirmed the `removedBuckets` path lacks the row-level visibility guard that the tombstone path has. *Would resolve if:* a two-overlapping-buckets revoke-one test is added asserting other-bucket rows survive (expected: currently fails for multi-bucket-per-collection / no-`bucketField`).
- **O3 — `related` runtime widening:** structurally bounded (flatten + independent scope, no JOIN). *Would resolve if:* a VAPT test instantiates a `related` data query whose naive join would pull a foreign-bucket row and asserts exclusion — and an app actually uses `related`.
- **O4 — row-version single-writer ceiling:** `_nizhal_next_row_version()` serializes on a singleton `FOR UPDATE` per write. *Would resolve if:* a write-throughput bench measures contention (the Linear `lastSyncId` single-ordering-point cost).
- **O5 — crdt CAS exhaustion + byte growth:** exhaustion silently drops the merge; bytes never compact. *Would resolve if:* a 6+ concurrent-writer test confirms behavior and a compaction strategy is scoped.
- **O6 — realtime is full repull, no delta:** `repull:bucket` carries no payload; repull cost scales with bucket size, not writes. *Would resolve if:* a membership-diff "delta poke" primitive is prototyped (server already knows affected rows in `mergeAwareTx`).

## Confidence summary
| Section | Confidence | Gap |
|---------|------------|-----|
| Top-down map (push/pull/applyMutation/mergeAwareTx/storage/realtime) | high | read directly; line anchors verified |
| Bottom-up trace to A-E2E | high | test read end-to-end |
| Q1 lww = commit order | high | merge split + sequencing read directly |
| Q2 overlapping-bucket eviction gap | medium-high | reconcile + purge read; no adversarial test exists to confirm runtime failure |
| Q3 `related` bounds visibility | high (mechanism) / medium (unexercised) | flatten+lint read; no app uses it |
| Idempotency/sequence/burn ordering | high | claim/checkSequence/burn read directly |
| crdt (Yjs) convergence | high | context7-confirmed commutative+idempotent |
| field merge atomicity (col+`_meta` same UPDATE) | high | SQL read directly |
| Client outbox/poison/sequence-lock | medium-high | `mutators.ts` core read; offline-executor internals (`@tanstack/offline-transactions`) inferred from call sites + docs |
| Row-version contention / cardinality limits | low | not benchmarked (design-level question) |
