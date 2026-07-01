# Lunora — Wire Protocol, Storage Codec & Framework Glue

Repo: `/Users/mithushancj/Documents/personal/echo/research/lunora`. All findings read from source; cited `path:line`.

---

## 1. The over-the-wire message protocol

All wire message types are TS discriminated unions in **`packages/client/src/types.ts`**, keyed on a string `type` discriminator. JSON-encoded over a hibernatable WebSocket; the server side parses/emits them in `packages/do/src/shard-do.ts` (e.g. the envelope dispatch around `shard-do.ts:2137–2297`) and `packages/do/src/subscription-delivery.ts`. Custom-mutator pushes ride a separate HTTP `/rpc` path with header watermarks (see §3), not the WS unions.

### 1a. Client → server — `ClientMessage` (`types.ts:462`)

```ts
export type ClientMessage =
    | ClientAckMessage              // { id; type:"ack" }                              types.ts:422
    | ClientConnectMessage          // one-shot post-open control frame                types.ts:374
    | ClientShapeSubscribeMessage   // partial-replication shape subscribe             types.ts:395
    | ClientShapeUnsubscribeMessage // { id; type:"shape_unsubscribe" }                types.ts:417
    | ClientStreamMessage           // start a streaming query                         types.ts:434
    | ClientSubscribeMessage        // live query subscribe                            types.ts:348
    | ClientUnsubscribeMessage      // { id; type:"unsubscribe" }                      types.ts:363
    | ClientWhisperMessage          // ephemeral broadcast to a topic                  types.ts:456
    | ClientWhisperSubscribeMessage;// join/leave a whisper topic                      types.ts:445
```

Field meanings (the load-bearing ones):

