# Lunora — Server / DO Sync Core (reverse-engineered)

A Zero-class local-first sync engine on Cloudflare Durable Objects. Authoritative
state lives in **per-shard SQLite inside a Durable Object** (`ShardDO`); `.global()`
tables live in D1. Reads/writes converge through one drizzle WHERE compiler, one
CDC changelog, and one hibernatable-WebSocket poke protocol.

All citations are `path:line` against
`/Users/mithushancj/Documents/personal/echo/research/lunora`.

---

## 1. Component map

### `packages/server/src/` — authoring surface (runs in the user's bundle, codegen-discovered via brand markers)
| File | Role |
|---|---|
| `shapes.ts` | `defineShape` — declarative partial replication. Brand `__lunoraShape`, `compileWhere` dispatch shim. |
| `mutators.ts` | `defineMutator` — paired client(optimistic)/server(authoritative) impls. Brand `__lunoraMutator`, `kind:"mutation"`. |
| `rls/define.ts` | `definePolicy`/`definePolicies`/`defineRole`/`definePermission` — read OR / write AND semantics. |
| `rls/policy-tag.ts` | `tagRlsMiddleware`/`readRlsTag` — stamps policies+roles on the `rls()` middleware via a `Symbol.for` non-enumerable prop so codegen can recover them. |
| `rls/shape-read-base.ts` | `buildRlsReadRegistry` + `composeShapeReadWhere` — the "shape where doubles as read-permission" machinery. |
| `rls/middleware.ts` (1472 ln) | `computeReadBaseWhere`/`indexRolePermissions`/`permissionName` — request-time RLS, reused verbatim by shapes. |

### `packages/do/src/` — the DO sync runtime
| File | Role |
|---|---|
| `shard-do.ts` (7212 ln) | `ShardDO` god-class: RPC dispatch, mutator watermark protocol, transaction span, write→diff→poke fan-out, alarm poll, hibernatable WS. |
| `ctx-db.ts` (3360 ln) | The DO ORM / `ctx.db` writer: `insert`/`patch`/`replace`/`delete`, OCC guard, `onRead`/`onWrite` hooks, per-column merge. |
| `ctx-db-shapes.ts` | `selectShapeRows` (seed) + `selectShapeMemberIds` (per-flush membership probe). |
| `ctx-db-cdc.ts` | `__cdc_log` append-only changelog + `__cdc_meta` epoch; `appendCdcChange`/`readCdcChanges`/`readCdcCursor`. |
| `ctx-db-client-watermark.ts` | `__client_watermark` table; `readClientWatermark`/`advanceClientWatermark`. |
| `ctx-db-global-shape-snapshot.ts` | `__global_shape_snapshot` durable per-socket baseline for D1-backed global shapes. |
| `shape-global-diff.ts` | Pure helpers: `diffGlobalMembership`, `buildPokeFrames`, `projectColumns`. |
| `subscription-delivery.ts` | Legacy live-query keyed list-delta encoder (`subscriptionListDeltas`) + `sendDeltaFrames`. |
| `dependency-tracker.ts` | Per-query read-dep collector (`recordRead`, `*scan` marker). |
| `reactive-cache.ts` | Convex-style per-shard memo cache keyed by `(fnPath, argsHash, identity)`; invalidated by write hooks. |
| `transaction.ts` | `ConflictError` (`ConflictKind = occ|unique|restrict|trigger|conflict`). |
| `socket-pool.ts` | `runSocketPool` — bounded (8-wide) fan-out shared by refresh + poke. |
| `shard-registry-do.ts` | `ShardRegistryDO` — persistent `Map<table, Set<shardKey>>` for dynamic fan-out. |
| `session-do.ts` | `SessionDO` — auth-session KV DO (orthogonal to sync). |
| `where-types.ts` | Structural `WhereInput` tree + `RELATION_EXISTS_KEY`. |

---

## 2. Key data shapes (verbatim TS)

