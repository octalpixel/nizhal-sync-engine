# Nizhal (codename `echo`) — Sync Engine Implementation Inventory

> A precise, evidence-grounded inventory of what exists in the Nizhal sync-engine
> codebase. Cites `path:line`. Describes what is built and what is explicitly
> deferred/absent per code markers. No quality judgement, no proposals.

Nizhal = a toolkit that generates a self-host, **no-WAL**, any-Postgres,
offline-sync engine from a declarative spec. Convergence model = **buckets**
(synced subset) + **per-table merge policy** (lww / field / crdt) + **HLC**
(field-merge tiebreak) + **append-only movement ledgers** (`balance = fold`).

Packages: `@nizhal/kernel`, `@nizhal/server`, `@nizhal/db-collection` (TanStack DB
adapter), `@nizhal/cli`, `@nizhal/react-native`. Reference app: `apps/credit-ledger`.

---

## 1. Package map (public exports)

### `@nizhal/kernel` — `packages/kernel/src/index.ts`
Re-exports `types`, `schema`, `mutator`, `sync-rules`, `contract`, `hlc`, plus a
version-matched `z` from zod (`index.ts:10`). It is the shared vocabulary both
server and client implement against; carries **no runtime I/O**.
- **`types.ts`** — core contracts: `Actor {userId, ownerId, [k]}`, `MutatorCtx`,
  `MutatorTx`, `MutatorDef/Registry`, `SyncRuleDef/SyncRules`, `Query`,
  `MembershipQuery`, wire types `PullResult`, `Mutation`, `Cursor`,
  `MergeMode = "lww"|"field"|"crdt"`, `MergePolicy`, `NizhalContract`.
- **`schema.ts`** — `pgTable` + drizzle column re-exports, `crdtText`/`crdtMap`
  (bytea CRDT columns), `schemaMergeMode`, `schemaMergePolicy`,
  `tableColumnMergeModes`, `NizhalTableSource {table, merge}`.
- **`mutator.ts`** — `defineMutator(schema, fn)`, `defineMutators(map)` (map key
  becomes the mutator `name`).
- **`sync-rules.ts`** — `defineSyncRules`, `SyncRuleBuilder` (`b.bucket`,
  `b.membership`, `b.table().where()`, `b.eq`, `b.params`, `b.raw`),
  `assertSyncRulesNoLeak`, `collectSyncRuleTables`, `flattenDataQueries`,
  `SyncRuleLintError`.
- **`contract.ts`** — `emitNizhalContract` → OpenAPI 3.1 + `x-echo` extension.
- **`hlc.ts`** — `createHlcClock`, `formatHlc`, `parseHlc`, `compareHlc`.
- **`drizzle-zod.ts`** — `createSelectSchema(table)` (drizzle-zod wrapper).

### `@nizhal/server` — `packages/server/src/index.ts`
Exports `createNizhalServer(config): NizhalServer` (the Hono app + `listen`),
`NizhalServerConfig`, `NizhalAuth`, and re-exports `./adapters/*`, `./auth.js`,
`./jobs.js`, `NizhalDb`. Responsible for the HTTP sync protocol, the
commit-chokepoint mutation apply, merge resolution (lww/field/crdt), realtime
publish, durable jobs, audit log, presence, blob presign, admin stats.

### `@nizhal/db-collection` — `packages/db-collection/src/index.ts`
The TanStack DB client adapter. Exports: `createNizhalClient` /
`NizhalClient`, `createCloudflareSubscribeSource` / `createPartySocketSource`,
`createWebSocketSource`, `httpSyncTarget` / `NizhalSyncTarget`,
`nizhalCollectionOptions` / `NizhalCollection`, `createNizhalMutators`,
presence (`presence`, `onPresence`, `presenceState`, `track`, `untrack`),
`manualOnlineDetector`, CRDT helpers (`createCrdtText`/`Map`, `applyCrdtUpdate`,
`crdtFieldBytes`, …), blob helpers (`createNizhalBlobs`, `memoryBlobStore`),
`createNizhalStatus`, `applyPullResult`/`buildNizhalSyncConfig`,
`createMemoryStorage`, and the persistence surface
(`opSqlitePersistence`, `waSqlitePersistence`, `migrateClientStore`,
`NIZHAL_CLIENT_STORE_VERSION/MIGRATIONS`).

### `@nizhal/cli` — `packages/cli/src/index.ts`
`nizhal <migrate|gen|introspect>`. **Only `migrate` is implemented**
(`storage.provision` over a `nizhal.config.ts` loaded via jiti, `index.ts:46-74`).
`gen` and `introspect` hard-throw `notImplemented` (`index.ts:36,39`).

### `@nizhal/react-native` — `packages/react-native/src/index.ts`
`createNizhalNitroClient(opts)` — `createNizhalClient` wired for RN: realtime over
native WebSockets (`nitroWebSocketSource` / `nitroCloudflareSubscribeSource`) +
HTTP over `react-native-nitro-fetch` (`installNitroFetch`), plus
`reactNativeOnlineDetector` and `installNizhalNativePolyfills`.

---

## 2. Server core (`packages/server/src/`)

### HTTP endpoints (`index.ts`, Hono app from `createNizhalServer`)
| Route | Method | Purpose | Line |
|---|---|---|---|
| `/nizhal/contract` | GET | emitted OpenAPI+`x-echo` contract | `index.ts:220` |
| `/nizhal/blob/presign-upload` | POST | presigned upload (501 if no blob adapter) | `:222` |
| `/nizhal/blob/:id/url` | GET | presigned download URL | `:261` |
| `/nizhal/blob/:key` | PUT/GET | local-FS blob store (token-gated) | `:281,295` |
| `/nizhal/stats` | GET | admin stats (admin-password gated, 501/401) | `:312` |
| `/nizhal/audit` | GET | audit log query (admin gated) | `:328` |
| `/sync/pull` | POST | scoped cursor pull | `:343` |
| `/sync/push` | POST | mutation apply (commit chokepoint) | `:386` |
| `/sync/realtime/authorize` | GET | per-bucket WS-auth probe (204/403) | `:482` |
| `/sync/stream` | GET (WS) | realtime repull + presence v2 | `:492` |

