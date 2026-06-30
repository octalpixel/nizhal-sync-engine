---
title: Validation & testing
description: Chaos suite, offline-first matrix, and convergence oracles.
---

Nizhal validates sync with adversarial emulation — not only happy-path unit tests.

## Chaos suite (`pnpm chaos`)

`apps/emulation` runs **19 scenarios** against a real `createNizhalServer` + N `createNizhalClient` instances with failure injectors:

- Network partition / delayed push
- Server restart mid-outbox
- Dropped realtime (SYNC-5 — `pull.intervalMs` converges)
- Garbage cursor (`cursorReset`)
- Poison mutation dead-letter + cascade-cancel
- Revoked membership eviction
- Concurrent POS inventory races
- Credit-ledger balance fold invariants

Default DB: PGlite. Set `NEON_URL` for managed Postgres.

**Current status:** 19/19 PASS on PGlite (see `rfcs/RFC-004-findings.md`).

## Offline-first matrix

`research/phase2/offline-first-testing-and-transports.md` defines a **30-scenario** matrix covering transports (web↔mobile), persistence drivers, and tenancy edge cases. Scenarios map to TS harness rows in `apps/emulation`.

## Oracles

- **Convergence** — `assertInvariants` diffs all clients vs server row sets (strips TanStack metadata + timestamp columns)
- **Exactly-once** — replay entire outbox twice → byte-identical server state
- **No poison wedge** — queue drains after deterministic failure

## What is verified today

| Area | Evidence |
|------|----------|
| Multi-device web | live-e2e, emulation harness |
| op-sqlite on device | `apps/op-sqlite-probe` iOS simulator |
| Managed Postgres | `NEON_URL` chaos + neon-smoke |
| CF realtime | `packages/server/examples/cf-e2e-smoke.ts` |
| RN native WS + fetch | `@nizhal/react-native` README path |

## What is not headless in Node

`op-sqlite` JSI — native only. Emulation uses wa-sqlite WASM / `node:sqlite` for the same persistence code paths; literal op-sqlite binary requires simulator/device (RFC-004 scope split).

## Run locally

```bash
pnpm install && pnpm build && pnpm test && pnpm chaos
```

Unit tests (~64+) stay in `pnpm test`; chaos is heavier and separate.