```ts
// server/src/shapes.ts:35 — declaration
interface ShapeDefinition<Args, Context = QueryContext> {
    readonly args?: Args;                 // validated on the DO before where() runs
    readonly columns?: ReadonlyArray<string>;   // projection; _id/_creationTime always kept
    readonly table: string;
    readonly where: (context: Context, args: InferValidatorMap<Args>) => WhereInput;
}
// :66 RegisteredShape adds: __lunoraShape: true, compileWhere(ctx:unknown, rawArgs) -> WhereInput
```

```ts
// shape-global-diff.ts:16 — wire row-op (DO mirror of client RowOp)
interface ShapeRowOp { key: string; op: "delete"|"insert"|"update"; table: string; value?: Record<string,unknown>; }
// :23 one shape's poke slice
interface ShapePokePart { rowsPatch: ShapeRowOp[]; shapeId: string; }
// :30 checkpoint/epoch + lastMutationId stamped on pokeStart/pokeEnd/pokePart
interface PokeFrameMeta { baseCheckpoint?: number; checkpoint: number; epoch?: string; lastMutationId?: number; pokeId: string; }
```

```ts
// shard-do.ts:273 — watermark classification of a custom-mutator push
type ClientMutationClass = { expected: number; kind: "already" | "gap" | "next" };
// :245 — resolved shape plan (codegen subclass fills effectiveWhere)
interface ResolvedShape { columns?: ReadonlyArray<string>; effectiveWhere?: WhereInput; global?: boolean; table: string; }
// :263 — per-socket per-shape poke baseline
interface ShapeMemo { cursor: number; }  // the __cdc_log seq this shape's view was poked through
```

```ts
// ctx-db-cdc.ts:25 — one changelog entry
interface CdcChange { doc?: Record<string,unknown>; id: string; op:"delete"|"insert"|"update"; seq: number; table: string; ts: number; }
// ctx-db.ts:279 — onWrite event
interface WriteEvent { doc?: Record<string,unknown>; id: string; op:"delete"|"insert"|"update"; table: string; }
// types.ts:162 — legacy live-query delta
interface MutationDelta { key: string; op:"insert"|"update"|"delete"; row?: Record<string,unknown>; table: string; }
```

---

## 3. Shapes — declaration, where-eval, and where-as-read-permission

**Declaration** (`server/src/shapes.ts:81`). `defineShape({ table, where, args?, columns? })`
validates `table` non-empty and `columns` non-empty-when-present (`:84`,`:88`), then
returns a `RegisteredShape` carrying `__lunoraShape:true` and a `compileWhere(ctx,
rawArgs)` shim that **validates args then evaluates `where`** (`:92-96`). `ctx` is
typed `unknown` at the dispatch boundary — the DO builds it from the socket's
verified identity and hands it back (`:69-77`), exactly like `RegisteredMutator.handler`.

**Server-side evaluation.** A shape runs **no procedure**, so `.use(rls(...))`
middleware never fires (`rls/shape-read-base.ts:5-13`). The codegen `ShardDO`
subclass overrides `resolveShape(name, args, identity)` (`shard-do.ts:3787`) to:
look up the `defineShape`, run `where(ctx, args)` under the **socket's verified
identity** (never the client's word — `shard-do.ts:3780-3785`, `ResolvedShape`
doc `:239`), and AND-compose with the table RLS read base-where into
`effectiveWhere`.

**Where-as-read-permission gate** lives in `rls/shape-read-base.ts`:
- `buildRlsReadRegistry(LUNORA_FUNCTIONS)` (`:229`) harvests `on:"read"` policies
  hoisted onto every registered function via the `readRlsTag` symbol, grouped
  per-`rls()`-middleware so each keeps its own role→permission map (`:94-125`).
