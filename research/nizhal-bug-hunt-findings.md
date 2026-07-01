# Nizhal — Adversarial Bug Hunt: Verified Findings

> Lens: **primary local-first; optimistic + server-authoritative; offline outbox + live WebSocket sync + server push/pull; for financial ledgers + chat where MISSING DATA is the cardinal sin.**
> Method: 5 adversarial hunters (4 subagents + orchestrator) across every data-loss vector; **every CONFIRMED finding below was re-verified first-hand in source by the orchestrator** (the agents' claims were not trusted blindly — several agent "bugs" were refuted on verification). Raw hunts: `_notes/hunt-{A-outbox,B-apply-publish,C-client-apply,D-drift,E-pull-completeness}.md`.

Severity: **P0** = silent missing-data / divergence on a common path · **P1** = real data-loss/divergence on a plausible path · **P2** = latent/edge or perf.

---

## Runtime validation (executable repros — moved from static to dynamic)

Repro harness: `playground/chat-nizhal/examples/bug-repro.ts` — the **real** Nizhal client+server, driven via `echo.pull({cursor, syncRule})` and `inProcessRealtime`. **DB-pluggable**: PGlite by default, **real Postgres when `DATABASE_URL` is set**. Run: `cd playground/chat-nizhal && [DATABASE_URL=postgres://…] pnpm exec tsx examples/bug-repro.ts`. **Validated on real Postgres 15.12** (throwaway local instance) — identical verdicts to PGlite, so these are *not* PGlite artifacts.

| Finding | PGlite | Real Postgres 15.12 | Evidence |
|---|---|---|---|
| **G1** (no history on bucket join) | 🔴 CONFIRMED | 🔴 **CONFIRMED** | B joins channel Y; server holds `[y1,y2,y3]`; B's replica shows **only `y3`** (sent after join), never the history `y1,y2`. |
| **B1** (live broadcast lost on publish failure) | 🔴 CONFIRMED | 🔴 **CONFIRMED** | publish throws after commit → row committed, B **never receives it live**, recovered only by a later pull. Worse than predicted: the client **silently swallows** the 500 (`push surfaced error: false`) and never re-publishes. |
| **C1** (failed ack pull freezes the collection) | ⚪ not reproduced | ⚪ **not reproduced** | injected a failed post-push reconcile (the two `reconcileLocalWrite` sites are mutually-exclusive, so this is the only reconcile for that write) — yet A's cursor still advanced (== healthy control) on **both** backends. The barrier did **not** freeze the cursor as the static read predicted → **C1 downgraded to unconfirmed**. Open question: does the barrier even engage (collectionId vs tableName in `isLocalWriteBlocked`)? Needs a barrier-level unit test. |
| **Idempotency under concurrency** (double-apply hypothesis — statically *refuted*) | ⏭ can't test | ✅ **holds** | 12 concurrent identical `/sync/push` (same `clientMutationId`) → **exactly 1 row**, all `200`, **zero** 5xx. `claimMutation` (`INSERT … ON CONFLICT DO NOTHING`) is correct under real row-level contention. Empirical confirmation of the static refutation — a test PGlite cannot run. |

### Relationship-heavy offline→online — on REAL hosted Neon (ap-southeast-1)

Harness: `playground/chat-nizhal/examples/relgraph-neon.ts` — a purpose-built maximally-relational domain (1:N project→issues, **M:N** issue↔labels join, **self-referential** issue-blocking + threaded comments, server-meaningful per-workspace issue number, deep **atomic multi-table cascade**), driven through two offline clients → reconnect → fresh-client convergence, on **real Neon Postgres**.

| Property | Verdict on real Neon | Evidence |
|---|---|---|
| Referential integrity across the graph | ✅ holds | `dangling: []` — every M:N link, self-ref parent, and FK resolves after convergence |
| Atomic multi-table cascade survives offline→online | ✅ holds | `i1` + 2 label links + opening comment all converge (`cascadeOk: true`) |
| No lost write | ✅ holds | all of `i1,i2,i3` + threaded reply present on a fresh client |
| **Server-computed issue NUMBER under offline** | 🔴 **NEW BUG** | `numberCollisions: [{number:1, count:2}]` — two clients offline both compute `max+1=1`; **no `(workspace_id,number)` uniqueness** → two issues share identifier **ENG-1**. The "derived server-meaningful value computed client-side offline" hazard; unhandled. |
| **G1 on a relationship-heavy graph** | 🔴 **CONFIRMED** | `g1GraphDaveIssues: []` — dave joins workspace W (server holds the full graph) and sees an **empty tracker**: no projects/issues/labels/comments backfilled. G1 confirmed on real Neon + a full graph. |

### Performance — the engine is latency-bound ("chattiness"), confirmed on real Neon

Measured on Neon (warm persistent-connection RTT ≈ **47ms**): a single mutation ≈ **6–9+ serialized round-trips**; a fresh-client bootstrap is **N+1** (one query per bucket×table). Root causes (all in `packages/server/src/adapters/storage.ts` + `index.ts`):
- **Global singleton `FOR UPDATE` for every row-version** — `_nizhal_next_row_version()` locks the `_nizhal_sync_control` singleton before `nextval` (`storage.ts:1049`). Serializes *every write in the DB* (the Linear-`lastSyncId` bottleneck, O4) + a lock round-trip. A plain `nextval(_nizhal_row_version_seq)` is atomic/lock-free; the `FOR UPDATE` is belt-and-suspenders.
- **Per-row awaited statements** — `applyMutation` is `BEGIN → checkMutationSequence(SELECT…FOR UPDATE) → claimMutation(INSERT) → N awaited body inserts → recordApplied(INSERT) → COMMIT`; the client flushes the outbox **one mutation per HTTP request**.
- **N+1 pull** — `getPostgresChanges` loops `for bucket { for table { await query } }` (`storage.ts:507`).
- **In production this is hidden** (server co-located with the DB → ~1ms/round-trip); it only bites on a WAN/remote connection. **Fixes:** (1) co-locate server+DB + Neon pooled endpoint; (2) swap the singleton lock for `nextval`; (3) batch cascade inserts (one multi-row INSERT/CTE); (4) collapse the N+1 pull (one query per table UNION-ing bucket scopes); (5) fold the bookkeeping into one `INSERT…ON CONFLICT…RETURNING`.

> **PGlite-fidelity note (resolved).** PGlite is a single serialized in-process connection — faithful for deterministic protocol/logic bugs (G1, B1) but unable to exercise true concurrency. The findings were therefore **re-run against real Postgres**, which (a) reproduced G1/B1 identically, (b) reproduced the C1 *non*-repro identically, and (c) enabled the concurrency test above. Still outstanding for the **deployed** stack: pointing the client at the user's hosted **Neon + Vercel/CF** deployment (real edge CF-DO realtime) — needs the user's `DATABASE_URL` / backend URL + token.

---

## CONFIRMED — ranked

### 🔴 P0 · G1 — Gaining access to a new bucket never backfills its history
**Where:** `server/adapters/storage.ts:664` (pull filters `_nizhal_row_version > cursor`), `:854` (`reconcileClientBuckets` computes only *removed* buckets), `:863,868` (`last_seen_cursor` **written but never read**), `kernel/types.ts:135` + `db-collection/sync.ts:58` (`cursorReset` is the only re-bootstrap, fired only on invalid/future cursor).
**Scenario:** an actor is added to a shop's `shop_members` / joins a chat channel. The new bucket shares the **single global cursor**; its pre-existing rows have `row_version ≤ cursor` → excluded forever. Nothing detects an *added* bucket or backfills it.
**Consequence:** chat → join a channel, see **zero history**. Ledger → granted shop/account access, see **no existing entries** → `fold(ledger)` balance is wrong (under-counts). Common path, completely silent.
**Primitives drift:** `_nizhal_client_buckets.last_seen_cursor` exists as if per-bucket cursors were intended, but the code uses one global cursor — an **unfinished primitive**.
**Test gap:** no test adds a bucket mid-session and asserts pre-existing rows arrive (`reconnect.test.ts` = same buckets; `removedBuckets` tests = losing access only).
**Fix:** finish per-bucket cursors (new bucket starts at 0, pull carries per-bucket cursors) — matches the schema's intent; OR have `reconcileClientBuckets` detect `current ⊋ previous` and scoped-re-bootstrap the added buckets; stopgap = `cursorReset` on any membership growth (correct, re-pulls everything).

### 🔴 P0–P1 · C1 — A failed post-push reconcile pull strands the write barrier → collection-wide cursor freeze
**Where:** `db-collection/mutators.ts:421-440` (`reconcileLocalWrite` is one-shot — `.catch(reportError)` at `:424`, no retry), `client.ts:524-531` (`acknowledgeLocalWrite` throws on a failed `puller.pull()` → `failAcknowledgement` resets phase to `pending`), `local-write-barrier.ts:36-44,67` (a `pending` entry blocks its key), `sync.ts:207` (`blocked` is **collection-wide** — any deferred row sets it), `sync.ts:100-104,121-123` (cursor advances only when `!blocked`; paging stops when blocked).
**Scenario:** optimistic write on row R succeeds server-side; the *post-push reconcile pull* fails (a routine network blip right after the push — the common mobile case). The barrier entry for R is reset to `pending` and **never retried**. The author's comment (`mutators.ts:416-420`) assumes "the normal pull cycle reconciles" — but a `pending` entry is exactly what makes every later pull **defer** R, so it never reconciles.
**Consequence (until app relaunch):** (1) every authoritative update **and delete** to R is deferred forever (R diverges — stale value, or phantom after a server delete); (2) because `blocked` is collection-wide, the **collection cursor freezes** and `keepPaging=false` caps each pull to page 1 → in a busy collection, newer rows beyond the first page **never sync** (missing data); (3) unbounded re-fetch of `> frozen_cursor` each pull. Recovered only on relaunch (in-memory barrier; the acked txn is gone from the durable outbox).
**Test gap:** `offline-batch-harness` T9 injects a *hung* ack (phase `acknowledging`, block off) — nothing injects a *failed* ack pull then asserts a later update/delete still lands.
**Fix:** clear the barrier on **push success** (the durable fact) rather than on a separate reconcile pull; or make `reconcileLocalWrite` retry/persist; or scope `blocked` per-row so one stuck row can't freeze the collection cursor.

### 🟠 P1 · B1 — `realtime.publish` failure after commit drops the live broadcast permanently (and 500s the committed push)
**Where:** `server/index.ts:400-443` (the try/catch wraps only `applyMutation`), `:453-459` (the `realtime.publish` loop is **outside** the try, inside the batch `for`), `:461` (`applied.push` is *after* the publish loop).
**Scenario:** `applyMutation` commits the tx; then `await realtime.publish(bucket)` throws (the Cloudflare DO-RPC / HTTP-bridge path can throw — exercised in `cloudflare-realtime.test.ts:138`). The throw escapes the handler → **500**, `applied.push` never runs. On client retry, the mutation is `alreadyApplied` → `didApply=false` → the `if (didApply)` guard (`:453`) **skips publish permanently**.
**Consequence:** the write is durably committed but **never broadcast** — connected clients don't see it live (chat message doesn't appear until a *later* successful publish to that bucket or a reconnect); the live-WebSocket-sync guarantee is void with **no retry**. Also a transient realtime hiccup **fails the whole push** for an already-committed write and **aborts the rest of the batch** (mutations after the failing one never run on this attempt).
**Test gap:** no test drives a publish failure *through the push handler*.
**Fix:** wrap publish in try/catch (a post-commit publish error must NOT fail a durably-committed push); make delivery at-least-once — a publish-intent outbox, a periodic safety pull, or durable LISTEN/NOTIFY — so a dropped broadcast self-heals.

