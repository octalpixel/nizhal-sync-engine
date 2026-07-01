# Zero — Client + Wire Protocol (reverse-engineered)

Monorepo: `packages/zero-protocol/`, `packages/zero-client/`, `packages/zero-schema/`.
All schemas are [valita](../zero-mono/packages/shared/src/valita.ts) runtime validators; messages are JSON **tuples** `[literalType, body]` — a discriminated union keyed on element `[0]`.

Zero is Replicache underneath: the client store is a Replicache DAG (IndexedDB), and Zero pokes drive Replicache's snapshot/rebase machinery. The Zero-specific layer adds **queries as the unit of sync** (ZQL→AST→"desired queries") and **custom server-authoritative mutators**.

---

## 1. The full wire-message catalog

### Upstream (client → server) — `zero-protocol/src/up.ts:12`

```ts
export const upstreamSchema = v.union(
  initConnectionMessageSchema,       // ['initConnection', {...}]
  pingMessageSchema,                 // ['ping', {...}]
  deleteClientsMessageSchema,        // ['deleteClients', {...}]
  changeDesiredQueriesMessageSchema, // ['changeDesiredQueries', {...}]
  pullRequestMessageSchema,          // ['pull', {...}]
  updateAuthMessageSchema,           // ['updateAuth', {...}]
  pushMessageSchema,                 // ['push', {...}]
  closeConnectionMessageSchema,      // ['closeConnection', {...}]
  inspectUpMessageSchema,            // ['inspect', {...}]
  ackMutationResponsesMessageSchema, // ['ackMutationResponses', MutationID]
);
export type Upstream = v.Infer<typeof upstreamSchema>;
```

### Downstream (server → client) — `zero-protocol/src/down.ts:16`

```ts
export const downstreamSchema = v.union(
  connectedMessageSchema,      // ['connected', {wsid, timestamp?}]
  errorMessageSchema,          // ['error', {...}]
  pongMessageSchema,           // ['pong', {...}]
  pokeStartMessageSchema,      // ['pokeStart', PokeStartBody]
  pokePartMessageSchema,       // ['pokePart',  PokePartBody]
  pokeEndMessageSchema,        // ['pokeEnd',   PokeEndBody]
  pullResponseMessageSchema,   // ['pull', {...}]
  deleteClientsMessageSchema,  // ['deleteClients', {...}]
  pushResponseMessageSchema,   // ['pushResponse', PushResponseBody]
  inspectDownMessageSchema,    // ['inspect', {...}]
  transformErrorMessageSchema, // ['transformError', ErroredQuery[]]
);
export type Downstream = v.Infer<typeof downstreamSchema>;
```

Downstream dispatch is a switch on `downMessage[0]` in `zero-client/src/client/zero.ts:1293`.

---

## 2. The poke protocol  (`zero-protocol/src/poke.ts`)

Pokes are **multi-part** so the server can stream multi-MB updates without holding the whole thing in memory (`poke.ts:7-30`). Each poke has a unique `pokeID`; all three messages for a poke share it. Poke messages for different `pokeID`s cannot interleave — if they do, the client treats it as an error, ignores both pokes, disconnects and reconnects (`poke.ts:26-29`).

### pokeStart — `poke.ts:32`

```ts
export const pokeStartBodySchema = v.object({
  pokeID: v.string(),
  baseCookie: nullableVersionSchema,       // version this poke updates FROM (null for fresh client)
  schemaVersions: v.object({
    minSupportedVersion: v.number(),
    maxSupportedVersion: v.number(),
  }).optional(),                           // present iff poke carries a rowsPatch
  timestamp: v.number().optional(),
});
```

### pokePart — `poke.ts:51` (the payload; can be 0..many per poke)

```ts
export const pokePartBodySchema = v.object({
  pokeID: v.string(),
  lastMutationIDChanges: v.record(v.number()).optional(),    // clientID -> new lmid
  desiredQueriesPatches: v.record(queriesPatchSchema).optional(), // clientID -> QueriesPatch
  gotQueriesPatch: queriesPatchSchema.optional(),            // which queries are now synced
  rowsPatch: rowsPatchSchema.optional(),                     // the actual row data
  mutationsPatch: mutationsPatchSchema.optional(),           // custom-mutator results
});
```

