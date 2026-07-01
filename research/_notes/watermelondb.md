# WatermelonDB — Sync Engine Profile (vs Nizhal)

> Primary sources: WatermelonDB docs (watermelondb.dev), the `Nozbe/WatermelonDB` GitHub README, and DeepWiki code-grounded answers over `Nozbe/WatermelonDB` (sync internals: `resolveConflict`, `applyRemoteChanges`, `fetchLocalChanges`, `synchronize`). Author: Radek Pietruszewski (@radex), Nozbe.
> Slots into [`sync-engine-landscape.md`](../sync-engine-landscape.md). Companion to the Replicache / Zero / lunora notes — WatermelonDB is the closest analog to **Replicache** (client lib + protocol contract, BYO server), but built around **real SQLite + lazy observables** instead of an IndexedDB KV prolly-tree.

---

## 0. Thesis in one paragraph

WatermelonDB is a **reactive, lazy-loaded ORM over SQLite (native) / LokiJS (web)** for React & React Native, plus a **sync protocol contract** — not a sync service. It ships only the **client**: you implement two backend endpoints (`pullChanges`, `pushChanges`) that conform to its wire shape, exactly like Replicache. Its defining bet is **performance through laziness**: "Nothing is loaded until it's requested," queries run on SQLite on a **separate native thread**, so the app launches instantly and stays fast "from hundreds to tens of thousands of records." Every query is **observable** — change a record and all dependent UI re-renders. Convergence is **column-level last-write-wins with a local-changes bias**: each record carries `_status` (`created`/`updated`/`synced`/`deleted`) and `_changed` (a comma-list of locally-dirtied columns); on conflict it spreads `{...local, ...remote}` then re-overlays the `_changed` columns from local, so the server wins *except* on fields the user touched locally. It has **no server**, **no realtime**, **no partial-sync primitive beyond "filter in your pullChanges"**, and **no buckets** — those are exactly the lines where Nizhal goes further.

The single idea to carry into Nizhal: **`_changed` as a per-column dirty-tracker is a dead-simple, storage-cheap mechanism for local-bias column merge** — no HLC, no per-field metadata jsonb, just a comma-string of column names that the merge replays last.

---

## 1. Core model & client store — lazy observables over real SQLite

**Layered object model** (`Database` → `Collection` → `Model` → `Query`):
- **`Database`** — single root instance; owns the `DatabaseAdapter` and a map of `Collection`s; manages transactions (`database.write(...)`). Access tables via `database.get('table')`.
- **`Collection`** — one per table; holds a `RecordCache` of already-materialized `Model`s.
- **`Model`** — one record instance; a JS class with decorators `@field`, `@date`, `@relation`, `@children`, `@text`. Minimal by design: "Watermelon's objects… only manage their own state and be an API for your app"; most logic is stateless pure functions.
- **`Query`** — fluent builder holding a `QueryDescription` (where/sort/take); compiles to SQL (native) or a LokiJS query (web).

**Why "lazy" = built for scale.** The framework's headline performance claim: *"Nothing is loaded until it's requested,"* and queries execute **directly on SQLite on a separate native thread** rather than pulling the dataset into JS memory. This is what lets it claim *"Launch your app instantly no matter how much data you have"* and *"Highly scalable from hundreds to tens of thousands of records."* Loading 50k rows into a JS array would jank the bridge/UI thread; querying SQLite and materializing only the visible slice does not. (Contrast: in-memory stores like lunora's cache or Loki on web must hold everything.)

**Reactive queries** (the observation system):
- `query.observe()` → `Observable<Model[]>`; re-emits when the **set of matching rows** changes (insert/delete into the result set).
- `query.observeWithColumns([cols])` → also re-emits when any of the named columns on matched rows change (needed for re-sorting a list when a sort key mutates).
- `model.observe()` → re-emits when that record changes.
- `withObservables(...)` HOC (and the `@nozbe/watermelondb/hooks` `useDatabase`/observable hooks) wires these into React, auto-re-rendering on change.

