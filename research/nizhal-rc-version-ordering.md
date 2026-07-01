# RC & Triage — the row-version global-lock / silent-skip (the deferred "chattiness" fix)

> `/diagnose` + `/triage-issue`. The sprint deliberately deferred the `nextval` swap because doing it naively *introduces* silent row-skip. This roots-causes it empirically and lands a validated, lock-free, no-WAL fix from prior art. (No GitHub remote on this repo — this doc is the issue body.)
> Repro: [`_notes/version-skip-repro.mjs`](./_notes/version-skip-repro.mjs) · Prior art: [`_notes/monotonic-watermark-prior-art.md`](./_notes/monotonic-watermark-prior-art.md).

## Symptom
Every synced write serializes through `_nizhal_next_row_version()`, which takes `SELECT … FOR UPDATE` on the `_nizhal_sync_control` singleton (`storage.ts:1049`) to assign `_nizhal_row_version`. This is the **chattiness / throughput bottleneck** (measured: warm-RTT-bound, one global lock per write; the Linear-`lastSyncId` problem, finding O4). The obvious fix — a plain `nextval` — was correctly flagged as **introducing a silent data-loss bug**.

## Root cause (empirically proven)
The engine **conflates version-*assignment* order (write time) with commit-*visibility* order (commit time).** A `> cursor` reader assumes *"if I've seen version N, every version ≤ N is visible."* That holds **only if assignment order == commit order.** The singleton lock enforces it by serializing assignment with the whole write; a lock-free `nextval` breaks it.

**Repro (real Postgres, interleaved transactions — PGlite can't, it's single-connection):**
```
1. NAIVE lock-free nextval()  → 🔴 SILENT SKIP CONFIRMED
   A grabs ver=1 (held open); B grabs ver=2, commits first.
   reader pull(cursor 0) → [B], cursor→2.  A commits.  reader pull(cursor 2) → [].
   Row A is committed but the reader NEVER returns for it. → the RC.
2. SINGLETON FOR UPDATE        → ✅ safe: B blocks on the lock until A commits → assignment==commit, but every write serialized.
3. commit-timestamp cursor      → ✅ works but weak (non-unique, unindexable, vacuum-dropped).
4. xid8 + snapshot-xmin horizon → ✅ lock-free AND exact (the recommended fix — see below).
```
Run: `DATABASE_URL=<real-pg> node research/_notes/version-skip-repro.mjs`.

## How the field solves "monotonic sync watermark without a global lock"
Three escape routes (full survey + sources in `_notes/monotonic-watermark-prior-art.md`):

