# Nizhal — Code-Review Readiness Brief

> The deliverable: everything needed to run a complete `/code-review` of Nizhal (this repo, codename `echo`) **with the full sync-engine landscape as backing**. It names the **missed primitives** to investigate, the **claimed properties** a review must verify (and how to falsify them), and a **subsystem checklist** with `file:line` anchors.
> Grounded in: [`_notes/nizhal-inventory.md`](./_notes/nizhal-inventory.md) (first-hand code inventory) + the landscape ([`sync-engine-landscape.md`](./sync-engine-landscape.md)) + the three engine deep-dives. Written for a reviewer newly onboarded to improve Nizhal.

---

## A. Nizhal in one page (the baseline you're reviewing)

**What it is.** A toolkit that generates a **self-host, no-WAL, any-Postgres** offline-sync engine from a declarative spec. Build-time generality, **coupled output** per app (the Linear/Figma "coupled is good" bet). Packages: `@nizhal/kernel`, `@nizhal/server`, `@nizhal/db-collection` (TanStack DB adapter), `@nizhal/cli`, `@nizhal/react-native`. Reference app: `apps/credit-ledger`.

**The convergence model (3 composed primitives):**
- **Buckets** — declarative, **no-leak-linted** sync rules (`assertSyncRulesNoLeak`, `kernel/sync-rules.ts:155`): every synced row provably bucket-scoped; raw SQL + zero-scope queries rejected.
- **Per-table merge policy** — `lww` (commit-order via `_nizhal_row_version`), `field` (per-field HLC tiebreak in a `_meta jsonb`), `crdt` (Yjs byte-merge under row-version CAS). Split at write time by `mergeAwareTx` (`server/index.ts:970`).
- **HLC clock** (`kernel/hlc.ts`) — sortable, causal, drift/overflow-guarded; the `field`-merge tiebreak.
- On top: apps model money/inventory as **append-only movement ledgers, `balance = fold(entries)`** so the dominant write is a conflict-free insert.

**The transport & protocol.** Opaque total-order **cursor pull** over a Postgres sequence (`_nizhal_row_version_seq`, **no WAL/logical replication**); idempotent **push** via `clientMutationId` claim + per-client contiguous `mutationID`; realtime sourced from the **commit chokepoint** (`realtime.publish(bucket)` → client gets `repull:${bucket}` → authoritative pull). Adapters: `inProcessRealtime`, `listenNotifyRealtime`, Cloudflare-DO.

**The client.** Durable **real-SQLite** outbox (op-sqlite native / wa-sqlite web) + **TanStack DB** for reactive reads; poison/dead-letter + `dependsOn` cascade-cancel; local-write barrier (field-merge of unacked optimistic writes); reconnecting WS; access-revocation eviction (`removedBuckets`).

**The bet, restated:** *no WAL* buys self-host-on-any-Postgres and operational simplicity; it **costs server-side IVM** (so realtime is repull-on-hint, not incremental delta). Everything below is downstream of that trade.

---

## B. The missed-primitives register (the user's explicit ask)

Prioritized. **P0** = product-thesis or security gap; **P1** = real capability/scaling gap worth building; **P2** = polish/known-deferred. Each: what it is, who has it, why it matters *for Nizhal's POS/ledger target*, evidence, and where to look.

### P0 — `nizhal gen` and `nizhal introspect` are unimplemented (the decoupling thesis is half-built)
- **What.** The README's core "contract-decoupled" bet is: server emits `/nizhal/contract` (OpenAPI+`x-echo`), client generates types via `nizhal gen` — *no server/Drizzle import on the client*. But `gen` and `introspect` **hard-throw** `notImplemented` (`cli/index.ts:36,39`).
- **Who has it.** tRPC/Zero/Electric all ship the typed-client story; it's table stakes for the "don't be tRPC" positioning.
- **Why it matters.** Today a consumer must hand-write client types or import server types — defeating the decoupling that distinguishes Nizhal from a monorepo-coupled engine. The contract emitter exists and is tested; only the consumer half is missing.
- **Review action.** Confirm the contract is rich enough to generate from (it carries `collections`, `merge`, `mutators` input refs, `syncRules` — `kernel/contract.ts`). Scope `gen` as the highest-leverage missing primitive.

