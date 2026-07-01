# Zero: ZQL query engine + IVM + zero-cache server (reverse-engineering notes)

Reverse-engineered by reading the real source under
`research/zero-mono/packages/`. Every claim is cited as `path:line` relative to
`packages/`. The system has three layers:

1. **ZQL / IVM** (`zql/src/ivm`, `zql/src/query`, `zql/src/builder`) — a
   dataflow engine of stateful operators that incrementally maintains a query
   result as a stream of `Change`s.
2. **zqlite** (`zqlite/src`) — a `Source` backed by a SQLite table (server-side
   IVM root).
3. **zero-cache** (`zero-cache/src/services`) — tails Postgres, maintains a
   SQLite replica, runs one IVM pipeline per client query, and pokes clients.

---

## 1. The Change / Diff type

A `Change` is a **tuple** (not an object — hot code) tagged by an integer enum.
`zql/src/ivm/change.ts`:

```ts
// change-type-enum.ts: ADD=0 REMOVE=1 EDIT=2 CHILD=3
// change-index-enum.ts: TYPE=0 NODE=1 OLD_NODE=2 CHILD_DATA=2  (OLD_NODE and CHILD_DATA share slot 2)

export type Change = AddChange | RemoveChange | ChildChange | EditChange;

export type AddChange    = [type: ChangeType.ADD,    node: Node, extra: null];
export type RemoveChange = [type: ChangeType.REMOVE, node: Node, extra: null];
// node row unchanged, but a descendant relationship changed:
export type ChildChange  = [type: ChangeType.CHILD,  node: Node, child: ChildData];
// row mutated in place (PK usually stable but not required):
export type EditChange   = [type: ChangeType.EDIT,   node: Node, oldNode: Node];

export type ChildData = { relationshipName: string; change: Change };  // recursive
```

A `Node` is a row **plus lazily-generated relationships** (`zql/src/ivm/data.ts:10`):

```ts
export type Node = {
  row: Row;
  // relationships are streams, generated on read; may yield 'yield' for time-slicing
  relationships: Record<string, () => Stream<Node | 'yield'>>;
};
```

So the IVM result is **hierarchical**, not a flat join table — a parent Node
carries child Nodes under named relationships. This is the whole reason Zero's
join is different from SQL (`zql/src/ivm/join.ts:41-50`).

**Sources speak a flatter dialect** — `SourceChange` is row-only, no
relationships (`zql/src/ivm/source.ts:9-20`): `SourceChangeAdd/Remove/Edit` =
`[type, row, null|oldRow]`. Operators turn `SourceChange` (rows) into `Change`
(nodes with relationships).

**The operator contract** (`zql/src/ivm/operator.ts`): an `Operator` is both an
`Input` and an `Output`.
- `Input.fetch(req: FetchRequest): Stream<Node | 'yield'>` — pull, returns rows
  in `SourceSchema.compareRows` order (`operator.ts:43`).
- `Output.push(change: Change, pusher): Stream<'yield'>` — push one incremental
  change downstream (`operator.ts:107`). Invariants the caller must keep: only
  add rows that don't already exist, only remove rows that do, by deep equality
  (`operator.ts:96-101`).
- `'yield'` is a cooperative time-slicing sentinel threaded through every
  stream; if a fetch/push yields, the yield must propagate to the caller
  immediately (`operator.ts:37-42`).
- Operators get scratch state via `Storage` (`set/get/scan/del`,
  `operator.ts:132`), backed by SQLite on the server (see §6).

**How operators transform a stream:** each operator receives `push(change)` from
upstream, mutates its internal state, and emits zero-or-more `push`es
downstream. The transformation per operator is the heart of §2. An `EditChange`
may be **split** into a remove + add when presence or relationships change
(`change.ts:41-57`, helper `maybe-split-and-push-edit-change.ts`).

---

## 2. IVM operator catalog

`buildPipeline` (`zql/src/builder/builder.ts:126`) wires these into a tree. The
distinct operators (`zql/src/ivm/`):

