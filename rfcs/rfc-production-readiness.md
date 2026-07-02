# RFC: Production readiness — from "pilot-proven" to a 50k-user release

**Status:** READY (not started) · **Slug:** `production-readiness` · authored 2026-07-03
**Parent:** `rfc-local-sync-convergence.md` (architecture) + `rfc-drizzle-native-sync-client.md`
(EXECUTED — the engine this RFC hardens). This RFC is the execution plan for the next session(s):
**X = 28 tasks in 7 phases**, driven to zero in order. Phase P1 ships `0.1.0` to npm; P2–P6 earn
the word "production"; P7 is the rollout.

## Framing — what 50k users actually changes

50k users ≠ 50k concurrent (plan for 2–5k concurrent WS, long tail offline for weeks/months).
Three things change, and every task below traces to one of them:

1. **Fleet heterogeneity** — you cannot force-update the app; old clients run old schemas and
   stale cursors for months. (P2 resync, P4 schema evolution)
2. **Blast radius** — a convergence bug is no longer a demo glitch; it is data loss across a
   fleet. (P3 chaos rig, P6 security/observability)
3. **Sustained load** — reconnect storms after deploys, sidecar-table growth vs vacuum, initial
   hydration of large datasets. (P5 load, P2 GC)

## Verified current state (2026-07-03 — empirical, not recalled)

**Already exists (do NOT rebuild):**
- `cursorReset` is END-TO-END in the protocol: server emits it (`packages/server/src/adapters/
  storage.ts:618`; bucket-visibility case at `:531-543`), client handles it with atomic
  re-bootstrap **and replay-rebases the pending outbox** (`packages/db-collection/src/drizzle/
  pull.ts:154`). P2 is therefore *detection* (epoch + horizon), not new protocol.
- Pull is paginated + resumable: `hasMore` + atomic per-page cursor (`storage.ts:579-619`,
  `pull.ts:143-173`).
- Multi-instance realtime seam: `listenNotifyRealtime` (`packages/server/src/adapters/
  realtime.ts:224`) beside `inProcessRealtime`.
- Durable job runner: `packages/server/src/jobs.ts` (`_nizhal_jobs`, claim + backoff +
  maxAttempts) — tombstone GC becomes a registered task, no new infra.
- Observability seam: `packages/server/src/observer.ts` (unwired).
- Engine sidecar tables in `packages/server/src/engine-tables.ts`: `_nizhal_mutations`,
  `_nizhal_clients`, `_nizhal_tombstones`, `_nizhal_sync_control`, `_nizhal_client_buckets`,
  `_nizhal_jobs`, `_nizhal_audit_log`.
- Proof so far: 7-test client e2e vs real server, live multi-device (3 devices), multi-tab
  (`crossTabChannel`), iOS on op-sqlite (v17 shim + contract test), brownfield B2 (`playground/
  pos`), web on Vite (`playground/local-notes`, pos).

**Verified gaps (each is a task below):**
- NO tombstone GC/retention anywhere in `packages/server/src` → unbounded growth.
- NO "cursor older than GC horizon" detection; NO server epoch/generation → a Postgres
  restore-from-backup regresses xid8 and silently strands every client.
- README quickstart + `.changeset/phase-0-1-1.5-initial-release.md` document the DELETED
  TanStack plane (`nizhalCollectionOptions`, `apps/credit-ledger`).
- No `LICENSE` file; no `license` field in any package.json.
- `@nizhal/react-native` survived the Arc E purge: imports `OnlineDetector` from
  `@tanstack/offline-transactions` + `createNizhalClient` — drags the legacy dep back.
- Root `package.json` scripts broken: `test` ends in `pnpm --filter emulation chaos` and
  `example:byo` filters a deleted package (`pnpm ls --filter` confirms no match).
- npm scope `@nizhal` unclaimed as of 2026-07-03 (`npm view @nizhal/kernel` → 404). Org must be
  created before `changeset publish`.
- OPEN: tabkeep WEB boot under Metro fails at wa-sqlite asyncify `_malloc` (full forensics in
  SESSION-HANDOFF, morning-of-2026-07-02 commit `8dbffc1` was the last verified state). Vite web
  is unaffected and live-verified.
- Android never run. Arc B leader-elected shared outbox not built (multi-tab correctness today
  rides server idempotency — documented caveat, `rfcs/rfc-multitab-clientgroup.md` has the plan
  and its `client-group.ts` spike was deleted with the legacy plane).

## Decisions needed (defaults chosen — confirm or override, then execute)