**Pull protocol** (`/sync/pull` → `storage.getChanges`, `storage.ts:490`):
request `{cursor, deviceId, limit}`; cursor is an opaque base64url-encoded bigint
over a Postgres sequence `_nizhal_row_version_seq` (`storage.ts:458-473`). The
server resolves the actor's bucket rows from sync rules, runs each scoped data
query for `_nizhal_row_version > cursor AND deleted_at IS NULL` (`buildDataQuery`,
`storage.ts:655`), merges tombstones/bucket-exits (`getRemovalCandidates`,
`:748`), sorts by version, pages by `limit`, and returns `PullResult`:
```ts
interface PullResult<T> {            // kernel/src/types.ts:126
  changed: { table: string; rows: T[] }[];
  tombstoned: { table: string; id: string; key?: string }[];
  removed?: { table: string; id: string; key?: string }[];   // left bucket scope
  removedBuckets?: BucketKey[];      // access-revocation eviction (REQ-14)
  cursor: Cursor;
  cursorReset?: boolean;             // server clamped invalid/future cursor → re-bootstrap
  hasMore?: boolean;                 // page truncated
  lastMutationId?: number;           // server-authoritative client sequence
}
```
`removedBuckets` is computed by `reconcileClientBuckets` (`storage.ts:841`), which
diffs the device's previously-stored buckets (`_nizhal_client_buckets`, keyed by
an actor-scoped device id, `:886`) against the current scope. CRDT columns are
re-encoded to base64 for the wire (`encodeCrdtColumnsInPullResult`, `index.ts:1129`).

**Push protocol** (`/sync/push`): request `{mutations: Mutation[]}` where
```ts
interface Mutation {                 // kernel/src/types.ts:142
  name: string; args: unknown;
  clientMutationId: string;          // idempotency key (primary)
  clientID?: string; mutationID?: number;   // per-client contiguous sequence
  hlc?: string; dependsOn?: string;
}
```
Each mutation runs through `applyMutation` (`index.ts:651`) inside
`storage.transaction`. Response: `{applied: string[], lastMutationId}` (single
client) or `{applied, clientSequences}` (multi-client). Status mapping on the
client side (`sync-target.ts:20`): `applied|duplicate|staleSequence|outOfOrder|rejected`
with HTTP 409→`outOfOrder`, 422→stored-mutation/poison-burn, 403→write-auth.

**Idempotency + sequencing** (`applyMutation`, `index.ts:651-738`):
1. If sequenced (`clientID` + `mutationID>0`), `checkMutationSequence`
   (`storage.ts:222`) does `SELECT … FOR UPDATE` on `_nizhal_clients` and returns
   `apply | alreadyApplied | outOfOrder` (requires `mutationID == last+1`).
   `outOfOrder` → 409 with `lastMutationId`; `alreadyApplied` → ack (replay stored
   error if any).
2. `claimMutation` (`storage.ts:189`) does
   `INSERT … ON CONFLICT DO NOTHING` into `_nizhal_mutations` keyed by
   `clientMutationId` — the idempotency gate. A lost race acks without re-running.
3. The mutator body runs once; `recordApplied` (`:240`) stores
   `{clientId, serverId, error}` for client-id→server-id reconciliation
   (`reconciliationMap`, `index.ts:1234`).
4. Deterministic app errors on a sequenced mutation are **burned**
   (`burnSequencedMutation`, `index.ts:740`) → recorded as applied-with-error so the
   poison write never wedges the per-client sequence (422).
5. After commit, realtime publishes each affected bucket
   (`realtime.publish(bucket)`, `index.ts:458`).

**Merge resolution** (the per-table merge policy applied at write time):
`mergeAwareTx` (`index.ts:970`) splits each update patch by column merge mode:
- **crdt** columns → `crdtMergeUpdate`/`mergeCrdtRow` (`index.ts:1041,1071`): Yjs
  `applyUpdate` over current+incoming bytes, written under an optimistic
  `_nizhal_row_version` CAS (≤5 retries).
- **field** (table merge mode `"field"`) scalar columns → `fieldMergeUpdate`
  (`index.ts:1151`): per-field HLC tiebreak written as
  `set col = case when coalesce(_meta->>col,'') < $hlc then $val else col end`,
  tracking the winning HLC per field in a `_meta jsonb` column. Emits an
  `onConflict {resolution:"merge"}` observer event.
- **lww** (default) → plain commit-ordered update.

**StorageAdapter interface** (`adapters/storage.ts:70`) — the DB-decoupling seam,
default `postgresStorage` (any Postgres, **no logical replication**):
`getChanges`, `getActorBuckets?`, `transaction`, `authorizeMutatorTx`,
`claimMutation`, `checkMutationSequence?`, `readLastMutationId`, `isApplied`,
`appliedMutationError?`, `recordApplied`, `appendAudit?`, `getAuditLog?`,
`provision`, `getClient?`. **Write authorization** (`createAuthorizedMutatorTx`,
`storage.ts:334`): every insert/update/delete result is checked against the
actor's bucket scopes (`rowMatchesScope`, `:438`); a row outside scope throws
`WriteAuthorizationError` → 403.

