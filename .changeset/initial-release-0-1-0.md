---
"@nizhal/kernel": minor
"@nizhal/local": minor
"@nizhal/db-collection": minor
"@nizhal/server": minor
"@nizhal/cli": minor
---

Initial public release (0.1.0) of the Nizhal offline-sync toolkit.

One standard: the drizzle-native sync client. `@nizhal/db-collection`'s `openNizhalStore` keeps a
single on-device SQLite file — derived real tables plus the `nizhal_outbox` / `nizhal_meta` /
`nizhal_dead_letter` control tables — in sync with a `@nizhal/server` over a no-WAL Postgres
(plain columns + triggers, no replication slot). Writes are optimistic + durable (one mutator =
one transaction); convergence is idempotent with tombstones and append-only folds.

Packages:
- `@nizhal/kernel` — schema helpers, `defineMutator(s)`, `defineSyncRules`, contract emission.
- `@nizhal/server` — `createNizhalServer` (Hono) + `postgresStorage` + realtime/auth/jobs adapters.
- `@nizhal/db-collection` — the sync client: `openNizhalStore`, `createNizhalClient`, custom
  `NizhalSyncTarget` for brownfield APIs, and a `@nizhal/db-collection/react-native` subpath.
- `@nizhal/local` — standalone purely-local native-Drizzle store (no server/sync): `openLocalDb`,
  cross-platform `useLiveQuery`, on-device drizzle-kit migrations.
- `@nizhal/cli` — `nizhal migrate`, provisioning the no-WAL engine onto existing Postgres tables.

`0.x` semver: breaking changes are allowed while the API stabilizes.
