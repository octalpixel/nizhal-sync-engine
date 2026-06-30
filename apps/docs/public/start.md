# Set up Nizhal for this project

You are a coding agent (Claude Code, Codex, or similar) running inside a user's
project folder. Your job: set up **Nizhal** — a self-host, offline-first sync engine —
for _this_ project, so the user gets a working sync stack (server on their Postgres +
an offline-first TanStack DB client) shaped to what they're actually building.

Nizhal is **a sync API embedded in your own backend**, not a separate service:
`@nizhal/server` (cursor-pull + idempotent-push + tombstones on any Postgres, no WAL /
no logical replication) + `@nizhal/db-collection` (a TanStack DB SyncConfig adapter +
durable outbox). Docs: https://nizhal-docs.pages.dev

**Read all of this before running anything.**

## Phase 1 — Scope it (ask the user, one question at a time)

Do NOT scaffold yet. First ask these **five** questions to scope the setup. Ask one at
a time, give your recommended default in brackets, and accept "use defaults" to take all
recommendations. Keep it light — this is scoping, not a design review.

1. **What are you building?** What's the core data that needs to sync — e.g. notes, a
   POS/inventory, chat, a CRM? (Drives the schema, mutators, and sync rules.)
2. **Platforms?** Web, React Native/Expo, or both? *[both]* — web uses wa-sqlite, RN uses
   op-sqlite via `@nizhal/react-native`.
3. **Postgres?** Which database should this use? Bring your own connection string — Nizhal runs
   on **any** Postgres with no special config (Supabase, Neon, RDS/Cloud SQL, self-hosted, …), or
   spin up local Docker Postgres for dev. *[ask the user for their connection string; offer local
   Docker for a quick start — do not assume a provider]*
4. **Conflict model?** Last-writer-wins (commit-order, the mutator body is the merge),
   per-field merge (HLC), or CRDT (Yjs) for collaborative text? *[LWW]* — most apps want LWW;
   movement/ledger data should be append-only (balance = fold), which needs no conflict policy.
5. **Realtime?** In-process (single server), Postgres LISTEN/NOTIFY (multi-instance), or
   Cloudflare Workers + Durable Objects? *[in-process]* — remember: the realtime ping is only a
   hint; the cursor pull is authoritative, so a missed ping self-heals.

Echo the chosen scope back in one line, then proceed.

## Rules (do not violate)

- **Stay in this folder.** Operate only within the current working directory.
- **Never invent or hardcode secrets.** Put the Postgres URL and JWT secret in `.env`
  (gitignored); never commit them.
- **Ground everything in the real API** — read the quickstart + reference below; do not
  invent exports. Verify symbols against the installed `@nizhal/*` packages.
- Requires **Node ≥ 20** (Bun also works).

## Phase 2 — Scaffold

1. **Read the conventions** so your code matches the framework:
   ```bash
   curl -fsSL https://nizhal-docs.pages.dev/getting-started/quickstart.md | cat
   curl -fsSL https://nizhal-docs.pages.dev/reference/api.md | cat
   curl -fsSL https://nizhal-docs.pages.dev/llms.txt | cat   # whole-docs digest
   ```
2. **Install only what each side needs** (Nizhal bundles postgres, @tanstack/db, and
   @tanstack/offline-transactions — don't install those separately):
   ```bash
   # shared + server (the Postgres driver + Hono are bundled in @nizhal/server)
   npm i @nizhal/kernel @nizhal/server drizzle-orm
   npm i -D @nizhal/cli
   # client + a SQLite driver peer for offline persistence
   npm i @nizhal/db-collection @journeyapps/wa-sqlite              # web
   # React Native instead: npm i @nizhal/react-native @op-engineering/op-sqlite @react-native-community/netinfo
   ```
3. **Model the domain** from the user's answer to Q1 — a Drizzle schema, then
   `defineMutators` (one mutator = one transaction = one aggregate; prefer append-only
   movement ledgers, balance = fold) and `defineSyncRules` (`b.membership({table, where,
   select})` to scope buckets to the actor — the no-leak lint requires every `data` query
   be bucket-scoped).
4. **Provision Postgres** with the chosen storage + realtime:
   ```bash
   npx nizhal migrate   # provisions change-tracking columns, tombstones, _nizhal_mutations — no WAL
   ```
   `postgresStorage({ connectionString })` + `inProcessRealtime()` (or `listenNotifyRealtime` /
   `cloudflareRealtime` per Q5).
5. **Server**: `createNizhalServer({ schema, mutators, syncRules, auth: bearerTokenAuth({ secret }) }).listen(port)`.
6. **Client**: `createNizhalClient({ server, auth, bucketsForSyncRule })` + `nizhalCollectionOptions`
   wired into a TanStack DB collection + `createNizhalMutators` for optimistic writes + outbox.
   Add `waSqlitePersistence` (web) / `opSqlitePersistence` (RN) for offline durability.
7. **Verify** with a smoke: two clients, push on A, pull on B, assert convergence
   (`balance = fold`) + idempotent replay. (Mirror `apps/credit-ledger/examples/live-e2e.ts`.)

When done, summarize what you scaffolded + how to run it, and point the user at
https://nizhal-docs.pages.dev for the concept docs.
