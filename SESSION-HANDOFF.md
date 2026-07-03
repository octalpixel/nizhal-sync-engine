# Session handoff — Nizhal (echo) sync engine

**Branch:** `fix/sync-engine-data-loss` → pushed to `origin/fix/sync-engine-data-loss` **and**
`nizhal-engine/main`. Tree clean; HEAD = `ac6ddf4`.
**Repo:** `/Users/mithushancj/Documents/personal/echo` (pnpm + turbo monorepo).

## ⭐ START HERE (2026-07-03)

The production-readiness RFC (`rfcs/rfc-production-readiness.md`) is **substantially executed**, and
this session added a **hostability** layer on top. Everything below is committed + pushed to both
remotes. What remains is **three user-gated items** (publish, live Vercel, Argent) — not more building.

**Do not re-derive** the sync architecture — it's captured in `docs/deploy.md` (the three-plane model
+ hosting), `docs/api.md`, and the RFCs. Read those, not the code, to get oriented.

### Done in the production-readiness RFC (see the harness task list #1–#29, and git log)
- **P1** (T1–T6): README/docs truth pass, LICENSE (MIT), folded `@nizhal/react-native`, root `pnpm
  test` fixed, per-package READMEs. **T7 (publish 0.1.0) is the one P1 task still open — PAUSED.**
- **P2** (T8–T11): server epoch + GC-horizon resync triggers + tombstone GC job + fleet-return e2e.
- **P3** (T12–T14): fault-injection chaos harness + deterministic scenarios + CI wiring.
- **P4** (T15–T18): contract version + `426 upgrade_required`, additive-only migrate guard, on-device
  derived-schema migration, `docs/schema-evolution.md`. Plus a T-extra actor-identity guard.

### Done this session — hostability (H1–H6), the server is now platform-agnostic
Commits `cc72275`, `dba314e`, `43132bf`, `326c6e7`. Summary:
- **Real production bug found + fixed** (`cc72275`): `listenNotifyRealtime`'s `pg_notify` triggers were
  never installed → realtime was **silently dead** on any real deploy. Now auto-installed by
  `listen()` / `provisionRealtime()`. Verified on **real Neon**, cross-instance `delivered=TRUE`.
- **Platform-agnostic entrypoint** (`dba314e`, H1/H5/H6): `NizhalServer` now exposes `webSocket`
  (injectable WS factory, `config.createWebSocket`), `injectWebSocket`, `provisionRealtime`,
  `runJobsOnce`. HTTP already ran anywhere via `app.fetch`; realtime is now portable too.
- **`playground/deploy`** — one `domain.mjs`, four entrypoints (Node container / Bun / Vercel
  serverless `api/server.mjs`+`api/drain.mjs` / Dockerfile) + host-agnostic `smoke.mjs`.
- **`docs/deploy.md`** (H4): container/serverless/edge matrix, realtime + auth per class, the
  "every host needs one Postgres" (transactional outbox) rationale, and a webhook-write recipe.

### Two post-1.0 RFCs authored this session (PROPOSED, non-blocking backlog)
- `rfcs/rfc-redis-streams-realtime.md` — a 4th `RealtimeAdapter` for teams behind a transaction-mode
  pooler (where `listenNotify`'s `LISTEN` can't survive) or already running Redis.
- `rfcs/rfc-framework-free-core.md` — extract `@nizhal/server/core` (Web-standard `Request→Response`
  handlers); `createNizhalServer` becomes a thin Hono binding. No protocol/client change.

## The three user-gated items (this is the actual "what's next")
1. **T7 — publish `0.1.0` to npm.** PAUSED pending explicit confirm (standing instruction). The npm
   scope `@nizhal` was UNCLAIMED on 2026-07-03 (`npm view @nizhal/kernel` → 404) — **create the org
   first**, then publish `0.1.0` directly (not `changeset version`). Task #7.