### pokeEnd — `poke.ts:66`

```ts
export const pokeEndBodySchema = v.object({
  pokeID: v.string(),
  cookie: versionSchema,          // version this poke updates TO (ignored if cancel)
  cancel: v.boolean().optional(), // discard the whole poke without applying
});
```

### The patches

**RowOp** (`row-patch.ts:6`) — the actual entity data:
```ts
put    { op:'put',    tableName, value: Row }
update { op:'update', tableName, id: PrimaryKeyValueRecord, merge?: JSONObject, constrain?: string[] }
del    { op:'del',    tableName, id: PrimaryKeyValueRecord }
clear  { op:'clear' }
```
`Row` (`data.ts:6`) is a `readonlyRecord` of JSON values (plus `undefined`≈`null`) — Zero values are limited to JSON because the Replicache layer serializes through IndexedDB (`data.ts:9-27`).

**QueriesPatch** (`queries-patch.ts:5`) — down direction uses bare `put{op,hash,ttl?} | del{op,hash} | clear`; the **up** direction (`upPatchOpSchema`) extends `put` with `ast?`, `name?`, `args?` (`queries-patch.ts:11`). Note the value is a *presence marker only* — when applied to Replicache the value is literally `null` (`zero-poke-handler.ts:323-328`). The query body lives elsewhere; the patch only tracks set membership by `hash`.

**MutationsPatch** (`mutations-patch.ts:12`) — ephemeral custom-mutator results: `put{op,mutation:MutationResponse} | del{op,id:MutationID}`. "On put the mutation promise is resolved/rejected and reference released" (`mutations-patch.ts:5-10`).

### How a poke is applied (client) — `zero-client/src/client/zero-poke-handler.ts`

`PokeHandler` (`zero-poke-handler.ts:46`) buffers `pokeStart`→`parts[]`→`pokeEnd` into a `PokeAccumulator` (`:31`), then **debounces**: a `setTimeout(…,0)` playback loop merges all buffered pokes into a single Replicache poke per frame, to avoid computing intermediate IVM diffs (`:37-45`, `:140-193`). `setTimeout` (not rAF) is used so background tabs still apply pokes (`:42`).

`mergePokes()` (`:214`) is the core. It:
1. Takes `baseCookie` from the first poke's start and `cookie` from the last poke's end (`:224-227`).
2. **Gap detection**: if `pokeAccumulator.pokeStart.baseCookie > prevPokeEnd.cookie` it throws `unexpected cookie gap` (`:234-244`) — the cookie chain must be contiguous.
3. Translates each protocol patch into a Replicache `PatchOperation` keyed into the client store:
   - `desiredQueriesPatches[clientID]` → key `d/{clientID}/{hash}` (`:254-266`, `toDesiredQueriesKey`)
   - `gotQueriesPatch` → key `g/{hash}` (`:267-273`, `toGotQueriesKey`)
   - `rowsPatch` → entity key `e/{table}/{pk}` via `rowsPatchOpToReplicachePatchOp` (`:274-285`, `:352`)
   - `mutationsPatch` → key `m/{clientID}/{mutationID}` (`:286-290`, `:334`)
4. Emits `{ baseCookie, pullResponse: { lastMutationIDChanges, patch, cookie } }` (`:293-300`) — i.e. it **fakes a Replicache pull response**, which is what drives Replicache's snapshot+rebase.

Key prefixes (`keys.ts:8-11`): `d/` desired-queries, `g/` got-queries, `e/` entities, `m/` mutation-responses.

`rowsPatchOpToReplicachePatchOp` (`:352`) also does **server→client name mapping** (`serverToClient.row`) and silently **drops rows for tables not in the client schema** (`:362-366`) — lets the server's AST reference tables the client doesn't know about.

