# Lunora — Client Sync Core (Reverse-Engineering Notes)

Scope: `packages/client/src/`. All citations are `path:line` against
`/Users/mithushancj/Documents/personal/echo/research/lunora/packages/client/src`.
Every claim below is traced to real code; quoted excerpts are verbatim.

The package is **TanStack-free by design**. The README/AGENTS say "TanStack DB
based", but the *binding* lives in `@lunora/db`; `@lunora/client` only exposes
dependency-free seams (`OutboxSink`, `subscribe(..., {onCheckpoint})`,
`callMutator`) that `@lunora/db` wires into TanStack `OfflineExecutor` /
collections. See `types.ts:152-167` (`OutboxSink` "the interface itself is
dependency-free so `@lunora/client` stays TanStack-free").

---

## 1. Component map

| File | Role |
|---|---|
| `lunora-client.ts` (3835 lines) | The `LunoraClient` god-object: HTTP RPC, one WS per shard, optimistic updates, offline flush, poke assembly, read-cache, reconnect, whispers, admin. |
| `subscription.ts` | `SubscriptionRegistry` + `SubscriptionState` — live-query cache keyed by `(fnPath, stableStringify(args), shardKey)`. |
| `local-store.ts` | `OptimisticLocalStore` (Convex-parity multi-query optimistic patch) + `createLocalStore`. |
| `offline-queue.ts` | `OfflineQueue` — bounded FIFO outbox, `QueuedMutation`, `nextId()`, persistence mirroring. |
| `delta-merge.ts` | `applyDelta` / `isMutationDelta` — splice a structured row delta into a cached list. |
| `stream.ts` | `createStream` — bounded async-iterator queue for streaming queries (`chunk` frames). |
| `reconnect.ts` | `createReconnect` — exponential backoff with decorrelated jitter. |
| `bookmark.ts` | In-memory `BookmarkStorage` for the `x-d1-bookmark` read-your-writes header. |
| `query-cache.ts` | `CachedQuery` durable read cache (Pillar 2), IndexedDB + in-memory adapters, `queryCacheKey`. |
| `persistence.ts` | `PersistenceAdapter` for the offline queue (IndexedDB autoincrement = FIFO, + in-memory). |
| `query/query-subscription.ts` | `createQuerySubscription` — framework-neutral subscribe→snapshot→error→cleanup state machine. |
| `mutation-runner.ts` | `createMutationRunner` — framework-neutral `mutate` wrapper around `client.mutation` (ref-counted pending). |
| `mutator-runner.ts` | `createMutatorRunner` — wrapper around a `@lunora/db` bound `MutatorHandle` (awaits `isPersisted.promise`). |
| `pagination/index.ts` | Cursor/page split-join state machine (`Page`, `PaginationResult`). |
| `preload.ts` | `preloadQuery` SSR token. |
| `types.ts` | All wire shapes (client↔server messages, `OutboxMutation`, `CachedQuery`, …). |

Backing store for the "local store": there is **no SQLite/IndexedDB-backed
reactive store**. The live cache is **in-memory** — `SubscriptionState.lastValue`
held in `SubscriptionRegistry` (`subscription.ts:14-83`). IndexedDB is used only
for two *durability* side-channels: the offline mutation outbox
(`persistence.ts`) and the optional read cache (`query-cache.ts`). Live query
results are delivered by direct callback fan-out (`handleDataMessage`,
`lunora-client.ts:3495-3501`).

---

## 2. Key data shapes (verbatim from source)

### Subscription state — the in-memory local store cell
```ts
// subscription.ts:14-83
interface SubscriptionState {
    acked: boolean;                       // server acked sub on current socket
    readonly args: Record<string, unknown>;
    readonly argsKey: string;             // stableStringify(args), cached once
    readonly callbacks: Set<SubscriptionCallback>;
    readonly checkpointCallbacks: Set<(w: { checkpoint?: number; mutationId?: number }) => void>;
    readonly errorCallbacks: Set<SubscriptionErrorCallback>;
    readonly fn: FunctionReference;
    readonly id: string;                  // `sub_<n>`
    lastMutationId?: number;              // from last `settled` frame
    lastValue: unknown;                   // THE cached query value
    serverCursor?: number;                // __cdc_log high-watermark; → sinceSeq
    serverEpoch?: string;                 // CDC epoch; → sinceEpoch
    serverVersion: number;                // ++ on every data/delta; rollback guard
    readonly shardKey?: string;
}
```

### Optimistic write/rollback (the "txn/rebase" structure)
There is **no explicit transaction object** in `@lunora/client`. The "txn" is a
**LIFO array of rollback closures** (`(() => void)[]`) returned by
`writeOptimisticToState`. Each closure captures `previous`, `versionAtApply`,
and `next` (`lunora-client.ts:296-340`). The TanStack `Transaction`
(`MutatorTransaction { isPersisted: { promise } }`, `mutator-runner.ts:8-10`)
only exists app-side in `@lunora/db`.

### Offline queue entry + persisted shape
```ts
// offline-queue.ts:3-19  — live entry (resolve/reject NOT persisted)
interface QueuedMutation<T = unknown> {
    readonly args: Record<string, unknown>;
    readonly functionPath: string;
    id?: string;                          // == idempotency key (mutationId)
    readonly identity?: string | null;    // issuing-identity fingerprint
    readonly reject: (error: unknown) => void;
    readonly resolve: (value: T) => void;
    readonly shardKey?: string;
}
// types.ts:97-110 — durable record
interface PersistedMutation {
    args: Record<string, unknown>; functionPath: string; id: string;
    identity?: string | null; shardKey?: string;
}
```

### Durable-outbox seam (the `@lunora/db` path)
```ts
// types.ts:138-150
interface OutboxMutation {
    args: Record<string, unknown>;
    clientId: string;                     // stable per-client id
    functionPath: string;
    idempotencyKey: string;               // `${clientId}:${mutationId}` → x-lunora-mutation-id
    identity: string | null;
    mutationId: number;                   // monotonic per-client → server __client_watermark
    shardKey?: string;
}
```

### Server row-op and poke frames (delta application)
```ts
// types.ts:583-635
interface RowOp { key: string; op: "delete"|"insert"|"update"; table: string; value?: Record<string,unknown>; }
interface ServerPokeStartMessage { baseCheckpoint?: number; epoch?: string; pokeId: string; type: "pokeStart"; }
interface ServerPokePartMessage  { lastMutationId?: number; pokeId: string; rowsPatch: RowOp[]; shapeId: string; type: "pokePart"; }
interface ServerPokeEndMessage   { checkpoint?: number; epoch?: string; pokeId: string; type: "pokeEnd"; }
```

---

## 3. Wire messages (client's view)

**Client → server** (`types.ts:347-471`, union `ClientMessage`):
- `connect` `{ id:"connect", type, clientId?, context? }` — one-shot after open (`sendConnectEnvelope`, `lunora-client.ts:2896-2907`).
- `subscribe` `{ id, type, query:{ functionPath?, table?, args?, sinceSeq?, sinceEpoch? } }`.
- `unsubscribe` `{ id, type }`.
- `shape_subscribe` `{ id, type, shape:{name,args?}, sinceCheckpoint?, sinceEpoch? }`.
- `shape_unsubscribe` `{ id, type }`.
- `stream` `{ id, type, query:{ functionPath, args?, shardKey? } }`.
- `ack` `{ id, type }`.
- `whisper` / `whisper_subscribe` / `whisper_unsubscribe`.
- Plain text `"lunora-ping"` keepalive (NOT JSON) — answered by DO hibernation auto-response `"lunora-pong"` without waking the DO (`lunora-client.ts:93-100, 3133-3153`).

**HTTP (not WS)**: `POST /_lunora/rpc` body `{ args, functionPath, shardKey }`
(`RpcEnvelope`, `types.ts:309-337`); headers `authorization`,
`x-lunora-mutation-id` (idempotency), `x-lunora-client-id` + `x-lunora-client-seq`
(custom-mutator), `x-d1-bookmark` (`rpcRequestHeaders`, `lunora-client.ts:2682-2713`).
Response `RpcResponseBody = { error:{code,message} } | { result; lastMutationId? }`
(`types.ts:345`).

**Server → client** (`types.ts:473-648`, union `ServerMessage`):
- `data` / `delta` `{ id, data?, delta?, cursor?, epoch?, lastMutationId? }`.
- `resume` `{ id, cursor?, epoch?, lastMutationId? }` — "nothing changed since sinceSeq".
- `settled` `{ id, cursor?, epoch?, lastMutationId? }` — write touched read-tables but byte-identical result (custom-mutator clients only).
- `ack` / `complete` / `error` `{ id?, error?, message? }`.
- `chunk` `{ id, data }` (stream).
- `pokeStart` / `pokePart` / `pokeEnd` (shape replication).
- `whisper` `{ topic, data, from? }`.

Dispatch switch: `handleServerMessage` (`lunora-client.ts:3237-3304`). Binary
frames decoded via a shared `TextDecoder`; non-JSON (the pong) is silently
dropped by the `JSON.parse` guard (`lunora-client.ts:3231-3235`).

---

## 4. Optimistic mutation lifecycle — "no flicker" rebase

Two mutation paths exist:
1. **Plain `client.mutation(fn,args,options)`** (`lunora-client.ts:1152-1207`) — per-call `optimistic` transform and/or Convex-parity `optimisticUpdate`.
2. **Custom mutator** via `callMutator` (`lunora-client.ts:782-827`) — the `@lunora/db` watermark protocol; optimistic overlay owned by `@lunora/db`, dropped on `onCheckpoint`/`settled`.

### Numbered flow (plain `mutation`, the in-client path)
1. Mint a stable idempotency key: `mutationId = options.mutationId ?? nextId()` (`:1168`). This same key rides the direct send AND any offline replay.
2. **Apply optimistic write immediately, synchronously.** `applyOptimisticUpdates` (`:2567-2594`) does an O(1) registry lookup by `SubscriptionRegistry.key(fnRef,args,shard)` and calls `writeOptimisticToState`, which mutates `state.lastValue = next` in place and fires every callback *before any await* (`:296-340`). The optional multi-query `optimisticUpdate` runs through `createLocalStore` (`local-store.ts:50-100`). Both push rollback closures onto one LIFO list.
3. **Decide online vs queue.** If the shard socket isn't open and the offline gate (`wasEverConnected || queueBeforeFirstConnect`) holds, or we're mid-reconnect (`wsState==="connecting"` + gate), enqueue (`:1186-1197`); else send.
4. **Send** `await this.rpc(fnRef, args, shard, { captureBookmark:true, mutationId })` (`:1200`). On success the server's `x-d1-bookmark` is captured for read-your-writes (`:2741-2747`).
5. **Reconcile (rebase).** The authoritative value arrives **out-of-band** as a `data`/`delta` frame on the WS, handled by `handleDataMessage` (`:3468-3502`): it sets `state.lastValue = payload`, `serverVersion += 1`, advances `serverCursor`/`serverEpoch`, persists to read-cache, and fans out. The optimistic rollback is then a **no-op**, because:
6. **The flicker-free rollback guard** (`:313-339`): the returned closure restores `previous` ONLY when (a) `state.serverVersion <= versionAtApply` (no newer server truth arrived) AND (b) `state.lastValue === next` (no later optimistic write stacked). So when the server delta already landed (serverVersion bumped), the rollback declines to restore — **the optimistic value is overwritten by the authoritative value with no intermediate revert-then-reapply repaint.** On error (`:1201-1206`) `rollbackOptimistic` unwinds LIFO; same guard prevents clobbering newer state.

**The rebase data structure = `serverVersion` monotonic counter + LIFO rollback
closures.** Rebasing is implicit: server frames always win because each bumps
`serverVersion` past the optimistic apply point, neutralizing the rollback.

For custom mutators the overlay-drop signal is the **watermark**:
`settled`/`pokeEnd` carry `lastMutationId`, surfaced via `checkpointCallbacks` /
`onCheckpoint` (`:3533-3552`, `:3440-3450`) so `@lunora/db` collapses the overlay
for confirmed writes even when no data frame is emitted.

---

## 5. Offline outbox

`OfflineQueue` (`offline-queue.ts:80-226`) is a **bounded FIFO** (`maxItems`
default 1000, `:93`). Two durable backends:
- **Built-in** `PersistenceAdapter` (IndexedDB, autoincrement key = FIFO order, secondary unique index on `id`, `persistence.ts:96-103,137-153`). Mirrored on `enqueue` (`offline-queue.ts:109-113`); removed by caller *after* successful replay → **at-least-once** (`types.ts:112-131`).
- **`OutboxSink` seam** (`@lunora/db` executor) — when wired, the built-in queue is bypassed entirely (`enqueueOfflineMutation`, `:2347-2368`).

**Idempotency / ordering / identity:**
- `id` = the call's `mutationId` and is sent as `x-lunora-mutation-id` on replay (`flushOfflineQueue`, `:3803`) so a committed-but-unacked write is server-deduped — "exactly-once rather than at-least-once" (`:3799-3801`).
- Custom-mutator path uses `idempotencyKey = "${clientId}:${mutationId}"` + monotonic `mutationId` backing the server `__client_watermark` (`types.ts:138-150`; `enqueueOfflineMutation` `:2352-2360`).
- **FIFO replay is sequential** (`await` in a `for` loop, not parallel `.then()`) precisely to preserve order for dependent mutations (`:3742-3829`, comment `:3746-3748`).
- **Identity guard**: every queued write is stamped with `identityFingerprint()` (length-prefixed FNV-1a over the bearer token, `:3679-3700`). At flush the identity is re-read **per item** (token rotation mid-flush) and a mismatch rejects with `OFFLINE_IDENTITY_CHANGED` (`:3764-3794`). On `setAuthToken` change, `rejectQueuedForIdentityChange` eagerly drains + unpersists (`:3709-3723`).
- **Replay error policy** (`:3807-3828`): only a **coded** error (server reached a verdict) drops the write (poison-message); an uncoded transport error re-queues `drained.slice(index)` FIFO and stops the flush for the next reconnect.
- Overflow rejects the oldest with `OFFLINE_QUEUE_OVERFLOW` (`offline-queue.ts:115-130`).

**Watermark / bookmark roles on the client:**
- `bookmark.ts` holds the `x-d1-bookmark` (D1 Sessions read-your-writes), captured from mutation responses (`:2741-2747`) and attached to subsequent queries (`attachBookmark`, `:2704-2710`).
- `clientWatermarks: Map<shardBucket, number>` (`:544`) tracks the highest server-echoed `lastMutationId` per shard; `confirmedMutationWatermark()` (`:762`) seeds `@lunora/db`'s `clientSeq` generator so a reload never reissues a stale sequence the server would silently swallow as a replay.

---

## 6. Delta merge / poke application

**Two server fan-out paths**, both into the *same* in-memory cache:

(a) **Re-execution / legacy delta** (`subscribe` channel) → `handleDataMessage` →
`resolveDataPayload` (`:3591-3610`): a `data` frame replaces wholesale; a `delta`
frame that passes `isMutationDelta` (`delta-merge.ts:86-98`, requires
string `key` + `table` + valid `op`) is spliced via `applyDelta`
(`delta-merge.ts:119-172`):
- `delete` → filter out by `_id`; unknown key = copied no-op.
- `insert` → order-preserving splice by `_creationTime` ascending (`insertionIndex`, `:61-77`), else append; idempotent if id already present (treated as update).
- `update` → replace in place, preserving position.
- Returns `undefined` (→ caller falls back to wholesale replace) when `current` isn't an array of `_id`-bearing objects or an insert/update carries no `row`.

(b) **Shape partial-replication** (`shape_subscribe` channel) → poke protocol
(`handlePokeStart/Part/End`, `:3355-3452`). Parts buffer per `shapeId` in a
`PokeBuffer` (`:482-489`) and apply **atomically at `pokeEnd`** into the keyed
`state.rows` map via `applyRowOpsToView` (`:83-91`: delete→`rows.delete`,
upsert→`rows.set`, value-less upsert skipped as membership-only). Atomic-at-end
means a socket dropping mid-poke leaves the view untouched and re-seeds on
reconnect ("no torn view", `:3370-3373`).

**Gap/fork detection at `pokeEnd`** (`:3417-3428`): if `epochForked`
(`buffer.epoch !== state.serverEpoch`) OR `baseDiverged`
(`state.serverCursor !== buffer.baseCheckpoint`), the client **clears the view,
nulls the cursor/epoch, skips the ops, and re-subscribes** to force a full
re-seed. Otherwise it applies ops, advances `serverCursor`/`serverEpoch`, records
`lastMutationId`, emits rows, and calls `onCheckpoint`.

---

## 7. Streaming + reconnect (hibernatable WS, catch-up)

**One WebSocket per shard key** (`ShardConnection`, `:223-245`); default shard
keyed `""`. Per-connection: reconnect backoff, heartbeat timer, connect timer,
pending unsubscribes, pending streams, `wasEverConnected`.

**Hibernation-friendly keepalive**: `startHeartbeat` sends plain-text
`"lunora-ping"` every `heartbeatIntervalMs` (default 30s); the DO answers via
`setWebSocketAutoResponse` **without waking** (`:93-100, 3133-3153`).

**Connect** (`ensureSocket`, `:2923-3083`): arms a fail-fast `connectTimer`
(default 10s) that force-closes a hung handshake and routes through normal
reconnect (`:2946-2965`). All event handlers guard `conn.socket !== socket` to
ignore superseded sockets.

**Reconnect** (`reconnect.ts:17-43`): exponential `initialDelayMs * 2**attempt`
capped at `maxDelayMs` (250ms→30s), decorrelated jitter in `[delay/2, delay]`.
`reset()` on successful `open`.

### Catch-up sequence (on socket `open`, `:2967-3042`)
1. `clearTimeout(connectTimer)`; `wsState="open"`, `wasEverConnected=true`, `reconnect.reset()`.
2. **`sendConnectEnvelope`** (announce `clientId` + context → `onConnect` hooks) — sent *before* resubscribing so context is in place.
3. `markShardPendingAck` then **resubscribe every** `SubscriptionState` on this shard via `sendSubscribeIfOpen` (`:3176-3202`), which rides `sinceSeq=serverCursor` + `sinceEpoch=serverEpoch` so the server can **`resume`** (skip re-snapshot) instead of re-sending the full value.
4. **`resendShapeSubscriptions`** — each carries `sinceCheckpoint`/`sinceEpoch`; server resumes or re-seeds if below CDC retention / epoch forked (`:2915-2921, 3204-3220`).
5. Flush `pendingUnsubscribes`, then `pendingStreams` (in-flight streams already torn down server-side, so only racing new ones remain).
6. Rejoin every whisper topic.
7. **`flushOfflineQueue(shardKey)`** — replay queued writes FIFO.
8. `startHeartbeat`.

**Resume frame handling** (`:3512-3520`): `handleResumeMessage` keeps `lastValue`,
marks acked, advances cursor, **fires no callback** (value unchanged; `subscribe`
already replayed the cached value synchronously at `:2069-2075`). This is the
"no-flicker on reconnect" mechanism for unchanged queries (Pillar 1b).

**Token expiry**: close code `4001` → `notifyTokenExpired` (`:3060-3062`); reconnect
is always armed and re-resolves identity from cookie/token.

---

## 8. Read cache (Pillar 2) — render-on-reload

Optional `QueryCacheAdapter` (`query-cache.ts`, IndexedDB schema v2 sharing the
`lunora` DB; LRU by `ts`, cap 500). On construct, `hydrateQueryCache` loads all
into `hydratedQueryCache` (`:2429-2443`). First `subscribe` for a key consumes the
entry via `takeHydratedCache`, **identity-gated** (`:2453-2464`), seeding
`lastValue`/`serverCursor`/`serverEpoch` so the UI renders offline immediately and
the resubscribe resumes from the persisted cursor. Live values are persisted
debounced (250ms coalesce) in `persistQueryValue` (`:2472-2490`). Identity change
clears the whole read cache (`:3731-3740`).

---

## Clever decisions

- **`serverVersion` as the rebase arbiter** — a single monotonic int makes "server already moved past this" an O(1) check, giving flicker-free reconcile without a real CRDT/OT layer (`:296-340`).
- **Same idempotency key on direct send and replay** — turns at-least-once durable replay into effective exactly-once via server dedupe (`:1163-1168, 3799-3803`).
- **Per-item identity re-read at flush** (not once at flush start) closes a token-rotation-mid-flush hole where user A's write could replay as user B (`:3756-3764`).
- **Atomic poke-at-`pokeEnd` + epoch/baseCheckpoint gap detection** — mid-poke disconnect never corrupts the view; a forked changelog forces a clean re-seed rather than a silently wrong splice (`:3417-3428`).
- **Plain-text ping answered by DO auto-response** — keepalive across hibernation with zero billable wakeups (`:93-100`).
- **`MAX_POKE_BUFFERS` (256) eviction of oldest** reclaims buffers abandoned by mid-poke disconnects (no `pokeEnd`) since abandoned ones are always oldest (`:3355-3373`).
- **`stableStringify` arg keys** collapse `{a,b}` vs `{b,a}` to one subscription, preventing duplicate server registrations (`subscription.ts:85-96`).
- **`callMutator` rejects `clientSeq <= 0` / fractional** because seq 0 is `<=` initial watermark → server acks as replay → silent dropped write that still reports `applied:true` (`:794-803`).
- **TanStack-free seams** keep the browser SDK dependency-light while `@lunora/db` layers the executor/collections on top.

---

## Open questions

1. **Server-side classification** — `classifyClientMutation` (referenced `:2693`) and `__client_watermark` advance semantics live in `@lunora/do`/`@lunora/runtime`, not read here. The `id == watermark+1` run / `> watermark+1` halt-and-resend logic is described in `types.ts:328-335` but unverified against server code.
2. **`@lunora/db` overlay mechanics** — `bindMutators`, `createExecutorOutboxSink`, and how `onCheckpoint` actually collapses the TanStack optimistic overlay are out of scope (in `@lunora/db`); only the client-side signals are traced.
3. **Cursor vs checkpoint dual-naming** — list subs use `serverCursor`/`sinceSeq`; shape subs use the same field name `serverCursor` but wire it as `sinceCheckpoint`. Whether these share one CDC `__cdc_log` numbering on the server is assumed, not confirmed.
4. **`delta` insert ordering** — `insertionIndex` only honors `_creationTime` ascending; queries with a custom server-side sort would mis-order an optimistically-merged delta until the next authoritative snapshot reconciles (`delta-merge.ts:54-77`). Is this a known accepted limitation?
5. **Heartbeat vs server liveness** — the client pings but nothing here reads a pong or fails a sub on missed pongs; liveness detection relies entirely on socket `close`/`error`. Is there a server-side idle-timeout that the 30s ping is tuned against?
6. **`MutationDelta.row` absence on older servers** (`delta-merge.ts:29-35`) — an insert/update with no `row` falls back to wholesale replace of `delta` itself, which for a row-delta payload would publish a single-row object as the whole query value until the next snapshot. Edge case worth confirming against current server output.