**RealtimeAdapter interface** (`adapters/realtime.ts:54`):
```ts
interface RealtimeAdapter {
  publish(bucket: BucketKey): void | Promise<void>;   // ONLY from commit chokepoint
  subscribe(buckets: BucketKey[], socket: RealtimeSocket): () => void;
  presence?: PresenceV2Adapter;
  provision?(input): Promise<void>;
  stop?(): Promise<void>;
  stats?(): RealtimeStats;
}
```
Default `inProcessRealtime` (`realtime.ts:77`): in-memory bucket→socket registry;
`publish` sends `repull:${bucket}` to subscribers; full **presence v2**
(`PresenceV2Adapter`, track/untrack/heartbeat/leaveSocket with a stale-sweep
timer). Also `listenNotifyRealtime` (`realtime.ts:224`): mirrors in-process but
listens on Postgres `LISTEN echo_bucket`, with `sync_control`-gated notify
triggers (`notifyBucketStatements`, `:288`). **Realtime is sourced from the commit
chokepoint** — `handlePush` calls `realtime.publish` after the mutation commits;
no WAL/replication tailing.

**Engine bookkeeping tables** (`engine-tables.ts`, drizzle; DDL mirror in
`storage.ts:engineStatements`):
```ts
_nizhal_mutations    (client_mutation_id PK, client_id, server_id, error, applied_at)
_nizhal_clients      (client_id PK, last_mutation_id bigint default 0)
_nizhal_tombstones   (table_name, row_id, client_key, bucket_key,
                      kind default 'tombstone', row_version bigint, deleted_at)
_nizhal_sync_control (id bool PK default true, suppress_notify bool, updated_at)  -- singleton
_nizhal_client_buckets (client_id, bucket_key, last_seen_cursor bigint, updated_at)
_nizhal_jobs         (id bigserial PK, task_slug, input jsonb, status default 'queued',
                      attempts, max_attempts default 3, run_at, locked_at,
                      last_error, created_at, updated_at)
_nizhal_audit_log    (row_version bigint PK default _nizhal_next_row_version(),
                      client_mutation_id, mutation_name, args jsonb, actor jsonb,
                      client_id, mutation_id bigint, hlc, affected_buckets jsonb, created_at)
```
Plus a sequence `_nizhal_row_version_seq` and function `_nizhal_next_row_version()`
(takes a `FOR UPDATE` lock on the `_nizhal_sync_control` singleton to serialize
version issuance, `storage.ts:1049`), and a `_nizhal_touch_updated_at` BEFORE-UPDATE
trigger that stamps `updated_at` + bumps `_nizhal_row_version`. Synced business
tables get `updated_at`, `deleted_at`, `_nizhal_row_version`, optional `_meta`
(field-merge), per-bucket-column indexes, and a tombstone/`bucket_exit` removal
trigger (`bucketStatements`, `storage.ts:1135`).

**Durable jobs / dead-letter** (`jobs.ts`): mutators enqueue via a
`BufferedJobScheduler` flushed inside the mutation tx (`createJobScheduler`,
`:72`). `createJobWorker` polls `_nizhal_jobs`, claims due jobs with
`FOR UPDATE`-style `UPDATE … WHERE status='queued'` + attempt increment
(`claimDueJobInTransaction`, `:184`), runs the task, and on failure either
re-queues with exponential backoff or, at `attempts >= maxAttempts`, sets
`status='dead_letter'` (`markJobFailed`, `:206`).

**Observer** (`observer.ts`): `NizhalObserver` hooks `onPull/onPush/onConflict/onError`
(`safeObserver` swallows hook throws, `:45`). `gatherStats` (`:77`) aggregates
buckets, applied mutations, dead-letter (jobs + errored mutations), job counts,
subscriptions, tombstones-last-hour for `/nizhal/stats`. Admin auth is a
timing-safe bearer/`admin_password` compare (`isAdminAuthorized`, `:166`).

**Auth** (`auth.ts`): `bearerTokenAuth({verify?|secret?})` resolves an `Actor`
from `Authorization: Bearer`. Built-in HS256 JWT issue/verify
(`issueBearerToken`/`verifyHs256Jwt`) checks `exp` and requires `userId`+`ownerId`;
constant-time signature compare. Stream auth also accepts the token via
`?authorization=`/`?token=` query (`requestWithStreamAuth`, `index.ts:864`).

**Cloudflare adapter** (`adapters/cloudflare/`): one **Durable Object per bucket**
(`NizhalBucket`, `server.ts:21`, `hibernate:true`). Two `RealtimeAdapter`
factories — `cloudflareRealtime(env)` (publish via DO RPC `stub.repull(bucket)`,
`realtime.ts:21`) and `cloudflareHttpRealtime(options)` (Node→Worker bridge:
`POST /_nizhal/publish?bucket=` with shared-secret bearer, `realtime.ts:58`). Both
implement only `publish`+`subscribe`; **`subscribe` is a no-op**
(`realtime.ts:37,71`) because fan-out lives in the DO, and **neither implements
`presence`/`stats`/`provision`/`stop`** (no presence-v2 on Cloudflare). Two worker
shapes: `createNizhalWorkerFetchHandler` (library, caller-supplied
`verifyToken`/`actorMaySeeBucket`, `worker.ts:40`) and `worker.entry.ts`
(deployable `export default {fetch}`, Web-Crypto HS256, `/_nizhal/publish` bridge).
Authorization (`authorization.ts`) is two-stage: at upgrade
(`authorizeRealtimeRoom`, fail-closed **500** if `NIZHAL_AUTHORIZATION_URL`/service
unset, `:33-38`; bucket probe expects **204** from `/sync/realtime/authorize`) and
continuous re-auth on every repull/relay (`authorizedConnections`, `:84`) closing
`1008` on `credential expired` / `bucket access revoked`. `socket-state.ts` holds
the hibernation-surviving `NizhalSocketAttachment {version, authorization, bucket,
subscriptions, cursor, identity, tokenExpiresAt, ephemeralRate}` + ping/pong
auto-response. `ephemeral.ts` relays `presence:`/`typing:`/`cursor:`/`whisper:`
frames with a 30-per-1s rate limit (whisper routed to a single `userId`).

---

## 3. Client core (`packages/db-collection/src/`)