### Source (root)
`Source.connect(sort, filters, splitEditKeys, debug)` returns a `SourceInput`;
`Source.push(SourceChange)` fans the change into every connected input
(`source.ts:54-97`). Two implementations:
- **`MemorySource`** (`memory-source.ts`) — client side. Keeps one
  `BTreeSet<Row>` per distinct sort ordering, shared across connections:
  `type Index = { comparator; data: BTreeSet<Row>; usedBy: Set<Connection> }`
  (`memory-source.ts:69-73`), `#indexes: Map<string, Index>` keyed by
  `JSON.stringify(sort)` (`memory-source.ts:103`, `#getOrCreateIndex:225`). The
  primary-key index is created in the constructor (`memory-source.ts:120-124`).
- **`TableSource`** (`zqlite/src/table-source.ts`) — server side, backed by a
  real SQLite table. `connect()` compiles filters to a SQL `WHERE`
  (`table-source.ts:224-272`); `#fetch` runs a prepared `SELECT` and streams
  rows (`table-source.ts:283-375`), reusing the **memory-source generators**
  (`generateWithOverlay`, `generateWithStart`) for overlay/start semantics
  (`table-source.ts:24-30`). `#writeChange` does INSERT/DELETE/UPDATE, and
  **rows are written _after_ being vended** so self-joins see consistent state
  (`table-source.ts:61-68, 403-491`). `fullyAppliedFilters` tells the builder
  whether a downstream `Filter` is still needed (`table-source.ts:247`).
  The **Overlay** mechanism (`Overlay = {epoch, change}`,
  `memory-source.ts:59`) makes an in-flight pushed change visible to fetches
  issued during the same push, without yet committing it to the index/table.

### Filter (stateless)
`Filter` applies a pure `(row) => boolean` predicate (`filter.ts:18-57`). It is
a **`FilterOperator`**, part of a special sub-graph for `where` clauses
(`filter-operators.ts`): `FilterStart`/`FilterEnd` adapt between the normal
`Input/Output` interface and a `filter(node): boolean` interface, so an OR of
predicates can be evaluated against a node **without re-fetching**
(`filter-operators.ts:8-25`, PR #4339). `beginFilter`/`endFilter` bracket a
fetch loop so operators (e.g. `Exists`) can cache for its duration.

### Join (stateful only via child fetch)
`Join` (`join.ts`) adds a named relationship to each parent Node whose value is
a stream of matching child Nodes (`join.ts:41-50`). It keeps **no row index of
its own** — it re-derives children by fetching the child input with a
constraint built from the parent's join key (`#processParentNode`,
`join.ts:252-302`, `buildJoinConstraint`). State is just the in-progress child
change (`#inprogressChildChange`, `join.ts:61-62`) plus an *overlay* so a
child's own push is reflected in the parent's relationship stream
(`generateWithOverlay`, `join.ts:264-291`). Push handling:
- **parent ADD/REMOVE/EDIT/CHILD** → re-wrap parent node, forward
  (`#pushParent`, `join.ts:129-193`). Parent EDIT asserts the join key didn't
  change (`join.ts:166-174`).
- **child ADD/REMOVE/CHILD/EDIT** → fetch matching parents, emit a
  `ChildChange` to each (`#pushChild`/`#pushChildChange`, `join.ts:195-250`).
`FlippedJoin` (`flipped-join.ts`) is the EXISTS-pushdown variant: it batches
child→parent fetches into a single multi-row `IN` statement
(`MULTI_CONSTRAINT_CHUNK_SIZE = 256`, `flipped-join.ts`), merging sorted streams
in JS — used when a `where exists(...)` is "flipped" so the child drives.

