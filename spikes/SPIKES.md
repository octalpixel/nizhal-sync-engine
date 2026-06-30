# Spikes — pre-Sprint-0 smoke tests (throwaway)

> Date: 2026-06-24. Purpose: turn the riskiest "should work" claims in RFC-001 into "does work / doesn't," against **real** libraries, before committing to Sprint 0. These are sacrificial — `node_modules/` gitignored; delete the dir anytime.

## Result: both load-bearing seams validated ✅

### Spike A — contract → codegen decoupling (RFC §4.7, the "don't be tRPC" decision)
`spikes/contract-loop/` — run: `node emit-contract.mjs && npx openapi-typescript contract.json -o nizhal.gen.d.ts`
- **PASS** Zod → OpenAPI/JSON-Schema (`zod-to-json-schema`) → typed client (`openapi-typescript` 7.13.0). Generated `Customer` / `RecordCreditInput` types correct (incl. optional `dueDate?`).
- **PASS** generated `nizhal.gen.d.ts` has **zero** server/ORM/relative imports → the client can be typed from the contract artifact alone. **Decoupling is real with off-the-shelf tools.**

### Spike B — the TanStack DB `SyncConfig` adapter (the core of `@nizhal/db-collection`)
`spikes/sync-adapter/` — run: `node spike.mjs`. Against **`@tanstack/db` 0.6.10** (the real beta):
- **PASS** adapter `begin/write/commit` lands pulled rows in the collection (simulated `/sync/pull`).
- **PASS** a realtime re-pull updates an existing row.
- **PASS** `subscribeChanges` fires on the re-pull (reactivity, == what `useLiveQuery` rides).
- **PASS** `collection.insert(...)` optimistic write appears immediately (offline write path).
- Confirms `nizhalCollectionOptions` is buildable against the real API: `createCollection({ id, getKey, sync: { sync: ({begin,write,commit,markReady}) => … }, onInsert })`.

## What is now de-risked
The two things no amount of doc-writing could confirm — (1) the new contract/codegen decoupling, (2) the beta TanStack DB integration our whole client rests on — both work as designed. Confidence to start Sprint 0 is materially higher.

## What is still UNPROVEN (honest — verify during Phase 0, lower risk)
- **Full server round-trip:** real `/sync/pull` cursor + `LISTEN/NOTIFY`→WS + idempotent push against an actual Postgres. (Generic SQL + NOTIFY — known tech, not spiked.)
- **SQLite persistence on real targets:** spike B used TanStack DB core (in-memory default), not `*-db-sqlite-persistence` (op-sqlite native / wa-sqlite web). The persistence is TanStack DB's shipped product, but not exercised here.
- **`loadSubset`** (partial replication) — used basic sync, not the subset hook.
- **Typed sync-rules → SQL compiler + no-leak lint** — our code; buildable, not spiked.

## Versions confirmed (for RFC deps)
`@tanstack/db` 0.6.10 · `openapi-typescript` 7.13.0 · `zod-to-json-schema` 3.x · `zod` 3.x · Node 22.