| # | Decision | Default (execute unless overridden) |
|---|---|---|
| D1 | License | MIT (`LICENSE` at root + `"license": "MIT"` in every published package) |
| D2 | `@nizhal/react-native` | FOLD: port `installNitroFetch` + `reactNativeOnlineDetector` onto the owned `OnlineDetector` type in `db-collection/src/types.ts`; delete the package (less is more, same as Arc E) |
| D3 | Web-on-Metro | BLESS Vite/Next/TanStack Start as the supported web paths; mark Metro-web "unsupported, tracked" in `docs/platforms.md`; keep the forensics. Fixing Metro is NOT on the critical path |
| D4 | Tombstone retention | 30 days default, configurable via server option `tombstoneRetention` |
| D5 | Version to publish | `0.1.0` (0.x semver = breaking allowed; honest about maturity) |
| D6 | Multi-tab for launch | Documented caveat (server idempotency dedupes; FIFO-across-tabs not guaranteed). Arc B coordinator is P6-optional (T28), not launch-blocking |

## The ledger — X = 28 → 0

### P1 — Truth pass + npm `0.1.0` (~1 day)

| # | Task | Done when |
|---|---|---|
| T1 | README rewrite: one standard, three entry paths (local-only `@nizhal/local` / greenfield `openNizhalStore` / brownfield `NizhalSyncTarget`), quickstarts that compile against current exports, status section honest about maturity | every symbol in README exists in `packages/*/src` exports; repo-map links resolve |
| T2 | `docs/api.md` + `docs/when-to-use-nizhal.md` audit: purge legacy symbols (`nizhalCollectionOptions`, `createNizhalMutators`, `openNizhalCollectionsStore`, credit-ledger refs) | `grep -rn "nizhalCollectionOptions\|createNizhalMutators\|openNizhalCollectionsStore\|credit-ledger" docs README.md` → 0 hits |
| T3 | LICENSE (D1) + `license` field in kernel/local/db-collection/server/cli package.json | `npm pkg get license` non-empty in each |
| T4 | Execute D2: fold `@nizhal/react-native` (port the two useful exports, delete package, remove from workspace + turbo) | `grep -rn "@tanstack" packages/` → 0 hits outside lockfile; gates green |
| T5 | Fix root scripts: `test` (drop the `emulation` chaos filter until P3 restores it), drop `example:byo`; root `pnpm test` green | root `pnpm test` exit 0 |
| T6 | Per-package README stubs (what it is, install, 10-line example, link to docs/) for the 5 published packages | files exist; `files`/npm pack includes them |
| T7 | Replace stale changeset with one describing the drizzle-native engine; create npm org `nizhal`; `changeset version` → `pnpm release` → `0.1.0` live | `npm view @nizhal/kernel version` → `0.1.0`; install-from-npm smoke test in a scratch dir passes |

### P2 — Resync protocol + tombstone GC (keystone, ~3–4 days)

`cursorReset` + client re-bootstrap + outbox replay ALREADY EXIST — these tasks add the two
missing *triggers* and the GC they unlock.