### Exists (stateful: a size cache)
`Exists` (`exists.ts`) is a `FilterOperator` that passes a node iff its named
relationship is (non-)empty. It keeps `#cache: Map<string, boolean>` keyed by
the parent join-key values (`exists.ts:27, #getCacheKey:224`), reused only
across a single `beginFilter`/`endFilter` loop and only when the join key isn't
the PK (`#noSizeReuse`, `exists.ts:60-64, 80-99`). The subtle part is `push`
(`exists.ts:109-208`): only an ADD/REMOVE **child change on the watched
relationship** can flip existence. On such a change it recomputes the
relationship size (`#fetchSize` streams and counts, `exists.ts:248-264`) and, at
the 0↔1 boundary, **synthesizes** an add or remove of the *parent* node
downstream (with the relationship doctored to reflect the not-yet/already
applied child), inverting the logic for `NOT EXISTS` (`exists.ts:139-200`).
`EXISTS_LIMIT = 3` / `PERMISSIONS_EXISTS_LIMIT = 1` bound the child subquery
(`builder.ts:224-225, 337`). `Cap` (`cap.ts`) is an order-free count limiter used
to terminate EXISTS subqueries efficiently against SQLite (`builder.ts:356-371`).

### Take (stateful: size + bound)
`Take` implements `limit` (`take.ts`). State per partition:
`TakeState = { size, bound: Row | undefined }` in `Storage`, keyed by partition
values (`take.ts:29-40, getTakeStateKey:710`), plus a global `maxBound`. It keeps
the first *n* rows by the input comparator and remembers the **bound** (last
accepted row) so an incoming push can be cheaply accepted/rejected
(`take.ts:44-54`). On ADD past a full window it removes the old bound before
adding (maintaining `output size <= limit` even mid-push, `take.ts:261-340`); on
REMOVE inside the window it pulls the next row in to refill
(`take.ts:341-419`); `EditChange` has its own large case analysis
(`#pushEditChange`, `take.ts:432-675`). `partitionKey` lets a single Take count
per group (e.g. limit-per-parent in nested subqueries).

### Skip (stateless)
`Skip` sets a start `Bound = {row, exclusive}` and drops everything before it
(`skip.ts:24-105`); pushes are filtered by `#shouldBePresent`, edits split via
`maybeSplitAndPushEditChange`.

### FanOut / FanIn (OR within a single source)
For a `where` with OR-of-subquery branches, `applyOr` builds
`FanOut → [branch filters/exists...] → FanIn` (`builder.ts:553-596`).
- `FanOut` (`fan-out.ts`) forks a node to every branch; on `push` it pushes to
  each output then signals the paired `FanIn`
  (`fanOutDonePushingToAllBranches`, `fan-out.ts:74-83`).
- `FanIn` (`fan-in.ts`) **accumulates** the per-branch pushes
  (`#accumulatedPushes`, `fan-in.ts:33, 71-74`) and, when FanOut signals done,
  replays them through `pushAccumulatedChanges` which **dedupes** so a node
  matching multiple OR branches is emitted once (`fan-in.ts:76-93`). This is how
  one upstream row is split to several predicates and merged back without
  double-counting.
`UnionFanOut`/`UnionFanIn` (`union-fan-out.ts`, `union-fan-in.ts`) are the
heavier full-`Input` analogues used when an OR branch contains a *flipped*
subquery join (`builder.ts:448-487`).

### View (sink)
`ArrayView` (`array-view.ts`) is the terminal `Output`. It maintains a
materialized JS structure (`View = EntryList | Entry | undefined`, `view.ts:9`)
by applying each change via `applyChange` (`view-apply-change.ts`), which is
**immutable / copy-on-write** so unchanged subtrees keep reference identity for
React.memo/Solid (`array-view.ts:39-76`). It hydrates by fetching the whole
pipeline once (`#hydrate`, `array-view.ts:140-157`), then every `push` mutates
the root and `flush()` fires listeners (`array-view.ts:159-183`).
`change → ViewChange` conversion lives at `array-view.ts:15-37`.

### Other helpers
`snitch.ts` (test spy), `catch.ts`, `push-accumulated.ts` (FanIn replay engine),
`constraint.ts` (the `Constraint`/`MultiConstraint` IN-clause type),
`maybe-split-and-push-edit-change.ts` (edit→remove+add splitter).

---

## 3. Query → pipeline → view → poke

