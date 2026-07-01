# Replicache Sync Engine — Reverse-Engineering Notes

Source: `packages/replicache/src/` in the rocicorp `mono` monorepo. Replicache is the
client-side sync library that **Zero** (`zero-client`) is built on top of. All
`path:line` citations below are real; everything was read from the actual source.

> Mental model (from `README-external.md`): "Replicache is a JavaScript framework for
> building high-performance, offline-capable, collaborative web apps." There is no
> in-repo design doc (`doc/` is empty), so the model below is reconstructed from code.

The one-line model: **Replicache is a versioned, immutable commit graph (git-like) over a
prolly BTree key-value map, persisted in IndexedDB, kept in sync with a server the
developer owns via two endpoints (push & pull). Local mutations are optimistic commits
that get *rebased* on top of authoritative server snapshots.**

---

## 1. Component Map

```
replicache-impl.ts        ReplicacheImpl: orchestrates everything. Owns memdag + perdag,
                          the mutate() proxy, push/pull connection loops, subscriptions.
│
├── db/                   The COMMIT GRAPH (git analogy: commits, refs, rebase)
│   ├── commit.ts         Commit<Meta>, LocalMetaDD31 / SnapshotMetaDD31, chain walking
│   ├── meta-type-enum.ts LocalDD31 = 4, SnapshotDD31 = 5  (SDD 1/2/3 are dead)
│   ├── write.ts          Write tx → newWriteLocal / newWriteSnapshotDD31, commitWithDiffs
│   ├── read.ts           Read tx over a commit's value map + index maps
│   ├── rebase.ts         REBASE: re-run a local mutation on a new basis
│   ├── index.ts          secondary index maintenance
│   └── scan.ts           scan iterator over the value map
│
├── btree/                The PROLLY/B+TREE backing the kv map (one tree per commit value)
│   ├── node.ts           DataNode (leaf) / InternalNode, Entry<V>, structural diff types
│   ├── read.ts           BTreeRead: get/scan/diff (the structural diff lives here)
│   ├── write.ts          BTreeWrite: mutate then flush() → new chunks for changed nodes
│   ├── splice.ts         computeSplices: entry-level diff used to skip unchanged subtrees
│   └── diff.ts           diff(old,new) → InternalDiff (array of add/del/change)
│
├── dag/                  Content-keyed (hash-keyed) immutable CHUNK store ("the DAG")
│   ├── chunk.ts          Chunk<V> = {hash, data, meta:Refs}; Refs sorted+deduped
│   ├── store.ts          Store/Read/Write interfaces; heads (named refs) + chunks
│   ├── store-impl.ts     StoreImpl over a kv store (the perdag)
│   ├── lazy-store.ts     LazyStore = the MEMDAG: lazily loads+LRU-caches perdag chunks
│   ├── gc.ts             refcount-based GC of unreachable chunks
│   └── visitor.ts        graph walk used by GC and persist/refresh gather steps
│
├── sync/                 The PUSH / PULL PROTOCOL
│   ├── push.ts           PushRequestV1, MutationV1, push()
│   ├── pull.ts           PullRequestV1, beginPullV1, handlePullResponseV1, maybeEndPull
│   ├── patch.ts          apply(): put/del/clear patch ops → BTree writes
│   ├── diff.ts           diffCommits → DiffsMap (value map + every secondary index)
│   └── ids.ts            ClientID, ClientGroupID branded strings
│
├── persist/              MULTI-TAB persistence to IndexedDB
│   ├── clients.ts        ClientV5/V6, ClientMap (per-tab client records)
│   ├── client-groups.ts  ClientGroup (shared by tabs that share mutators+indexes)
│   ├── persist.ts        memdag → perdag (push local state down to shared IDB)
│   ├── refresh.ts        perdag → memdag (pull other tabs' state up, rebase locals)
│   ├── heartbeat.ts      liveness timestamp per client (HEARTBEAT_INTERVAL = 60s)
│   ├── client-gc.ts      collect dead clients; client-group-gc.ts collect dead groups
│   └── gather-*-visitor  collect mem-only / not-cached chunks for the above
│
├── puller.ts / pusher.ts Developer-supplied fetch functions + response shapes
├── patch-operation.ts    PatchOperation (put/del/clear) — the server's wire format
├── cookies.ts            Cookie = opaque server cursor; compareCookies ordering
├── subscriptions.ts      SubscriptionsManager: re-runs queries when diffs touch keys
└── hash.ts               Hash = 22-char id. NB: now random UUID+counter, not content hash
```