### P0 — `related` / correlated-subquery read-authorization recursion (partial-sync auth leak) — ✅ CLEARED by verification
- **Verdict (verified in code, `/code-understand` pass):** **NOT a leak.** `related` queries are lint-recursed (`sync-rules.ts:223`) **and** at runtime **flattened** by `flattenDataQueries` (`sync-rules.ts:185`) into *independent* top-level queries, each executed with its own `buildBucketScope` (`storage.ts:507,655`). There is **no correlated JOIN** — a related table can only be scoped to bucket-key values the actor already holds, so the existence-oracle / visibility-widening risk does not arise. Caveat: `.related(` is **unused by every Nizhal app/test** (all hits are in the vendored `research/zero-mono/`), so the mechanism is implemented + linted but unexercised — add a VAPT test if/when an app adopts it (open question O3).
- **What.** Sync-rule data queries support `related` sub-queries (`kernel/sync-rules.ts:49`). The no-leak lint checks each `related` query is bucket-scoped (`collectQueryLintIssues` recurses, `:223`).
- **Who has it.** Zero **rewrites the AST recursively into correlated subqueries** specifically to close the existence-oracle (`read-authorizer.ts`); Convex cites Arc's **CVE-2024-45489** as the partial-sync-permissions cautionary tale.
- **Why it matters.** The classic sync auth leak: a related/joined row leaks data outside the user's bucket. Nizhal's lint is structural (every query scoped) but the review must prove **composition** is safe.
- **Review action.** Trace `buildDataQuery` (`storage.ts:655`) for `related` queries; write a VAPT test: a `related` query whose join would pull a foreign-bucket row — assert it's excluded. (Existing `security-vapt` tests cover *write* scope, not `related` *read* widening.)

### P1 — No server-side incremental delta (membership diff) — realtime is full repull
- **What.** On a write Nizhal sends `repull:${bucket}`; the client re-reads everything `_nizhal_row_version > cursor` in that bucket. There is **no per-write row-delta**.
- **Who has it.** **lunora** computes a **membership diff** without WAL: drain the CDC op-slice for changed ids, probe `selectShapeMemberIds(effectiveWhere, ids)`, emit only insert/update/delete row-ops (`lunora` `shard-do.ts:6352`). Zero does full IVM.
- **Why it matters.** This is **the most borrowable primitive in the whole study** because lunora proves you can do incremental deltas **without WAL** — exactly Nizhal's constraint. For a large shared bucket (a busy shop, a multi-cashier POS), repull bandwidth grows with bucket size per write; a membership-diff poke grows with *writes*. Nizhal already has the ingredients: `_nizhal_row_version`, the audit log, per-bucket indexes.
- **Review action.** Scope a "delta poke" primitive: the `repull` hint could carry the changed row(s) computed from the mutation's affected rows (the server already knows them in `mergeAwareTx`). This is a P1 *new primitive to develop*, not a bug.

### P1 — Overlapping-bucket eviction wrongly drops in-scope rows — ✅ CONFIRMED (lead finding)
- **Verdict (verified first-hand in code):** **Confirmed correctness bug.** Server `reconcileClientBuckets` computes `removedBuckets` as a pure **set-difference of bucket keys** (`storage.ts:854`) with **no row-level "still visible elsewhere" guard** — even though the *tombstone/bucket-exit* path has exactly that guard (`getVisibleRemovalRows`, `storage.ts:783`). The client `purgeRemovedBuckets` (`sync.ts:517`) then **deletes the entire collection when no `bucketField` is configured** (`:524-528`), or deletes rows by their single `bucketField` value (`:531-537`). So a row reachable via two buckets (one revoked, one retained) is wrongly evicted — and because cursor pull only returns rows with `_nizhal_row_version > cursor`, the evicted row is **not re-delivered** until it next mutates → *persistent* wrong eviction. Asymmetry note: pull *dedups* overlapping buckets correctly (`seenRows`, `storage.ts:517`); only the revocation-eviction path lacks the symmetric guard.
- **What.** A device can be in multiple buckets (`_nizhal_client_buckets`). A **row belonging to two buckets** the device subscribes to is wrongly evicted when access to *one* is lost.
- **Who has it.** **Zero's CVR refcounts** every row per query and deletes only at refcount 0. Nizhal's client-side eviction purges "all local rows whose `bucketField` is in the removed set" (`sync.ts:244`) — a row reachable via two buckets but tagged with one `bucketField` could be wrongly purged, or a row with no `bucketField` purges the whole collection.
- **Why it matters.** Multi-bucket membership is exactly the POS case (a product visible in "store A" and "all-stores" buckets). Wrong eviction = data disappears from a screen the user still has access to.
- **Review action.** Construct a two-overlapping-buckets test: revoke one, assert rows still in the other survive. Inspect `reconcileClientBuckets` (`storage.ts:841`) and the client `purgeRemovedBuckets` (`sync.ts:517`). **Likely a real correctness gap.**