**`createNizhalClient`** (`client.ts:80`) is the orchestrator: holds per-rule
cursors, hint handlers, presence state, pullers, a `LocalWriteBarrier`, and the
in-memory `lastMutationId`. Surfaces `pull`, `push`, `subscribe` (repull hints),
`registerPuller`, `acknowledgeLocalWrite`, presence, cursor, scope-buckets, and
status. The HTTP transport is `httpSyncTarget` (`sync-target.ts`); realtime
defaults to `createPartySocketSource` (one reconnecting socket to `/sync/stream`,
auth in query) or `createCloudflareSubscribeSource` (one socket per bucket to
`/parties/nizhal-bucket/<bucket>`).

**Pull/push wire shapes** (`sync-target.ts`):
```ts
interface NizhalPullRequest  { cursor; syncRule; buckets; clientId; limit? }
interface NizhalPullResponse extends PullResult { removedBuckets; hasMore; lastMutationId? }
type      NizhalPushRequest  = Mutation
interface NizhalPushResponse { status: "applied"|"duplicate"|"staleSequence"
                                       |"outOfOrder"|"rejected";
                               result?; serverId?; error?; lastMutationId? }
```
`httpSyncTarget` posts `{mutations:[request]}`, maps 409→`outOfOrder`, refreshes
auth once on 401, and wraps fetch in a 20s timeout that becomes a *retriable* error
so a hung connection releases the sequence lock (`sync-target.ts:57-85`).

**`sync.ts` — applying a pull to the local collection**: `buildNizhalSyncConfig`
returns a TanStack DB `SyncConfig` whose `sync()` single-flights paginated pulls,
gated on `echo.waitForLocalWritesReady()`. Two apply paths:
- **local-first** (`applyLocalFirstPullResult`, `sync.ts:196`): stages upserts +
  deletes, committed via `collection.utils.acceptMutations`. The **local-write
  barrier** defers authoritative rows/deletes for keys with an unacknowledged
  optimistic write — `stageUpsert` field-merges the locally-pending fields on top
  of the server row (`:222-242`), `stageDelete` skips (`:209`).
- **server-authoritative** (`applyPullResult`, `sync.ts:379`): server-wins, writes
  insert/update/delete change messages directly.

**Access-revocation eviction**: `removedBuckets` purges all local rows whose
`bucketField` is in the removed set (`sync.ts:244-252` local-first; `purgeRemovedBuckets`
`:517` server-auth). With no `bucketField`, the whole collection is purged.
Tombstones and `removed` both apply as local deletes. Separately, **TTL eviction**
(`evictTtlBuckets*`, `sync.ts:324,431`) drops rows for buckets that have been
out-of-scope longer than `bucketTtlMs`.

**Offline outbox + idempotent push + poison-quarantine** (`mutators.ts`,
`createNizhalMutators`): each `mutate.x(args)` validates args, builds a canonical
`NizhalEnvelopeMetadata {mutation:{name,args,clientID,mutationID,hlc}, dependsOn?}`
(`mutators.ts:43,305`), creates a TanStack `@tanstack/offline-transactions`
offline transaction, runs the mutator optimistically over a collection-backed
`MutatorTx` (`collectionMutatorTx`, `:563`), and durably commits to the outbox.
The mutationFn (`:205`) then:
- short-circuits if the mutation or its `dependsOn` is poisoned (cascade-cancel,
  `:219-229`),
- `attemptPush` (`:445`) allocates the per-client `mutationID` **under a sequence
  lock** (`withSequenceLock`, `:402`), pushes, and on an `outOfOrder`/`staleSequence`
  response re-allocates from the server's `lastMutationId` and retries,
- classifies failures (`push-errors.ts:classifyPushError`): terminal
  (400/401/403/404/405/422 or `NonRetriableError`) → **park** to dead-letter;
  everything ambiguous (timeouts, 409/425/429, all 5xx, network, unknown) →
  retriable (re-thrown so the executor retries).
`PoisonGuard` (`:101`) holds parked entries in memory + `DeadLetterStorage`, exposes
`retryDeadLetter(key?)` (`:487`, unpark→re-push→re-park on failure) and
`onDeadLetterChange`.

**Per-client mutation id** (`mutation-id.ts`): `mutationID` is a monotonic positive
integer required to equal `last+1` server-side; persisted under
`nizhal:mutation-id` in `_nizhal_meta` (NOT the outbox) so it survives restart —
a reset counter would re-emit already-applied ids the server treats as
`alreadyApplied`, silently losing the write (`mutation-id.ts:1-6`).
`nextMutationIdFrom` = `max(persisted high-water, pending outbox ids) + 1`;
per-transaction allocations are durably keyed (`allocateMutationId`).

**Queued-mutation / pending-op data shapes**:
```ts
// the canonical envelope carried in the offline-transaction metadata
interface NizhalEnvelopeMetadata {                           // mutators.ts:43
  mutation: Pick<Mutation,"name"|"args"|"clientID"|"mutationID"|"hlc">;
  dependsOn?: string;
}
// durable outbox row (_nizhal_outbox: key TEXT PK, value TEXT)  sqlite-storage.ts
//   value = serialized @tanstack/offline-transactions transaction
// dead-letter / poison entry (in memory)
interface NizhalPoisonEntry {                                 // types.ts:93
  idempotencyKey: string; mutation: Mutation; error: Error; parkedAt: number;
}
// dead-letter persisted row (_nizhal_dead_letter)            dead-letter-storage.ts:12
interface StoredDeadLetter {
  idempotencyKey: string; mutation: Mutation;
  error: { name: string; message: string; stack?: string }; parkedAt: number;
}
// outbox inspection surface                                  status.ts:14
interface OutboxEntry { id; mutationFnName; idempotencyKey?; retryCount;
                        lastError?:{message}; createdAt }
```

**`local-write-barrier.ts`** — `LocalWriteBarrier` tracks per-`(collectionId,key)`
optimistic writes with phase `pending|acknowledging` and `changedFields`. `isBlocked`/
`pendingFields` drive the field-level merge in `sync.ts`; `acknowledgeLocalWrite`
(`client.ts:511`) runs a fresh authoritative pull per affected collection then
`completeAcknowledgement` (best-effort, bounded by `NIZHAL_ACK_TIMEOUT_MS`).