### AST → operator tree (`buildPipeline`, builder.ts:126)
1. `mapAst` (wire name remap) then `completeOrdering` appends PK to every
   `orderBy` so sorts are total (`builder.ts:134-137`, `complete-ordering.ts`).
2. Optional cost-based `planQuery` reorders joins (`builder.ts:140-141`,
   `zql/src/planner`).
3. `buildPipelineInternal` (`builder.ts:256`) per AST node:
   - `delegate.getSource(table).connect(orderBy, where, splitEditKeys)` → source
     input (`builder.ts:310-320`).
   - `ast.start` → `Skip` (`builder.ts:323-327`).
   - EXISTS conditions → `applyCorrelatedSubQuery(..., isExistsChild=true)`
     building a child pipeline + `Join`, bounded by `EXISTS_LIMIT`
     (`builder.ts:329-350`).
   - `ast.where` → `applyWhere`: if no flipped subquery, `buildFilterPipeline`
     wraps a `FilterStart … Filter/FanOut/FanIn/Exists … FilterEnd` chain
     (`builder.ts:399-411, applyFilter:523`); flipped subqueries take the
     `applyFilterWithFlips` path with `UnionFanOut`/`FlippedJoin`
     (`builder.ts:414-521`).
   - `ast.limit` → `Take` (or `Cap` for exists children) (`builder.ts:356-383`).
   - `ast.related` → one `Join` per related subquery, child built recursively
     (`builder.ts:385-394, applyCorrelatedSubQuery:650`).
4. Returns the terminal `Input`; the caller attaches a sink (`ArrayView` on the
   client, a push-accumulating `Output` on the server).

Static auth params are bound into the AST before building via
`bindStaticParameters` (`builder.ts:146-202`) — `Parameter` nodes become
`literal`s pulled from `authData`/`preMutationRow`.

### Build → materialize → react (client)
`ArrayView` ctor hydrates by `fetch`ing the pipeline, applies each node as an
add, flushes once, then listens for `push`es (`array-view.ts:78-183`). Listeners
(React/Solid hooks) get the immutable `data` snapshot.

### Server: query → pipeline → row stream → poke (the full numbered flow)
On the server the sink is not a view but a **row-change streamer**, and the
output is a **poke** to the client. End-to-end:

1. **Replica advances.** Replicator commits a Postgres transaction to the SQLite
   replica and fires `version-ready` (see §4/§5).
2. **View-syncer wakes.** `ViewSyncerService.run()` loops over the
   `version-ready` subscription under a lock+CVR (`view-syncer.ts:466-545`).
3. **Snapshot diff.** `PipelineDriver.advance(timer)` asks the `Snapshotter` for
   the `SnapshotDiff` between the last-served and current replica version
   (`pipeline-driver.ts:679-702`), then for each changed row issues a
   `SourceChange` (add/remove/edit, conflict rows deleted) into the relevant
   `TableSource.genPush` (`pipeline-driver.ts:704-798`).
4. **IVM runs.** Each `TableSource` push fans through all connected query
   pipelines; each pipeline's terminal `Output` calls
   `streamer.accumulate(queryID, schema, [change])`
   (`pipeline-driver.ts:494-501`).
5. **Nodes → row changes.** `Streamer.stream()` walks each hierarchical `Change`
   into flat per-row `RowChange = {type, queryID, table, rowKey, row}`,
   recursing into relationships and **dropping any `system:'permissions'`
   subtree** so permission-only rows never reach the client
   (`pipeline-driver.ts:960-1066`, drop at `:978` and `:1030`).
6. **Refcount + CVR.** `ViewSyncerService.#processChanges` batches RowChanges into
   a `Map<RowID, RowUpdate>` where `RowUpdate.refCounts[queryID]` is +1 on ADD,
   -1 on REMOVE, 0 on EDIT (`view-syncer.ts:2206-2291`). `CVRQueryDrivenUpdater
   .received()` merges these into stored CVR row records; a row whose total
   refcount drops to 0 yields a **delete** patch, otherwise a **put** patch with
   contents (`cvr.ts:836-940`).