| # | Task | Done when |
|---|---|---|
| T8 | Server epoch: uuid written to `_nizhal_sync_control` at provision (and on `nizhal reset`); returned in every pull response; client persists it in `nizhal_meta`, on mismatch discards cursor and treats pull as `cursorReset` (adopting the new epoch). Covers Postgres restore-from-backup (xid8 regression) | e2e: provision → sync → simulate restore (rewrite epoch) → client detects, resets, converges; unpushed outbox write survives via replay |
| T9 | GC horizon: `_nizhal_sync_control` gains `tombstone_horizon` (xid8). `getChanges` with `cursor < horizon` → respond `cursorReset` (reuse the existing emit path at `storage.ts:618`) | unit + e2e: client with pre-horizon cursor gets a clean full re-hydration, deleted rows do NOT resurrect |
| T10 | Tombstone GC as a `ctx.jobs` task (`jobs.ts` registry): delete `_nizhal_tombstones` older than `tombstoneRetention` (D4), advance `tombstone_horizon` in the SAME tx | job test: tombstones pruned, horizon advanced atomically; a client straddling the horizon exercises T9 |
| T11 | The fleet-return e2e: client offline "3 months" (tombstones GC'd under it) → returns → reset → converges; PLUS assert the T6-era claim that pending outbox mutations replay after reset (make the implicit explicit) | new scenarios green in db-collection suite |

### P3 — Chaos rig on the new plane (~1 week)

| # | Task | Done when |
|---|---|---|
| T12 | Fault-injection harness: wrapper around the client transport/`NizhalSyncTarget` (drop, duplicate, reorder, delay, 5xx/timeout mid-push) + crash-during-flush via store close/re-open between outbox enqueue and push ack | harness lands in `packages/db-collection/test/chaos/`; runs headless in Node against the pglite server |
| T13 | Scenario suite: partition mid-push → reconnect (no dup, no loss); duplicate delivery (idempotency); crash between pull-apply and cursor write (must be impossible — one tx — assert); offline-past-GC-horizon → T9 reset path; seeded-random soak (bounded iterations) | all scenarios green, deterministic via seed |
| T14 | Wire into CI + restore root `pnpm test` chaos leg (undo the T5 stopgap) | CI job green; root `pnpm test` includes chaos |

### P4 — Schema evolution for an un-updatable fleet (~1 week)

| # | Task | Done when |
|---|---|---|
| T15 | Contract/protocol version: server declares `contractVersion` + `minSupportedVersion`; push from an older client → structured `426 upgrade_required`; client surfaces it as a typed status (app decides UX) | e2e: old-version client blocked with typed error, current client unaffected |
| T16 | `nizhal migrate` additive-only guard: fail on rename/retype/drop/NOT-NULL-without-default of a synced column unless `--allow-breaking` (which also bumps `minSupportedVersion`) | CLI test matrix: additive passes, each breaking shape fails with actionable message |
| T17 | On-device derived-schema migration: store derived-DDL fingerprint in `nizhal_meta`; on app update, diff → apply additive `ALTER TABLE`s; non-additive diff → wipe-and-rehydrate via the T8/T9 reset path (outbox preserved) | test: add-column upgrade migrates in place; breaking upgrade resets cleanly |
| T18 | `docs/schema-evolution.md`: the playbook (what's additive, how to ship a breaking change in two releases, minSupportedVersion policy) | doc exists, linked from README |

### P5 — Load + reconnect storms (~3–4 days)

| # | Task | Done when |
|---|---|---|
| T19 | Load harness (script, not a package): N simulated clients over the pos schema against one server on a THROWAWAY local Postgres; measure p99 pull/push latency vs `_nizhal_changes` size, postgres.js pool behavior, WS memory. Start N=1k, target 5k | `research/load-test-report.md` with real numbers + observed limits |
| T20 | Reconnect storm: verify client transport reconnect has jittered backoff and pokes coalesce into one scheduled pull (fix if not — expected ~20 lines) | kill server under 1k connected clients → restart → no thundering-herd pull spike (measured) |
| T21 | Soak: multi-hour run under sustained writes; watch sidecar growth, vacuum interplay, snapshot-xmin horizon, GC job cadence | soak findings appended to the report; any pathology → new task |

### P6 — Fleet polish (~1 week)

| # | Task | Done when |
|---|---|---|
| T22 | Android live pass: tabkeep on Android emulator (op-sqlite + the v17 shim) via Argent — boot, write, converge with a second device | live-verified; platforms.md matrix row flips to proven |
| T23 | Execute D3: platforms.md marks Metro-web unsupported/tracked; Vite/Next/Start blessed; tabkeep-expo web notes the state | docs merged; no ambiguous platform rows |
| T24 | Dead-letter surface: `store.status` exposes dead-letter count + last error; `onError` hook replaces bare `console.error`; `retryDeadLetter` documented | e2e: poisoned mutation → status reflects it → retry drains it |
| T25 | TTL bucket eviction port to the drizzle plane (the long-standing follow-up) | eviction e2e green (rows past TTL removed locally, not tombstoned server-side) |
| T26 | Observability: wire `observer.ts` (pull/push counts+latency, WS connections, per-rule row counts) to a pluggable sink; client sync-health snapshot (last-sync ts, outbox depth, dead-letter count) | metrics visible in the load harness run; snapshot API documented |
| T27 | Security: adversarial sync-rule tests (client CANNOT pull outside its scope or push mutations touching others' rows — try forged ids/params); payload size caps + basic rate limit on push/pull | adversarial suite green; caps configurable |
| T28 | (Optional per D6) Arc B leader-elected shared outbox for web multi-tab, per `rfc-multitab-clientgroup.md` — else ship the documented caveat | either coordinator e2e green, or caveat in docs/platforms.md |

### P7 — Pilot + staged rollout (calendar time, operational)

- Dogfood pos or tabkeep as a real app for 2 weeks; triage from telemetry (T26), not hunches.
- Staged rollout 1% → 10% → 100% with the sync-health snapshot as the canary metric.
- Runbook: deploy (migrate → server → clients), backup/restore drill that PROVES T8 (restore a
  throwaway, watch the fleet reset), on-call notes for dead-letter spikes.

## Gates (every phase ends green)

`pnpm check-types` · `pnpm lint` · `pnpm --filter @nizhal/db-collection test` ·
`pnpm --filter @nizhal/server test` · `pnpm --filter @nizhal/local test` ·
`pnpm --filter @nizhal/kernel test` · root `pnpm test` (from T5 on) · after T7: install-from-npm
smoke test. Real-PG tests: `NIZHAL_TEST_DATABASE_URL=<session-created throwaway>` only.

## Sizing

P1 ~1d · P2 ~3–4d · P3 ~1w · P4 ~1w · P5 ~3–4d · P6 ~1w → **4–6 engineering weeks + pilot
calendar time.** P1 and P2 first, strictly in order; P3–P5 can interleave; P6 fans out.

## Security constraints (persist verbatim, every session)

- Never connect to or mutate any DB except a **session-created throwaway** (local Postgres.app DB
  or a fresh Neon branch). Prod/live/main-named DBs are off-limits (e.g. `ordereka-live-app-prod`).
- Do **not** delete the Neon DBs backing live deployments without repointing.
- No `git add -A` (name files); never push secrets. `NIZHAL_TEST_DATABASE_URL` for real-PG tests.