**`push-errors.ts`** — `classifyPushError(error) → "retriable"|"terminal"`. Bar for
terminal is deliberately high (parking = user-visible loss): only
`TERMINAL_STATUSES = {400,401,403,404,405,422}` (parsed from the
`push|pull failed: NNN` prefix only) or an explicit `NonRetriableError` /
`NizhalSyncTargetError{retriable:false}`. Network/timeout/aborted → retriable.

**`websocket-source.ts`** — `createWebSocketSource`: one reconnecting socket over an
injected `WebSocketFactory` (`WebSocketLike` = WHATWG subset, web/`ws`/Nitro all
satisfy). Exponential backoff + full jitter (1s→10s, ×1.5), a `minUptime` stability
gate (5s) to defeat accept-then-close loops, a 4s connect timeout, opt-in
app-level heartbeat (`ping`/`pong`, 25s/10s), fresh URL+headers per (re)connect
(token never stale), online-aware fast reconnect, and `onConnectFailure`→`false`
to stop retrying (auth-fatal). The `repull:` frame is handled in `client.ts`
(`connectStream`, `:232`) as a hint that fans out to all pull handlers; reconnect
always triggers an authoritative catch-up pull.

**`persistence/`** — two real SQLite backends, both yielding `NizhalSQLitePersistence
{persistence, outboxStorage, metaStorage, clientIdStorage, deadLetterStorage, …}`:
- **op-sqlite** (RN native, `op-sqlite.ts`): duck-types op-sqlite v15→v17 execute
  APIs, `BEGIN IMMEDIATE` + `SAVEPOINT echo_op_sp_n`.
- **wa-sqlite** (web, `wa-sqlite.ts` + `wa-sqlite-database.ts`): low-level
  `statements/bind_collection/step/row` core API, `SAVEPOINT echo_wa_sp_n`,
  tolerant of duplicate-column ALTERs.
- **`storage-operation-queue.ts`** — a promise-chain mutex serializing **all**
  SQLite execute/transaction ops so reads/writes/txns never interleave on the one
  connection; `whenIdle()` backs `flushOutbox`/`dispose`.
- **`client-meta.ts`** — `_nizhal_meta` KV: `device_client_id` (durable clientId)
  + the `nizhal:mutation-id` high-water. (The pull **cursor** is NOT in `_nizhal_meta`
  — it lives in-memory on the client + in TanStack DB sync metadata under
  `cursor:<syncRule>`.)
- **`migrate.ts`** — `NIZHAL_CLIENT_STORE_VERSION = 3`; ordered migrations
  v1 `_nizhal_outbox`, v2 `_nizhal_meta`, v3 `_nizhal_dead_letter`; version row in
  `_nizhal_store_version`. `migrateClientStore` **refuses to start** (throws
  `NizhalClientStoreVersionError`) if the stored version is *ahead* of target
  (downgrade-corruption guard, `:94`). `mergeClientStoreMigrations` rejects user
  migrations colliding with internal versions.

Client-store DDL (`migrate.ts:42-67`):
```sql
CREATE TABLE IF NOT EXISTS _nizhal_outbox      (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS _nizhal_meta        (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS _nizhal_dead_letter (idempotency_key TEXT PRIMARY KEY,
                                                value TEXT NOT NULL, parked_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS _nizhal_store_version (id INTEGER PRIMARY KEY, version INTEGER NOT NULL);
```

**`status.ts` / `manual-online-detector.ts`** — `SyncStatus {connectivity,
pendingMutations, lastPullCursor, lastPulledAt, lastError, deadLettered}`;
`createNizhalStatus` derives connectivity from the offline executor and exposes
`outbox.list()` / `outbox.deadLetter()`. `manualOnlineDetector` is a manual
online/offline switch (forces offline, notifies-to-flush on release) for
deterministic offline→online testing.

---

## 4. Kernel — buckets + merge policy + HLC convergence model

**Merge policy (`schema.ts`)** — per-table mode is `lww` (default), `field`, or
`crdt`; declared either on the schema source or per-column:
```ts
// schema.ts:44
export function schemaMergeMode(source): MergeMode {
  if (isNizhalTableSource(source)) return source.merge ?? "lww";
  return "lww";
}
// schema.ts:49 — composes table mode + per-column modes into a MergePolicy
export function schemaMergePolicy(source): MergePolicy {
  const tableMode = schemaMergeMode(source);
  const columnModes = isNizhalTable(table) ? tableColumnMergeModes(table) : new Map();
  if (columnModes.size === 0) return tableMode;
  const policy: Record<string, MergeMode> = {};
  if (tableMode !== "lww") policy._ = tableMode;
  for (const [column, mode] of columnModes) policy[column] = mode;
  return policy;
}
// per-column merge modes read off drizzle column fieldConfig.merge (schema.ts:76)
// crdt columns are bytea, tagged {merge:"crdt", root:"text"|"map"} (schema.ts:88-105)
```
In practice (`apps/credit-ledger/src/schema.ts:60`): the schema map declares
`customers: { table: customers, merge: "field" as const }` — a field-merge table —
while `shops`/`ledger_entries`/`reminders` default to `lww`. `MergeMode`/`MergePolicy`
live in `kernel/src/types.ts:152`.

**Buckets / sync rules (`sync-rules.ts`)** — `b.bucket({parameters, data})` defines
a bucket: `parameters(actor)` returns either a `BucketParams` (`b.params({key:col})`)
or a `MembershipQuery` (`b.membership({table, where, select})`); `data(bucket)`
returns the rows belonging to each bucket via `b.table(t).where(b.eq(col, bucket.key))`.
The **no-leak lint** (`assertSyncRulesNoLeak`, `:155`) rejects any data query that
is not built with the builder, has zero bucket scopes, or uses raw SQL — so every
synced row is provably bucket-scoped. Reference (`apps/credit-ledger/src/sync-rules.ts`):
the `myShops` bucket is parameterized by `shop_members` membership for the actor and
scopes `customers`/`ledger_entries`/`reminders` by `shop_id`.

