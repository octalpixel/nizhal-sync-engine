---
title: Audit log
description: Enable and query Nizhal's append-only mutation audit log.
---

The audit log is **on by default**: `nizhal migrate` creates `_nizhal_audit_log` and
`createNizhalServer` appends one immutable row per applied mutation. To **opt out** — e.g. a
cost-sensitive or very high-write app that doesn't want an unbounded log — set `audit: false` in the
same server configuration used by both:

```ts
export default {
  db: process.env.DATABASE_URL!,
  schema,
  syncRules,
  mutators,
  auth,
  // audit: false,   // opt out: skips the table and all audit writes (zero overhead)
};
```

With the default, migration creates `_nizhal_audit_log` and every applied mutation appends a row in
the same transaction (rollback drops both). Set `audit: false` and Nizhal creates no table and
executes no audit write. A storage adapter that doesn't support audit degrades gracefully — no error,
no write.

## What is stored

Each successfully applied mutation appends one row in the mutation's database transaction. A
rollback therefore removes both the business changes and the audit append. The row contains the
shared, totally ordered `rowVersion`, client mutation ID, mutator name, parsed arguments, actor,
client ID, mutation ID, HLC, affected buckets, and creation time. Duplicate mutation replay does not
append another row.

Nizhal exposes no audit update or delete operation. Postgres audit rows use the same
`_nizhal_next_row_version()` allocator as sync cursors. The exported `libsqlAuditStorage` primitive
uses `_nizhal_row_versions` for the equivalent shared allocation inside a libSQL write transaction;
consumer-supplied libSQL `StorageAdapter` implementations can use that primitive at their commit
chokepoint.

## Query from the server

```ts
const entries = await storage.getAuditLog?.({
  actor: { userId: "user-123" },
  buckets: ["shop-456"],
  sinceVersion: "1000", // exclusive
  untilVersion: "2000", // inclusive
  limit: 100,
});
```

Results are ordered by `rowVersion` ascending. The default limit is 100 and the maximum is 1,000.
Actor filters match the supplied actor fields; bucket filters match any supplied bucket.

`GET /nizhal/audit` exposes the same query to server administrators. Authenticate with the bearer
token configured by `NIZHAL_ADMIN_PASSWORD`, as for `/nizhal/stats`:

```text
GET /nizhal/audit?bucket=shop-456&sinceVersion=1000&limit=100
Authorization: Bearer <NIZHAL_ADMIN_PASSWORD>
```

The endpoint is disabled when audit is off and is not a client sync endpoint.

## Deliberate v1 non-goals

Audit argument redaction and retention/pruning are not configurable in v1. Enabling audit stores the
full parsed mutation envelope, so do not put secrets in mutation arguments. Full event sourcing,
time-travel reconstruction, branching, and client-facing audit queries are also out of scope.
