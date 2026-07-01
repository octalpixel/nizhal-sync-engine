# RFC: Local↔Sync convergence — one schema, one query surface, a ladder

**Status:** Draft (decision-ready) · **Slug:** `local-sync-convergence` · **Author:** autonomous session (2026-07-02)

---

## 1. The "1" (end state)

**A Nizhal app is written once — a Drizzle PG schema + mutators (+ sync rules when it syncs) — and
runs anywhere on the ladder:**

```
Rung 0  local-only     @nizhal/local        real SQLite tables, drizzle queries, live queries. No server.
Rung 1  synced         same client DB       + outbox + mutators + pull + WS poke  ⇄  PG server (the engine we have)
```

Climbing a rung changes **configuration, not code shape**: the schema is defined once (PG dialect),
the client SQLite schema is *derived* from it, the query surface is the real Drizzle query builder on
both rungs, and reactivity is the same `watch`/`useLiveQuery`. `playground/pos` is the live proof this
ladder is what people build: an offline-only POS whose code says *"single offline shop for now
(becomes the sync bucket later)"* (`playground/pos/web-nizhal/src/nizhal/client.ts:13`).

**PG stays the off-the-shelf primitive.** The server engine (xid8 row-versions, tombstone triggers,
snapshot-xmin horizon, bucket scoping) is proven and PG-specific — we do not adapterize it. Other
backends join at the **protocol** level (§8), not by porting the engine.

## 2. Current state (grounded)

| Concern | Today | Evidence |
|---|---|---|
| Local-only plane | `@nizhal/local`: real sqlite drizzle tables, drizzle-kit bundled migrations, cross-platform live queries | `packages/local/`, `docs/local.md` |
| Sync plane client store | JSON-blob-per-row KV (TanStack `db-sqlite-persistence-core`), **not** drizzle-queryable | mapping session 2026-07-02; `key TEXT, value TEXT` tables |
| Schema definition | **Already once** — shared `domain.ts` (pgTable + mutators + syncRules) imported by server *and* client bundle | `apps/tabkeep-expo/src/client.ts:2` |
| …but | docs promise the opposite: "types generated via `nizhal gen` (planned); do not import server Drizzle schema on the client" | `docs/api.md:3` |
| `nizhal gen` | stub (`notImplemented("gen", "C4 …")`) | `packages/cli/src/index.ts:38-40` |
| `nizhal introspect` | stub (B9 brownfield introspection) | `packages/cli/src/index.ts:41-43` |
| Contract | shipped: `GET /nizhal/contract` = OpenAPI 3.1 + `x-echo` (collections, merge policy, mutator input schemas, sync-rule names) | `packages/kernel/src/contract.ts:20-56`, `server/src/index.ts:220` |
| Brownfield provisioning | **built & non-destructive**: `add column if not exists` (`updated_at`, `deleted_at`, `_nizhal_row_version xid8`), triggers, separate `_nizhal_*` tables; idempotent; helpful error when tables missing | `packages/server/src/adapters/storage.ts:1363-1382`, `cli/src/index.ts:67-72` |
| Realtime | WS pokes (`repull:${bucket}`), client catch-up pull stays authoritative; PG `LISTEN/NOTIFY` bridge with per-table notify triggers | `server/src/realtime.ts:193-197`, `:224-316` |
| Mutators | structured-`where` `MutatorTx` runs on client (collections) and server (SQL) | Item 1a, `kernel/src/types.ts:37-50` |
| Column types actually used by apps | `text`(+enum), `integer`, `timestamptz`, `numeric`, `real` — nothing exotic | repo survey 2026-07-02 |
| Schema-once mechanics | **spiked, 13/13 PASS**: pgTable → derived sqliteTable → drizzle-kit migration SQL → typed round-trips | `spikes/pg-to-sqlite-schema/` (Spike C) |

## 3. What `@nizhal/local` wins that the sync plane's offline doesn't

The sync plane already does offline — but its store is a JSON-blob KV, so it can never serve:

1. **Real SQL over your data** — aggregates, joins, `ORDER BY`+`LIMIT` pushed to SQLite, partial
   indexes. The blob plane answers only "give me the collection; filter in JS".
2. **The Drizzle toolkit as the app surface** — drizzle-kit migrations, `db.query.*`, transactions,
   anything that wraps a drizzle instance (better-drizzle composes for free).
3. **Zero server requirement** — no sync rules, no outbox, no transport; a WatermelonDB-class
   dependency footprint.

These are why local exists as its own plane. The gap is that today the two planes don't meet — that
is what this RFC closes.

## 4. The convergence decision

**Decision: sync converges onto the drizzle-native plane — the synced client store becomes real
SQLite tables (the same plane `@nizhal/local` runs), and the TanStack blob store becomes an
implementation detail we eventually retire from the sync path. The server engine and wire protocol
do not change at all.**