**HLC (`hlc.ts`)** — `createHlcClock({nodeId})` produces `send()`/`recv(remote)`
returning sortable `"<ISO-wall>-<counter:4hex>-<nodeId:16hex>"` strings
(`formatHlc`, `:60`), with monotonic counter on tie, 60s max-drift + counter-overflow
guards. The client stamps every mutation's `hlc` (`mutators.ts:310`); the server
advances its own clock on receive (`serverHlc.recv`, `index.ts:674`) and uses the
HLC as the per-field tiebreak in `fieldMergeUpdate`.

**How they compose (the convergence model):** sync rules define *what* converges
(the bucket = synced subset, lint-guaranteed leak-free). The merge policy defines
*how* each table/column converges on concurrent writes: **lww** (commit-ordered,
`_nizhal_row_version`), **field** (per-field HLC tiebreak via `_meta`), **crdt**
(Yjs byte-merge). HLC supplies the deterministic, causality-respecting tiebreak for
field-merge. On top of all three, applications model money/inventory as **append-only
movement ledgers where `balance = fold(entries)`** (credit = +amount, payment =
−amount; `apps/credit-ledger/src/client.ts:75` `foldLedgerBalance`) so the dominant
write is a conflict-free insert, not a contended update.

---

## 5. Explicit gaps (per code markers)

| Location | Marker | Intent / what is deferred |
|---|---|---|
| `packages/cli/src/index.ts:36` | `notImplemented("gen", "C4 …")` | `nizhal gen` (typed client from `/nizhal/contract`) — **absent**, deferred to RFC C4 |
| `packages/cli/src/index.ts:39` | `notImplemented("introspect", "B9 …")` | `nizhal introspect` (brownfield schema introspection) — **absent**, deferred to B9 |
| `packages/server/src/index.ts:225,264` | `501 "blob adapter not configured"` | blob upload/download off unless a blob adapter is wired |
| `packages/server/src/index.ts:314,330,333` | `501 "… not configured / not enabled"` | admin stats, admin audit, audit log — off by default (need admin password / audit support) |
| `packages/server/src/adapters/cloudflare/realtime.ts:37,71` | `subscribe(){return ()=>{}}` | Cloudflare `subscribe` is a deliberate no-op (fan-out lives in the DO) |
| Cloudflare adapter (all files) | (no presence/stats/provision/stop) | **No presence-v2 on Cloudflare** — capability gap vs `inProcessRealtime` |
| `packages/server/src/adapters/cloudflare/authorization.ts:33-38` | fail-closed 500 | realtime auth refuses to run unless `NIZHAL_AUTHORIZATION_URL`/service configured |
| `packages/server/src/adapters/cloudflare/README.md:60` | "Phase 2" | Node→DO publish bridge labeled Phase 2, but `cloudflareHttpRealtime` now implements it (marker is stale) |
| `packages/db-collection/src/client.ts:42,44`; `presence.ts:34,45` | `@deprecated` | `subscribePresence`/`presence` superseded by `onPresence`/`presenceState` (kept for compat) |
| `apps/tabkeep-expo/src/persistence.ts:3` | "in-memory for now … next increment" | durable **web** persistence (wa-sqlite under Metro) absent in that example; native is durable |
| `apps/credit-ledger/src/jobs.ts:15` | "Phase 0: … no-op send" | SMS reminder handler enqueues durably but performs **no actual send** (gateway deferred) |
| `apps/docs/.../server/storage.md:44` | "Phase 0 ships Postgres only" | alternate storage backends (**D1/SQLite**) backlogged behind `StorageAdapter` |

**Roadmap-declared-but-not-built realtime adapters:** the README (`README.md:19`)
lists "Cloudflare/PartyKit adapter on the roadmap"; the Cloudflare adapter now
exists (publish + DO rooms) but **without presence-v2**, and a generic PartyKit
adapter beyond the partyserver routing is not a distinct module. `listenNotifyRealtime`
exists as the Postgres `LISTEN/NOTIFY` alternative to `inProcessRealtime`.

**Primitives explicitly deferred/absent per markers:** CLI `gen`, CLI `introspect`,
alternate storage backends (D1/SQLite), durable web persistence in the example app,
real SMS gateway send, Cloudflare presence-v2; plus config-gated optionals (blob,
admin stats, admin audit) that 501 unless wired.

---

## 6. Test surface