### memdag vs perdag (the key dual-store split)

`replicache-impl.ts:482-486`:
```ts
this.perdag = new StoreImpl(perKVStore, newRandomHash, assertHash);
this.memdag = new LazyStore(
  this.perdag,
  ...
```
- **perdag** = persistent DAG, backed by IndexedDB. *Shared by all tabs* of a client
  group. Slow.
- **memdag** = `LazyStore`, an in-memory LRU cache over the perdag (`dag/lazy-store.ts:17`:
  "Dag Store which lazily loads values from a source store and then caches them in an LRU
  cache"). This is where *this tab's* live reads, local mutations, and pull/rebase happen.
  Memory-only chunks (uncommitted local work) live here until `persist()` flushes them
  down to the perdag.

---

## 2. The Core Model: Client View + Mutations

### The commit graph (`db/commit.ts`)

A `Commit<M>` wraps a DAG chunk whose data is `CommitData<M>` (`commit.ts:46-77,529-545`):

```ts
type CommitData<M extends Meta> = FrozenTag<{
  readonly meta: M;
  readonly valueHash: Hash;          // root of the BTree value map (the client view)
  readonly indexes: readonly IndexRecord[]; // roots of secondary-index BTrees
}>;
```

Two live commit types (`meta-type-enum.ts`; the three SDD types are dead):

```ts
// commit.ts:257-267 — an optimistic LOCAL mutation
type LocalMetaDD31 = {
  type: MetaType.LocalDD31;           // = 4
  basisHash: Hash;                    // parent commit (the chain link)
  mutationID: number;                 // monotonic per client
  mutatorName: string;                // which registered mutator
  mutatorArgsJSON: FrozenJSONValue;   // its args (replayable!)
  originalHash: Hash | null;          // pre-rebase identity of this mutation
  timestamp: number;
  clientID: ClientID;
  baseSnapshotHash: Hash;             // cached pointer to the snapshot it sits on
};

// commit.ts:298-303 — an authoritative SNAPSHOT from the server
type SnapshotMetaDD31 = {
  type: MetaType.SnapshotDD31;        // = 5
  basisHash: Hash | null;
  lastMutationIDs: Record<ClientID, number>; // server's acked mutationID per client
  cookieJSON: FrozenCookie;           // the opaque server cursor for this snapshot
};
```

The DAG **head** named `'main'` (`DEFAULT_HEAD_NAME`, `commit.ts:26`) points at the tip of
the chain. Walking `basisHash` back from the head: `Local → Local → … → Snapshot`. The
local commits above the base snapshot are exactly the **pending mutations** not yet
acknowledged by the server (`commit.ts:102-119 localMutations`).

`mutationID` is resolved by walking the chain (`commit.ts:79-100 getMutationID`): a snapshot
reports `lastMutationIDs[clientID] ?? 0`; a local commit reports its own `mutationID` if it
belongs to `clientID`, else recurses to its basis.

### Creating a local commit (the optimistic write path)

`replicache-impl.ts:1511-1602 #mutate` is the whole optimistic-write story:

1. Take the memdag write lock; read current `main` head (`:1538`).
2. `newWriteLocal(headHash, name, frozenArgs, originalHash=null, …)` (`:1541`) — see
   `db/write.ts:290-328`. This opens a `BTreeWrite` over the basis commit's `valueHash`
   and assigns `mutationID = basis.getNextMutationID(clientID)` (`write.ts:302`).
   **MutationIDs are monotonic per client, assigned at commit time = previous + 1.**
3. Build a `WriteTransactionImpl(clientID, mutationID, 'initial', …)` and run the
   developer's mutator: `result = await mutatorImpl(tx, args)` (`:1571`). The mutator calls
   `tx.put/del` which mutate the BTree.
4. `dbWrite.commitWithDiffs(DEFAULT_HEAD_NAME, this.#subscriptions)` (`:1575`): flushes the
   BTree to new chunks, writes a `newLocalDD31` commit, moves `main`, and **computes the
   diff vs the basis** in the same pass (`write.ts:218-283`).
5. Kick a push (`this.#pushConnectionLoop.send(false)`, `:1594`) and `fire(diffs)` to
   subscriptions (`:1595`), then schedule a `persist()`.

So a local mutation is a real commit on the chain; the UI sees its effect immediately
(optimism) before the server has seen it.

### Rebase — the heart of reconciliation (`db/rebase.ts`)

When a newer server snapshot arrives, the pending local mutations must be *re-applied* on
top of it (their old chunks reference the old snapshot). Rebase does this by **re-running
the mutator function** against the new basis — it does not replay a recorded patch; it
replays the *intent* (name + args):

```ts
// db/rebase.ts:25-99 rebaseMutation (abridged)
const localMeta = mutation.meta;
const name = localMeta.mutatorName;
const args = localMeta.mutatorArgsJSON;

const basisCommit = await commitFromHash(basisHash, dagWrite);
const nextMutationID = await basisCommit.getNextMutationID(mutationClientID, dagWrite);
if (nextMutationID !== localMeta.mutationID) {        // strict ordering invariant
  throw new Error(`Inconsistent mutation ID: original: ${localMeta.mutationID}, ...`);
}

const dbWrite = await newWriteLocal(
  basisHash, name, args,
  mutation.chunk.hash,   // <-- becomes the new commit's originalHash
  dagWrite, localMeta.timestamp, mutationClientID, formatVersion);

const tx = new WriteTransactionImpl(mutationClientID, await dbWrite.getMutationID(),
  'rebase', zeroData, dbWrite, lc);
await mutatorImpl(tx, args);   // RE-EXECUTE the mutator on the new state
return dbWrite;
```

Two correctness notes baked into the code:
- The `mutationID` must line up exactly with the new basis (`rebase.ts:68-72`) — mutations
  replay in the same order they were created.
- If a mutator *name no longer exists* in the deployed code, rebase stubs in a **no-op**
  rather than crashing (`rebase.ts:43-59`): "Developers must not remove mutator names …
  Replicache needs to be able to replay mutations during pull."

`rebaseMutationAndCommit` (`rebase.ts:126-150`) commits the rebased mutation onto a head
name; `rebaseMutationAndPutCommit` (`:101-124`) just writes the chunk without moving a head
(used by persist).

---

## 3. Push Protocol (`sync/push.ts`, `pusher.ts`)

### Wire shapes

```ts
// push.ts:36-52 — one optimistic mutation, as sent to the server
type MutationV1 = {
  id: number;            // == LocalMetaDD31.mutationID
  name: string;          // mutator name
  args: ReadonlyJSONValue;
  timestamp: number;
  clientID: ClientID;
};

// push.ts:58-78 — POST body to the developer's push endpoint
type PushRequestV1 = {
  pushVersion: 1;
  schemaVersion: string; // app-defined, lets server know mutator/arg format
  profileID: string;     // per-browser-profile id
  clientGroupID: ClientGroupID;
  mutations: MutationV1[];
};
```

### How push works (`push.ts:109-166`)

1. Under a memdag read lock, gather the pending local commits between the base snapshot and
   `main`: `localMutations(mainHeadHash, dagRead)` (`push.ts:122-129`). The lock is released
   *before* the HTTP call ("Important! Don't hold the lock through an HTTP request!").
2. If none pending → return `undefined` (`:131-133`).
3. Reverse to **tail-first / ascending mutationID order** (`:137`) and map each
   `LocalMetaDD31` → `MutationV1` via `convertDD31` (`:99-107`): `id = lm.mutationID`,
   `name`, `args`, `timestamp`, `clientID`.
4. POST via the developer-supplied `pusher` (`:163` → `callPusher` → `pusher(body, requestID)`).

### MutationID assignment & idempotency

- IDs are **monotonic per client**, assigned as `basis.getNextMutationID() = prev + 1`
  (`write.ts:302`, `commit.ts:66-71`). The same id is carried unchanged through every
  rebase (`rebase.ts:68`), so the *(clientID, mutationID)* pair is a stable identity for a
  mutation across optimistic create → N rebases.
- **Idempotency is the server's responsibility, enabled by this id.** The server persists a
  `lastMutationID` per client and must ignore/skip any mutation whose `id <=` what it has
  already applied. The client enforces the matching invariant on the way back in: pull's
  `lastMutationIDChanges` may never go backwards (`pull.ts:238-252`).
- Requests carry a `requestID = ${clientID}-${sessionID}-${counter}` (`request-id.ts:23-26`)
  for tracing, not for dedup.

There is no `clientID`-level "exactly once" magic in the client beyond monotonic ids + the
server's `lastMutationID` watermark; that watermark is what eventually *removes* a pending
local commit (see pull §4).

---

## 4. Pull Protocol (`sync/pull.ts`, `puller.ts`, `sync/patch.ts`, `cookies.ts`)

### Wire shapes

```ts
// pull.ts:61-71 — POST body to the developer's pull endpoint
type PullRequestV1 = {
  pullVersion: 1;
  schemaVersion: string;
  profileID: string;
  cookie: Cookie;               // the client's CURRENT base-snapshot cursor
  clientGroupID: ClientGroupID;
};

// puller.ts:42-48 — normal-case response the server returns
type PullResponseOKV1 = {
  cookie: Cookie;                           // new cursor (opaque to client)
  lastMutationIDChanges: Record<ClientID, number>; // server-acked ids since req.cookie
  patch: PatchOperation[];                  // how to mutate the kv map
};
// plus ClientStateNotFoundResponse | VersionNotSupportedResponse (puller.ts:62-65)
```

### The COOKIE — opaque server cursor (`cookies.ts`)

`cookies.ts:9-26`: "A cookie is a value that is used to determine the order of snapshots."
It is either a primitive (`null | string | number`) or any JSON object carrying an
`order: number | string` field. The client never interprets it — it only **orders** it via
`compareCookies` (`cookies.ts:38`). Each snapshot stores its cookie in
`SnapshotMetaDD31.cookieJSON`. On pull the client sends its current base-snapshot cookie
and the server returns the delta from that cursor to a newer one.

### The PATCH operations (`patch-operation.ts`, `sync/patch.ts`)

The server's wire patch (`patch-operation.ts:37-49`) is exactly three ops:

```ts
type PatchOperation =
  | { op: 'put';   key: string; value: ReadonlyJSONValue }
  | { op: 'del';   key: string }
  | { op: 'clear' };
```

(`PatchOperationInternal` additionally has an `'update'` merge op, but `sync/diff.ts` and
patch optimization note it is "not used in Zero/Replicache".) `patch.apply`
(`patch.ts:94-148`) first `optimizePatch`es (drop everything before the last `clear`,
collapse repeated ops per key, sort, bulk-load runs of `put` via `dbWrite.putMany`), then
applies to the BTree write.

### Rebuilding the snapshot + rebasing locals — the two-phase pull

**Phase A — `beginPullV1` + `handlePullResponseV1` (build a new snapshot on a side branch):**

1. Read the current base-snapshot cookie from `main` and send it as `req.cookie`
   (`pull.ts:95-112`).
2. On response, re-acquire the memdag write lock and re-verify the base snapshot hasn't
   moved: if `expectedBaseCookie !== baseCookie` → `CookieMismatch`, abandon (`pull.ts:213-236`).
3. Guard ordering: `lastMutationIDChanges` may not regress (`:238-252`); response cookie may
   not be `< baseCookie` (`:255-263`); equal cookie + nonempty patch is a NoOp/error
   (`:265-284`).
4. Build a **new snapshot commit** on a side branch, *not* on `main`:
   ```ts
   // pull.ts:286-299
   const dbWrite = await newWriteSnapshotDD31(
     baseSnapshot.chunk.hash,
     {...baseSnapshotMeta.lastMutationIDs, ...response.lastMutationIDChanges}, // merged LMIDs
     frozenResponseCookie,
     dagWrite, clientID, formatVersion);
   await patch.apply(lc, dbWrite, response.patch);
   syncHead = await dbWrite.commit(SYNC_HEAD_NAME);   // head 'sync', not 'main'
   ```
   The new snapshot's value map = old base snapshot's map + patch. Its `lastMutationIDs`
   are the merge of old + the server's new acks.

**Phase B — `maybeEndPull` (rebase pending locals over the new snapshot, then fast-forward
`main`):** (`pull.ts:304-476`, driven by `replicache-impl.ts:764-818`)

1. Verify `sync` head is what we expect and that `syncSnapshot.basisHash === mainSnapshot`
   (no overlapping syncs, `pull.ts:338-352`).
2. Collect pending locals on `main`, and keep only those whose `mutationID` is **greater
   than** the new snapshot's `lastMutationID` for that client (`pull.ts:360-379`). *This is
   how acknowledged mutations get dropped*: if the server's new snapshot already reflects a
   mutation, it is **not** replayed and effectively disappears from the pending set.
3. If any remain → return them as `replayMutations` (ascending order). The orchestrator
   loops, calling `rebaseMutationAndCommit(mutation, dagWrite, syncHead, SYNC_HEAD_NAME, …)`
   for each, advancing `syncHead` (`replicache-impl.ts:795-816`). Re-enters `maybeEndPull`.
4. When nothing is left to replay: compute the diff between old `main` value map and the new
   `sync` value map (plus indexes), then **atomically set `main = syncHead` and remove the
   `sync` head** (`pull.ts:406-435`). Fire subscriptions with the diff
   (`replicache-impl.ts:785-790`).

`poke()` (`replicache-impl.ts:1091-1137`) is the push-driven variant: the server pushes a
`PokeInternal` (baseCookie + the same PullResponse), the client runs `handlePullResponseV1`
then `maybeEndPull` — identical reconciliation, no client-initiated HTTP.

```
main:   S0 ── L1 ── L2 ── L3            (S0 = old snapshot, L1..3 pending locals)
                                  pull: build S1 on 'sync' from S0 + patch, LMIDs say L1 acked
sync:   S0 ── S1
                                  rebase L2,L3 onto S1 (re-run mutators); drop L1 (acked)
sync:   S0 ── S1 ── L2' ── L3'
                                  fast-forward: main := sync
main:   S0 ── S1 ── L2' ── L3'
```

---

## 5. The DAG + BTree: cheap structural diffing

### Chunks and the DAG (`dag/chunk.ts`, `dag/store.ts`)

A `Chunk<V>` is `{hash, data, meta: Refs}` (`chunk.ts:41-61`). `Refs` is an opaque
sorted-deduped `Hash[]` (`chunk.ts:13-39`) — the outbound edges to other chunks. The store
keeps **named heads** (refs like `main`, `sync`, `client-groups`) and content chunks; GC is
refcount-based over reachability from heads (`dag/gc.ts`).

> **Important nuance about "content-addressed":** `hash.ts:27-28` states *"We are no longer
> using hashes but due to legacy reason we still refer to them as hashes. We use UUID and
> counters instead."* `newRandomHash` (`hash.ts:71-87`) yields `<random12><counter10>`.
> So chunks are **immutable and hash-keyed**, but the hash is *not* a digest of content.
> The dedup/structural-sharing property therefore comes from the **write path**, not from
> content hashing: when a BTree is flushed, only *mutated* nodes get new chunks; untouched
> nodes keep their existing hash. Two trees that share an unchanged subtree literally share
> the same chunk hash, which is what makes diffing cheap.

### The prolly/B+tree (`btree/node.ts`, `btree/read.ts`)

The value map of each commit is a B+tree whose nodes are DAG chunks:
`BaseNode<V> = [level, Entry<V>[]]` (`node.ts:39-44`). Leaves (`DataNode`, level 0) hold
`Entry<FrozenJSONValue>`; internal nodes hold `Entry<Hash>` (key → child chunk hash)
(`node.ts:42-44`, `31`). `BTreeWrite.flush()` rewrites only dirty nodes bottom-up, so the
root hash changes iff the data changed, and unchanged sibling subtrees retain their hashes.

### Diffing two commits = diffing two trees by hash (`btree/read.ts:158-282`, `splice.ts`)

`BTreeRead.diff(last)` walks both trees in lockstep (`read.ts:167-228 diffNodes`):
- Equalize levels by flattening the deeper side's children (`read.ts:173-196`).
- Two leaves of equal level → merge-walk entries by key, emitting `add/del/change`
  (`read.ts:230-282 diffEntries`).
- Two internal nodes of equal level → `computeSplices(last.entries, current.entries)`
  (`read.ts:209`). **`computeSplices` compares each entry's VALUE — which for an internal
  node is the child's Hash — with `deepEqual` (`splice.ts:33-47`).** When two child hashes
  are equal, no splice is produced and **that entire subtree is skipped without being
  read.** Only the spliced ranges are recursed into (`read.ts:213-227`).

That hash-equality short-circuit is the whole reason a diff between two large commits costs
O(changed nodes) rather than O(tree size) — and it is what powers subscriptions (§ below)
and the pull diff (`pull.ts:406-428`). `sync/diff.ts:diffCommits` runs this over the primary
map *and every secondary index* (`diff.ts:60-129`), producing a `DiffsMap` keyed by index
name (`""` = primary, `diff.ts:23-34`).

```ts
// btree/diff.ts:5-11 — materialize the lazy diff once
export function diff(oldMap: BTreeRead, newMap: BTreeRead): Promise<InternalDiff> {
  return asyncIterableToArray(newMap.diff(oldMap));
}
```

### Subscriptions / change events (`subscriptions.ts`, wired in `replicache-impl.ts`)

`DiffComputationConfig` (`sync/diff.ts:18-21`) lets the engine skip diffing entirely when no
subscription cares; `SubscriptionsManager` implements it. Every state transition produces a
`DiffsMap` and calls `this.#subscriptions.fire(diffs)`:
- after a local mutation (`replicache-impl.ts:1575,1595` — `commitWithDiffs` then `fire`),
- after a pull/poke completes with no more replays (`:785-790`),
- after a `refresh()` from another tab (`:1248`).

A subscription re-runs its query only if the diff touched keys in its scope, so the BTree's
cheap structural diff is the load-bearing primitive for reactive reads. (Zero replaces this
key-set re-run with full IVM; see §6.)

---

## 6. Client Groups & Multi-Tab Persistence

### Client vs Client Group (`persist/clients.ts`, `persist/client-groups.ts`)

- A **Client** = one tab/instance (`clients.ts:46-100`). `ClientV6` carries
  `heartbeatTimestampMs`, `refreshHashes` (chunks it is pinning while refreshing),
  `persistHash` (last snapshot it pushed to the group), and its `clientGroupID`.
- A **ClientGroup** (`client-groups.ts:12-66`) is shared by all clients (tabs) that have the
  **same set of mutator names and the same index definitions** (enforced immutable,
  `client-groups.ts:159-171`). It stores:
  ```ts
  type ClientGroup = {
    headHash: Hash;                                  // perdag commit last persisted by group
    mutatorNames: readonly string[];
    indexes: IndexDefinitions;
    mutationIDs: Record<ClientID, number>;           // highest local mutationID per client
    lastServerAckdMutationIDs: Record<ClientID, number>; // highest server-acked per client
    disabled: boolean;                               // server deleted the group → stop sync
  };
  ```
  `mutationIDs` vs `lastServerAckdMutationIDs` is precisely the "is there unpushed work?"
  check (`client-groups.ts:214-227 clientGroupHasPendingMutations`) — and it lets *one* tab
  recover *another* tab's unacknowledged mutations without loading the commit graph.

### How tabs share state: persist (down) + refresh (up)

The perdag is the shared substrate; each tab has its own memdag. Two flows reconcile them,
both built on **the same rebase primitive as pull**:

- **`persist()`** (`persist/persist.ts:45-60`, called via `replicache-impl.ts:1184-1199`):
  push this tab's memdag state *down* to the shared perdag client group. Gathers the
  memory-only chunks under the base snapshot, writes them to perdag, then "rebases onto the
  client's perdag client group all memdag local commits not already in the perdag history,"
  and updates `mutationIDs` / `lastServerAckdMutationIDs`.

- **`refresh()`** (`persist/refresh.ts:61-169`, via `replicache-impl.ts:1233-1248`): pull the
  *latest shared* perdag client-group head *up* into this tab's memdag, then rebase this
  tab's pending locals on top, and emit a `DiffsMap` so this tab's subscriptions update when
  *another* tab's mutation (or a pull in another tab) lands. To avoid copying the whole
  perdag graph it gathers only not-yet-cached chunks up to `GATHER_SIZE_LIMIT = 5 MB`
  (`refresh.ts:42,142-150`) via `GatherNotCachedVisitor`, and pins them in `refreshHashes`
  so GC can't drop them mid-rebase (`refresh.ts:120-167`).

- **`heartbeat`** (`persist/heartbeat.ts:13`): each client writes `heartbeatTimestampMs`
  every 60s; `client-gc`/`client-group-gc` reap clients/groups that stopped beating, which
  triggers `collect-idb-databases` cleanup.

So "multiple tabs share persisted state" = shared perdag + per-tab memdag, kept consistent
by persist/refresh, both of which *rebase local mutations* exactly like pull does. The
`clientGroupID` is also what is sent on pull (`clients.ts:59-63`) so the server tracks
`lastMutationID` per *client* within the *group*.

---

## 7. What Replicache Deliberately Does NOT Do

Grounded in the code, not folklore:

1. **No queries / no incremental view maintenance (IVM).** Reactivity is "re-run the
   subscription body if the key-diff intersects its read-set" (`subscriptions.ts`,
   `sync/diff.ts`). There is no query language, no join/filter engine, no incremental
   operators. That entire layer is **Zero** (`zql`, `zero-cache`), which sits on top of this
   engine (`ReplicacheImpl` exposes `#zero?.advance(...)` hooks at `replicache-impl.ts:787,
   1591` precisely so Zero can plug its IVM in).