Why this direction and not the reverse (bolting drizzle queries onto the blob store):

- The blob store *cannot* serve SQL (§3.1) — views-over-JSON (PowerSync's trick) is a real pattern
  but forfeits drizzle-kit migrations and real columns, and PowerSync itself had to ship a
  `drizzle-driver` to meet drizzle demand. We'd be building their compatibility layer instead of our
  product.
- The server never sees the client store. Pull returns rows; push takes named mutations. The client
  storage swap is invisible to `@nizhal/server` — every loss-proof on the wire protocol keeps its
  value.
- The mutator model already fits: structured-`where` `MutatorTx` (Item 1a) maps 1:1 onto drizzle
  sqlite ops (`{id}` → `eq(pk, id)`). The optimistic path needs **no reflection at all** on real
  tables — the disease Item 1a cured stays cured.

**What we are *not* deciding:** ripping out `@nizhal/db-collection` now. It is battle-tested
(109 tests, deterministic loss repros). The migration is staged (§10); the blob plane remains the
shipped sync client until the drizzle-native client passes the *same* repro suites.

## 5. Path A — greenfield: schema defined once (spiked)

Keep exactly today's authoring model — one transport-free `domain.ts` with `pgTable` + mutators +
sync rules. The client SQLite schema is **derived**, never written:

```ts
// kernel (new): deriveSqliteSchema(pgSchema) — mechanical lowering, fail-closed
customers(pg: text/timestamptz/…)  →  customers(sqlite: text/integer{timestamp_ms}/…)
```

Spike C proved the whole chain against tabkeep's real tables plus a kitchen-sink table:
derivation → `drizzle-kit/api` `generateSQLiteDrizzleJson`/`generateSQLiteMigration` (client
migration SQL) → better-sqlite3 → typed round-trips (Date exact to the ms, boolean, jsonb, bigint).
The mapping table (13 pg column types → text/integer/real, fail-closed on unknowns) lives in
`spikes/pg-to-sqlite-schema/derive.mjs` and covers a superset of every column any app schema uses.

Placement: `@nizhal/kernel` (it already owns schema reflection — `tableColumnMergeModes` etc.).
Apps on Rung 0 that intend to sync later write `pgTable` from day one and open
`@nizhal/local` with the derived schema; climbing to Rung 1 changes no table definition.

Open mapping decisions (recorded, defaults chosen):
- `numeric` → **text** (exactness; money should be integer cents anyway — tabkeep does this).
  Override hook if an app wants `real`.
- `crdtText`/`crdtMap` (bytea, used by zero apps today) → excluded from v1 derivation; fail-closed
  error names the column.
- Server-side defaults (`defaultNow`, …) intentionally not mirrored — client values come from pull
  or mutators.

## 6. `nizhal gen` — scope (this is where it earns its keep)

`gen` is the artifact that makes the ladder work **without sharing source** — and it fixes the
standing contradiction between `docs/api.md:3` and what every app actually does (bundling the server
pgTable schema into the client).

```
nizhal gen client (--server <url> | --config nizhal.config.ts) --out src/nizhal.gen/
```

**Emits** (all from the contract, zero server imports — Spike A already proved the decoupling):
1. `schema.ts` — client `sqliteTable` definitions for the synced tables (Spike C lowering).
2. `migrations/` + `meta/` — **real client SQLite migrations**: `gen` stores the previous drizzle
   snapshot in the out dir and emits `generateSQLiteMigration(prev, cur)` diffs. Client schema
   evolution becomes an append-only migration bundle — the same `{journal, migrations}` format
   `@nizhal/local` already applies on all three platforms.
3. `client.ts` — typed `mutate.*` client from the contract's mutator input schemas
   (openapi-typescript path validated in Spike A).
4. `sync-meta.ts` — table→bucket-column map + merge policy (from `x-echo`).

**Contract extension required (small):** today's `x-echo` carries JSON-schema row shapes, which are
lossy for lowering (a timestamptz and a text both become `"string"`; only `format` hints survive).
Add `x-echo.tables[table].columns[] = { name, drizzleType, notNull, primary, enumValues? }` emitted
from the same drizzle reflection the kernel already does. JSON-schema stays for validation/types;
the column block is for schema lowering.

**Wins, concretely:**
- Greenfield: `domain.ts` stays the single source; the *client bundle* carries generated sqlite
  schema instead of pg-core imports.
- Brownfield (§7): a client team can target a running server with **only a URL** — schema, types,
  mutate client, migrations all fall out of `GET /nizhal/contract`.
- Client migration story: schema evolution on synced tables gets real DDL diffs; nuke-and-repull
  (Zero's rebuildable-cache stance) remains the recovery path, never the primary path — the outbox
  and any local-only tables can't be nuked.

Recovery/versioning rule (from Zero's playbook): contract carries a schema version; an incompatible
client gets a `re-bootstrap` signal (we already have `cursorReset` machinery on bucket growth).

## 7. Path B — brownfield: the porulle-POS walkthrough

Scenario: a POS frontend must go offline-first against an **existing porulle backend** (Postgres,
drizzle, server-side). Admin adds products in porulle; every offline POS converges. Multi-user,
multi-device. Backend team will mount a sidecar but won't rewrite anything.

The server side of this is **mostly built already**:

1. **Introspect** (`nizhal introspect`, stub → scope): emit a `pgTable` subset for the tables to
   sync (products, orders, …) from the live DB — drizzle-kit pull does the heavy lifting; we filter
   and annotate. Output feeds `nizhal.config.ts`.
2. **Declare** sync rules (bucket = store/org id — porulle rows already carry `organizationId`) and
   mutators. Mutators are the brownfield seam: they can write the tables directly *or* call porulle
   services — they're just server functions with a `MutatorTx`.
3. **Provision**: `nizhal migrate` against the existing PG — proven non-destructive and idempotent
   (`add column if not exists` for `updated_at`/`deleted_at`/`_nizhal_row_version xid8`, touch +
   tombstone + notify triggers, engine state in separate `_nizhal_*` tables;
   `storage.ts:1363-1447`). The one hard requirement: each synced table has an `id` primary key.
4. **The magic brownfield property — trigger-based capture:** porulle's admin keeps writing through
   its own stack, *knowing nothing about Nizhal*. The `BEFORE UPDATE` touch trigger bumps
   `_nizhal_row_version`, the notify trigger emits `pg_notify('echo_bucket', …)` → WS poke →
   every POS repulls the products bucket. Deletes/soft-deletes/bucket-exits land in
   `_nizhal_tombstones` via the removal trigger. **No porulle code changes for the read path.**
5. **Mount** the Nizhal Hono server (sidecar or same process — it's a Hono app) with auth mapped to
   porulle sessions; POS writes go through named mutators (multi-user convergence = the engine's
   existing mutation-id + bucket model).
6. **Generate the client**: `nizhal gen client --server https://pos-sync.example.com` → the POS
   frontend gets sqlite schema + typed mutate + migrations, imports nothing from the backend.

What this asks of the backend team: run one migration command they can read first (`--dry-run`
should be added — it's a `statements[]` array today), host one route group, accept three columns and
three triggers per synced table. That's the honest cost; it's low, and it's the *same* engine we've
already loss-tested rather than a second brownfield-special path.

## 8. PG-primary; "other frameworks/DBs" = protocol, not adapters

Push-back on adapterizing the storage engine now: the engine's guarantees are **built from PG
internals** — `xid8`/`pg_current_xact_id` commit ordering, `pg_snapshot_xmin` horizons,
`LISTEN/NOTIFY`. A MySQL/SQLite-server "adapter" would not be a port, it would be a re-derivation of
the correctness argument per backend — the most expensive thing we could buy while having zero users
asking for it (§2 CLAUDE.md: no speculative capability).

What we keep open instead — already true, keep it deliberate:
- **The wire protocol is backend-agnostic**: pull cursor + rows, push named mutations, contract
  JSON, WS pokes. Any backend that implements the four routes is a Nizhal server. Document the
  protocol (one doc page) — that's the extension surface for "other frameworks/DBs".
- **Client side is already DB-plural** (expo-sqlite / op-sqlite / wa-sqlite; better-sqlite3 in
  tests) via drizzle drivers + duck-typed change feeds.
- The `SyncEngineStorage` interface inside `@nizhal/server` remains internal; a second
  implementation is a *future* RFC gated on real demand.

## 9. PayloadCMS — the verdict (pushback, as requested)

You were **half right**, and the half matters:

- **Right:** Payload's `@payloadcms/drizzle` is the strongest existing precedent for *one schema IR
  lowered to PG and SQLite drizzle dialects* + *programmatic drizzle-kit migration generation*
  (`buildDrizzleTable.ts` per dialect; `requireDrizzleKit` → `generateSQLiteMigration` etc.). Their
  lowering table (timestamp→text+strftime, jsonb→text json, boolean→integer, enum→text+list) and
  ours (Spike C) agree almost line for line — independent confirmation the mapping is small and
  stable.
- **Wrong direction:** Payload has **no client-side story at all** — `db-sqlite` is a *server*
  talking to libSQL; there is no offline, no sync, no on-device anything. Its problem is "which
  server DB do you rent"; ours is "a PG server replicating into thousands of device SQLites". The
  architecture to study for that is PowerSync (sync rules → buckets; client JSON store under typed
  views — structurally our *current* blob plane), ElectricSQL (read-path sync; writes explicitly
  app-owned — validating that our mutator/outbox write path is the hard part worth owning), and
  Zero/drizzle-zero (one TS schema + codegen from drizzle-pg — validating §5/§6).
- **Also borrow from Payload:** its dialect lowering lives behind hooks (`beforeSchemaInit`) — our
  derivation should similarly take a per-column override map instead of growing flags.

One more self-correction of the field, in our favor: *nobody* hand-maintains two dialect schemas.
Every serious system is one-source + mechanical lowering. The only fork is *what* the source is —
neutral DSL (Zero, Payload) vs one dialect (drizzle-zero: PG). For us PG-as-source wins because
"your existing drizzle pgTable just works" is the wedge, and the kernel already reflects it.

## 10. Rung 1 mechanics — sync on the drizzle-native plane (staged)

The synced client DB layout (one SQLite file):

```
products, orders, …          ← derived tables (real columns), written ONLY by pull-apply + mutator replay
_nizhal_outbox               ← queued mutations (same shape the blob plane's outbox has today)
_nizhal_meta                 ← mutation-id high-water, cursor, contract/schema version
__drizzle_migrations         ← client DDL bookkeeping (already shipped in @nizhal/local)
```

- **Writes**: app calls `mutate.addToCart(...)` → mutator runs locally via `MutatorTx` lowered to
  drizzle sqlite ops (optimistic apply **directly into the tables**) + enqueue in outbox →
  update_hook fires → live queries re-render. Push replays the named mutation server-side (existing
  protocol; mutation-id/409-resync machinery unchanged).
- **Reconciliation**: on server echo / pull, rows are upserted authoritatively; a rejected mutation
  triggers rebase = re-pull affected rows + replay remaining outbox mutations (deterministic
  mutators make replay the rebase — the same model the engine already relies on server-side). This
  is the **hard part** and gets its own design review; the honest alternative if direct-apply
  rebase proves gnarly is a PowerSync-style overlay view for pending rows. Decision deferred to the
  implementation RFC — *both* fit the same file layout above.
- **Reactivity**: `update_hook` (shipped in `@nizhal/local`) — pull-apply and mutator writes both
  trigger it; `useLiveQuery` just works.
- **Realtime**: existing WS poke → pull. Nothing changes.

**Stages** (each independently shippable, gates = the existing loss-repro suites re-targeted):
1. **Schema-once + gen** — `deriveSqliteSchema` into kernel (from Spike C), contract column
   extension, `nizhal gen client`. Ships value to *both* planes; no risk to the sync path. Also
   `--dry-run` for migrate.
2. **Read-path convergence** — pull-apply into derived real tables + cursor in `_nizhal_meta`;
   read-only synced drizzle DB (server-authoritative rung for dashboards/porulle-POS product
   catalog). The blob plane still handles writes for existing apps.
3. **Write-path convergence** — outbox + mutator replay + rebase design review; drizzle-native
   client passes `repro-offline-loss` + push/409 suites; tabkeep-expo migrates as the reference.
4. **Retire** the blob plane from the sync path (keep TanStack for whoever wants collection UX as a
   layer, not a requirement).

## 11. Decisions

| # | Decision | Status |
|---|---|---|
| D1 | Sync converges onto the drizzle-native plane; server/protocol unchanged | **decided** (§4) |
| D2 | Schema source of truth = drizzle `pgTable` (kernel); client sqlite derived, never authored | **decided** (§5, spiked) |
| D3 | `nizhal gen client` from contract (+column metadata extension); real client migrations via snapshot diffs | **decided** (§6) |
| D4 | PG is the only first-party server engine; other backends via documented protocol | **decided** (§8) |
| D5 | PayloadCMS: borrow lowering-table + drizzle-kit-api pattern; not a sync architecture precedent | **decided** (§9) |
| D6 | Optimistic strategy on real tables: direct-apply + replay-rebase vs overlay views | **open** — stage-3 design review |
| D7 | `numeric` lowering default (text) + per-column override hook | default chosen, revisit with first real consumer |
| D8 | crdt columns client-side representation | **open** — no app uses them yet; fail-closed until one does |

## 12. Immediate next steps

1. Kernel: `deriveSqliteSchema` (port Spike C's `derive.mjs`, typed, fail-closed) + tests.
2. Kernel/server: contract `x-echo.tables[].columns` extension (reflection already exists).
3. CLI: `nizhal gen client` (schema + migrations + typed mutate + sync-meta) — un-stub.
4. `nizhal migrate --dry-run` (print `statements[]`) — brownfield trust cheaply bought.
5. Stage-2 read-path spike: pull-apply into derived tables against the real server
   (the emulation harness already runs client+server+wa-sqlite in Node).