The "got-this-data" signal: when a poke applies, Replicache's `experimentalWatch` on prefix `g/` fires in `QueryManager` (`query-manager.ts:132-154`) → updates `#gotQueries` → fires `gotCallback(true)`, which is how a query transitions to "complete".

### baseCookie / version / pokeID mechanism (gap detection)

- `version`/`cookie` is just a `v.string()` (`version.ts:3`); `nullableVersion` allows `null` for a brand-new client (`poke.ts:34-37`).
- Each poke is `baseCookie → cookie`. The client maintains the chain; a non-contiguous base cookie either (a) throws `unexpected cookie gap` in merge (`zero-poke-handler.ts:239`), or (b) surfaces from Replicache as `unexpected base cookie for poke`. Both paths clear the buffer, disconnect and reconnect (`zero-poke-handler.ts:196-205`, `zero.ts:1888-1898` → `ClientErrorKind.UnexpectedBaseCookie`). The comment at `:197` notes this can legitimately happen across tabs in one client group refreshing from IDB at different times.

---

## 3. Queries as the unit of sync (the "shapes" equivalent)

The client never asks for rows directly. It declares a **set of desired queries**; the server syncs exactly the rows those queries match, and pokes down `gotQueriesPatch` + `rowsPatch`.

### ZQL → AST → hash

A ZQL query compiles to an `AST` (`ast.ts:217`): `{schema?, table, alias?, where?, related?, start?, limit?, orderBy?}`. The wire AST supports `SimpleCondition` / `and` / `or` / `correlatedSubquery` (EXISTS/NOT EXISTS) conditions, correlated subqueries with `correlation:{parentField,childField}` compound keys, and `static` parameters (`authData` / `preMutationRow`) resolved server-side (`ast.ts:89-98`). `normalizeAST` (`ast.ts:442`) canonicalizes (sorts conditions/related, flattens nested and/or) so identical queries hash identically.

Two query kinds → two hash schemes (`query-hash.ts`):
- **Legacy / client query**: `hashOfAST(ast)` = `h64(JSON.stringify(normalizeAST(ast)))` base36 (`query-hash.ts:6`). The AST itself is sent on the wire.
- **Custom / named query** (server-authoritative): `hashOfNameAndArgs(name, args)` = `h64("{name}:{JSON(args)}")` (`query-hash.ts:17`). Only `name`+`args` are sent; the server resolves them to an AST via a **transform** step.

### Registration: `QueryManager` (`zero-client/src/client/query-manager.ts:71`)

> "Tracks what queries the client is currently subscribed to on the server. Sends `changeDesiredQueries` message to server when this changes. Deduplicates requests so we only listen to a given unique query once." (`query-manager.ts:66-70`)

- `addLegacy(ast,ttl,gotCb)` / `addCustom(ast,{name,args},ttl,gotCb)` (`:331`, `:320`) — normalize, hash, then `#add` (`:344`).
- `#queries: Map<hash, Entry>` with refcount `count` (`:46-54`, `:77`). First subscriber → enqueue a `put` op; extra subscribers just `++count` (`:359-386`). This is the dedup.
- Unsubscribe decrements; at `count===0` the query goes to a `#recentQueries` LRU (`recentQueriesMaxSize`); only on LRU eviction is a `del` op enqueued (`:475-497`). So recently-unused queries linger (cache) before deregistration.
- **TTL**: each desired query carries a `ttl` (clamped, `clampTTL`); raising ttl re-sends a `put` (`:428-443`). TTL lets the server keep syncing a query for a while after the client stops desiring it.
- Changes are **batched/throttled** (`#queryChangeThrottleMs`) then flushed as one message (`:445-473`):

```ts
this.#send(['changeDesiredQueries', { desiredQueriesPatch: [...pending] }]);
```

`changeDesiredQueriesBodySchema` = `{ desiredQueriesPatch: upQueriesPatchSchema, traceparent? }` (`change-desired-queries.ts:4`).