2. **No built-in server.** The developer must implement the push and pull endpoints. The
   client only knows a `Pusher` and `Puller` *function* (`pusher.ts`, `puller.ts:34-37`) and
   the JSON shapes; it never talks to a database. The server owns the authoritative state,
   the cookie semantics, and per-client `lastMutationID` bookkeeping.

3. **No server-defined data shape on the wire.** The server speaks only `put/del/clear`
   patches against an opaque key→JSON map (`patch-operation.ts:37-49`). Replicache has no
   notion of tables, schemas, or relations — those are app conventions over flat keys.

4. **No conflict resolution beyond "rebase = re-run the mutator."** There is no OT, no CRDT
   merge. Convergence comes from server authority + deterministic mutator replay
   (`db/rebase.ts`). The mutator function *is* the conflict-resolution policy.

5. **No interpretation of the cookie or ordering of business data.** `compareCookies`
   (`cookies.ts`) only orders snapshots; the engine never reasons about *what* changed
   server-side, only that a newer snapshot exists.

6. **No removal/renaming of mutators across deploys (a constraint, not a feature).** Because
   pending mutations are replayed by `(name,args)`, a deployed mutator name must keep
   existing or sync silently no-ops it (`rebase.ts:43-59`). The developer must respect this.

---

## Open Questions