**Client store, two adapters:**
- **`SQLiteAdapter`** (iOS / Android / Windows / Node) — real SQLite; with **JSI** enabled it does synchronous native calls (no async bridge), the basis for Turbo (§6).
- **`LokiJSAdapter`** (web) — LokiJS in-memory DB, optionally persisted to **IndexedDB** (incremental IndexedDB + web-worker options for perf). Web is therefore *not* real SQLite — it's the one place WatermelonDB is in-memory, like lunora.

---

## 2. Sync protocol — the `synchronize()` primitive

`synchronize()` is the whole engine. It is a **pull-then-push** orchestration; you supply the two network functions.

```
synchronize({
  database,
  pullChanges: async ({ lastPulledAt, schemaVersion, migration }) => ({ changes, timestamp }),
  pushChanges: async ({ changes, lastPulledAt }) => { /* optional; returns experimentalRejectedIds? */ },
  migrationsEnabledAtVersion,
  conflictResolver,         // optional custom merge
})
```

**Flow** (from code):
1. `getLastPulledAt()` → local watermark (`null` on first sync).
2. `getMigrationInfo()` → `schemaVersion` + `migration` (the set of tables/columns added since `lastPulledAt`, so the server can include newly-needed columns/tables — see §5).
3. Call **`pullChanges({lastPulledAt, schemaVersion, migration})`** → server returns **`{changes, timestamp}`**.
4. `applyRemoteChanges(changes)` inside one write transaction.
5. `setLastPulledAt(timestamp)` — **the server's clock becomes the new watermark** (clients never invent the timestamp; avoids clock skew).
6. If `pushChanges` provided: `fetchLocalChanges()` → **`pushChanges({changes, lastPulledAt})`** → `markLocalChangesAsSynced(...)` (honoring optional `experimentalRejectedIds`).

**Change-set shape** — `SyncDatabaseChangeSet` = `{ [tableName]: { created: DirtyRaw[], updated: DirtyRaw[], deleted: RecordId[] } }`. Created/updated are full raw rows; deleted is just IDs.

**Per-record sync columns** (the heart of the local-change computation):
- **`_status`**: `'created'` (new, never pushed) | `'updated'` (dirtied since last sync) | `'synced'` (matches server) | `'deleted'` (tombstoned locally, pending push).
- **`_changed`**: comma-separated list of **column names dirtied locally** since last sync (e.g. `"name,is_completed"`). Empty when synced.

**Computing local changes** (`fetchLocalChanges`): query rows where `_status IN ('created','updated')`, plus deleted IDs from the adapter; bundle into the change-set. Cheap — it's an indexed status scan, no diff against a base snapshot (unlike Replicache's commit-chain rebase).

**Applying remote changes** (`applyRemoteChanges`, in one txn):
- **created**: insert; if ID already exists locally, treat as update.
- **updated**: if local is `synced` → overwrite with server row; if local is `updated` → **conflict → resolveConflict** (§3); if local is `deleted` → ignore (local delete will be pushed).
- **deleted**: destroy locally (even if locally changed).

**`last_pulled_at` watermark**: single timestamp; the server returns *everything changed since it*. This is the **same coarse watermark family as Nizhal's cursor / Replicache's cookie** — but it's a wall-clock timestamp, not an opaque monotonic sequence, which is why the docs are careful that the *server* supplies it.

---

## 3. Conflict resolution — column-level LWW with local bias

Default `resolveConflict(local, remote)`:
1. If `local._status === 'deleted'` → return `local` (local delete still wins, will be pushed).
2. Else build `resolved = { ...local, ...remote }` (remote wins broadly), but **force `id`, `_status`, `_changed` from local**.
3. Then for each column in `local._changed`, **overwrite `resolved[col] = local[col]`** (locally-touched columns keep the local value).
4. Record stays `_status: 'updated'` — local changes still need pushing.

Net: **server wins per-column, except columns the user changed locally → those stay local.** This is column-level last-write-wins **biased to local pending edits**. It is *not* HLC-ordered and *not* causal — it's "whoever the client last touched, the client keeps until pushed." Custom `conflictResolver({tableName, local, remote, resolved})` can override.