### The up-patch op (`queries-patch.ts:11`)
```ts
upPutOpSchema = { op:'put', hash, ttl?, ast?, name?, args? }   // ast for legacy, name+args for custom
del = { op:'del', hash }
clear = { op:'clear' }
```

### Adding/removing a query ⇒ changing the sync set
1. Component subscribes to a ZQL query → `QueryManager.#add` → (if new) `put{hash,ast|name+args,ttl}` enqueued.
2. Throttle flush → `['changeDesiredQueries', {desiredQueriesPatch}]` upstream (or, at connect, folded into `initConnection`, see §6).
3. Server diffs the desired set against the client-group's CVR, runs/maintains the queries, and pokes down `desiredQueriesPatches` (echo), `gotQueriesPatch` (now-complete set), and `rowsPatch` (the rows).
4. Client applies poke → `g/{hash}` appears → `gotCallback(true)` → query reports "complete".
5. Unsubscribe → refcount 0 → LRU → eventual `del{hash}` → server stops syncing, pokes `del`/`rowsPatch` removing now-unmatched rows.

**Important coupling**: queries cannot be deregistered while mutations are pending — `#add`'s cleanup defers removal via `mutationTracker.onAllMutationsApplied` if `mutationTracker.size > 0` (`query-manager.ts:401-411`, callback wired at `:121-130`), because a rebase might need data the query was keeping in scope.

### Custom queries transform (server side, but protocol-visible)
Custom/named queries are resolved server-side: `transformRequestBody = [{id,name,args}]` → `transformResponseBody = ({id,name,ast} | ErroredQuery)[]` (`custom-queries.ts:6-45`). Failures come back downstream as `['transformError', ErroredQuery[]]` (`custom-queries.ts:54`) → `QueryManager.handleTransformErrors` fires `gotCallback(false, error)` (`query-manager.ts:269-297`).

---

## 4. Mutations: CRUD vs Custom

Mutation wire type is a union (`mutation.ts:116`):
```ts
mutationSchema = v.union(crudMutationSchema, customMutationSchema);
```

### Common envelope
Both carry `{ type, id: number, clientID: string, name, args, timestamp }` (`mutation.ts:98`,`:107`). `id` is the per-client monotonic **mutation id**; `(clientID,id)` is the global `MutationID` (`mutation-id.ts:3`).

### CRUD mutators (legacy, being removed)
- `type: MutationType.CRUD`, fixed `name: '_zero_crud'` (`mutation.ts:99-102`, `CRUD_MUTATION_NAME` `:12`).
- `args: [{ ops: CRUDOp[] }]` where each op is `insert | upsert | update | delete` carrying `{tableName, primaryKey, value}` (`mutation.ts:45-96`).
- Client-side API builds these: `zero.mutate.issue.insert({...})` → `makeEntityCRUDMutate` (`crud.ts:95`) → calls the internal `_zero_crud` Replicache mutator with `{ops:[op]}`; batch form collects ops then one call (`crud.ts:51-74`).
- CRUD mutators run **optimistically on the client and are re-applied authoritatively by zero-cache** (schema tied to the sync connection: `pushBody.schemaVersion`).
- Gated by `schema.enableLegacyMutators` (`crud.ts:26-35`). Note `crud.ts:222-225`: CRUD rebase does **not** update the IVM branch — acceptable because CRUD is being replaced by custom mutators.

### Custom mutators (server-authoritative)
- `type: MutationType.Custom`, arbitrary `name: string`, `args: JSON[]` (`mutation.ts:107-114`).
- User defines `CustomMutatorDefs` — `(tx, args, ctx) => Promise<void>`, arbitrary-depth namespaces (`custom.ts:36-85`). The same function runs **on the client optimistically** and **on the server authoritatively** (the server is the source of truth; the client copy is a prediction).
- Client run: `makeReplicacheMutator` wraps the user fn; it builds a `TransactionImpl` (`custom.ts:117-199`) over the Replicache write tx with `tx.mutate` (CRUD executor against the IVM branch) and `tx.query` (ZQL over the local IVM sources). `tx.reason` is `'optimistic'` on first run, `'rebase'` on replay (`custom.ts:158-160`).
- Calling a custom mutator returns `MutatorResult = { client: Promise, server: Promise }` (`custom.ts:68-71`) — the client promise settles when the optimistic apply finishes; the server promise settles when the authoritative result is acked.

