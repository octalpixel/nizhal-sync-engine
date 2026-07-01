# Tabkeep Expo

The Tabkeep credit ledger as an **Expo / React Native** app — the same offline-first sync engine
([@nizhal/db-collection](../../packages/db-collection)) and the same domain (customers + append-only
ledger + per-shop sync rule) as the web flagship, with a React Native UI that runs on **web, iOS, and
Android** from one codebase.

The point: Nizhal's client is platform-agnostic. `createNizhalClient` has no DOM dependency, and
persistence is the only platform seam — `op-sqlite` on native, `wa-sqlite` or in-memory on web.

## Run (Expo web)

```bash
# 1. the Tabkeep demo API (CORS enabled for cross-origin browser clients)
pnpm --filter @nizhal/example-tabkeep dev:server

# 2. the Expo app on web
pnpm --filter tabkeep-expo web      # → http://localhost:8081
```

The app fetches a demo session, opens a Nizhal client, and syncs customers + ledger entries to the
server. Point it elsewhere with `EXPO_PUBLIC_NIZHAL_SERVER`.

Verified: bundles for web (Metro), renders the RN UI, and a customer added in the app round-trips to
the server (confirmed via `/sync/pull`).

## Run (native)

```bash
pnpm --filter tabkeep-expo ios       # or: android
```

Native uses **op-sqlite** for a durable on-device store (`src/persistence.native.ts`, selected
automatically by Metro). Same Nizhal client/outbox as web — only the local store differs.

> **Native build status (Expo SDK 56 / RN 0.86):** the app **compiles and installs** on the iOS
> simulator, but currently **crashes at launch in dyld — before any JS runs** — with
> `Symbol not found: facebook::jsi::Value::strictEquals … Expected in hermesvm.framework`. The
> prebuilt `hermes-engine` (250829098.0.14) doesn't *export* that JSI symbol that the prebuilt
> `ExpoModulesCore` binds to. This is an **environment-wide Expo-56 prebuilt-Hermes ABI skew**: the
> sibling `op-sqlite-probe` (same toolchain) crashes identically. It is **not** app or Nizhal code
> (verified: the same client + domain run on web). JSC is not an escape hatch — Expo ≥ SDK 53 removed
> it. The fix is a toolchain pass: build Hermes from source, or align to an Expo SDK / Hermes prebuilt
> where the symbol is exported. The native wiring here is correct and ready once the toolchain is fixed.

## The reference: declare once, run + deploy from the same source

Tabkeep is the reference for what building on Nizhal looks like. You write three things, once:

- **`src/domain.ts`** — the tables, the four financial verbs (mutators), and the one shop-scoped sync
  rule. Transport-free: no engine internals, no client/server wiring. This *is* the app's spec.

Everything else is derived from it:

- **`src/client.ts`** — the offline-first client. Below the `createEcho` platform seam it's one
  `openNizhalStore({ echo, schema, syncRules, mutators, actor, persistence })` call; the launch
  dance (cached-open → background refresh → first-launch retry) is one `startLocalFirstBootstrap`
  call in `App.tsx`. Collections, outbox, mutation-id/dead-letter stores, and the merge policies are
  all framework.
- **`nizhal.config.ts`** — `{ schema, syncRules }` re-exported from the domain, so the server engine
  and the client are provisioned from the same declarations and can't drift.

## Deploy the engine (`nizhal migrate`)

`nizhal migrate` provisions the sync engine (row-version columns, tombstones, audit, triggers) onto
your **existing** business tables — create those first (your ORM/SQL), then:

```bash
nizhal migrate --config nizhal.config.ts --db "$DATABASE_URL"   # fresh install or in-place upgrade
nizhal reset   --config nizhal.config.ts --db "$DATABASE_URL" --yes   # clean-slate reprovision
```

Migrate is version-aware and idempotent: a fresh DB is provisioned + stamped, an older engine is
migrated in place (e.g. the bigint→xid8 row-version upgrade, preserving row order and every client
cursor), and a current one is a no-op. The no-skip row-version guarantee is enforced in CI against a
real Postgres, so correctness travels with the repo, not just a live session.

## Notes

- `src/domain.ts` is a self-contained copy of the Tabkeep domain — the same shape the web flagship
  declares. The engine packages are the real shared dependency; the domain is small enough to keep
  per-app rather than couple the two behind a shared package.
- Web persistence here is in-memory (records sync but don't survive a reload). Durable web persistence
  via `wa-sqlite` under Metro is the next increment; native gets durability via `op-sqlite`.
- `ios/` and `android/` are not committed — they're regenerated with `expo prebuild` (CNG).