7. **Poke.** Patches go to `PokeHandler.addPatch`. Per client,
   `ClientHandler.startPoke` emits `['pokeStart',{pokeID,baseCookie}]`, batches
   `['pokePart',{rowsPatch, gotQueriesPatch, desiredQueriesPatches,
   lastMutationIDChanges, ...}]` (flush every 100 parts), then
   `['pokeEnd',{pokeID, cookie}]` advancing the client's `baseVersion`
   (`client-handler.ts:188-345`). `startPoke` over all clients is a fan-out
   wrapper (`client-handler.ts:85-105`).
8. **Commit.** `#advancePipelines` flushes the CVR updater (persisting the new
   version + row records) and ends the pokes at the final version
   (`view-syncer.ts:2301-2368`). The client applies the patches to its local
   Replicache store, which feeds its **own** client-side IVM (MemorySource),
   re-running steps 3-4 locally and updating the `ArrayView`.

Adding/removing a query (new client query, TTL expiry, errored transform) goes
through `#syncQueryPipelineSet → #addAndRemoveQueries`
(`view-syncer.ts:1669-2103`): transform+hash each query (permissions applied,
§5), `PipelineDriver.addQuery` hydrates it from the current snapshot
(`pipeline-driver.ts:419-607`), and `deleteUnreferencedRows` + `catchupClients`
emit the resulting put/del patches.

---

## 4. zero-cache server architecture (component diagram-in-words)

```
                ┌──────────── Postgres (source of truth) ────────────┐
                │  logical replication slot (pgoutput, proto v1)      │
                └───────────────────────┬─────────────────────────────┘
                                        │ WAL frames (XLogData 'w', keepalive 'k')
                                        ▼
   change-source/pg/                ChangeSource  (ONE per shard)
   ┌──────────────────────────────────────────────────────────────────┐
   │ stream.ts: START_REPLICATION SLOT … LOGICAL <lsn> (pgoutput)      │
   │ pgoutput-parser.ts: bytes → {begin,relation,insert,update,delete, │
   │                              truncate,commit,message}             │
   │ change-source.ts #makeChanges: pgoutput msg → ChangeStreamData    │
   │   ['begin',…,{commitWatermark}] ['data',insert|update|…]          │
   │   ['commit',…,{watermark}] ['rollback',…]                         │
   │ Acker: withhold PG ack until change durably stored (advances slot)│
   └───────────────────────────────────┬──────────────────────────────┘
                                        │ ChangeStreamMessage stream
                                        ▼
   change-streamer/                 ChangeStreamerImpl  (ONE — the fan-out point)
   ┌──────────────────────────────────────────────────────────────────┐
   │ run(): for each change →  storer.store(wm,change)  (persist)      │
   │                           forwarder.forward([wm,tag,json]) (fanout)│
   │ storer.ts:   Postgres "CDC" change DB (changeLog, replicationState)│
   │              — durable history for subscriber catch-up            │
   │ forwarder.ts:#active/#queued subscribers; promote queued→active   │
   │              at each commit boundary; Broadcast = majority-ack     │
   │              flow control (one slow subscriber can't stall stream) │
   │ subscriber.ts: catch-up from watermark (buffer live) → go live    │
   └───────────────────────────────────┬──────────────────────────────┘
        subscribe({watermark, replicaVersion, mode})  (in-proc + change-streamer-http)
        ┌───────────────────────────────┼────────────────────────────────┐
        ▼ (mode='backup')               ▼ (mode='serving', one per task)   ▼ …
   replicator/                      replicator/ (per zero-cache process)
   ┌──────────────────────────────────────────────────────────────────┐
   │ IncrementalSyncer.run(): changeStreamer.subscribe(...)            │
   │   → WriteWorkerClient.processMessage (writes in a worker thread)  │
   │ change-processor.ts TransactionProcessor:                        │
   │   begin → db.beginConcurrent() (serving) / beginImmediate(backup)│
   │   insert/update/delete → SQLite rows + _0_version = commitWmark  │
   │   + writes the replica's own SQLite ChangeLog (for IVM diffing)  │
   │   commit → updateReplicationWatermark(stateVersion); db.commit() │
   │ notifier.ts: on commit → notifySubscribers({state:'version-ready'│
   │              , watermark}) — coalesced, replayed to new subs     │
   └───────────────────────────────────┬──────────────────────────────┘
                                        │ ReplicaState 'version-ready' (no data)
                                        ▼
   view-syncer/  (ONE ViewSyncerService per CLIENT GROUP)
   ┌──────────────────────────────────────────────────────────────────┐
   │ run(): for await version-ready → #runInLockWithCVR:               │
   │   Snapshotter: BEGIN CONCURRENT snapshots "leapfrog" replica      │
   │   PipelineDriver: one IVM pipeline per query; advance(diff)       │
   │   → RowChanges → refcount → CVRQueryDrivenUpdater → poke patches  │
   │   ClientHandler (one per connection/client): pokeStart/Part/End   │
   │   CVRStore: persist Client View Record (in cvrDb Postgres)        │
   └───────────────────────────────────┬──────────────────────────────┘
                                        │ Downstream pokes (WebSocket)
                                        ▼
                                 zero-client (Replicache + client-side IVM)
```

