# Chaos rig (P3)

Fault-injection tests for the drizzle-native sync client against the real server on PGlite. The
invariant under test across every scenario: under dropped / duplicated / delayed / 5xx transport, the
fleet still converges with **no duplicate and no loss** — the engine's idempotent replay, contiguous-
sequence resync, and one-transaction pull-apply hold.

## Run

```bash
pnpm chaos                                    # just the chaos suite (from repo root)
pnpm --filter @nizhal/db-collection test      # chaos runs as part of the full suite (and in CI)
```

The chaos suite is part of `pnpm test`, so CI covers it — there is no separate chaos package to run.

## Pieces

- `chaos-target.ts` — `chaosSyncTarget(base, config)` wraps any `NizhalSyncTarget` and, driven by a
  **seeded** PRNG (`makeRng(seed)`), injects: push/pull drops (retriable), duplicate delivery, random
  latency, and 5xx "lost ack after apply" (delivered to the server, then throws — the retry must
  dedupe). All faults are transient/retriable; the test is whether the engine converges anyway.
- `chaos.test.ts` — scenarios: lost-ack push storm, duplicate delivery, interrupted-pull atomicity,
  crash-during-flush (store close/re-open), and a seeded two-client soak.

## Reproducing a failure

Every run is deterministic in its seed. A soak failure prints the assertion; re-run the same file to
replay it exactly (the seeds are literals in the test). To explore, change the `makeRng(<seed>)`
literals or the fault rates in the scenario and re-run `pnpm chaos`.