| Route | Who | Mechanism | Fits Nizhal? |
|---|---|---|---|
| **Assign at COMMIT, in commit order, lock-free** | Zero, Electric, PowerSync, Instant, Debezium (**WAL LSN**); FoundationDB/**Convex** (commit version) | the DB stamps the number on the commit record; consumer reads whole txns in commit order; resume at `confirmed_flush_lsn` | ❌ needs WAL/slot — violates Nizhal's no-WAL thesis |
| **Assign at write, advance reader only to the settled prefix** | **Postgres snapshot `xmin`**; Kafka high-watermark (min LEO); Debezium watermarks | low-water mark below which every txn is settled; reader never crosses an in-flight txn | ✅ **stock Postgres, no slot, no GUC** |
| **Global counter** (serialize assignment+commit), or **accept overlap + dedup** | **Linear `lastSyncId`** = Nizhal's singleton; **WatermelonDB** `last_pulled_at` (wall clock + idempotent merge) | one hot counter, or coarse re-pull window | ⚠️ counter = the bottleneck we're escaping; overlap = fine as a fallback |

The universal lesson (Kafka, Debezium, FoundationDB, MVCC): with lock-free assignment you **must not advance the cursor to the max you've seen — advance it to the min of the in-flight frontier.**

## Recommended fix — write-time `xid8` + reader-side snapshot-`xmin` horizon
Reconstructs the WAL/FoundationDB "commit-ordered cursor" on **stock Postgres, no replication privileges, no write-path lock.** Validated by demo #4 above.

**Schema (replace the singleton-locked row-version):**
```sql
-- drop _nizhal_next_row_version() + the _nizhal_sync_control FOR UPDATE from the write path
ALTER TABLE <t> ADD COLUMN _nizhal_seq xid8 NOT NULL DEFAULT pg_current_xact_id();
-- BEFORE UPDATE trigger re-stamps: NEW._nizhal_seq = pg_current_xact_id();
CREATE INDEX <t>_nizhal_seq_idx ON <t> (_nizhal_seq);
```
`pg_current_xact_id()` reuses the xid the write already consumes — **no extra lock, no hot singleton.**

**Reader (cursor is an `xid8` per client):**
```sql
SELECT pg_snapshot_xmin(pg_current_snapshot()) AS horizon;          -- settled-prefix low-water mark
SELECT * FROM <t> WHERE _nizhal_seq >= :cursor AND _nizhal_seq < :horizon ORDER BY _nizhal_seq, id;
-- cursor := horizon
```

**No-skip proof:** by `xmin`'s documented semantics every txn `< horizon` is committed-or-aborted (aborted rows invisible under MVCC); xids are handed out monotonically so **no future txn can land below `horizon`** → the prefix `[…, horizon)` is *frozen and complete*; an in-flight txn has `_nizhal_seq ≥ horizon` so it's excluded now and picked up once the horizon passes it. The cursor **never crosses an in-flight transaction** → out-of-order-commit skip is structurally impossible (demo #4: B held at horizon 755 while A in-flight, then `[A,B]` at 757).

**Cost (honest):** a long-running write txn holds `xmin` back, stalling the watermark (sync latency) — the *same* head-of-line behavior as VACUUM's xmin, bounded by your longest write txn. **Strictly better than today:** writers never block each other; only the reader's *advance* waits, and only for genuinely-in-flight work.

## Fix plan (TDD, sequenced — its own increment, not an end-of-sprint bolt-on)
1. **Regression test first** — promote `version-skip-repro.mjs` into a real-Postgres vitest (gated on a `DATABASE_URL`, since PGlite can't do concurrency): assert naive-nextval skips, and the xid8+horizon path delivers `[A,B]` with no skip. This is the correct seam (the bug needs ≥2 concurrent writers — a single-connection test gives false confidence).
2. **Schema/provision** — swap `_nizhal_row_version bigint DEFAULT _nizhal_next_row_version()` → `_nizhal_seq xid8 DEFAULT pg_current_xact_id()`; BEFORE-UPDATE re-stamp; index `(bucketCol, _nizhal_seq)`. Remove the singleton + `_nizhal_next_row_version()`.
3. **Cursor type** — change `Cursor` from base64(bigint) to base64(xid8); `normalizePullCursor` clamps against `pg_snapshot_xmin` (not `last_value`); `getPostgresChanges` filters `_nizhal_seq >= cursor AND _nizhal_seq < horizon` and advances `cursor := horizon`. The tombstone/removal `row_version` columns move to `xid8` too (they already get a fresh value — now a fresh xid).
4. **Interplay with shipped fixes** — G1's added-bucket detection and F1's eviction are cursor-mechanism-agnostic (they key off the bucket set, not the version type) — they carry over. Re-run their tests against the new cursor.
5. **Migration** — alpha, no production data; a clean reprovision. If needed, backfill `_nizhal_seq` from existing rows (monotonic order preserved) and force one `cursorReset`.
6. **Verify** — the new concurrency regression test green on real Postgres; the existing 69 server + 99 db-collection tests green; measure the throughput win (no global lock).

## Post-mortem — what would have prevented this
The bug class is *"a correctness invariant (cursor monotonicity) enforced by a performance-killing mechanism (global lock) because the cheaper, correct mechanism (settled-prefix horizon) wasn't known."* Prevention is architectural: **document the cursor's correctness contract** ("the watermark must be a commit-ordered low-water mark, never a write-time assignment order") in an ADR next to the storage adapter, so the next person doesn't reach for a plain `nextval` (silent skip) *or* a global lock (bottleneck). Hand-off candidate for `/improve-codebase-architecture` once the fix lands.
