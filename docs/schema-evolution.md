# Schema evolution for an un-updatable fleet

At 50k users you cannot force-update the app. Old clients run old schemas for weeks or months, so
changing a synced table is a distributed-systems problem, not a migration script. Nizhal gives you
three coordinated guardrails so a schema change either stays safe for old clients or blocks them
cleanly instead of corrupting their data.

## What's additive (safe) vs breaking

An **additive** change is one an old client can ignore and a new client can adopt without a reset:

- a **new nullable column**,
- a **new column with a default**,
- a **new table**.

A **breaking** change is one an old client cannot survive — the row it decodes no longer matches what
it expects:

- **dropping** a synced column,
- **renaming** one (= drop + add),
- **retyping** one (`text` → `integer`, …),
- adding a **NOT NULL column without a default** (old clients write rows without it and fail).

## The three guardrails

1. **Server version gate** (`minClientVersion`) — the server publishes a `contractVersion` and refuses
   writes from a client whose `contractVersion` is older than `minClientVersion`, returning a typed
   `426 { code: "upgrade_required" }`. The client surfaces it (the durable outbox is preserved and
   flushes once the app updates). Set `createNizhalClient({ contractVersion })` on the client and
   `createNizhalServer({ contractVersion, minClientVersion })` on the server.

2. **`nizhal migrate` additive-only guard** — `migrate` snapshots the synced-column shape and, on the
   next run, blocks a breaking change with an actionable per-column message unless you pass
   `--allow-breaking`. This stops you shipping a breaking DDL change by accident.

3. **On-device auto-migration** — when the app opens with a changed derived schema, the client
   migrates additive columns in place (`ALTER TABLE ADD COLUMN`) and, on a breaking change, drops +
   recreates the local tables and re-hydrates from the server (pending outbox writes are replayed, so
   nothing is lost). This is automatic — no app code required.

## How to ship a breaking change (the two-release rule)

Never drop/rename/retype a synced column in a single release. Split it:

**Release 1 — additive.** Add the new shape alongside the old one (a new column), and have your
mutators dual-write both. `nizhal migrate` passes (purely additive). Old clients keep working against
the old column; new clients populate both.

**Release 2 — remove, gated.** Once enough of the fleet is on Release 1 (watch the telemetry), bump the
server's `minClientVersion` to the Release-1 version, then run `nizhal migrate --allow-breaking` to drop
the old column. From here:

- clients on Release 0 (the old shape) are blocked with `upgrade_required` — they cannot corrupt data,
- clients on Release 1+ migrate on device (additive for R1, a clean reset for R2) and converge.

This turns "an old client silently writes the wrong shape" into "an old client is told to update."

## `minClientVersion` policy

- Default `0.0.0` — accept every client, including pre-versioning ones.
- Bump it **only in the release that removes an old shape**, and set it to the *oldest release that is
  safe against the new schema* (usually the previous release). Bumping it too aggressively locks out
  users who simply haven't opened the app yet; too timidly and a stale client can still write the old
  shape.
- `--allow-breaking` reminds you to bump it — the two are meant to move together.

## Reference

- Version gate: `packages/db-collection/test/version-gate.test.ts`
- Migrate guard: `packages/kernel/src/schema-evolution.ts`, `packages/cli/test/schema-guard.test.ts`
- On-device migration: `packages/db-collection/test/schema-migrate.test.ts`
- API: [`docs/api.md`](./api.md)