### 🟠 P1 · F1 — Overlapping-bucket revocation evicts in-scope rows persistently
**Where:** `server/adapters/storage.ts:854` (`removedBuckets` = pure key set-diff, **no** row-level "visible elsewhere" guard — unlike the tombstone path's `getVisibleRemovalRows` `:783`), `db-collection/sync.ts:524-528` (no `bucketField` → **purge whole collection**), `:531-537` (else purge by single bucket value).
**Scenario:** a row reachable via buckets {A, B}; revoke A. The client deletes the row though it's still visible via B; cursor pull (`> cursor`) won't re-deliver it until it next mutates.
**Consequence:** rows the user *still has access to* disappear locally and stay gone — wrong ledger view / missing chat content.
**Test gap:** no two-overlapping-buckets revoke-one test.
**Fix:** mirror the tombstone guard — exclude from eviction any row still satisfying a retained bucket's scope (server filters `removedBuckets` against retained scope, or client purges by "in no retained bucket").

### 🟠 P1 (latent) · A1 — `dependsOn` cascade-cancel is non-functional
**Where:** `db-collection/mutators.ts:312` (`dependsOn = def.dependsOn(args)` — an app/domain string), `:150` (`poisonedKeys` holds only the internal random `idempotencyKey`), `:219` (`poison.isPoisoned(dependsOn)` compares across **disjoint namespaces** → never true); server never reads `dependsOn` (declared only at `kernel/types.ts:149`).
**Scenario:** app declares `payment` depends on `credit`; the `credit` mutation is terminally parked (dead-lettered). The cascade-cancel check can't match, so the `payment` pushes and applies anyway.
**Consequence:** a ledger with the dependent op but not its dependency → **wrong balance**. Currently unwired by any app (no test uses real `dependsOn`), but a **trap**: an adopter who sets `dependsOn` reasonably expects cascade-cancel and silently gets none. Server-side dependency ordering via `dependsOn` is also unimplemented.
**Fix:** make `dependsOn` reference a poisonable identity (expose the dependency's `idempotencyKey`/`clientMutationId` and compare against it), and/or honor `dependsOn` server-side for ordering; until then, document it as non-functional.

---

## LATENT / LOWER-SEVERITY (verified)

- **🟡 P2 · D2 — HLC nodeId truncated 128→64 bits.** `kernel/hlc.ts:82-85` keeps only the last 16 hex of the UUID nodeId; field-merge breaks ties by strict `<` on the full HLC (`server/index.ts:1170`). An exact `wallTime+counter+truncated-nodeId` collision → byte-equal HLC → the **incoming field edit silently loses**. Low probability, on the ledger `field`-merge path; discards the entropy meant to break ties. Fix: use the full nodeId (or ≥96 bits).
- **🟡 footgun · D1 — `clientID` device-uniqueness assumed, not enforced.** The mutation watermark keys on the **raw** `clientID` (`storage.ts:222`) while bucket reconciliation keys on an **actor-scoped** device id (`:852`). Default mints a per-device UUID (safe), but if an app sets `clientID` to anything non-device-unique, two devices share a `_nizhal_clients` row → the second's writes hit `alreadyApplied` → **silently dropped**. Fix: validate/derive `clientID` as device-unique; reconcile the two scoping schemes.
- **🟡 design · F2 — `lww` orders by commit, not HLC.** `server/index.ts:1021` plain UPDATE; HLC consumed only by `field` merge. A stale offline `lww` update replayed later beats a causally-newer online write. Enshrined as intended in `sync-core.test.ts` — **product decision to confirm**, not a defect; consider HLC-tiebreaking `lww` since every mutation already carries an HLC.
- **🟡 P1 perf · G2 — Pull loads the entire in-scope changeset into memory before paging.** `buildDataQuery` has no SQL `LIMIT` (`storage.ts:668`); `limit`/`hasMore` trim only the JS array (`:537`). A far-behind client or large bucket forces O(all-in-scope) load+sort per pull — the bootstrap "Goldilocks" problem is unbounded. Fix: push `ORDER BY _nizhal_row_version LIMIT` into SQL per bucket + k-way merge.
- **🟡 medium · B2 — Background jobs that write synced tables don't publish.** `jobs.ts` never calls `realtime.publish`, and `inProcessRealtime` installs no DB triggers → scheduled ledger postings are invisible to live clients until reconnect. Fix: publish affected buckets from the job commit path (or use a trigger-based realtime adapter).
- **🟡 edge · B3 — `affectedBuckets` filtered against post-commit membership** (`index.ts:1251`): a mutator that removes the actor from a bucket drops the notification to that bucket's remaining members. Fix: compute affected buckets from the write, independent of the actor's post-commit membership.
- **Design ceilings (from `/code-understand`):** O4 `_nizhal_next_row_version()` singleton `FOR UPDATE` = global write-throughput bottleneck (the Linear `lastSyncId` problem); O5 crdt Yjs bytes never compacted (monotonic growth); O6 realtime is full repull, no delta poke (lunora proves a WAL-free membership-diff is possible — the one new primitive most worth building).

---

## REFUTED (verified SAFE — so the review doesn't re-chase these)

| Hypothesis | Why it's safe | Evidence |
|---|---|---|
| Version-tie page-skip on pull | Every change row + every tombstone/bucket_exit gets a **fresh unique** `_nizhal_row_version` → no ties → `>cursor` paging can't skip | `storage.ts:1119,1157,1172,1184` |
| `staleSequence`/`outOfOrder` reallocation → double-apply or livelock | `idempotencyKey` (clientMutationId) preserved across reallocation; server `claimMutation` + `isApplied` dedup converges | `mutators.ts:467`, `storage.ts:189` |
| Restart re-emits a fresh idempotency key → double-apply | `idempotencyKey` is persisted in the outbox and restored | `mutation-id.ts`, durable outbox |
| Dependent ops reordered | Push is strict-FIFO single-flight (`withSequenceLock`) | `mutators.ts:402` |
| Concurrent same-`clientMutationId` double-apply | `_nizhal_mutations` PK + `checkMutationSequence` `FOR UPDATE` | `storage.ts:189,222` |
| crdt CAS exhaustion silently drops a write | `SELECT … FOR UPDATE` inside the serialized tx makes version-change-under-CAS unreachable | `index.ts:1052` |
| Burn-crash wedges the sequence | `checkMutationSequence` advance rolls back with the failed tx; `burnSequencedMutation` re-advances | `index.ts:659,740` |
| Cursor encode/decode round-trip / `>cursor` boundary | base64url(bigint) round-trips; globally-unique sequence | `storage.ts:458-488` |

---

## Priority order for fixing (ledger/chat-weighted)
1. **G1** (P0, silent missing history on join/grant — the most common-path data loss).
2. **C1** (P0–P1, routine network blip freezes a collection — high frequency).
3. **B1** (P1, live broadcast lost + committed push 500s — breaks the live guarantee).
4. **F1** (P1, overlapping-bucket eviction).
5. **A1** (P1 latent, fix or document `dependsOn` before anyone ships a credit→payment dependency).
6. Then D2, D1, G2, B2 as hardening; decide F2 (product call); scope O6 (delta poke) as the new primitive.
