# Session handoff — Nizhal (echo) sync engine

**Branch:** `main` (local) → pushed to `nizhal-engine/main` and origin's `fix/sync-engine-data-loss`, both at `de73a1b`. Tree clean.
**Repo:** `/Users/mithushancj/Documents/personal/echo` (pnpm + turbo monorepo).

## Update (2026-07-02 session) — Arc C: `@nizhal/local` (local-only native-Drizzle DX)

Shipped a new standalone package **`@nizhal/local`** (WatermelonDB-class DX for purely local
apps: drizzle-kit migrations applied on-device, real Drizzle query builder, cross-platform live
queries — expo-sqlite / op-sqlite / browser wa-sqlite) plus the **`playground/local-notes`**
reference app (verified live in Chrome via Argent: insert/delete live re-render, reload
persistence). Zero sync-engine diffs. Docs: `docs/local.md`; decisions:
`local-drizzle-implementation-notes.md`. Gates after: check-types 22/22, lint 0,
server 74 passed, db-collection 109 passed, @nizhal/local 13/13.

**Arc B (multi-tab) remains where the list below left it** (#28–#30 open). Priority call made
this session (build-for-one): Arc C was the user's explicit ask and shipped first; before
resuming Arc B, decide caveat 1 below (refactor `createNizhalMutators` to be
shared-outbox-capable vs continuing the duplicate engine in `client-group.ts`).

## What this session delivered (all committed + pushed)

Two arcs. Reference the commits/RFCs — don't re-read them wholesale.

### Arc A — Productization plan (plan: `research/nizhal-productization-plan.md`), all done
- `b46af04` **Item 1a** — structured-`where` `MutatorTx`; deleted the Hermes-fragile drizzle key reflection (borrowed from better-drizzle; analysis in `.understanding/better-drizzle-borrow.md`).
- `fa8c686` **Item 1** — `openNizhalStore` (derives collections from schema+syncRules) + kernel `describeSyncedTables`.
- `c999e13` **Item 2** — `startLocalFirstBootstrap` + session stores; deleted per-app session files.
- `314b4bc` **Item 3** — engine schema versioning (`_nizhal_meta`) + version-aware `provision` + v1→v2 bigint→xid8 migration + `nizhal reset`.
- `8cfccd6` **Item 4** — CI `real-postgres` job (postgres:16 service) running the no-skip concurrency test.
- `f502d8f` **Item 5** — tabkeep as the reference: transport-free `domain.ts` + `nizhal.config.ts`; proven deployable via `nizhal migrate` against a throwaway Postgres.
- `f79ef35` fixed a committed NUL byte in `storage.ts`; `9775be4` merged biome format drift + fixed all lint rules (gate now green); `c7aec2c` **authoritative downward mutation-id resync on 409** (real fix) + made the db-collection suite deterministic (`fileParallelism: false`).

### Arc B — Multi-tab ClientGroup (plan: `rfcs/rfc-multitab-clientgroup.md`), partial
- `873b812` **Chunk 1** — `openNizhalClientGroup` (`packages/db-collection/src/client-group.ts`): Nizhal-owned leader-gated shared-outbox flush loop. 4/4 Node tests (`test/client-group.test.ts`).
- `de73a1b` (+ `e2c77d5`) **browser adapter** (`src/client-group-browser.ts`: Web Locks + BroadcastChannel + localStorage) + an **Argent/CDP-driven** cross-tab browser test (`test/browser/`, see its README). **No Playwright/esbuild** (removed per user). Verified live in a real Chrome: Web Locks elected one leader, a follower tab's write was flushed by the leader tab past a transient 503, outbox drained.

## Verification state (last observed)
- `pnpm check-types` 19/19 · `pnpm lint` exit 0 · server suite 74/74 · db-collection 105 passed / 1 skipped (deterministic, ~3 min).
- Browser cross-tab: verified live via Argent (not an automated CI test yet).

## Pending tasks (harness task list)
- **#28 Chunk 2** — allocate the shared per-client mutationID **and the enqueue ordinal** under the election mutex; leader **failover** (leader tab dies mid-flush → follower adopts, no gap/dup).
- **#29 Chunk 3** — wire the existing `waSqlitePersistence` (wa-sqlite/OPFS) into the tabkeep **web** app (`apps/tabkeep-expo/src/persistence.ts` returns `undefined` today) + integrate the coordinator into `openNizhalStore`.
- **#30 Chunk 4** — replace the `it.skip` in `packages/db-collection/test/repro-offline-loss-codex.test.ts` ("keeps an offline follower-tab write durable…") with the real coordinator scenario; graduate the browser flow into CI.
- **#31** — Argent update `v0.13.0` available; only apply with explicit consent (`npx @swmansion/argent update`).

## Known issues / caveats (the honest devil's-advocate list — read before continuing Arc B)
1. **Coordinator duplicates the real engine.** `client-group.ts` reimplements ~200 lines of `createNizhalMutators` (mutationID alloc, 409 resync, retry, park) as an **incomplete** copy — **no optimistic collection apply, no HLC, no `dependsOn` cascade**. Strongly consider **refactoring `createNizhalMutators` to be shared-outbox-capable** instead of maintaining two push engines that will drift.
2. **`nextOrdinal()` is a non-atomic RMW on shared meta.** Concurrent cross-tab enqueues can share an ordinal → **mis-ordering** (not loss; cmid is in the key). The "FIFO across tabs" guarantee only holds for sequential enqueues until Chunk 2 puts ordinal allocation under the mutex.
3. **Browser test validates a simplified stack** — localStorage (not the production **wa-sqlite/OPFS shared across tabs**, which is the riskiest untested part: SQLite multi-tab concurrency) and a trivial always-accept echo (not the real server's contiguous-sequence check).
4. The skipped repro test is **still skipped**; un-skipping is the Chunk 3/4 deliverable.
5. **Opportunity cost (build-for-one):** multi-tab web is **off the mobile-release critical path** — the release target `tabkeep-expo` is single-process (no tabs). Reconsider Arc B priority vs shipping the mobile reference before sinking more into it.

## Security constraints (must persist across sessions)
- Never connect to or mutate any DB except a **session-created throwaway** (local Postgres.app DB or a fresh Neon branch). Prod/live/main-named DBs are off-limits (e.g. `ordereka-live-app-prod`).
- Do **not** delete the Neon DBs backing live deployments without repointing.
- No `git add -A` (name files); never push secrets. Use `NIZHAL_TEST_DATABASE_URL` for real-PG tests.

## How to run things
- Tests: `pnpm --filter @nizhal/db-collection test` (deterministic, ~3 min) · `pnpm --filter @nizhal/server test`.
- Real-PG no-skip test: `NIZHAL_TEST_DATABASE_URL=<throwaway> pnpm --filter @nizhal/server exec vitest run test/version-skip-concurrency.test.ts`.
- Browser cross-tab QA: `pnpm --filter @nizhal/db-collection build && … serve:browser-harness`, then drive two `?tab=A`/`?tab=B` tabs via Argent (see `packages/db-collection/test/browser/README.md`).

## Suggested skills for the next session
- **`/autonomous-stand`** — to drive Chunk 2→4 (or the mobile-release path) to done.
- **`/build-for-one`** — to make the Arc-B-vs-mobile-release priority call first.
- **`/diagnose`** — for the untested wa-sqlite/OPFS multi-tab concurrency (build a real feedback loop before trusting it).
- **`/mobile-device-testing`** — Argent is the browser + iOS/Android driver here (Chromium via CDP; two `?tab=` tabs for cross-tab).