### Push protocol (`push.ts`)
```ts
pushBodySchema = {
  clientGroupID, mutations: Mutation[], pushVersion,
  schemaVersion?,        // CRUD only; custom delegates schema versioning to the API server
  timestamp, requestID, traceparent?, auth?(deprecated)
}
pushMessageSchema = ['push', pushBody]
```
Pusher (`zero.ts:1921`): Replicache hands Zero a `PushRequest`; Zero waits for `connected`, then sends **one `['push',…]` message per mutation** over the websocket (`zero.ts:1947-1983`). It maps CRUD args server-side (`mapCRUD`) and wraps each in `CRUDMutation`/`CustomMutation`. **Idempotency**: it skips mutations at-or-below `#lastMutationIDSent` (`zero.ts:1934-1938`, `:1980-1982`) so reconnect/replay never double-sends; for mutation-recovery pushes (different `clientGroupID`) it resends from index 0 (`:1930-1933`).

### Responses & idempotency
- `pushResponseBody = pushOk{mutations: MutationResponse[]} | pushError(deprecated)` (`push.ts:83`). Modern errors come as `['error',…]`; the deprecated `pushError` variants (`unsupportedPushVersion`, `unsupportedSchemaVersion`, `http`, `zeroPusher`) remain for back-compat (`push.ts:34-81`).
- `MutationResponse = {id: MutationID, result: MutationOk{data?} | MutationError}` (`mutation.ts:144`). `MutationError = appError{error:'app',message?,details?} | zeroError{error:'oooMutation'|'alreadyProcessed'}` (`mutation.ts:118-137`). `alreadyProcessed` is the **idempotency** signal — a duplicate is settled as success (`mutation-tracker.ts:365-368`).
- Two delivery paths for results: (1) synchronous `['pushResponse',…]` → `MutationTracker.processPushResponse` (`zero.ts:1330`); (2) durable, via poke `mutationsPatch` written to `m/{clientID}/{id}` and watched by `MutationTracker` (`mutation-tracker.ts:85-100`,`:153-188`). On result, the client sends `['ackMutationResponses', MutationID]` upstream (`push.ts:94`, `mutation-tracker.ts:182-187`) so zero-cache can clean up stored results (`_zero_cleanupResults`, `mutation.ts:17-40`).

### MutationTracker (`zero-client/src/client/mutation-tracker.ts:51`)
Maps an `EphemeralID` (assigned at call time, `:102-110`) → resolver, and `mutationID → ephemeralID` once Replicache assigns the id (`:112-122`). It resolves the per-mutation promises when results arrive (push response or poke), and resolves *all* mutations `≤ lmid` when the **last-mutation-id advances** (`lmidAdvanced`, `:277-295`) — see versioning. It also fires `onAllMutationsApplied` once `lmid ≥ largestOutstanding`, which is what unblocks query deregistration (§3).

---

## 5. Client store + rebase

**Backing store**: Replicache. The Zero client store *is* a Replicache DAG persisted in IndexedDB; entities live under `e/`, desired/got queries under `d/`,`g/`, mutation results under `m/` (`keys.ts:8-11`). Reactive ZQL reads run against an in-memory **IVM source branch** (`IVMSourceBranch`) layered over that store (`custom.ts:127-148`).