### P1 — Bucket cardinality ceiling & observability
- **What.** Dynamic/membership buckets (`b.membership`) create one bucket per parameter value. There is **no documented cardinality limit or metric**.
- **Who has it.** **PowerSync's headline limit is 1,000 buckets/user** (`PSYNC_S2305` "Too Many Buckets") — they treat cardinality explosion as *the* operational risk of bucketed sync.
- **Why it matters.** A sync rule keyed on a high-cardinality column (e.g. per-customer) silently explodes buckets → fan-out cost, `_nizhal_client_buckets` bloat, realtime publish storms. Nizhal inherits the exact failure mode PowerSync warns about, without the guardrail.
- **Review action.** Check whether `reconcileClientBuckets` / `realtime.publish` cost scales with bucket count per device; add a cardinality metric to `/nizhal/stats`. P1 *to develop* (a limit + a warning).

### P1 — `lww` uses commit-order, not HLC — a causally-older offline write can clobber a newer one
- **What.** `lww` mode = "plain commit-ordered update" via `_nizhal_row_version` (inventory §2). HLC is used **only** in `field` mode. So a write that was made *earlier* on an offline client but *replayed later* overwrites a *causally newer* server value.
- **Who has it.** Figma/Linear order by server receipt too (and accept it); but they have *no offline-for-days* story. Nizhal advertises durable offline — so a stale offline `lww` write resurfacing days later and winning is a real anomaly. PowerSync's checkpoint barrier sidesteps this (client can't advance past pending writes); Nizhal's local-write-barrier is per-key but the *server* still applies in commit order.
- **Why it matters.** For the ledger target it's mostly moot (inserts, not updates). But `customers` is `field`-merged and other tables default `lww` — a stale offline rename winning is surprising. Decide if `lww` should be HLC-tiebroken too (Nizhal already stamps every mutation's `hlc`).
- **Review action.** Verify the intended semantics are documented; test "old offline update vs new online update to same `lww` field." Consider an `lww`-with-HLC default.

### P1 — Client schema evolution of synced business tables
- **What.** Nizhal has **client-store** migrations (engine tables, versioned, downgrade-guarded — `migrate.ts`). But evolving a **synced business table** (add/rename a column) across many clients at different versions has no described mechanism.
- **Who has it.** Field-wide hard problem (Ink & Switch **Project Cambria** = bidirectional lenses). Most engines punt; naming it is the value.
- **Why it matters.** A column added server-side must reach old clients without breaking their local SQLite/TanStack schema; a rename is worse. This is the kind of "primitive that was missed" that bites in production.
- **Review action.** Check how a new column flows through `getChanges` → pull → client apply → local SQLite. Likely a documentation + forward-compat-codec gap.

### P2 — Bucket/data priorities (preemption)
- PowerSync supports **bucket priorities** (high-priority data preempts). Nizhal pulls in one cursor order. For a POS, "show today's open tickets before last year's history" would want this. Absent; P2 *to develop*.