### `packages/server/test/`
- `audit-log.test.ts` — RFC-008 Postgres audit: row rolls back with a failed mutator; one immutable row per applied mutation in version order; actor/bucket/version-range filters; off when `audit:false`, on by default; `/nizhal/audit` admin-gated.
- `blob-observability.test.ts` — blob presign→PUT→sync `blob_refs`→download round-trip; out-of-bucket download 404; observer pull/push/conflict/error hooks; `/nizhal/stats` 401-gated.
- `cloudflare-realtime.test.ts` — `cloudflareRealtime` RPC→DO broadcasts `repull:`; no-op subscribe; `cloudflareHttpRealtime` bridge POST + secret; auth 500-when-unconfigured / 403-deny / accept; revoked member closed 1008; expired credential dropped; attachment survives hibernation; ping/pong; ephemeral relay + rate-limit 1008.
- `crdt-field.test.ts` — concurrent Yjs text merges while scalar lww stays commit-ordered; field-merge resolves scalars per-field by HLC (`_meta`); CRDT column round-trips pull as base64.
- `getchanges-bench.test.ts` — `getChanges` batches to O(T) not O(M·T) over 50 shops × 200 rows; deterministic across identical DBs.
- `libsql-audit.test.ts` — libSQL audit storage: provisions only when on; business+audit roll back together; shared version order; actor/bucket/version filters.
- `membership-params.test.ts` — membership param resolution binds where-values; a quote in userId is treated as a literal (no SQL injection).
- `security-regression.test.ts` — raw/unscoped queries lint-rejected; reused clientId can't leak another owner; duplicate clientMutationId runs once under concurrency; spoofed `affectedBuckets` ignored; HS256 without `exp` 401; 413/429 enforced and per-actor isolated; expired-token replay rejected; refreshed token can't escalate ownerId.
- `security-vapt.test.ts` — Wave-0 VAPT: foreign-bucket insert/update/delete 403 + rollback; unauthorized WS room 403; re-auth before each ping (no pings post-revoke); expired credential closed 1008; revocation tracked per device (`removedBuckets` once per device).
- `server-foundation.test.ts` — provisioning DDL adds sync columns/triggers/version index **without logical replication**; notify DDL only in listen/notify adapter; serves `/nizhal/contract`; failed mutator not recorded; bearer auth good/bad.
- `sync-core.test.ts` — pull returns only in-bucket changes+tombstones with advancing cursor; equal-timestamp paging; soft-delete tombstones + bucket-exit removals; 401 on unauth; apply-once with id reconciliation + publish; repull over `/sync/stream`; presence v2 frames; `removedBuckets` on scope loss; job retry→dead-letter; cascade rollback; out-of-order 409 + poison-burn 422 without wedging LMID; duplicate sequenced applied once; field-merge per-field HLC vs lww commit-order.

### `packages/db-collection/test/`
- `auth-refresh.test.ts` — 401 refreshes token and retries pull once; non-refreshable 401 surfaces error without infinite retry.
- `cloudflare-subscribe-source.test.ts` — one socket per bucket with async token; delivers frames; `onReconnect` only on re-open; injected factory; unsubscribe closes all, no stray reconnect.
- `crdt-integration.test.ts` — two clients editing the same CRDT text converge through the full client→server stack.
- `durability-exploit.test.ts` — durable outbox by default: hung push still commits optimistic write before network; survives close/reopen and forced-offline; complex envelope byte-faithful across restart; ECONNREFUSED retries (no dead-letter); deterministic 4xx parks once and survives reload (no persistence error logged).
- `integration.test.ts` — optimistic write + id reconciliation; second client converges <5s via ping; applied pulls don't re-enqueue (no echo loop); `removedBuckets` purge; bucket-exit/soft/hard delete removal; poison parks while later good write drains.
- `local-first.test.ts` — cold offline-first writes persist across restart with `fetch` never called; pull-as-ack-barrier keeps dirty rows (conflict surfaced) then reconciles; server-authoritative opt-in keeps server-wins.
- `manual-online-detector.test.ts` — online by default; forces offline/online; notifies (flush) only on release; follows base unless overridden.
- `mutation-id-continuity.test.ts` — sequence continues after restart (the offline-loss regression); preserves server sequence on first launch post-upgrade; recovers a pending allocation after a crash; serializes producers through one elected leader; no default-counter allocation before `waitForInit`; flushes all multi-message writes contiguously; no loss on transient first-push error.
- `mutation-id.test.ts` — unit: `nextMutationIdFrom` continues from max high-water; rejects corrupt/fractional/negative/NaN; throws on 2^53 exhaustion; `allocateMutationId` allocates above all high-waters and durably keys each tx.
- `offline-batch-harness.test.ts` — RFC-011 fault-injecting real-client→real-server: 3 offline writes flush under latency; transient 503 retries not parks; terminal 400 doesn't vanish the gap; `retryDeadLetter` recovers once fault clears; slow-but-completing push doesn't strand; async outbox drains fully; hung ack (F-D) bounded; hung push (F-C) times out and retries.
- `persistence.test.ts` — wa-sqlite: rows+outbox survive 3 sessions; v1→v2 migration preserves outbox; downgrade fails safe (`NizhalClientStoreVersionError`); 12 parallel writes no sqlite-misuse; 50-cycle insert/delete; interleaved `applyCommittedTx`; complex ledger row bind-coercion + restart; default migrations stamp version + empty outbox.
- `presence-v2.test.ts` — metas-per-key for two connections (join+sync); leave on disconnect via diffs; stale presence reaped after heartbeat timeout.
- `push-errors.test.ts` — `classifyPushError`: honors `retriable`; `NonRetriableError`→terminal; network/timeout→retriable; 408/409/425/429/5xx→retriable; 400/401/403/404/405/422→terminal; status from prefix only; unknown→retriable.
- `reconnect.test.ts` — REQ-25: disconnected server edit converges on reconnect; rapid reconnects coalesce (≤2 extra pulls); out-of-scope bucket evicted after TTL, in-scope kept; large initial pull pages until caught up.
- `repro-offline-loss-codex.test.ts` — adversarial: zero silent loss across 100 varied offline batches (server-auth, latency + 503); recovers split-brain producers; follower-tab write durable until leader flushes; reused numeric sequence not treated as applied without the record; converges after synthetic stale + real out-of-order; pulls every row once in version order.
- `repro-offline-loss-deepseek.test.ts` — 5 attack vectors: 50-iter offline batches zero loss; shared outbox/clientID converge; malformed `{applied}` shapes parsed; UUID-dedup provenance; outOfOrder/stale converge; commit-order preserved; mid-push drop no loss; first-accept+second-503 both land.
- `security-vapt.test.ts` — the persisted `deviceId` is sent on every pull body.
- `status-blob.test.ts` — `SyncStatus`+outbox wired to executor; blob keys content-addressed (sha-256); `memoryBlobStore` put/get/list/delete offline.
- `sync-target.test.ts` — custom target used instead of HTTP (fetch never called); rejection → terminal `NizhalSyncTargetError`; `lastMutationId` parsed from pull/push/409 (stale→accepted:false, gap→outOfOrder).
- `websocket-source.test.ts` — builds URL from buckets; re-reads getUrl/getHeaders per reconnect; `onReconnect` only on reconnect; stability gate vs hot loop; connect-timeout retry; heartbeat ping + missed-pong reconnect (4000); pong liveness-only; `onConnectFailure`→false stops; online-detector fast reconnect; unsubscribe closes + stops.