### Replicator (Postgres → SQLite)
- **Source.** `change-source/pg/stream.ts:198-206` opens
  `START_REPLICATION SLOT … LOGICAL <lsn> (proto_version '1', publication_names
  '…', messages 'true')` over a `connection.replication:'database'` socket; slot
  created with the **pgoutput** plugin (`replication-slots.ts:78`). pgoutput
  bytes are decoded in `pgoutput-parser.ts` (begin `'B'`, relation `'R'`, insert
  `'I'`, update `'U'`, delete `'D'`, truncate `'T'`, commit `'C'`, message `'M'`).
- **Translation.** `ChangeMaker.#makeChanges` (`change-source.ts:949-1037`) maps
  each pgoutput message to a `ChangeStreamData` tuple (`begin/data/commit/
  rollback`, shapes in `protocol/current/downstream.ts:12-49`). Watermarks come
  from the commit **LSN** via `toStateVersionString` → a `LexiVersion`
  (`lsn.ts:31-33`).
- **Apply.** `IncrementalSyncer` subscribes to the change-streamer and hands each
  message to a write-worker thread (`incremental-sync.ts:96-179`).
  `TransactionProcessor` (`change-processor.ts:322`) opens `BEGIN CONCURRENT`
  (serving) or `beginImmediate` (backup) (`:352-376`), applies inserts as
  upserts that stamp `_0_version = commitWatermark` on every row
  (`:440-473`, `ZERO_VERSION_COLUMN_NAME` re-exported from
  `replication-state.ts:21`), writes a SQLite **ChangeLog** for IVM, and on
  commit calls `updateReplicationWatermark` advancing
  `_zero.replicationState.stateVersion` (`replication-state.ts:196-206`).
- **Notify.** After a change-log-affecting commit the `Notifier` fans a
  coalesced `{state:'version-ready', watermark}` to view-syncers
  (`incremental-sync.ts:82-85`, `notifier.ts:31-69`). The message carries no
  data — the view-syncer re-reads the replica.

### Change-streamer (one stream → many subscribers)
ONE Postgres slot → ONE `ChangeStreamerImpl`. Its `run()` does
**store-then-forward** for every change (`change-streamer-service.ts:354-500`):
`storer.store` persists to a Postgres "CDC" change DB
(`storer.ts:194 cdcSchema`) and returns a single shared JSON string;
`forwarder.forward([watermark, tag, json])` fans it to all active subscribers
(`forwarder.ts:85`). A new subscriber is **queued** and only promoted to
**active** at the next commit boundary (`forwarder.ts:115-139`); it first
catches up from its watermark out of the change DB, buffering live messages,
then goes live (`subscriber.ts:84-124`). `Broadcast` uses majority-ack flow
control so one slow/new subscriber can't stall the stream
(`broadcast.ts:88-189`). The **PG slot only advances after a tx is durably
stored** (ack chain: subscriber/storer commit → source `Acker` → standby status
frame, `change-streamer-service.ts:339`, `storer.ts:618`,
`change-source.ts:582-642`). Watermarks are `LexiVersion`s; only `commit`
watermarks equal their LSN — `begin`/`data` use `preCommit = prevCommit+1` plus
a `pos` tiebreaker because concurrent-tx LSNs interleave
(`change-streamer-service.ts:189-249`). **Two change-logs exist** and must not
be conflated: the change-streamer's Postgres CDC log (for catch-up) and the
replica's SQLite ChangeLog (for IVM diffing).