2. **H3 — live Vercel deploy.** The serverless entrypoint is code-complete and proven **locally** (ran
   the exact `export default serve() + injectWebSocket` entry against throwaway Postgres → smoke 5/5).
   A *live* deploy needs throwaway **Neon + Vercel** projects created (gated by the "confirm before
   cloud create" rule) and the Vercel **WebSocket public-beta** permission. Task #26 (in_progress).
3. **Argent 0.14.0** update available — apply only with explicit consent. Task #23.

## Non-obvious facts to not rediscover
- **`listenNotifyRealtime` needs a DIRECT / session-mode Postgres URL.** A transaction pooler
  (PgBouncer `transaction`, Neon/Supabase pooled) silently drops the persistent `LISTEN`. HTTP
  push/pull are fine through a pooler; only realtime needs the direct connection.
- **The Vercel entrypoint is verified LOCALLY only.** `@hono/node-server`'s `serve()` self-listens, so
  `playground/deploy/api/server.mjs` was run as-is on `:3000` and smoked 5/5 — but the Vercel platform
  wrapper + WS beta are unverified until H3's live deploy.
- **`inProcessRealtime` is dev-only** and warns under `NODE_ENV=production` — it's a single-process
  antipattern (a socket on instance A never hears a write on instance B).
- **Three planes** (in `docs/deploy.md`): data (`/sync/push`+`/sync/pull`, transactional, authoritative)
  · realtime (the `repull:<bucket>` poke, ephemeral hint, best-effort) · jobs (`_nizhal_jobs`, the
  server's transactional outbox — enqueue is atomic-in-tx; drained by the job worker's poll loop on
  `listen()` or by `runJobsOnce()` from cron on serverless). Tombstone GC is the one built-in,
  self-perpetuating job on that plane.

## Verification state (last observed this session)
- `pnpm lint` clean (179 files) · `check-types` green (server + kernel) · `@nizhal/server` suite
  **82 passed / 4 skipped**; `test/entrypoint.test.ts` locks the new platform-agnostic API surface.
- Deploy proofs: Node container smoke **5/5**, Bun **5/5**, Vercel-entry-local **5/5**, drain handler
  3-way (no-secret / 403 / correct-secret); real-Neon cross-instance `listenNotify` delivered.
- Real-PG tests are gated on `NIZHAL_TEST_DATABASE_URL` (skip without it), wired into CI's
  real-postgres job.

## Deeper post-1.0 backlog (unchanged from before, still open)
- **Multi-tab (Arc B)** was decided a *documented caveat* (D6), off the mobile-release critical path.
  If revisited: `rfcs/rfc-multitab-clientgroup.md` + the honest caveats there (the coordinator
  duplicates ~200 lines of `createNizhalMutators`; `nextOrdinal()` is a non-atomic RMW; the browser
  test used localStorage, not the riskier wa-sqlite/OPFS-shared-across-tabs path).
- The two RFCs above (redis-streams realtime, framework-free core).

## Security constraints (MUST persist across sessions)
- Never connect to or mutate any DB except a **session-created throwaway** (local Postgres.app DB or a
  fresh Neon branch). Prod/live/main-named DBs are off-limits (e.g. `ordereka-live-app-prod`).
- Do **not** delete Neon DBs backing live deployments; **confirm before any cloud create/delete**
  (Neon projects, Vercel projects). Don't touch the live `nizhal-chat` (Neon `square-hill-26087642`).
- No `git add -A` (name files); never push secrets. `NIZHAL_TEST_DATABASE_URL` for real-PG tests.
- Push every commit to **both** remotes (`origin/fix/sync-engine-data-loss` + `nizhal-engine HEAD:main`).

## How to run things
- Gates: `pnpm lint` · `pnpm --filter @nizhal/server check-types` · `pnpm --filter @nizhal/server test`.
- Deploy smoke (container class): from `playground/deploy`,
  `DATABASE_URL=postgres://…direct… JWT_SECRET=… pnpm --filter nizhal-deploy start`, then
  `SERVER_URL=http://127.0.0.1:4700 node playground/deploy/smoke.mjs` → 5/5.
- Bun: `pnpm --filter nizhal-deploy start:bun` (port 4720). Vercel-entry local: `node
  playground/deploy/api/server.mjs` (self-listens :3000) then point the smoke at it.

## Suggested skills for the next session
- **`/autonomous-stand`** — to drive T7 (publish) or H3 (live Vercel) to done once unblocked.
- **`/ship-it`** — the verification bar (no workarounds, prove "done") for the publish + live deploy.
- **`/mobile-device-testing`** — Argent drives Chromium (CDP) + iOS/Android; used for the live browser
  QA of the sync engine and any Vercel-hosted verification.