### `packages/kernel/test/`
- `membership-params.test.ts` — `defineSyncRules` builds an `echo-membership` descriptor with actor-bound where-clause + `bucketColumns:["shopId"]`.
- `smoke.test.ts` — `defineMutators` assigns map-key names; `defineSyncRules` preserves rules; non-bucket-scoped query throws `SyncRuleLintError`; `emitNizhalContract` emits OpenAPI 3.1 (collections/syncRules/mutator input refs + schemas).

### `packages/cli/test/`
- `migrate.test.ts` — `nizhal migrate` loads `.mjs` and `.ts` (jiti) config and calls `storage.provision`; turns PG 42P01 (missing business table) into actionable guidance.

### `apps/credit-ledger/test/` — fitness / acceptance suite
- `harness.ts` (shared) — boots a real `createNizhalServer` over **PGlite** with the credit-ledger schema/mutators/sync-rules + sms-reminder job + in-process realtime; seeds one shop/owner/customer; exposes a real `node:http` port.
- `e2e.test.ts` (**A-E2E-shopbook**, the headline acceptance test) — drives the full
  **offline `recordCredit` → reconnect → balance = fold(ledger)** round trip: the
  optimistic write appears and the local balance equals `foldLedgerBalance` while the
  server row is absent until reconnect; on reconnect the push converges, the server
  row lands with the exact amount, and an `sms-reminder` job is enqueued in
  `_nizhal_jobs`. A second fresh client bootstraps and converges to the same entry
  <5s. A subsequent `recordPayment` propagates so both fold-balance and computed
  balance settle to `credit − payment` (2500→2000) — proving append-only money math
  holds across two clients end-to-end.
- `live-transport.test.ts` — over-the-wire smoke (`runLiveE2e`) on a real port: HTTP
  sync passes, a realtime ping is received over a real WebSocket, and `listen` boots
  with jobs so an `sms-reminder` row lands ("LIVE E2E PASSED").
- `security-vapt.test.ts` — tenant-write VAPT: foreign-shop
  `updateCustomerName`/`updateCustomerPhone`/`deleteCustomer` rejected ≥400 while
  same-shop write succeeds (200); DB confirms shop-b rows byte-for-byte unchanged.

### Other apps
- `apps/notes/test/smoke.test.ts` — owner-scoped sync rules (`["myNotes"]`) + mutator set (`addNote`/`editNote`/`deleteNote`).
- `apps/tabkeep/test/domain.test.ts` — `foldLedgerBalance` folds append-only integer movements; minor-unit money parse/format without float; rejects >2 decimals.
- `apps/emulation/test/security-vapt.test.ts` — POS tenant-write VAPT (mirror): foreign-location `updateProductName`/`updateProductSku` ≥400, same-location 200, foreign assets unchanged.

---

## Primitives Nizhal HAS
- **No-leak-linted bucket sync rules** (membership + param + relation queries; raw SQL banned).
- **Opaque total-order cursor pull** over a Postgres sequence (`_nizhal_row_version_seq`), **no WAL / no logical replication**.
- **Idempotent push** via `clientMutationId` claim + per-client contiguous `mutationID` sequence (`checkMutationSequence`).
- **Per-table merge policy**: `lww` (row-version commit order), `field` (per-field HLC via `_meta`), `crdt` (Yjs bytea text/map).
- **HLC clock** (sortable, causal, drift/overflow-guarded) as the field-merge tiebreak.
- **Server-side write authorization** (every write checked against actor bucket scopes → 403).
- **Tombstones + bucket-exit removals + access-revocation eviction** (`removedBuckets`) + TTL bucket eviction.
- **Durable offline outbox** (real SQLite: op-sqlite native, wa-sqlite web) with poison-quarantine / dead-letter + `retryDeadLetter` + cascade-cancel on `dependsOn`.
- **Local-write barrier** (defers authoritative rows for unacknowledged optimistic writes, field-level merge).
- **Reconnecting WebSocket realtime** (backoff+jitter, stability gate, heartbeat, fresh auth per connect) sourced from the **commit chokepoint** (`realtime.publish`), with `inProcessRealtime`, `listenNotifyRealtime`, and Cloudflare-DO adapters.
- **Presence v2** (track/untrack/heartbeat, state+diff frames) — in-process / Node stream only.
- **Durable jobs** with retry + dead-letter; **append-only audit log**; **admin stats**; **blob presign** (S3/R2/local-FS).
- **Contract emitter** (`/nizhal/contract`, OpenAPI 3.1 + `x-echo`); **`nizhal migrate`** (provisions sync engine onto existing tables); **client-store migrations** (versioned, downgrade-guarded).
- **Bearer/HS256 auth**, body-size + per-actor rate limits, CORS.

## Primitives explicitly deferred / absent (per code markers)
- **`nizhal gen`** (typed client codegen from the contract) — not implemented (CLI C4).
- **`nizhal introspect`** (brownfield schema introspection) — not implemented (CLI B9).
- **Alternate storage backends (D1 / SQLite / MySQL)** — backlogged behind `StorageAdapter`; Postgres only ships.
- **Cloudflare presence-v2** — absent (CF adapters implement only `publish`+no-op `subscribe`).
- **Durable web persistence in the example app** (wa-sqlite under Metro) — named "next increment"; the package backend exists, the example is in-memory on web.
- **Real SMS gateway send** — handler enqueues durably but the send is a no-op (Phase 0).
- **Config-gated optionals that 501 unless wired**: blob adapter, admin stats, admin audit, audit log (default-off).
- **Deprecated-but-present** presence API: `subscribePresence` / `presence` (superseded by `onPresence` / `presenceState`).