- `composeShapeReadWhere` (`:254`) = `andMerge(resolveReadBaseWhere(...), shapeWhere)`.
  `resolveReadBaseWhere` (`:180`) reuses the **same** `computeReadBaseWhere` /
  `indexRolePermissions` / `permissionName` primitives the request-time middleware
  uses (`:25`), so a shape filter has "zero semantic drift" from an equivalent guarded query.
- **Fail-closed parity with `guardWriter`:** under `.rls("required")` a non-`.public()`
  table with **no** read policy returns the `FALSE_PREDICATE = { OR: [] }` sentinel
  (`:72`, `:187`) → replicate nothing. Multiple groups OR (`:195-217`); all-deny → FALSE.

**In-memory / SQL representation of a subscription.** Wire descriptor
`ShapeSubscriptionQuery { name, args?, sinceSeq?, sinceEpoch? }` (`types.ts:51`).
At runtime each socket's attachment holds `shapes: Record<subId,
ShapeSubscriptionQuery>` (hibernation-persisted), and the DO keeps a per-socket
`shapeMemos: Map<ws, Map<subId, ShapeMemo>>` whose `cursor` is the `__cdc_log` seq
that subscription was last poked through (`shard-do.ts:262`, `:6272`). The SQL
representation is **not materialized** — membership is computed on demand by
compiling `effectiveWhere` to SQL via the shared `compileWhereSql`
(`ctx-db-shapes.ts:36`, `selectShapeRows`/`selectShapeMemberIds`).

---

## 4. Poke diff protocol — membership diff without re-running the query

Two diff strategies depending on backend:

### Shard-local (SQLite) shapes — CDC op-log + membership probe
On a write, the DO records changed tables; `flushChangedTables` (`shard-do.ts:5701`)
coalesces and (via `waitUntil`, off the response path) runs
`drainSubscriptionRefreshes` → `Promise.all([refreshSubscriptions, pokeShapeSubscribers])`
off **one post-write cut** `(frameCursor=currentCdcCursor, frameEpoch)`
(`:5782-5786`).

`pokeShapeSubscribers(changed, frameCursor, frameEpoch)` (`:6177`) fans over
sockets with `runSocketPool` (8-wide, `awaitWsDrain` backpressure per send,
`:6218`,`:6239`). Per shape, `buildShapeDiff` (`:6352`) is the crux — **it does NOT
re-run the query against the whole table**:
1. `readShapeOpRange(table, sinceSeq=memoCursor, upTo=checkpoint)` drains the
   `__cdc_log` slice and **collapses multiple ops on the same id to the newest**
   (`:6299-6324`), memoized per-flush so N shapes on a table share **one** op-log
   drain (`opRangeCache`, `:6186`).
2. `selectShapeMemberIds(sql, table, effectiveWhere, ids)` (`ctx-db-shapes.ts:107`)
   probes **only the changed ids** (`id IN (...) AND <compiled effectiveWhere>`),
   returning the subset still satisfying the predicate.
3. Split (`shard-do.ts:6369-6389`):
   - id still a member + post-image present → `{op: change.op, value: projectColumns(doc, columns)}` (upsert)
   - `insert` that never matched → **emit nothing** (was never replicated)
   - `update` that left the set, or a `delete` → `{op:"delete"}` (pre-image unknowable; conservative drop, no-op on client if never held)

### `.global()` (D1) shapes — full re-read + snapshot diff
No per-DO op-log, so an **alarm poll loop** (`alarm()` `:2368` → `pollGlobalShapes`)
re-reads full membership each tick via `readGlobalShapeRows` and diffs against the
**durable** per-socket baseline `__global_shape_snapshot`
(`ctx-db-global-shape-snapshot.ts`). `diffGlobalMembership(rows, previous, {columns,
table})` (`shape-global-diff.ts:77`) emits new key→insert, changed projected JSON→update,
vanished key→delete. The baseline is persisted (not a `WeakMap`) specifically so a
hibernation eviction can't drop a `delete` and leave a phantom row (`:1-15` module doc).

### Wire framing & atomicity
`buildPokeFrames(parts, meta)` (`shape-global-diff.ts:116`) emits **`pokeStart` →
one `pokePart` per shape → `pokeEnd`**; "all parts apply atomically at `pokeEnd`"
(`:110`). `pokeStart` carries `{baseCheckpoint, epoch, pokeId}`; each `pokePart`
carries `{rowsPatch, shapeId, lastMutationId?}`; `pokeEnd` carries `{checkpoint,
epoch, pokeId}`. `sendPoke` (`shard-do.ts:6720`) stamps `lastMutationId` =
`socketClientWatermark(ws)` so the client drops the matching optimistic overlay.
Memo advance is delivery-gated: part-bearing shapes advance their memo **only after
the poke send returns true** (`:6220-6224`); a failed send leaves the memo so the
next flush re-emits (idempotent on the keyed client).

---

## 5. Mutators server-side — serialized, no OCC-retry loop, per-column convergence

**Authoritative execution.** `defineMutator` pairs `client` (optimistic, TanStack DB
tx) with `server` (authoritative). `RegisteredMutator.handler` validates args then
runs `server` (`mutators.ts:92`), and `kind:"mutation"` makes the DO wrap it in the
shard's BEGIN/COMMIT span exactly like an ordinary mutation (`:78-86`).

**Serialization — the "no OCC-retry loop" claim confirmed.** `runInTransaction`
(`shard-do.ts:2622`) wraps the handler in `state.blockConcurrencyWhile(run)`
(`:2667`) and `state.storage.transaction(async () => handler())` (`:2657`). workerd
**forbids** raw `BEGIN`/`COMMIT`/`SAVEPOINT` inside a DO, so it uses the platform's
native atomic transaction primitive (`:2641-2650`); `transactionDepth` rejects nested
tx (`:2623`). Because `blockConcurrencyWhile` serializes dispatch, there is **no
server retry loop** — `mutators.ts:14-16` states it plainly: "The DO is serialized…
so there is no server-side OCC-retry loop: a `ConflictError` here is a deterministic
self-conflict, not a race to retry."

OCC still exists but only as a **CAS guard against the DO's own intra-mutation
`await`** (before-update triggers / onDelete cascades). `runGuardedWrite`
(`ctx-db.ts:1497`) runs the write then `SELECT changes()`; zero rows ⇒
`ConflictError(..., "occ")` (`:1502`). The `patch` UPDATE's WHERE includes `AND
__doc__ = <read-time snapshot>` (`:2933`) so a concurrent commit during the
intervening await fails the CAS instead of clobbering (`:2923-2929`). Only `kind:"occ"`
is counted as true write contention (`transaction.ts:1-10`).

**Per-column convergence via `patch` — no CRDT.** `patch(id, patch)`
(`ctx-db.ts:2874`) does `const merged = { ...existing, ...patch, _id: id }`
(`:2907`) and writes the whole merged doc back. Only the keys **present in
`patch`** overwrite; untouched fields are copied from `existing`. So two offline
edits to *different* fields of the same row each `patch` only their own field; when
both replay through the serialized DO, each merges over the other's already-committed
doc and **both survive** — last-writer-wins **per column**, achieved by the JS spread
merge, not a CRDT. `patch(id, {field: undefined})` is **rejected** (`assertNoExplicitUndefined`
`:1464`,`:2905`) because the merge+`JSON.stringify` would silently delete the field —
callers must pass `null` to clear. (Two concurrent edits to the *same* field still
LWW-collapse; convergence is per-column, not per-character.)

---

## 6. Watermark protocol — stable clientId + monotonic clientSeq

Table `__client_watermark(identity, client_id, last_mutation_id, PRIMARY KEY(identity,
client_id))` (`ctx-db-client-watermark.ts:53`). **Scoped by authenticated `identity`**
(`""` for anon) so a spoofed/reused `clientId` under another user reads its own zeroed
counter and can't suppress the real owner's sequence (`:14-22`,`:69-76`). `clientId`
is a `crypto.randomUUID` minted by the SDK (`:18-22`).

Dispatch (`shard-do.ts:1968-2019`): `classifyClientMutation` (`:3343`) reads the
watermark and classifies `clientSeq` (forwarded as the `x-lunora-client-seq` header):
```
seq <= watermark        → "already" → ack without re-run, echo lastMutationId  (rejectNonNextMutation :3397)
seq == watermark + 1     → "next"    → run authoritative server impl
seq  > watermark + 1     → "gap"     → 409 OUT_OF_ORDER, client resends from `expected`  (:3405)
```
This makes pushes **idempotent** (replay acks without re-applying) and **ordered**
(gaps halt the batch). For a `"next"` push the watermark advance + idempotency dedup
row are committed **inside the handler's transaction** via `commitMutationBookkeeping`
(`:3471`) so writes+dedup+watermark land atomically. The standalone
`advanceClientWatermark` (`ctx-db-client-watermark.ts:89`) uses `ON CONFLICT … SET
last_mutation_id = MAX(...)` to stay monotonic, and the protocol **self-heals** a
crash between handler-commit and a *non-atomic* advance: the unacked replay
re-classifies `"next"`, re-runs idempotently (idempotency row dedups the real write),
re-advances — only ever replaying, never skipping/double-applying (`:78-88`,
`shard-do.ts:2008-2016`).

---

## 7. Sharding

A **shard = one Durable Object instance = one SQLite database**, addressed by a shard
key (`.shardBy(key)` partitions by user/tenant/room; default topology is a single
`__root__` DO — AGENTS.md "Architecture Overview"). Each DO is its own consistency
boundary (`reactive-cache.ts:8-11`).

`ShardRegistryDO` (`shard-registry-do.ts`) is the **persistent source of truth for
which shard keys are live per table**, so the query coordinator can fan a cross-shard
read to every live shard for **dynamic** cardinality (one shard per user-created
channel). It is a single conventionally-named instance (`__lunora_shard_registry__`
`:39`) holding an in-memory `Map<table, Set<shardKey>>` (`:116`) persisted under one
`__tables__` key (`:42`). HTTP-only surface: `POST /register`, `POST /unregister`,
`GET /list?table=`, `GET /snapshot` (`:131-153`). A worker registers a key on
first-seen write (via `ctx.waitUntil` off the user path, `:16-20`); read-modify-write
spans are serialized with `blockConcurrencyWhile` (`:205`,`:246`). The runtime's
`createDynamicShardRegistry` caches `/list` with a small TTL (`:18-21`).

---

## 8. Dependency tracking / reactive cache — which subs to re-poke

`DependencyTracker` (`dependency-tracker.ts:73`) stamps a dep `${table}:${id}` for
every row a query reads (`recordRead`), and a special `${table}:*scan` marker
(`SCAN_DEP` `:31`) for any non-index read — those must invalidate on **every** write
to the table because a `patch` can flip a row in/out of a scan predicate without
changing the id set (`:6-13`). It is **ctx-threaded, not AsyncLocalStorage**
(workerd ALS needs `nodejs_compat`; shard DOs run the slimmer `sqlite_compat`
profile — `:12-24`).

`ReactiveCache` (`reactive-cache.ts:113`) memoizes results keyed by
`reactiveCacheKey(fnPath, stableStringify(args), identity)` (`:396`) — **identity is
required** so the shared single-`__root__`-DO doesn't serve user A's RLS-filtered
result to user B (`:388-395`). Each entry stores its dep `Set` plus a `tableIndex`
(`table:id → Set<key>`) so `invalidate(table, id)` is O(deps) not O(entries)
(`:117`,`:221`). On a write, `ctx.db`'s write path calls `cache.invalidate(table,
id)` which drops both the row's per-id deps **and** the `table:*scan` bucket
(`:224-225`, called from `patch` at `ctx-db.ts:2943`). `invalidate` returns the
removed keys so `ShardDO.flushChangedTables` re-runs their subscribers. LRU eviction
pins entries with `subscribers.size > 0` (`:374`) to avoid a re-run storm. The cache
is invalidated via the **same `onWrite`/write hooks** that drive CDC + broadcast, so
the reactive layer and the sync layer never drift.

The actual re-poke decision is **table-set based**: `refreshSubscriptions` /
`pokeShapeSubscribers` only act on subscriptions whose read-table set intersects the
flush's `changed` set (`shard-do.ts:6268` skips `!changed.has(resolved.table)`); the
reactive cache is an orthogonal speedup for the one-shot query path.

---

## 9. Surprising / clever design decisions

- **One WHERE compiler, three callers.** Shapes, RLS, and queries all compile
  `WhereInput` through `compileWhereSql` (`ctx-db-shapes.ts:18-20`,
  `where-types.ts:3-11`) — "zero second predicate implementation," so a shape can
  never diverge from the query/RLS semantics it claims to mirror.
- **Membership diff, not query re-run.** The poke path probes membership of *only the
  changed ids* (`selectShapeMemberIds`), then derives insert/update/delete from
  CDC-op × membership — bounded by writes, not table size.
- **`insert`-that-never-matched emits nothing** (`shard-do.ts:6380`) — avoids
  spamming every shape subscriber on a table with no-op deletes.
- **Per-flush op-range memo** (`opRangeCache`) collapses N shapes-on-a-table into one
  changelog drain (`:6293-6297`).
- **Durable global-shape snapshot** fixes a real phantom-row bug a `WeakMap` baseline
  caused across hibernation (`ctx-db-global-shape-snapshot.ts:8-16`).
- **CDC epoch** pairs with the seq cursor so a reset/recycled-DO timeline fork forces
  a re-snapshot instead of silently resuming onto forked data (`ctx-db-cdc.ts:157-166`).
- **Identity-by-value into subscription re-runs** (`SubscriptionIdentity`
  `shard-do.ts:300`) — the deferred `waitUntil` refresh never reads the mutable
  per-request identity fields a concurrent RPC owns, preventing cross-user leakage.
- **Self-healing watermark** — non-atomic advance is *deliberately* safe because the
  replay path re-runs idempotently.
- **`sqlite_compat` over `nodejs_compat`** drove the explicit ctx-threading of the
  dep tracker rather than ALS — a runtime-profile-driven architecture choice.

---

## Open questions / couldn't confirm

- **`commitMutationBookkeeping` invocation site.** I confirmed its definition
  (`shard-do.ts:3471`) and that the codegen `handleRpc` mutation branch is *documented*
  to call it before commit, but `handleRpc` itself is abstract (`:2390`); the concrete
  call lives in generated `_generated/*`/codegen templates I did not open.
- **`.shardBy` / `.global()` schema wiring.** I read the sharding *runtime* (registry
  DO, `ResolvedShape.global`) but did not open `server/src/schema.ts` /
  `data-model.ts` to confirm exactly how `shardMode`/`.global()` is declared and how
  codegen sets `ResolvedShape.global` (doc says "from the schema's `shardMode`",
  `shard-do.ts:255`).
- **`refreshSubscriptions` body** (legacy live-query re-run) — I traced its callers,
  coalescing, and the `subscriptionListDeltas` encoder it uses, but did not read the
  method body itself; the keyed-delta vs full-snapshot fallback logic is fully in
  `subscription-delivery.ts` though.
- **Same-field concurrent-edit semantics** are LWW by inference from the spread merge;
  I did not find an explicit test asserting it.
- **Cross-shard relation reads** (`RELATION_FUNCTION_PREFIX`, `relation-predicates.ts`,
  `relations.ts`) were out of the time budget — noted as fan-out reads served bare for
  the coordinator's concat/sum merge (`shard-do.ts:1955-1965`) but not traced.
