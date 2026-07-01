# Monotonic, gap-tolerant sync watermarks: prior art and a recommendation for Nizhal

**The one problem.** For incremental (`> cursor`) sync you need a watermark that is (a) **monotonic** (so `> cursor` makes progress), (b) **gap-tolerant / resumable**, and (c) **never lets a reader skip a row that committed out-of-order**.

**The core tension (restated precisely).** If you assign a sequence number at **write time** (lock-free — `nextval`, an `INSERT … RETURNING id`, an auto-increment), then **assignment order ≠ commit-visibility order**. Concretely: transaction A grabs seq `N-1` then B grabs seq `N`; B commits first. A reader sees row `N` (committed, visible), advances its cursor past `N`, and **never comes back for `N-1`** when A finally commits. Row `N-1` is silently skipped.

A **global lock that serializes "assign the number" with "commit"** removes the gap (assignment order *becomes* commit order), but it is a single hot row every writer must pass through — Nizhal's `_nizhal_sync_control` singleton `FOR UPDATE`, Linear's global `lastSyncId`. It kills write concurrency.

Every system below resolves the tension in one of three ways:

1. **Assign the number at COMMIT, in commit order, lock-free** — the database itself does this on the WAL/MVCC commit path (Postgres LSN, FoundationDB commit version, Convex commit timestamp). Assignment-order *is* commit-order by construction. *Requires database-internal machinery.*
2. **Assign at write time, but only ADVANCE the reader's cursor to the settled prefix** — the "low-water mark / snapshot horizon" below which every transaction is committed-or-aborted, so nothing can still appear there (Postgres snapshot `xmin`; the general CS pattern; Debezium/DBLog watermarks). *Works on a stock database with no commit hook.*
3. **Serialize assignment with commit via a global counter** — accept the bottleneck (Linear `lastSyncId`, Nizhal singleton), or **accept overlap and dedup** so exact order stops mattering (WatermelonDB).

---

## 1. Postgres WAL LSN — assigned at COMMIT, in commit order, for free

Used by **Zero / zero-cache**, **ElectricSQL**, **PowerSync**, **InstantDB**, **Debezium**.

**Why the LSN gives commit-order for free.** The WAL LSN (Log Sequence Number) is the byte position of a record in the write-ahead log. A transaction's **COMMIT record** is written to the WAL at the instant the transaction commits, so commit records appear in the WAL **in commit order**, and their LSNs are therefore monotonically increasing in commit order. The number is assigned by the WAL-insert path under a lightweight WAL-insert lock that every commit already takes — there is **no separate global serialization point for sync**; you reuse the commit machinery.