### View-syncer (per client group) + the Snapshotter leapfrog
One `ViewSyncerService` per **client group** (`view-syncer.ts:199`), holding a
`PipelineDriver`, a `CVRStore`, a `Lock`, and a `Map<clientID, ClientHandler>`
(`view-syncer.ts:208-265`). A connection enters via `initConnection`, which
creates a `ClientHandler`, validates auth, transforms queries, and resolves
`#initialized` to start the run loop (`view-syncer.ts:783-887`). The run loop
serializes all DB work under `#lock`+CVR and either `#advancePipelines` (steady
state) or hydrates missing queries (`view-syncer.ts:466-545`).

The **`Snapshotter`** decouples view-syncers from the replicator: the replicator
is the sole writer; each view-syncer holds two SQLite `BEGIN CONCURRENT`
snapshots that "leapfrog" to replay the change-log timeline in isolation,
simulating (and rolling back) the IVM mutations without ever committing
(`snapshotter.ts:32-90`). `PipelineDriver.advance` reads the `SnapshotDiff`
between versions and pushes the row deltas through the pipelines
(`pipeline-driver.ts:679-798`). A `ResetPipelinesSignal` circuit-breaks
advancement that exceeds a time budget vs. total hydration time
(`pipeline-driver.ts:835-869`).

### CVR — Client View Record (what each client has)
Persisted in a Postgres `cvrDb` (the `CVRStore`), the CVR is the server's memory
of every client group's synced state (`cvr.ts:58-82`):

```ts
type CVR = {
  id: string;                          // = clientGroupID
  version: CVRVersion;                 // monotonic {stateVersion, minorVersion}
  replicaVersion: string | null;       // replica lineage it was built against
  clients: Record<string, ClientRecord>;   // per client: desired queries, lmid
  queries: Record<string, QueryRecord>;    // got queries: ast, transformationHash, ttl
  clientSchema: ClientSchema | null;
  ...
};
```

Row membership is **refcounted, not duplicated**: each CVR row record stores
`refCounts: {[queryHash]: number}` (`cvr.ts:51-55`), so a row referenced by
three queries is synced once and only deleted when all three drop it
(`cvr.ts:905-921`, `deleteUnreferencedRows` for queries that were removed,
`cvr.ts:959+`). `CVRQueryDrivenUpdater` diffs received rows against stored
records to produce put/del patches and bump the version
(`cvr.ts:560-940`); `CVRConfigDrivenUpdater` handles desired-query/client config
changes. The client's `baseCookie` (= a serialized `CVRVersion`) is sent on
connect; `ClientHandler` only pokes patches with `toVersion > baseVersion` and
advances `baseVersion` at `pokeEnd` (`client-handler.ts:194-345`). New/behind
clients are caught up from the CVR's stored row/config patches via
`#catchupClients` (`view-syncer.ts:2124-2204`). `PipelineDriver` also keeps an
**XOR row-set signature** per query (`#rowSetSignatures`,
`pipeline-driver.ts:148, 640-655`) to detect non-deterministic re-hydration
drift and force a re-sync.

---

## 5. Partial replication + server-side permission enforcement