**Optimistic layering + rebase** (Replicache DD31 model, `replicache/src/sync/pull.ts`): the DAG has a `main` head (optimistic, includes pending local mutations) and, during a poke/pull, a `sync` head built from the new server snapshot. Zero's `mergePokes` feeds a synthetic pull response (`zero-poke-handler.ts:293-300`); Replicache's `maybeEndPull` (`pull.ts:304`) then:
1. Builds the new snapshot at `cookie` (sync head).
2. Collects pending local commits from `main` (`localMutations`, `pull.ts:355-359`).
3. For each, compares `commit.meta.mutationID` against the snapshot's `lastMutationID` for that `clientID` (`pull.ts:368-379`): mutations already reflected in the server snapshot are **dropped**; mutations with a higher id are **replayed** (rebased) on top of the new snapshot (in ascending mutation-id order, `:382`).
4. On replay, the *same* custom-mutator function re-runs with `tx.reason==='rebase'` (`custom.ts:158-160`), recomputing the optimistic state against authoritative data.
5. When no pending mutations remain, diffs are computed against `main` and fired to subscriptions (`pull.ts:386-419`).

So optimistic state = authoritative server snapshot + replay of not-yet-acked local mutations. Once a mutation's `lmid` is reached, its optimistic commit is discarded and the authoritative version takes over — invisibly, because they should match.

---

## 6. Versioning scheme (cookie / version / lmid)

Three coordinated counters keep client and server in agreement:

1. **cookie / version** (`version.ts`) — opaque server version string; monotonic. Every poke is `baseCookie → cookie`; the chain must be contiguous (gap ⇒ disconnect/reconnect, §2). Persisted with the Replicache snapshot; a fresh client starts at `null` (`poke.ts:34-37`).

2. **lastMutationID (lmid)** — per `(clientGroupID, clientID)` count of mutations the **server** has durably applied. Pushed down in `pokePart.lastMutationIDChanges` (`poke.ts:53`). Client wiring:
   - `handlePokePart` extracts the self lmid and stores `#lastMutationIDReceived` (`zero.ts:1863-1868`).
   - After the merged poke applies, `PokeHandler` calls `mutationTracker.lmidAdvanced(lmid)` (`zero-poke-handler.ts:182-188`).
   - `lmidAdvanced` (`mutation-tracker.ts:277`) resolves every outstanding mutation with `mutationID ≤ lmid` (insertion-ordered, so it can `break` early, `:301-311`) and notifies `onAllMutationsApplied` when caught up.
   - It also gates Replicache rebase (§5): commits `≤` snapshot lmid are dropped, `>` are replayed.

3. **Per-client mutation id (`id`)** — monotonic counter assigned by Replicache when a mutation is created; carried in every `Mutation.id` and echoed in `MutationResponse.id` and `MutationID`. Drives push idempotency (`#lastMutationIDSent`, `zero.ts:1934-1938`) and the lmid comparison.

**Pull** (`pull.ts`) is used only for **mutation recovery**, not normal sync: `pullRequest{clientGroupID, cookie, requestID}` → `pullResponse{cookie, requestID, lastMutationIDChanges}` with **no patch** ("Pull is currently only used for mutation recovery which does not use the patch", `pull.ts:15-16`). It lets a reconnecting client learn which of its old mutations the server already applied.

### Connect handshake (`connect.ts`) — folds queries into the first frame
1. WS opens; server sends `['connected', {wsid, timestamp?}]`. The server **waits** for `initConnection` before poking, to avoid syncing no-longer-desired queries (`connect.ts:6-12`).
2. Client sends `['initConnection', initConnectionBody]` (`connect.ts:50`):
```ts
{
  desiredQueriesPatch: upQueriesPatch,   // the whole current desired set
  clientSchema?,                         // only when no server snapshot/cookie yet
  deleted?, activeClients?,
  userPushURL?, userPushHeaders?,        // custom-mutator endpoint config
  userQueryURL?, userQueryHeaders?,      // custom-query endpoint config
  traceparent?,
}
```
The init message (and auth token) are base64+URI-encoded into the WS `Sec-WebSocket-Protocol` header (`connect.ts:60-88`). Because queries can be added while awaiting `connected`, `QueryManager.getQueriesPatch(tx, lastPatch?)` diffs the just-sent init patch against the current set so only the delta is re-sent via `changeDesiredQueries` (`query-manager.ts:203-267`).
3. `clientSchema` (`client-schema.ts:28`) `{tables:{[t]:{columns:{[c]:{type}}, primaryKey}}}` is normalized+hashed (`normalizeClientSchema`, `:41`); the client only sends it on first connect (no cookie yet) and assumes zero-cache already has it once it holds a snapshot (`connect.ts:26-29`).
4. On `connected`, `MutationTracker.onConnected(#lastMutationIDReceived)` resolves mutations whose responses were lost while disconnected (`zero.ts:1751`, `mutation-tracker.ts:266-268`); after the first post-connect poke applies, `QueryManager.markGotQueriesAuthoritative()` re-fires `got` for the whole subscribed set since the server sends `gotQueriesPatch` as a diff and won't re-`put` queries it thinks the client already has (`zero.ts:820`, `query-manager.ts:179-201`).

