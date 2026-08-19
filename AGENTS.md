# AGENTS.md — rules for any agent/worker in this repo

You are implementing **Nizhal** — a self-host, no-WAL offline-sync engine. Work **only inside this `echo/` repo**.

## The binding contract
- **`rfcs/RFC-001-nizhal.md`** is the implementation contract. Read it fully. Section 8 is the WBS (chunk IDs C1–C16); Section 9 is the validation contract (assertion IDs); Section 4 is the interface spec.
- `research/` holds the locked decisions (read for rationale). `blueprints/` are reference apps. `rfcs/sprints/` is the build plan. **Read these; do not modify them** unless a task explicitly says so.

## Non-negotiable design invariants (from the RFC/research)
1. **Client substrate = TanStack DB** (op-sqlite/wa-sqlite + db-ivm + offline-transactions). Do not build a client store/reactivity/outbox.
2. **Nizhal = `@nizhal/server` + `@nizhal/db-collection` adapter + `@nizhal/cli` + `@nizhal/kernel`.** Server runs on any Postgres, **no logical replication**.
3. **Contract decoupled:** server emits `GET /nizhal/contract` (OpenAPI/JSON-Schema); client types come from `nizhal gen`. **No server-source/Drizzle import on the client.**
4. **Sync rules:** declarative, server-evaluated, typed, no-leak-linted. Not middleware.
5. **Writes:** one business op = one mutator = **one server transaction**; idempotent replay via `clientMutationId`; client-id→server-id reconciliation.
6. **Domain modeling:** append-only **movement ledgers**; balances are **folds** (no stored mutable balances). Multi-table ops are atomic single-mutator cascades.
7. **Realtime:** default **in-process** pub/sub, sourced from the commit chokepoint, DB-agnostic. `LISTEN/NOTIFY`/Redis/Cloudflare(PartyKit+PartySocket) are swappable adapters. Ping is a hint; cursor pull is authoritative.
8. **Phase 0 musts:** poison-mutation dead-letter + cascade-cancel (REQ-13); access-revocation eviction (REQ-14).

## Toolchain
pnpm workspaces + turbo + tsc (build/typecheck) + vitest (test) + biome (lint/format). Before declaring any task done:
```
pnpm install && pnpm build && pnpm check-types && pnpm test && pnpm lint
```
All must be green. No `--no-verify`, no `@ts-ignore`, no placeholders/TODOs in delivered code. Ship the permanent fix, root-caused.

## Packages
- `packages/kernel` (`@nizhal/kernel`) — schema/mutator/sync-rules/contract contracts.
- `packages/db-collection` (`@nizhal/db-collection`) — the TanStack DB `SyncConfig` adapter + offline mutationFn glue + client transport (PartySocket).
- `packages/server` (`@nizhal/server`) — Hono endpoints (`/sync/pull`, `/sync/push`, `/sync/stream`, `/nizhal/contract`) + StorageAdapter/RealtimeAdapter (postgres + in-process defaults) + job worker + auth hook.
- `packages/cli` (`@nizhal/cli`) — `migrate`, `introspect`, `gen`.
- `apps/credit-ledger` — the Phase-0 reference app (validates the fitness functions).

<!-- plandesk:start -->
@.plandesk/skill.md
<!-- plandesk:end -->

<!-- plandesk-factory:start -->
## Plan Desk Factory — default operating mode

This repository runs on the Factory workflow. On any work request:
1. **Follow the factory cycle** — the always-on [factory.md](.agents/factory/factory.md) contract governs each work item: pull → read → red gate → delegate → prove → observe → gate → ship. Bracket the session with `start_agent_run` / `complete_agent_run`; call `record_agent_progress` every cycle.
2. **Delegate implementation by default — when a worker is available.** The supervisor orchestrates; IC workers execute. Probe the dispatchers in [.agents/factory/workers/](.agents/factory/workers/) per [protocol.md](.agents/factory/protocol.md) and hand each work item to a probed worker. **If no worker is installed on this machine, do the work yourself under the same contract** — never skip the cycle just because you are the one typing, and never assume a delegation skill or worker CLI exists that this repo did not ship. Write inline without dispatch only for trivial edits, integration/conflict resolution, and review fixes under ~5 lines.
3. **Execute without pausing** — decompose the goal into verifiable moves on a harness task list (`TaskCreate` / `TaskList` / `TaskUpdate`), drive them to zero, and ship finished work without pausing for permission. The IC spine is [execution.md](.agents/factory/execution.md).
4. **Prove before done** — re-run the claimed checks per [protocol.md](.agents/factory/protocol.md); exit codes are authoritative.

New to this repo? Run `plandesk onboard` for the full Plan Desk + Factory model and the operating loop.

@.agents/factory/factory.md
<!-- plandesk-factory:end -->