**How a logical-replication / CDC consumer makes it a gap-free resumable cursor.** Logical decoding reads the WAL through a **replication slot** and a **reorder buffer**: it buffers a transaction's changes keyed by xid and **emits them only when it reaches that transaction's COMMIT record**. So even though interleaved data records for concurrent A and B are physically intermixed in the WAL, the consumer receives *whole transactions, in commit order*. If A starts before B but B commits first, B is delivered first — exactly the order a cursor needs ([PostgreSQL streaming-replication protocol](https://www.postgresql.org/docs/current/protocol-replication.html)).

Two LSNs on the slot define the resumable point ([Gunnar Morling, "confirmed_flush_lsn vs restart_lsn"](https://www.morling.dev/blog/postgres-replication-slots-confirmed-flush-lsn-vs-restart-lsn/), [devgenius internals](https://blog.devgenius.io/postgresql-logical-replication-internals-restart-lsn-vs-confirmed-flush-lsn-explained-312593202881)):
- **`restart_lsn`** — earliest WAL the slot still needs (Postgres won't recycle WAL past it). Decoding *restarts* here.
- **`confirmed_flush_lsn`** — the LSN up to which the **consumer has acknowledged durable receipt**. On reconnect, streaming of *decoded commits* resumes after this point. This is the **consistent point / resumable cursor**: everything `<= confirmed_flush_lsn` is durably consumed; everything after is replayed. Gap-free because the consumer advances it only after persisting, and commit-ordered because the WAL is.

**Per-system specifics (DeepWiki, primary):**

- **Zero / zero-cache** (`rocicorp/mono`): consumes `begin`/`data`/`commit` logical-replication messages in `PostgresChangeSource`. It explicitly notes **"LSNs from concurrent transactions can overlap, making them unsuitable for directly sorting individual messages,"** so `ChangeStreamerService` derives a **`Watermark`** — a monotonically increasing, lexicographically sortable id: a `commit` message gets the watermark of its commit LSN; `begin`/`data` get `preCommitWatermark` = previous-commit-watermark + 1; a `pos` column breaks ties inside a transaction. Changes are persisted to a `changeLog` table; the `Acker` sends ACKs that advance `confirmed_flush_lsn`. Replicators subscribe **from their current watermark**, the `Storer` does catch-up from that point, and the `Forwarder` buffers live changes until catch-up completes so **no row is skipped**. Initial sync uses the slot's `consistent_point` LSN as `replicaVersion`.
- **ElectricSQL** (`electric-sql/electric`): `ReplicationClient` decodes logical replication; `MessageConverter` assembles messages into `TransactionFragment`s delivered to `ShapeLogCollector` only **once the `Commit` arrives** (commit order). The LSN is the **shape-log offset**; `offset=-1` means "whole log from start," a specific LSN resumes. It tracks `received_wal` and `flushed_wal`; a `FlushTracker` computes the **minimum flushed offset across all shapes**, and only then advances `confirmed_flush_lsn` (a per-consumer low-water mark — see §8). Slot invalidation ⇒ purge shapes and refetch from a fresh consistent point.
- **PowerSync** (`powersync-ja/powersync-service`): `WalStream` consumes `pgoutput`; a **checkpoint** = `(WAL LSN, InternalOpId)`. After initial snapshot it records `pg_current_wal_lsn()` as `no_checkpoint_before` so a checkpoint can't be published until replication has caught past the snapshot window (no skipped rows). Clients resume from `(last_checkpoint opid, last_checkpoint_lsn)`. Keepalives via `pg_logical_emit_message` keep `confirmed_flush_lsn` advancing during idle.

**Relevance to Nizhal:** this is the gold standard, but it **requires WAL/logical-replication access** (a superuser-ish slot, `wal_level=logical`). Nizhal's constraint is *any self-host Postgres, possibly no WAL access* → this whole family is off the table as the primary mechanism. It is, however, the design to imitate: *assign in commit order, advance a low-water mark only over the durable/settled prefix.*

---

## 2. Postgres `track_commit_timestamp` / `pg_xact_commit_timestamp(xid)` — commit order without the WAL

Enable the GUC `track_commit_timestamp` (needs a restart; available on stock Postgres ≥ 9.5, **no replication privileges**), then `pg_xact_commit_timestamp(xid) → timestamptz` returns the wall-clock commit time of a transaction ([functions-info](https://www.postgresql.org/docs/current/functions-info.html)). Combined with each row's system column `xmin` (the inserting/updating xid), you can in principle order rows by *commit time* rather than write time, recovering some of the LSN's benefit without a slot.

**Tradeoffs (why it is weak as a cursor):**
- **Not unique, not a total order.** Commit timestamps are clock values; two transactions committing in the same microsecond get equal timestamps. There is no tiebreak, so `> cursor` can skip rows with the same timestamp, or re-read them, depending on `>` vs `>=`.
- **No monotonicity guarantee across the cluster.** It is wall-clock; NTP corrections can move it. Commit *order* ≠ timestamp order under skew.
- **It does not give you the settled-prefix.** A commit timestamp tells you *when* a settled txn committed, but a reader still needs to know which transactions might *still* commit below its cursor. The timestamp alone has no in-flight set; you still need the snapshot horizon of §3. So this never stands alone for the no-skip guarantee.
- **Lookup cost & retention.** `pg_xact_commit_timestamp` is a per-xid function call (no index over it), and **commit-timestamp data is removed by vacuum/freeze** — old rows lose their commit time. You cannot build an efficient indexed `WHERE commit_ts > cursor` scan.

**Verdict for Nizhal:** usable only as an *ordering attribute for display*, never as the correctness-bearing watermark. Skip as primary.

---

## 3. Postgres snapshot horizon (`pg_current_snapshot()`, `pg_snapshot_xmin`) — the settled-prefix low-water mark

This is the **canonical lock-free answer for a stock database**, and the backbone of the Nizhal recommendation.

`pg_current_snapshot() → pg_snapshot` exposes the MVCC visibility horizon as `xmin:xmax:xip_list` ([functions-info](https://www.postgresql.org/docs/current/functions-info.html)). The precise semantics, quoted:

> **`xmin`** — "Lowest transaction ID that was still active. **All transaction IDs less than `xmin` are either committed and visible, or rolled back and dead.**"
> **`xip_list`** — "Transactions in progress at the time of the snapshot."

So `pg_snapshot_xmin(pg_current_snapshot())` is a **hard horizon: every transaction below it is settled (committed-or-aborted) — none can still be in flight, and no future transaction can ever be assigned an xid below it** (xids are handed out monotonically increasing). Modern Postgres gives this as **`xid8`** (`pg_current_xact_id()`, 64-bit, monotonic, no wraparound), the indexable, sortable key we want. (Legacy `txid_current_snapshot()` / `txid_snapshot_xmin()` are the pre-13 `bigint` equivalents.)

**The pattern (assign at write, advance only to the horizon):**
1. Stamp every written row with the writing transaction's id: a column `seq xid8 DEFAULT pg_current_xact_id()` (set on insert *and* update). Lock-free — it reuses the xid the write already consumes.
2. The reader keeps an `xid8` cursor. Each pull:
   - read `horizon := pg_snapshot_xmin(pg_current_snapshot())`,
   - `SELECT … WHERE seq >= cursor AND seq < horizon ORDER BY seq, id`,
   - set `cursor := horizon`.
3. **Why it never skips:** the half-open prefix `[…, horizon)` is *immutable and complete* — every txn there is settled (so its rows are either visible-forever or dead-forever), and no later txn can inject a row with `seq < horizon`. A txn that was in flight at pull time has `seq >= horizon`, so it is excluded *now* and picked up on a later pull once the horizon passes it. The out-of-order-commit gap is **structurally impossible**: the cursor never crosses an in-flight transaction.

**Cost:** a single long-running write transaction holds `xmin` back, so the watermark (and thus sync latency) stalls until it commits/aborts — the *same* head-of-line behavior as VACUUM's xmin horizon. This is bounded by your longest write transaction and is dramatically cheaper than a global write lock: writers run fully concurrently; only the *reader's advance* waits.

---

## 4. FoundationDB versionstamps / commit versions — commit version assigned atomically at commit

FoundationDB uses **MVCC for reads, optimistic concurrency for writes**, with versions handed out by a single logical **Sequencer/master** through proxies ([FDB paper](https://www.foundationdb.org/files/fdb-paper.pdf), [data modeling](https://apple.github.io/foundationdb/data-modeling.html)):
- A transaction gets a **read version** from a GRV proxy at start: "guaranteed to be **no less than any committed version**" at that moment — a consistent snapshot.
- At commit, a commit proxy obtains a **commit version** from the Sequencer that is "**larger than any existing read or commit version**." Resolvers do OCC conflict checking; the version is assigned **atomically at commit**, in commit order.

A **versionstamp** is 10 bytes = 8-byte commit version + 2-byte intra-batch order, written into a key *as part of the committing transaction*. It is "**unique and monotonically increasing for the entire lifetime of a single cluster**" ([Fragno, "Versionstamps should be everywhere"](https://fragno.dev/blog/versionstamps)). Because it is the *commit* version, **assignment order = commit order**, so a CDC/sync consumer just stores a high-water mark and polls `versionstamp > last_versionstamp` — gap-free, no skips, no duplicates. **Convex is FoundationDB-lineage** and uses the same MVCC-commit-timestamp-as-cursor idea (§5). This is §1's property delivered by the storage engine instead of the WAL.

---

## 5. Convex — single committer, append-only log, monotonic commit timestamps

Convex (`get-convex/convex-backend`, DeepWiki) is MVCC over an append-only transaction log:
- A transaction `begin()`s at a `RepeatableTimestamp` (consistent snapshot for all its reads).
- All commits funnel through **one serial `Committer`**. On commit it runs an OCC check, then `next_commit_ts()` assigns a **`Timestamp` strictly greater than the latest in `SnapshotManager` and `last_assigned_ts`** — monotonic by construction — and appends to the log via `LogWriter::append`.
- **Gap-free & commit-ordered because a single committer serializes appends**; there is no out-of-order window — the number is assigned at the same serial point that publishes the write.
- Reactivity: a subscription records a `begin_timestamp`; a `LogReader` walks log entries in a timestamp range (`for_each_index`); `WriteLog::is_stale` detects whether a read set was invalidated between `reads_ts` and `ts`. A `RetentionCoordinator` trims the log only after all subscriptions have passed a timestamp (so no active reader loses data).

**Note for Nizhal:** Convex *does* use a single serialization point (the Committer) — but it's an in-process append to a log, not a row-lock `SELECT … FOR UPDATE` round-trip per write. Same shape as Linear/Nizhal conceptually; far cheaper mechanically. It shows the singleton is acceptable *if it's cheap*; the problem with Nizhal's is that it's a Postgres row lock on the write path.

---

## 6. Linear's global `lastSyncId` — the bottleneck Nizhal currently shares

`lastSyncId` is **a single global integer incremented by 1 per committed transaction across the entire database** — "the version number of the database," spanning all workspaces ([reverse-linear-sync-engine](https://github.com/wzhudev/reverse-linear-sync-engine), endorsed by Linear's CTO; [talk](https://linear.app/blog/scaling-the-linear-sync-engine), [HN discussion](https://news.ycombinator.com/item?id=36519448)). Quoting the reverse-engineering writeup: *"all transactions sent by clients follow a total order … This total order is represented by the sync id"*; *"When a transaction is successfully executed by the server, the global lastSyncId increments by 1."* Clients detect they are behind when their `lastSyncId < server's` and request the missing delta packets.

This is **exactly Nizhal's `_nizhal_sync_control` singleton**: a single hot counter every write must serialize through to guarantee assignment-order = commit-order. It *is* a serialization point, and "Scaling the Linear Sync Engine" is largely about **working around that one global bottleneck** — batching transactions, MongoDB-backed caching of the model graph, splitting the bootstrap, and partitioning load off the hot path — rather than removing the global counter (they keep the total order; they make everything *around* it cheaper). Confirmed: same shape, same bottleneck.

---

## 7. WatermelonDB `last_pulled_at` — wall-clock watermark, made safe by overlap + dedup

WatermelonDB's cursor is a **wall-clock timestamp**: `lastPulledAt` ([Sync docs](https://watermelondb.dev/docs/Sync/Frontend)). The server returns its **own** `timestamp` (server clock, not the client's) as the new `lastPulledAt`, and on the next pull returns "**ALL changes in all collections since lastPulledAt**," i.e. `updated_at > last_pulled_at`.

**Why a wall-clock watermark is coarse/unsafe for exact ordering** — and how Watermelon tolerates it:
- It has **no settled-prefix guarantee**: a row whose `updated_at` is *below* `last_pulled_at` but whose transaction *commits after* the pull would be skipped — the exact out-of-order-commit bug. Clock skew between writers makes "`updated_at`" not even a real order.
- Watermelon survives this by **(a) overlap** — it re-pulls a window and accepts that the same rows come back, and **(b) idempotent apply** — changes are merged by primary key, so duplicates are harmless; `pushChanges()` must resolve *only after* the backend confirms receipt. It deliberately trades exactness for a simple, conflict-tolerant pull.
- For correctness this only holds if the watermark is set **conservatively** — far enough back to cover the worst-case (clock skew + longest in-flight write). That conservative margin is a *guessed* version of §3's exact horizon.

**Verdict for Nizhal:** robust and trivially portable, but coarse — re-sends rows, needs idempotent client apply, and its safety rests on a hand-tuned margin. Best as a *fallback / belt-and-suspenders*, not the primary mechanism.

---

## 8. The general CS pattern — "stable prefix / low-water mark of a partially-ordered commit stream"

Every safe scheme above is one idea: **track a low-water mark below which the stream is totally settled, advance only to there.**

- **Snapshot xmin (§3)** — the min in-flight transaction; the prefix below it is settled.
- **Kafka high-watermark vs log-end-offset** ([2-Minute Streaming](https://blog.2minutestreaming.com/p/kafka-high-watermark-offset)): the **LEO** is the next write position (assignment frontier); the **high-watermark = min LEO across the in-sync replica set**, "grows monotonically," and **consumers may only read up to the HW** — never the un-replicated tail. Same shape as §3: writers race ahead (LEO), readers are bounded by the settled prefix (HW = a *minimum* across the in-flight set).
- **Debezium / DBLog watermarks** ([Incremental Snapshots](https://debezium.io/blog/2021/10/07/incremental-snapshots/), DBLog paper): snapshot reads run inside a consistent read at LSN N; streaming starts from N; **low/high watermarks are written into the transaction log** to bracket each snapshot chunk and reconcile it against concurrent changes, so the snapshot→streaming handoff has **no gap and no lost change**; reconciliation by primary key makes the overlap idempotent.
- **Lamport / commit-timestamp + gap detection, vector clocks** — generalize the same low-water-mark to multiple writers: you can only advance the global cursor to the *minimum across all sources'* settled positions.

The lesson: with lock-free (partially-ordered) assignment you **must not** advance the cursor to the *max* you've seen; advance it to the **min of the in-flight frontier minus one**. §3 is the direct Postgres realization.

---

## Synthesis & ranking for Nizhal (no WAL, any self-host Postgres, stay lock-free-ish)

| Approach | No-skip correctness | Lock-free writes | Portability (stock PG) | Cost / caveat |
|---|---|---|---|---|
| **(a) write-time `xid8` seq + reader advances only to snapshot `xmin`** | **Exact** (structural) | **Yes** | **Yes** (`pg_current_xact_id`, `pg_snapshot_xmin` — no slot, no GUC) | Watermark stalls behind longest in-flight write txn; one `xid8` column + index per table |
| (b) `track_commit_timestamp` ordering | No (needs §3 anyway; non-unique, unindexable) | Yes | Needs GUC + restart; vacuum drops data | Weak; ordering attribute only |
| (c) committed-prefix watermark on the commit path | Exact | **No** — a global counter *is* the serialization point | Yes | This is the current singleton / Linear `lastSyncId` |
| (d) accept-overlap + dedup (Watermelon-style) | Conditional (only with conservative margin) | Yes | Yes | Re-sends rows; needs idempotent apply; safety = guessed margin |

**Ranking: (a) ≫ (d) > (b) > (c).**

- **(c)** is what Nizhal has and what we are escaping — correct but it *is* the bottleneck (§6). Reject as primary.
- **(b)** never carries the correctness on its own (it still needs the §3 horizon for no-skip) and is unindexable/vacuum-fragile. Reject as primary.
- **(d)** is a fine *safety net* and is what Watermelon ships, but its correctness depends on a hand-tuned overlap margin and idempotent client apply — coarse, and wastes bandwidth.
- **(a)** is the only option that is simultaneously **exact, lock-free, and pure stock-Postgres**. It is the §1/§4 "assign-in-commit-order" guarantee *recovered without the WAL*, by reading MVCC's own settled-prefix horizon (§3/§8).

---

## Recommended approach for Nizhal — precise mechanism

**Use (a): write-time `xid8` stamp + reader-side snapshot-horizon watermark.** Drop the `_nizhal_sync_control` singleton `FOR UPDATE` from the write path entirely.

**Schema (per synced table):**
```sql
ALTER TABLE t ADD COLUMN _seq xid8 NOT NULL DEFAULT pg_current_xact_id();
-- ensure UPDATES re-stamp it:
--   set _seq = pg_current_xact_id() in the UPDATE (or a BEFORE UPDATE trigger)
CREATE INDEX t_seq_idx ON t (_seq);
```
`pg_current_xact_id()` returns the writing transaction's monotonic 64-bit id, assigned by the same machinery the write already uses — **no extra lock, no hot singleton row**. All rows written by one transaction share its `_seq` (tiebreak by primary key for intra-txn order).

**Reader (per pull), cursor is an `xid8` persisted per client:**
```sql
-- 1. read the settled-prefix horizon
SELECT pg_snapshot_xmin(pg_current_snapshot()) AS horizon;   -- xid8

-- 2. pull the immutable, complete half-open prefix
SELECT * FROM t
WHERE _seq >= :cursor AND _seq < :horizon
ORDER BY _seq, id;

-- 3. advance
-- cursor := horizon
```

**Correctness argument (the no-skip proof):**
- By the documented semantics of `xmin`, **every transaction with id `< horizon` is committed-or-aborted** at pull time. Aborted rows are invisible under MVCC, so the query returns exactly the *committed* rows of that prefix.
- Xids are assigned **monotonically increasing**, so **no transaction that commits in the future can ever have `_seq < horizon`**. The prefix `[…, horizon)` is therefore *frozen* — nothing new can appear in it after the reader passes.
- A transaction in flight at pull time has `_seq >= horizon`, so it is **excluded now** and read on a later pull once the horizon advances past it. The reader's cursor **never crosses an in-flight transaction** ⇒ the out-of-order-commit gap is impossible.
- Half-open `[cursor, horizon)` with `cursor := horizon` ⇒ **no gaps, no overlap, no duplicates** at the boundary.

**Cost & caveats (state them honestly):**
- **Head-of-line blocking by long write transactions:** a transaction that stays open holds `xmin` back, stalling the watermark (sync latency), exactly like VACUUM's xmin horizon. Mitigate by keeping write transactions short (they should be anyway) and monitoring `xmin` age. This is *strictly better* than the current global write lock: writers never block each other; only the reader's *advance* waits, and only for genuinely-in-flight work.
- **`pg_current_xact_id()` consumes a real xid** on every write — but any row-modifying write already consumes one, so this is essentially free.
- **xid8 does not wrap** in practice (64-bit), so unlike raw 32-bit `xid` there is no wraparound handling.
- **Keep client apply idempotent by primary key** (cheap insurance): a row updated again later gets a new, higher `_seq` and is correctly re-sent. This also lets you bolt on (d) as a belt-and-suspenders fallback if you ever want a coarse wall-clock backstop.

**One-line summary:** Nizhal should stop serializing *assignment with commit* (the singleton) and instead **assign lock-free at write time using `pg_current_xact_id()`**, while the reader **only advances its cursor to `pg_snapshot_xmin(pg_current_snapshot())`** — the MVCC settled-prefix horizon. This is the FoundationDB/Convex/WAL "commit-ordered cursor" guarantee reconstructed on stock Postgres with zero replication privileges and zero write-path lock.
