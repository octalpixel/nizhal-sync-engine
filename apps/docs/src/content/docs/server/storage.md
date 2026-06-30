---
title: Storage
description: postgresStorage, StorageAdapter, and no-WAL provisioning.
---

```ts
import { postgresStorage, buildPostgresProvisionPlan } from "@nizhal/server/adapters";

const storage = postgresStorage({ connectionString: process.env.DATABASE_URL! });
await storage.provision({ schema, syncRules });
```

## StorageAdapter interface

- `getChanges` — cursor pull with bucket scope, tombstones, `removedBuckets`
- `transaction` — atomic mutator execution
- `authorizeMutatorTx` — fail-closed write scoping from the actor's sync-rule membership inside that transaction
- `claimMutation` / `recordApplied` — idempotent push + client-id reconciliation
- `provision` — DDL from schema + sync rules

`buildPostgresProvisionPlan` returns raw SQL statements for inspection or CI diffing.

## What provision creates

- `updated_at` / `deleted_at` plus `_nizhal_row_version` on synced tables
- `_nizhal_sync_control` loop-gate + per-table change log
- `_nizhal_mutations` — idempotency + client→server ID map
- `_nizhal_tombstones` — delete propagation
- `_nizhal_client_buckets` — scope tracking
- Bucket + row-version indexes for cursor scans

**No logical replication.** Runs on managed Postgres (Neon, RDS, Supabase) without superuser WAL settings.

## CLI

```bash
nizhal migrate --config nizhal.config.js
```

See [CLI reference](/reference/cli/).

## Custom adapters

`StorageAdapter` is the seam for alternate backends (D1/SQLite backlog). Phase 0 ships Postgres only; the interface exists so a second backend is a new adapter, not a rewrite.