**What it explicitly does NOT solve** (docs are blunt): no business-logic conflicts (two users booking the last seat — the *backend* must reject one), no server-side integrity/uniqueness, no multi-client coordination (it's master/replica, server is master, no P2P). The merge is purely a **client-side column reconciliation**; correctness of *what the server stores* is your backend's job.

---

## 4. Backend-agnostic — protocol contract, no server (the Replicache parallel)

WatermelonDB ships **only the client + the sync protocol**. *"You only need to provide two API endpoints on your backend that conform to Watermelon sync protocol."* There is **no server package, no hosted service, no realtime channel.** This is the same posture as Replicache and Electric: the engine defines the wire contract; you own both endpoints and the database.

Backend rules the docs make **MUST**-strength:
- Pull **MUST return all record changes in all collections since `lastPulledAt`** (created/updated rows + deleted IDs).
- If `lastPulledAt` is null/0 → **MUST return all accessible records** (first-sync / bootstrap).
- Pull **MUST provide a consistent view** of changes since `lastPulledAt` (do it in a single query / under a write lock so nothing mutates mid-read).
- Push **MUST be fully transactional**: "If there is an error, all local changes MUST be reverted on the server, and an error code MUST be returned."
- Push conflict guard: "If the `changes` object contains a record that has been modified on the server after `lastPulledAt`, you MUST abort push and return an error code" (forces the client to pull-then-retry — optimistic-concurrency at the request level).
- Recommended change-tracking: a `last_modified` (= `NOW()` on every write) column, query `last_modified > lastPulledAt`; deletes via soft-delete flag or a separate deleted-IDs table.

**Partial sync = filter in pullChanges (no primitive).** There are no buckets, no shapes, no sync-rules. The doc's entire partial-sync story is: *"If permission to access records has been granted, the pull endpoint must add those records to `created`; if permission… has been revoked, the pull endpoint must add those records to `deleted`."* I.e. **you hand-write the scoping in your pull query**, and you simulate access-revocation eviction by emitting the row into `deleted`. This is Replicache's "hand-written client view" with extra manual bookkeeping, and the polar opposite of Nizhal's lint-enforced bucket scoping.

---

## 5. Schema & migrations

- **Schema**: `appSchema({ version, tables: [ tableSchema({ name, columns: [{name,type,isIndexed?,isOptional?}] }) ] })`. Types: `string`/`number`/`boolean`. Versioned.
- **Migrations**: `schemaMigrations({ migrations: [{ toVersion, steps: [...] }] })` with steps `createTable({...})`, `addColumns({table, columns})`. Passed to the **adapter** constructor (`new SQLiteAdapter({ schema, migrations })`), not to `synchronize()`. On app update, Watermelon diffs code-version vs stored-version and applies steps; if no path → DB reset (data loss guard).
- **The `migration` param to sync**: `synchronize()` computes `getMigrationInfo()` → a `MigrationSyncChanges` describing **which tables/columns were added since `lastPulledAt`**, passed to `pullChanges`. This lets the server **back-fill newly-added columns/tables** on the *first* sync after a schema bump — without it, a column added in v3 would never get historical data because `last_modified` on old rows predates the watermark. (Gated by `migrationsEnabledAtVersion`.) This is a genuinely clever primitive most sync engines lack: **schema-version-aware backfill folded into the normal pull.**

---

## 6. Tradeoffs the authors admit

- **No built-in server.** Client + protocol only; you write both endpoints and own the DB.
- **No partial-sync / permissions primitive.** You filter rows in `pullChanges`; revocation = emit to `deleted`. No buckets/shapes/sync-rules, no lint that proves a row is scoped.
- **No realtime.** Sync is **pull/push you trigger** (on app open, on push-notification, on interval, on user action). There is no server→client push channel — no WS pokes, no IVM deltas. "Live" within a device is the observable layer; *across* devices it's only as fresh as your next `synchronize()` call.
- **Conflict is shallow by design.** Column-LWW-with-local-bias only; business rules and integrity are punted to the backend.
- **Web ≠ native store.** LokiJS/IndexedDB in-memory on web; real on-thread SQLite only on native. Performance story is strongest on RN.
- **React/React-Native-first.** Tightly coupled to the React rendering model and decorators; not a general-purpose store.
- **Turbo login is "unsafe"/experimental.** The bulk-import fast path (`unsafeTurbo: true`) is first-sync-only (`lastPulledAt === null`), requires SQLiteAdapter+JSI, expects `pullChanges` to return raw JSON text (`syncJson`) or a pre-loaded `syncJsonId` so the JSON is imported **natively, bypassing JS parsing** — up to ~5.3× faster, less memory — but the API is marked unsafe and can't combine with `_unsafeBatchPerCollection`.

---

## 7. Nizhal vs WatermelonDB

### Where they agree
- **Real on-device SQLite client store** (Nizhal op/wa-sqlite; Watermelon native SQLiteAdapter). Both reject the "load everything into JS" model. (Caveat: Watermelon web falls back to LokiJS/IndexedDB.)
- **Backend-agnostic protocol contract, BYO server.** Neither ships a hosted sync service; both define a pull/push wire shape over **any** backend you implement. (Watermelon goes further — *truly* no server code at all, like Replicache; Nizhal at least ships server-side sync-rule/merge machinery you run against any Postgres.)
- **Coarse watermark pull.** Watermelon's `last_pulled_at` ↔ Nizhal's cursor: "give me everything changed since X," not a per-query IVM delta.
- **Column-level LWW.** Watermelon's default ↔ Nizhal's `lww` / `field` modes — both do per-column last-write-wins; both keep the server as source of truth.
- **You own the write authority semantics.** Watermelon's push-abort-on-server-conflict ↔ Nizhal's mutator-in-one-txn + write-scope check: the *backend* is where real correctness lives.
- **Offline writes via local dirty-tracking.** Watermelon `_status`/`_changed` ↔ Nizhal durable outbox: edits survive offline and flush on reconnect.

### Where they differ (Nizhal goes further)
| Dimension | WatermelonDB | Nizhal |
|---|---|---|
| Server | **None** (you write both endpoints) | Ships server-side engine: sync-rule eval, write-auth, merge — runs on **any Postgres, no WAL** |
| Partial sync | **Filter in `pullChanges`** (manual) | **Buckets** + `assertSyncRulesNoLeak` lint (structural scope proof) |
| Write authorization | Push-abort-on-conflict only; app enforces rules | **Server-side `rowMatchesScope` → 403** + mutator txn |
| Realtime | **None** — you poll/trigger sync | **WS hint → repull-on-`repull:${bucket}`** |
| Conflict model | One mode: column-LWW + local bias via `_changed` | **3 modes**: `lww` / per-field-HLC (`field`) / **CRDT (Yjs)** per column |
| Ordering / causality | Wall-clock `last_pulled_at`; `_changed` flags | **HLC** + monotonic `mutationID` + opaque row-version seq |
| Domain pattern | none | **append-only movement ledger** (balance = fold) |
| Eviction | emit row into `deleted` manually | `removedBuckets` / TTL / access-revocation eviction |

In landscape terms: WatermelonDB sits where **Replicache** sits — *client lib + protocol, BYO everything* — but swaps Replicache's IndexedDB-prolly-tree-KV + mutator-replay for **real SQLite + lazy observables + a `_changed`-column merge**. Nizhal occupies a strictly larger surface (buckets + server write-auth + realtime hint + three merge modes), paying for it with server-side machinery WatermelonDB refuses to own.

### Landscape-matrix row (append to §1 of `sync-engine-landscape.md`)

| Engine | Authority | Partial-sync unit | Live-query mechanism | Conflict / write path | Client store | Server / transport | Offline writes |
|---|---|---|---|---|---|---|---|
| **WatermelonDB** | Server (your backend; master/replica) | **hand-filtered `pullChanges`** (no bucket/shape primitive; revoke→`deleted`) | **none cross-device** (poll/trigger `synchronize()`); **on-device = lazy observables** (`observe`/`observeWithColumns`) | **column-LWW + local bias** via `_changed` overlay; push-abort-on-server-conflict; backend owns business rules | **real SQLite** (native; JSI) / **LokiJS+IndexedDB** (web); `_status`/`_changed` dirty-tracking | **BYO server, 2 endpoints**; **HTTP pull/push, no realtime** | ✅ via `_status='created'/'updated'`, flushed on next sync |

---

## 8. What Nizhal should STEAL

1. **`_changed` comma-list as the column-dirty tracker.** Nizhal's `field` mode carries per-field HLC in a `_meta jsonb`. For columns that only need *local-bias LWW* (not causal ordering), a flat `_changed` string is dramatically cheaper to store, read, and replay — `resolved = {...local, ...remote}` then re-overlay `_changed` cols is ~5 lines. Worth offering as a lightweight tier *below* `field`-HLC for tables that don't need causal tiebreaks. (And it's exactly the "keep my pending edits, take server otherwise" UX users expect.)
2. **Lazy observables over SQLite for scale.** Nizhal delegates client reactivity to TanStack DB; WatermelonDB's `observe()/observeWithColumns()` model — re-emit on *set membership* change vs re-emit on *named-column* change — is a clean, battle-tested taxonomy. The `observeWithColumns` distinction (only re-render a sorted list when the sort key moves) is a real perf primitive to make sure TanStack-DB integration preserves.
3. **Turbo bulk-import for first-sync bootstrap.** WatermelonDB's `unsafeTurbo` — return **raw JSON imported natively, bypassing JS parsing** — is directly applicable to Nizhal's paginated bootstrap. First-sync of a shop's full ledger into op/wa-sqlite via JS `INSERT` loop is slow; a native bulk-import path (raw JSON → SQLite C bulk insert) is the same ~5× win. Nizhal already has `cursorReset` re-bootstrap; a Turbo-style native import would make it fast.
4. **The dead-simple sync contract as an API-design north star.** `synchronize({pullChanges, pushChanges})` — two functions, one watermark, three arrays (`created`/`updated`/`deleted`) — is the clearest sync API in the field. Nizhal's contract is richer (buckets, HLC, dependsOn) but the *ergonomic ceiling* WatermelonDB sets ("a junior can implement the backend in an afternoon") is the bar the `nizhal gen`/contract emitter should hit.
5. **Schema-version-aware backfill in pull** (the `migration` param). When a column is added in a new schema version, WatermelonDB's `migration` info tells the server to back-fill it on next pull — solving the "new column never gets historical data because old rows predate the watermark" bug. Nizhal's client-store migrations are versioned/downgrade-guarded, but verify it has an equivalent **post-migration backfill pull** for newly-added bucket columns; if not, steal this.
6. **Push-abort-on-server-conflict as a cheap OCC fallback.** For tables where Nizhal users opt out of merge entirely, WatermelonDB's "if any pushed row changed on server after `lastPulledAt`, reject the whole push" is a trivially-correct request-level optimistic-concurrency mode worth offering as a fourth, ultra-conservative merge option.

---

## 9. Sources

- WatermelonDB — Sync Intro: https://watermelondb.dev/docs/Sync/Intro ("two API endpoints… conform to Watermelon sync protocol")
- WatermelonDB — Sync Backend (MUST-rules, partial sync via created/deleted, last_modified tracking): https://watermelondb.dev/docs/Sync/Backend
- WatermelonDB — Sync Frontend (`synchronize`, pullChanges/pushChanges, conflictResolver, unsafeTurbo): https://watermelondb.dev/docs/Sync/Frontend
- WatermelonDB — Architecture (minimal objects, Database/Collection/Model/Query, pure functions): https://watermelondb.dev/docs/Implementation/Architecture
- WatermelonDB — Schema & Migrations: https://watermelondb.dev/docs/Schema , https://watermelondb.dev/docs/Advanced/Migrations
- GitHub README (scale/lazy/observable/offline-first bullets): https://github.com/Nozbe/WatermelonDB
- DeepWiki (code-grounded internals: `resolveConflict`, `applyRemoteChanges`, `fetchLocalChanges`, `synchronize`, `_status`/`_changed`, Turbo): https://deepwiki.com/Nozbe/WatermelonDB
- Author: Radek Pietruszewski (@radex), Nozbe — https://github.com/radex