**Partial replication** = the union of all clients' active query results is the
only data ever sent. There is no full client mirror; the CVR's refcounted row
records *are* the partial replica per client group (§4). The set of synced rows
is exactly what the IVM pipelines for that group's `queries` produce. When the
last query referencing a row is removed (TTL expiry, client unsubscribe), its
refcount hits 0 and a delete patch is sent (`cvr.ts:905-921`). This is why
**`NOT EXISTS` is server-only** — on the client you can't tell "row doesn't
exist" from "row not synced" (`builder.ts:60-70`, `enableNotExists` true only on
server at `pipeline-driver.ts:470`).

**Permissions are enforced by rewriting the query AST**, not by a runtime
gate. Before a query is hydrated, `transformAndHashQuery` →
`transformQuery` → `transformQueryInternal` (`auth/read-authorizer.ts:24-103`):

1. For the queried table, look up `permissionRules.tables[table].row.select`
   rules. **If none exist, default-deny** (inject an empty `or` so no rows
   match) — fail closed (`read-authorizer.ts:66-84`).
2. `addRulesToWhere` ANDs the original `where` with an `OR` of the allow-rule
   conditions: `where' = AND(originalWhere, OR(rule1, rule2, …))`
   (`read-authorizer.ts:105-119`).
3. Recurse into `related` subqueries **and** into `where`-position correlated
   subqueries, so a `whereExists('secret', …)` also gets the secret table's read
   rules — otherwise existence/contents could be inferred as an oracle
   (`read-authorizer.ts:95-101, 121-152`).
4. `bindStaticParameters` injects the JWT auth claims as literals
   (`read-authorizer.ts:45-59`, builder `bindStaticParameters`).

The transformed AST is then hashed (`transformationHash = hashOfAST(transformed)`,
`read-authorizer.ts:38`); a changed hash forces re-hydration. Because permission
rules can read tables the user can't see, any IVM subtree added **by** the
permission system is tagged `system: 'permissions'` on its `SourceSchema`
(`schema.ts:14-22`) and the `Streamer` **never streams those rows to the client**
(`pipeline-driver.ts:978, 1030`). The view-syncer always re-transforms custom
queries on (re)connect so authorization is re-validated against current auth
(`view-syncer.ts:1758-1795`). Internal queries (e.g. `lmids`, `mutationResults`)
skip permission rewriting (`read-authorizer.ts:32-34`, `cvr.ts:84-130`).

---

## Open questions

1. **Planner.** `planQuery` / `zql/src/planner` and the SQLite cost model
   (`zqlite/src/sqlite-cost-model.ts`, `sqlite-stat-fanout.ts`) were not read in
   depth — how join ordering and the flip decision (`cond.flip`) are actually
   chosen, and when `FlippedJoin` beats `Join` + `Exists`.
2. **`view-apply-change.ts` internals.** The copy-on-write tree-edit algorithm
   (how `Entry`/`EntryList` subtrees are spliced while preserving references)
   was inferred from `array-view.ts`, not read line-by-line.
3. **`take.ts` edit cases.** The full `#pushEditChange` case matrix
   (`take.ts:432-675`) is correct by construction but I did not verify each of
   the oldCmp/newCmp branches against the tests.
4. **Mutations path.** `mutagen` (`services/mutagen/*`), `pusher.ts`, and how
   optimistic client mutations + `lastMutationID` reconcile with the read path
   (the `mutationResults` internal query) were out of scope here.
5. **CVR storage layout.** `cvr-store.ts` (1382 lines) — exact Postgres table
   schema for row records/patches, the `rowsVersion` columns, and the
   `catchupRowPatches`/`catchupConfigPatches` queries — only read at the
   interface level.
6. **Snapshotter correctness.** How `BEGIN CONCURRENT` interacts with WAL2 and
   the exact ChangeLog query used to compute `SnapshotDiff` (`snapshotter.ts`
   beyond the header) and the `advanceWithoutDiff` fast path.
7. **Backfill.** `change-source/pg/backfill-stream.ts` and how schema changes /
   new columns are backfilled into the replica without a full resync.
8. **`'yield'` time-slicing.** The cooperative scheduler
   (`TimeSliceTimer`, `view-syncer.ts:2673`) and how yield budgets are tuned
   against `#yieldThresholdMs` were noted but not characterized.