---

## Schema (shared client/server) — `zero-schema/src/`

- Builder pattern: `table('user').columns({...}).primaryKey('id')` (AGENTS.md; `builder/`).
- Wire-relevant runtime shape is `clientSchema` (§6) — `{tables:{columns:{type:ValueType}, primaryKey:string[]}}`, `ValueType = 'string'|'number'|'boolean'|'null'|'json'` (`client-schema.ts:5`).
- **Name mapping**: schema drives `NameMapper` (`zero-schema/src/name-mapper.ts`) — `clientToServer` / `serverToClient`. The client stores/queries use *client* names; ASTs are mapped to *server* names before sending (`query-manager.ts:168-170`, `:360`), and incoming `rowsPatch` is mapped back (`zero-poke-handler.ts:362-399`). Lets app-facing column/table names differ from the Postgres source.
- Permissions live in `zero-schema/src/compiled-permissions.ts` and are enforced server-side via the AST's `static` params (`authData`, `preMutationRow`) (`ast.ts:89-98`); they are not part of the client→server message flow beyond the auth token carried in the connect handshake / `updateAuth`.

---

## Open questions

1. **`mutationResults` in `mergePokes`** — the local `mutationResults` array (`zero-poke-handler.ts:230`,`:305-307`) is allocated but never populated from `pokePart.mutationsPatch` (those go straight to the `m/` patch instead). Is this dead/forward-compat scaffolding, or does another path fill it? The comment at `:302-304` says it's there so strict validation can parse the field before it's introduced.
2. **`schemaVersions` on `pokeStart` vs `schemaVersion` on push** — pokeStart carries a `{min,max}` range (`poke.ts:42`) while push carries a single `schemaVersion` (CRUD only). How does the server reconcile a client schema range against the CVR's stored schema, and what triggers `unsupportedSchemaVersion`?
3. **`gotQueriesPatch` is per-poke, not per-client** — `desiredQueriesPatches` is keyed by clientID but `gotQueriesPatch` is global to the connection (`poke.ts:56-59`). Confirm "got" is genuinely client-group-scoped (shared across tabs) while "desired" is per-tab.
4. **CVR (Client View Record)** — the server-side structure that diffs desired-vs-synced to produce `gotQueriesPatch`/`rowsPatch` is referenced (`connect.ts:28`) but lives in `zero-cache`; not examined here. How exactly does it compute the minimal `rowsPatch` for an incremental query change (IVM)?
5. **Cross-tab client group** — `#handlePokeError` notes cookie divergence "across tabs in the same client group" (`zero-poke-handler.ts:196-200`). Where is the leader/follower or BroadcastChannel coordination, and which tab owns the single websocket?
6. **`constrain` in row `update`** (`row-patch.ts:17`) — what server condition emits a constrained update (column subset) vs a full `put`, and how does the client merge interact with optimistic rebased state?
7. **`flip`/`scalar` on `correlatedSubquery`** (`ast.ts:324-331`) and the `planIdSymbol` — these look like query-planner hints. Are they ever serialized, or stripped before the AST hits the wire (the symbol can't be JSON-serialized)?