### P2 — CRDT byte-history GC / compaction
- Yjs documents accumulate update history (Ink & Switch's metadata-growth problem). Verify whether Nizhal ever compacts the `crdt` bytea (`mergeCrdtRow`, `index.ts:1071`) or grows unbounded. P2.

### P2 — Cloudflare presence-v2 + hibernation-efficient keepalive
- Cloudflare adapter implements only `publish` + **no-op `subscribe`**, **no presence-v2** (inventory §5). And the client uses an **app-level heartbeat** (wakes the worker) where **lunora uses `setWebSocketAutoResponse`** (answered without waking the DO → zero billable wakeups). For a Cloudflare-hosted deployment this is a direct cost primitive. P2.

### P2 — Multi-tab / multi-client-per-device coordination
- Replicache's **client groups** let one tab recover another's pending mutations. Nizhal has leader election (the `mutation-id-continuity` test asserts "serializes producers through one elected leader") — verify robustness across tab-close mid-flush and shared-outbox races. P1→P2 depending on target (RN-first lowers urgency).

---

## C. Claimed-property verification matrix (the correctness review)

Each is a property the code *claims*; the review must **prove or falsify** it. Build the falsification loop first (per the diagnose discipline), don't reason from the happy-path test.

| Property | Where claimed | Risk if false | How to falsify |
|---|---|---|---|
| **Idempotent push under concurrency** | `claimMutation` `INSERT … ON CONFLICT DO NOTHING` + `checkMutationSequence` `SELECT … FOR UPDATE` (`storage.ts:189,222`) | double-apply or lost write | Two concurrent requests, same `clientMutationId`, interleave the claim vs sequence check; assert mutator body runs exactly once. (`security-regression.test` covers duplicate; add the *claim-vs-sequence interleave*.) |
| **No silent write loss across offline/replay** | extensive (`repro-offline-loss-*.test.ts`) | the cardinal sync sin | These tests are strong (100+ varied batches). Re-run with *power-loss between handler-commit and watermark-advance* (lunora self-heals this; verify Nizhal does via the `claim`+`recordApplied` ordering). |
| **`field` merge is causally correct** | `fieldMergeUpdate` HLC compare (`index.ts:1151`) | wrong field wins | Two clients edit different fields then same field with crossed HLCs; assert per-field winner = highest HLC, and the `_meta` write is atomic with the column (same UPDATE). |
| **`crdt` converges under concurrent edits** | `mergeCrdtRow` Yjs `applyUpdate` under row-version CAS, ≤5 retries (`index.ts:1041`) | divergence or CAS livelock | Two clients edit same Yjs text concurrently (`crdt-integration.test` covers convergence); add a **CAS-exhaustion** case (6+ concurrent writers) — does it error or wedge? |
| **Every synced row is bucket-scoped (no leak)** | `assertSyncRulesNoLeak` (`sync-rules.ts:155`) | data leak across tenants | Covered for raw/unscoped; **extend to `related` read-widening** (see P0). |
| **Every write is scope-checked** | `rowMatchesScope` → 403 (`storage.ts:438`) | tenant write breach | `security-vapt` covers foreign-bucket writes; verify cascades (multi-table mutator) check *every* affected row, not just the first. |
| **Cursor is monotone & reset is safe** | base64 bigint over `_nizhal_row_version_seq`; `cursorReset` clamps future/invalid (`storage.ts:458`) | missed rows or infinite re-bootstrap | Feed a future cursor, a torn cursor, and a cursor past a sequence wrap; assert `cursorReset` re-bootstraps without dropping rows. |
| **Poison write can't wedge the per-client sequence** | `burnSequencedMutation` (422) (`index.ts:740`) | one bad mutation halts a client forever | `offline-batch-harness` covers; verify a *dependsOn* chain where the parent is poisoned cancels dependents (claimed `:219`) and the sequence still advances. |
| **HLC drift guard** | `assertHlcBounds` 60s drift / counter overflow (`hlc.ts:87`) | clock-skew DoS or ordering break | Feed a remote HLC 1h in the future; assert it throws rather than poisoning the clock. |
| **Revocation evicts, no phantom rows** | `removedBuckets` purge (`sync.ts:244,517`) | stale data visible after access loss | The overlapping-bucket case (P1) is the falsification — revoke one bucket, assert other-bucket rows survive *and* truly-removed rows vanish. |

---

## D. Subsystem review checklist (with anchors)

**`@nizhal/kernel`**
- [ ] `sync-rules.ts` — does `related` recursion (`:223`) fully bound visibility? Does `b.raw` (`:97`) bypass the no-leak lint anywhere it's allowed?
- [ ] `mutator.ts` — mutator runs client+server; confirm no non-determinism trap (ids generated in mutator? Convex/Zero forbid it — Nizhal uses `clientMutationId`, verify args don't carry server-only state).
- [ ] `hlc.ts` — `normalizeHlcNodeId` truncates to 16 hex; collision risk across many clients? `parseHlc` regex strictness.
- [ ] `contract.ts` — is the emitted contract sufficient for a future `gen`? (it is the P0 enabler).

**`@nizhal/server`**
- [ ] `index.ts:651` `applyMutation` — the claim/sequence/run/record/publish ordering under crash; the `mergeAwareTx` (`:970`) per-column split correctness; multi-row CRDT CAS retry bound.
- [ ] `storage.ts` — `getChanges` (`:490`) batching is O(T) not O(M·T) (tested in `getchanges-bench`); `reconcileClientBuckets` (`:841`) overlapping-bucket correctness (P1); `_nizhal_next_row_version` `FOR UPDATE` singleton lock (`:1049`) — is it a write-throughput bottleneck (the Linear `lastSyncId` single-ordering-point problem)?
- [ ] `adapters/realtime.ts` — `publish` from commit chokepoint only; `listenNotifyRealtime` suppress-notify gating; **does repull fan-out scale with bucket cardinality?** (P1).
- [ ] `adapters/cloudflare/` — no-op `subscribe`, no presence-v2 (P2); fail-closed auth (`authorization.ts:33`); hibernation keepalive cost vs lunora's auto-response.
- [ ] `jobs.ts` — dead-letter at `maxAttempts`; side-effects-in-jobs pattern (good, Convex-aligned).

**`@nizhal/db-collection`**
- [ ] `sync.ts` — local-first vs server-auth apply paths; the **eviction correctness** (P1); TTL eviction interplay with revocation.
- [ ] `mutators.ts` + `mutation-id.ts` — sequence allocation under the leader-election + restart (the `mutation-id-continuity` regression); `withSequenceLock` re-allocation on `outOfOrder`.
- [ ] `push-errors.ts` — terminal vs retriable boundary (parking = user-visible loss); is the `{400,401,403,404,405,422}` set right (e.g. is a 422 *always* poison)?
- [ ] `local-write-barrier.ts` — field-level merge of unacked writes; the `lww`-clobber question (P1).
- [ ] `persistence/` — SQLite op-queue mutex (no interleave); migration downgrade guard; **business-table schema evolution** (P1).
- [ ] `websocket-source.ts` — backoff/jitter, stability gate, heartbeat; reconnect always triggers catch-up pull.

**Reference app `apps/credit-ledger`**
- [ ] The `A-E2E` fitness test (`e2e.test.ts`) is the north star — confirm it actually exercises offline→reconnect→`balance=fold` across two clients (it does). Use it as the regression baseline for any change.

---

## E. How to run the review

1. **Adopt the falsification loop (diagnose §10).** For each P0/P1 property in §C, build a *failing-first* test before reasoning. The repo's PGlite harness (`apps/credit-ledger/test/harness.ts`) + the `offline-batch-harness` fault injector are the ready-made loops.
2. **Lead with the two P0s** (security: `related` read-auth; thesis: `gen`/`introspect`) — they're the highest-leverage and the security one is falsifiable today.
3. **Then the P1 correctness pair** — overlapping-bucket eviction and `lww`-vs-HLC — both are concrete, testable anomalies, not opinions.
4. **Treat server-side membership-diff (P1) as a design RFC**, not a bug — it's the one *new primitive* the landscape most strongly suggests, and lunora proves it's achievable without WAL.
5. **Use `/code-review high` per package**, seeded with the anchors in §D; escalate to `ultra` for the `applyMutation`/`mergeAwareTx` concurrency core, which is where a real bug, if any, lives.

---

### Appendix — research artifact index
- [`lunora-sync-engine.md`](./lunora-sync-engine.md) · [`replicache-sync-engine.md`](./replicache-sync-engine.md) · [`zero-sync-engine.md`](./zero-sync-engine.md) — per-engine visual models.
- [`sync-engine-landscape.md`](./sync-engine-landscape.md) — the comparison + primitives catalog.
- `_notes/` — raw reverse-engineering notes (lunora A/B/C, replicache, zero-client-protocol, zero-zql-cache, web-landscape, nizhal-inventory).
- `_notes/youtube/` — 12 talk transcripts + `SYNTHESIS.md` (~90 primitives).
