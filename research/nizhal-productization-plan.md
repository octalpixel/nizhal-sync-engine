# Nizhal productization + deployability — plan of record

> Diagnose + triage per item, sequenced. Alpha, no users → **breaking changes embraced**; the framework
> owns *assembly*, apps own *declarations* (no app glue in `packages/`). tabkeep = the release target.
> better-drizzle borrow analysis: [`.understanding/better-drizzle-borrow.md`](../.understanding/better-drizzle-borrow.md).

## The two gaps (root cause)
1. **Productization:** the framework makes every app hand-assemble the same wiring — `createNizhalClient`
   → `nizhalCollectionOptions` per table → `preload` each → `createNizhalMutators` with
   outbox/meta/deadletter storage → `manualOnlineDetector`, plus a platform-split transport and a
   hand-rolled local-first bootstrap. ~50+ lines of *framework glue* copied across chat/tabkeep/expo/
   credit-ledger. Compounded by mutators using **raw drizzle predicates**, forcing the client to
   reflect the row key out of drizzle internals (the Hermes bug).
2. **Deployability:** `nizhal migrate` = one `provision()` call, forward-idempotent only. No version
   stamp, no engine-schema evolution → xid8 can't upgrade an existing DB (`add column if not exists`
   no-ops on the old bigint column).

## Item 1a — structured-`where` MutatorTx *(borrowed; root-cause fix + DX; do first)*
- **Problem:** `tx.update(t).set(p).where(eq(t.id,id))` forces `extractSimpleIdEquality` to reflect the
  key from drizzle `queryChunks` — engine-fragile (broke on Metro/Hermes; patched with `brand||encoder`).
- **Fix (better-drizzle DX):** `tx.update(table, { id }).set(patch)` / `tx.delete(table, { id })`.
  Client reads `{id}` directly (delete `extractSimpleIdEquality`); server maps `{id}`→`eq(pk,id)`.
- **Increments:** kernel `MutatorTx` type → client `collectionMutatorTx` → server `mergeAwareTx` →
  all app mutators (renameCustomer, chat updateNote, …) + tests.
- **Done:** db-collection suite green (no key-reflection), on-device rename works, no `queryChunks` refs.

## Item 1 — `openNizhalStore` primitive *(collapse the assembly glue)*
- **Fix:** `openNizhalStore({ echo, schema, syncRules, mutators, actor, persistence })` → derives one
  collection per synced table (bucketField from syncRules, getKey from pk), preloads, wires
  outbox/meta/deadletter + online detector; returns `{ collections, mutate, onlineDetector, dispose }`.
  Repository-per-table shape validated by better-drizzle's `better(db,{schema})`.
- **Increments:** syncRule→(table,bucketField) introspection helper (reuse server `collectSyncRuleTables`,
  export from kernel) → the primitive → refactor tabkeep-expo `createTabkeepExpoClient` onto it.
- **Done:** tabkeep-expo client ≈ one call; chat/credit-ledger refactorable the same way.

## Item 2 — transport + bootstrap into the framework
- **Fix:** `@nizhal/react-native` re-exports a platform-correct `createNizhalClient` (nitro on native)
  so apps drop `echo.native/echo.ts`; `createLocalFirstBootstrap({ fetchSession, sessionStore })`
  (cache session → open-local-first → background refresh); persistence adapter exposes a KV so
  `session.native.ts` disappears.
- **Done:** tabkeep-expo `App.tsx` bootstrap + session files collapse into framework calls.

## Item 3 — engine versioning + real migrations *(deployability keystone; standalone)*
- **Fix:** `_nizhal_meta(key,value)` stamps `engine_version`. provision/migrate become version-aware:
  fresh → provision current + stamp; existing older → run ordered engine migrations to current.
  Ship **v1→v2 = bigint→xid8** (ALTER row_version/tombstone/audit `using ::text::xid8`; swap the
  function to `pg_current_xact_id()`; drop `_nizhal_row_version_seq`; tombstone index → non-unique).
  Add `nizhal reset` (drop `_nizhal_*` + reprovision) for the clean-slate path.
- **Test:** build an old-style bigint engine DB → `migrate` → assert xid8 + row order preserved + no loss.
- **Done:** an existing bigint-provisioned DB upgrades in place to xid8 with data intact.

## Item 4 — CI (verified → guaranteed)
- GitHub Actions: gate (build+check-types+test+lint) + a Postgres-service job running
  `version-skip-concurrency.test.ts` (`NIZHAL_TEST_DATABASE_URL`) so no-skip is repo-enforced.
- **Done:** a fresh clone's CI proves loss-free + the migration test, not just a live session.

## Item 5 — ship tabkeep as the reference release
- After 1a/1/2/3: tabkeep-expo client ≈ 10 lines of declaration, deployable via `nizhal migrate`,
  correctness CI-guaranteed. The "1" made real for one app.

## Order & rationale
1a → 1 → 2 (productization/DX; 1a is the foundation and deletes the fragile reflection) · 3 in parallel
(standalone, deployability) · 4 (lock-in) · 5 (payoff). All breaking, all fine now.