1. **Content-addressing vs random hashes.** `hash.ts:27-28` says hashes are now random
   UUID+counter, yet `dag/` is described as "content-addressed." How does write-path dedup
   actually behave when, say, two independent inserts produce structurally identical leaves
   — are they ever coalesced, or only un-rewritten nodes share chunks? (Suspect only the
   latter; would confirm in `btree/write.ts:flush`.)
2. **Cookie-mismatch / overlapping-sync recovery.** `pull.ts:224-236` flags a known
   imprecision (issue #713): using cookie-equality as a proxy for "snapshot unchanged."
   What real-world interleavings of refresh + pull hit `CookieMismatch`, and is silent
   abandonment always safe?
3. **`update` patch op.** `patch-operation.ts` and `patch.ts` fully implement an `update`
   merge op, but `sync/diff.ts:71-73` says it's "not used in Zero/Replicache." Is it dead
   code, a Zero-only future, or used by some legacy puller?
4. **Mutation recovery across client groups.** `mutation-recovery.ts` + `recoverMutations`
   (`replicache-impl.ts:885`) lets one client push another (dead) client's pending
   mutations using `lastServerAckdMutationIDs`. The exact safety argument for cross-client
   push idempotency (vs the server's `lastMutationID`) deserves a dedicated trace.
5. **Index-change commits.** `meta-type-enum.ts` shows a retired `IndexChangeSDD`; in DD31,
   index maintenance happens inline in `db/write.ts` (`updateIndexes`). Confirm there is no
   longer any separate index-change commit type on the chain.
6. **GC vs refcount under lazy loading.** `dag/gc.ts:RefCountUpdatesDelegate` handles the
   case where lazily-loaded refs "may not have been counted." The interaction between
   LazyStore eviction, `refreshHashes` pinning, and refcount correctness is subtle and worth
   a focused read of `lazy-store.ts:515+ ChunksCache`.
```