- **`ClientConnectMessage`** (`types.ts:374`): `{ type:"connect"; id; clientId?; context? }`. First frame after socket open. `clientId` is the **stable per-client id** persisted with the outbox — it scopes the server's `__client_watermark` so custom-mutator pokes can echo this client's `lastMutationId` (`types.ts:375-381`). `context` (e.g. `{ roomId, sessionId }`) registers with the server and is replayed to `onDisconnect`.
- **`ClientSubscribeMessage`** (`types.ts:348`): `{ type:"subscribe"; id; query:{ args?; functionPath?; sinceEpoch?; sinceSeq?; table? } }`. `sinceSeq` is the persisted `__cdc_log` cursor high-watermark for **Pillar 1b resume** — present only when a durable `QueryCacheAdapter` restored a cached value; the server may answer with a lightweight `resume` frame instead of a full snapshot (`types.ts:351-358`).
- **`ClientShapeSubscribeMessage`** (`types.ts:395`): `{ type:"shape_subscribe"; id; shape:{ name; args? }; sinceCheckpoint?; sinceEpoch? }`. Subscribe to a declarative **shape** (server-side partial replication scoped by `shardBy` + predicate + RLS). Client sends shape *name* + validated `args`; server resolves the trusted `where` (the client can't forge identity/RLS `baseWhere`) and streams the rowset, then live poke diffs. `id` is echoed as `shapeId` on every poke part. `sinceCheckpoint` below the server's retained floor (`minCdcSeq`) or an epoch mismatch forces a full re-seed (`types.ts:399-412`).
- **`ClientStreamMessage`** (`types.ts:434`): `{ type:"stream"; id; query:{ functionPath; args?; shardKey? } }`. Cancelled by an `unsubscribe` with the same id (sub/stream id-spaces share the cancel channel; `sub_*` vs `stream_*` prefix keeps registries searchable).
- **`ClientWhisperMessage` / `ClientWhisperSubscribeMessage`** (`types.ts:456`, `:445`): ephemeral topic broadcast (typing indicators, live cursors, presence). `whisper` payload relayed verbatim, **no SQLite/CDC write**; sender does not receive its own whisper.

### 1b. Server → client — `ServerMessage` (`types.ts:637`)

```ts
export type ServerMessage =
    | ServerAckMessage         // { id; type:"ack" }                                   types.ts:545
    | ServerChunkMessage       // { id; data; type:"chunk" } — one stream chunk        types.ts:556
    | ServerCompleteMessage    // { id; type:"complete" } — stream done                types.ts:550
    | ServerDataMessage        // full snapshot OR row delta                           types.ts:474
    | ServerErrorMessage       // { type:"error"; id?; error?; message? }              types.ts:538
    | ServerPokeEndMessage     // close an atomic poke batch                           types.ts:628
    | ServerPokePartMessage    // one shape's slice of an in-flight poke               types.ts:611
    | ServerPokeStartMessage   // open an atomic poke batch                            types.ts:600
    | ServerResumeMessage      // lightweight "nothing changed" resume ack             types.ts:503
    | ServerSettledMessage     // list write with byte-identical result                types.ts:522
    | ServerWhisperMessage;    // ephemeral whisper relayed from a peer                types.ts:568
```

Field meanings:

- **`ServerDataMessage`** (`types.ts:474`): `{ type:"data"|"delta"; id; data?; delta?; cursor?; epoch?; lastMutationId? }`. `data` = full snapshot, `delta` = row patch the client merges in place (`subscription-delivery.ts:8`). `cursor` = `__cdc_log` high-watermark this frame covers (persisted as `serverCursor`, replayed as `sinceSeq`). **`lastMutationId`** = the highest custom-mutator `mutationId` from this client the server has applied (the per-client `__client_watermark`) — echoed so the outbox drops confirmed pending mutations and TanStack DB collapses the matching optimistic overlay (`types.ts:487-493`).
- **`ServerResumeMessage`** (`types.ts:503`): `{ type:"resume"; id; cursor?; epoch?; lastMutationId? }`. Pillar 1b — server determined nothing the subscription reads changed since `sinceSeq`; client keeps its cached value and only advances `serverCursor`.
- **`ServerSettledMessage`** (`types.ts:522`): `{ type:"settled"; id; cursor?; epoch?; lastMutationId? }`. A write touched a **list** subscription's read table but produced a **byte-identical** result, so the data frame is suppressed. Sent **only** to a `@lunora/db` custom-mutator client (one that announced a `clientId`) so its optimistic list overlay still drops; plain `useQuery` subscribers never get it; older clients ignore it safely.
- **Poke trio** (Zero's poke protocol, atomically-applied shape-diff batch):
  - **`ServerPokeStartMessage`** (`types.ts:600`): `{ type:"pokeStart"; pokeId; baseCheckpoint?; epoch? }`. `baseCheckpoint` = expected client checkpoint before apply (gap detection); `epoch` mismatch forces re-seed.
  - **`ServerPokePartMessage`** (`types.ts:611`): `{ type:"pokePart"; pokeId; shapeId; rowsPatch: RowOp[]; lastMutationId? }`. One shape's slice; `shapeId` echoes the `ClientShapeSubscribeMessage.id`.
  - **`ServerPokeEndMessage`** (`types.ts:628`): `{ type:"pokeEnd"; pokeId; checkpoint?; epoch? }`. Client commits buffered parts atomically and advances its checkpoint (replayed as `sinceCheckpoint` next reconnect). A socket drop mid-poke → re-seed, no torn view (`types.ts:593-598`).
- **`RowOp`** (`types.ts:583`): `{ key; op:"delete"|"insert"|"update"; table; value? }`. Wire form of the DO's `__cdc_log` `CdcChange`. `insert`/`update` carry the post-image in `value` (projected to the shape's `columns`); `delete` omits it (identifies the row by `key`=`_id`). An unknown `key` on `delete` is a safe client no-op.

### 1c. The HTTP `/rpc` watermark response (not a WS union)

Custom-mutator pushes return **`RpcResponseBody`** (`types.ts:345`):

```ts
export type RpcResponseBody =
    | { error: { code: string; message: string } }
    | { lastMutationId?: number; result: unknown };
```

A watermarked push additionally carries `lastMutationId` = the highest per-client sequence the DO applied, which keeps the client's `clientSeq` generator monotonic across reloads. Request side: `x-lunora-client-id` + monotonic `x-lunora-client-seq` headers (`lunora-client.ts:767-770`). Semantics — `id <= watermark` is a replay (skipped/acked), `id == watermark+1` runs authoritatively, `id > watermark+1` halts (`OUT_OF_ORDER`) so the client resends from `watermark+1` (`types.ts:330-335`).

---

## 2. Storage codec for DO SQLite — `packages/sql-store/src/value-codec.ts`

SQLite is the **baseline** storage form on every engine: no boolean (1/0), no native JSON (TEXT), no >64-bit int (decimal string). Postgres/MySQL dialects reuse these helpers and override only where the driver is native (`value-codec.ts:1-10`). The same codec is used for `.global()` tables; `serializeColumnValue = sqliteEncode` (ctx-db.ts:284) and decode runs through `decodeGlobalRow` → `sqliteDecode` (ctx-db.ts:357-374).

### Encode — `sqliteEncode(value)` (`value-codec.ts:14`)

| JS value | Stored form | Line |
|---|---|---|
| `boolean` | `1` / `0` (SQLite has no boolean) | `:15-17` |
| `null` / `string` / `number` | verbatim | `:19-21` |
| `bigint` | decimal **string** (`value.toString()`) | `:23-25` |
| `Uint8Array` | bound directly as **BLOB** (BYTEA on PG) — **must precede JSON fallback**, else `JSON.stringify(uint8array)` corrupts it to `{"0":…}` | `:30-32` |
| `ArrayBuffer` | wrapped to `Uint8Array` → BLOB | `:34-36` |
| anything else (object/array/record) | `JSON.stringify(value)` (TEXT) | `:38` |

### Decode — `sqliteDecode(raw, kind)` (`value-codec.ts:92`)

Driven by the field's **effective validator `kind`** (not the stored JS type). `null` → `null` short-circuits (`:93`).

| `kind` | Decode | Line |
|---|---|---|
| `"any"` / `"union"` | JSON-parse **only** if the string starts with `{` or `[` (a scalar union member round-trips through SQLite's native column type) | `:98-101` |
| `"array"` / `"object"` / `"record"` | `tryJsonParse(raw)` when string | `:102-106` |
| `"bigint"` | `decodeBigint` — decimal string → `BigInt`, else verbatim | `:107-109` |
| `"boolean"` | `0/1` → `false/true` | `:110-112` |
| else (`string`/`number`/`date`/`timestamp`/`id`/`literal`) | verbatim | `:113-115` |

Supporting helpers:
- **`tryJsonParse(raw)`** (`:42`): `JSON.parse`, returns `raw` unchanged on failure.
- **`decodeBigint(raw)`** (`:51`): `BigInt(raw)` for a decimal string, else verbatim.
- **`effectiveColumnKind(validator)`** (`:71`): unwraps `v.optional(inner)` — the validator's own `kind` is `"optional"`, which hides the real storage form, so it recurses into `_meta.inner` (stashed by `@lunora/values`' `createValidator`) so the decode reverses the *real* form. This is why an optional column stores/loads exactly as its inner kind would.

### IDs and framework columns

- The logical document id field `_id` maps to physical column **`id`**; `_creationTime` is preserved as itself (`ctx-db.ts:95`, `:370-371`).
- Row serialization tuple is ordered `["id", "_creationTime", ...fields]`, fields encoded via `serializeColumnValue` (= `sqliteEncode`), absent columns bound as `null` (`ctx-db.ts:2197-2212`).
- `decodeGlobalRow` rebuilds the doc: each field through `sqliteDecode(raw, effectiveColumnKind(validator))`, then sets `_id = row.id`, `_creationTime = row._creationTime` (`ctx-db.ts:357-374`). It is engine-agnostic and tolerant of a driver returning either the stored string OR a pre-parsed value (e.g. mysql2 parses JSON columns) (`ctx-db.ts:351-355`).

### The dialect seam — `packages/sql-store/src/dialect.ts`

`SqlDialect` (`dialect.ts:43`) is the per-engine value object that lets one ORM core (`createSqlCtxDb`) drive SQLite/D1, Postgres, MySQL. Codec-relevant members: `encode`/`decode` (`:76-78`), `columnType(kind)` (SQLite affinity vs PG `JSONB`/`BYTEA`/`BOOLEAN` vs MySQL `JSON`/`TINYINT(1)`/`LONGBLOB`; `:47-53`), `companionTypes` for internal agg/rank/CDC tables (`:62-74`), `frameworkColumns()` = the `id` PK + `_creationTime` (`:79-80`), `indexKeyPrefix` (MySQL TEXT/BLOB needs a key-prefix length; `:89`), `isUniqueViolation` → 409 ConflictError (`:91`), `supportsReturning` (SQLite/PG yes, MySQL no → `affectedRows` OCC; `:96-97`), and `tableExists` (`:107`). `SqlExec.all`/`run` is the async surface (`dialect.ts:37-40`); `run` reports `rowsAffected` for the MySQL OCC guard that lacks `RETURNING`.

---

## 3. TanStack DB glue — `packages/db/src/`

### 3a. `lunoraCollectionOptions({ list | shape })` (`collection-options.ts:146`)

Builds a `CollectionConfig<TRow,string>` (+ sync controls) that live-syncs a Lunora source into TanStack DB. **Exactly one of `list` or `shape`** (XOR throw at `:147-149`).

- Key extractor defaults to `row._id` (`:151`). `getKey` and `autoIndex:"eager"` + `defaultIndexType:BTreeIndex` so live queries' joins/filters/sorts stay fast (`:208-213`).
- Collection `id` = `options.id ?? options.list?.__lunoraRef ?? \`shape:${shape.name}\`` (`:214`).
- The `sync.sync(writer)` closure (`:215-247`) builds `emit = makeDiffEmit(syncedJson, writer)` — a JSON-diff-into-channel keyed by row id, where `syncedJson` is owned **outside** `sync.sync` so it survives sync restarts (`:153-157`). On subscription error it calls `writer.markReady()` then `onError` — a rejected subscription never hangs the collection in `loading` (`:221-224`).
- **`openSubscription(args, onReady)`** (`:168-206`) is one uniform callback shape over both sources:
  - **shape path** → `client.subscribeShape({ args, name }, onRows, { onCheckpoint, onError, shardKey })` (`:198-202`).
  - **list path** → `client.subscribe(list, args, onRows, { onCheckpoint, onError })` (`:205`).
  - `onRows` does `emit(toMap(rows, getKey)); onReady()`. A **list** `data` frame carries no per-frame watermark, so it advances the registry from `client.confirmedMutationWatermark()` (the push-ack stream) so a `bindMutators` overlay drops exactly when synced rows land instead of `awaitMutationId` hanging forever (`:178-186`).
- **`CheckpointRegistry`** (`:63-90`) — two monotonic `Gate`s (`:20-51`): `awaitCheckpoint(cursor)` / `awaitMutationId(id)` resolve when `resolve({ checkpoint?, mutationId? })` advances past them; a threshold already passed resolves immediately. This is the no-flicker hold: the optimistic overlay is kept until the synced server value lands.
- **`scope(args?)`** (`:249-264`) — re-points a `scopeBy` collection (unsubscribe, clear rows via `emit(new Map())`, re-subscribe); no-op for unscoped.

`defineCollections` (`define-collections.ts:97`) is the declarative wrapper: each entry → `lunoraCollectionOptions` (`:109-117`) → `createCollection`; `insert` entries get a durable, retried, client-id-keyed write action via `@tanstack/offline-transactions` (`startOfflineExecutor`, `:163-167`; per-action `crypto.randomUUID()` client id at `:186-191`). The reserved `OUTBOX_MUTATION_FN_NAME` replay handler re-plays raw offline `client.mutation`s under the **original idempotency key** and drops a write whose captured identity no longer matches the signed-in user (`NonRetriableError`, `:144-161`).

### 3b. `useMutator` runs the optimistic txn + watermarked push

Client mutators are defined with **`defineMutator({ apply, serverRef })`** (`define-mutators.ts:33`): `apply` is the optimistic body against local collections, `serverRef` names the authoritative server impl — "the server impl is the linearization point — this body is a prediction the server can override" (`:27-31`).

**`bindMutators(client, context, mutators)`** (`define-mutators.ts:105`) — each bound handle opens a TanStack `createTransaction({ autoCommit:true, metadata:{serverRef}, mutationFn })` (`:166-183`), where:
1. `transaction.mutate(() => mutator.apply({ collections }, args))` writes the predicted rows (`:185-187`).
2. `mutationFn` calls `pushSerialized(serverRef, args)` (`:172-174`) which serializes pushes **per binding** in a FIFO chain (`pushChain`, `:124`) and, inside the critical section, claims `clientSeq = max(counter, client.confirmedMutationWatermark(shardKey)) + 1` (`nextClientSeq`, `:115-119`) then `client.callMutator(serverRef, args, { clientSeq, shardKey })` (`:134-137`).
3. If the DO swallows the push as a replay (`applied === false`), it **reissues above the now-known watermark** (loop, capped at 32, `:131-149`) — closes the silent-drop window after a reload without risking double-apply.
4. If `context.checkpoints` is wired, the `mutationFn` then `await checkpoints.awaitMutationId(appliedSeq)` — holding the overlay until the poke echoes this client's `lastMutationId`; skipped when no watermark stream, where the by-value diff converges in place (`:176-181`).

The DO rejects any `clientSeq > watermark + 1` as `OUT_OF_ORDER` and drops it, which is why pushes are strictly serialized (`:96-103`). `client.callMutator` (`lunora-client.ts:782-827`) sends `x-lunora-client-id` + `x-lunora-client-seq`, captures the ack watermark, bumps `clientWatermarks`, and returns `{ applied, result }` where `applied = ackWatermark === undefined || ackWatermark === clientSeq` (`:824`).

**`useMutator(handle)`** (`react/src/use-mutator.ts:32`) is a thin React wrapper: `{ mutate, pending, error, isError, reset }` over a bound handle via `createMutatorRunner(handle, { setError, setPending })` (`:39`). It owns **only** the in-flight/error React state (ref-counted `pending` across overlapping calls); the optimistic overlay + push are owned by the bound handle + TanStack's optimistic-transaction layer. Explicitly: *"Reads stay on the existing `useLiveQuery`; no new query hook is needed"* (`use-mutator.ts:26-28`).

### 3c. Reads stay on `useLiveQuery` — confirmed

- `use-mutator.ts:26-28` states reads stay on `useLiveQuery`.
- The example reads exclusively through `useLiveQuery` from `@tanstack/react-db` (`Chat.tsx:3,51,61,80`).
- `@lunora/react`'s own `useQuery` (`use-query.ts`) / `useSubscription` (`use-subscription.ts`) are the **non-TanStack-DB** path (raw query subscriptions over TanStack *Query* / the client query state machine) — a separate read surface from the TanStack DB collection layer, not used for collection reads.

---

## 4. End-to-end developer wiring — `apps/playground`

The most complete example of `defineShape` + `defineMutator` + collection + `useLiveQuery`. (`useMutator`/`bindMutators` ship in `@lunora/db/mutators`; the playground uses the sibling `defineCollections` + outbox `actions` form for writes — both run the same optimistic-txn + watermarked-push core.)

**Server shape** — `apps/playground/lunora/shapes.ts:9`:
```ts
export const channelMessages = defineShape({
    args: { channelId: v.id("channels") },
    columns: ["channelId", "text", "userId", "createdAt"],
    table: "messages",
    where: (_ctx, arguments_) => ({ channelId: arguments_.channelId }),
});
```
The `where` runs server-side under the socket's trusted identity → which rows replicate is a server (reads-as-permissions) decision (`shapes.ts:3-8`).

**Server custom mutator** — `apps/playground/lunora/mutators.ts:9`:
```ts
export const sendMessage = defineMutator({
    args: { channelId: v.id("channels"), createdAt: v.number(), text: v.string(), userId: v.id("users") },
    client: () => { /* optimistic overlay applied by the binding */ },
    server: async (ctx, arguments_) => {
        const id = await ctx.db.insert("messages", { channelId, createdAt, text, userId });
        return { _id: id, channelId, text };
    },
});
```
`createdAt` is caller-stamped so the authoritative handler is deterministic; the insert appends to `__cdc_log` and pokes every `channelMessages` subscriber — echoing args alone would emit no CDC entry, so subscribers would never observe the send (`mutators.ts:11-25`).

**Client data layer** — `apps/playground/src/client/messages-store.ts:44`: one `defineCollections(client, {...})` call wires `channels` / `messages` / `users` collections + the offline outbox. `messages` declares `insert:{ mutation: api.messages.send, optimistic, toArgs }` and `scopeBy:"channelId"` (`:63-82`); the store exposes `send`/`createChannel` actions and `setActiveChannel` → `database.scope.messages(...)` (`:88-98`).

**Component** — `apps/playground/src/client/Chat.tsx`:
- `const store = getMessagesStore(client)` (`:29`) where `client = useLunora()` (`:27`).
- Reads via `useLiveQuery`: channels (`:51`), a live **messages ⨝ users** left-join with `orderBy createdAt asc` + `select` (author names/ordering derived client-side, no extra round-trip; `:61-77`), and a localStorage drafts collection (`:80`).
- Writes via the optimistic action: `const { id, transaction } = store.send({ channelId, text, userId })` (`:89`), marks the row pending until `transaction.isPersisted.promise` settles (ack supersedes the optimistic row; rejection rolls it back; `:91-108`).
- `store.setActiveChannel(activeChannel)` re-points the scoped subscription on channel change (`:54-56`).

Connection status (in scope) — `react/src/use-connection-status.ts:14`: `useConnectionStatus()` via `useSyncExternalStore` over `client.onConnectionStatus` / `client.connectionStatus()` (`idle → connecting → connected → offline`).

---

## Open questions

1. **`defineShape` server definition.** `shapes.ts` imports `defineShape` from `lunorash/server`, but I read only its *usage* + the client-side `ShapeSource`/`ClientShapeSubscribeMessage` contract. The server-side `defineShape` implementation and how `where`/`columns`/RLS `baseWhere` compile into the trusted `__cdc_log` projection live in `@lunora/server` / `packages/do/src/ctx-db-shapes.ts` (+ `shape-global-diff.ts`), which I did not open.
2. **Poke emission internals.** The poke trio shape is fully documented in `types.ts`, but the DO-side batching that produces `pokeStart/pokePart/pokeEnd` (`subscription-delivery.ts`, `socket-pool.ts`, the `__cdc_log` cursor management) was only sampled at the header level — exact ordering/coalescing rules not verified end-to-end.
3. **`useMutator` + `bindMutators` in an example.** No example app wires `defineMutator`(client) + `bindMutators` + `useMutator` together; the playground uses the `defineCollections` outbox-action path. The two share the watermarked-push core, but a worked `useMutator` example wasn't found under `examples/` or `apps/`.
4. **Server watermark store.** `__client_watermark` semantics are documented from the client/types side; the authoritative replay/OUT_OF_ORDER enforcement lives in `packages/do/src/ctx-db-client-watermark.ts` (not opened) — worth confirming the exact `id == watermark+1` gate matches the client's reissue loop.
5. **`serializeColumnValue` for non-SQLite engines.** Confirmed `= sqliteEncode` for the SQLite/D1 core (ctx-db.ts:284); the Postgres/MySQL `encode` overrides (native `jsonb`/`boolean`/`bytea`) live in `@lunora/hyperdrive/global`, which is outside the read scope.
