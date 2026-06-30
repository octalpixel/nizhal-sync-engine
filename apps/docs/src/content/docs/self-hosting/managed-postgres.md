---
title: Managed Postgres
description: Neon, RDS, and Supabase without logical replication.
---

Nizhal's provisioning uses ordinary DDL + triggers — no `wal_level = logical`, no replication slot, no superuser grants for logical decoding.

`nizhal migrate` layers the sync engine (row-version triggers, `_nizhal_*` tables) onto your
**existing** business tables — it does not create them. Create your business schema first (your
ORM/SQL migrations, or the app's own DDL), then run migrate; against an empty database it stops with
a message telling you to create your tables first. A `.ts` config (`nizhal.config.ts`) loads directly
— no separate build step.

## Neon

```bash
# 1. create your business tables (your migrations), then:
DATABASE_URL="postgresql://..." nizhal migrate --config nizhal.config.ts
pnpm --filter credit-ledger example:neon
```

`apps/credit-ledger/examples/neon-smoke.ts` runs against `NEON_URL`. Chaos suite accepts `NEON_URL` for managed-Postgres verification (`pnpm chaos`).

## RDS / Supabase / other managed PG

Requirements:

- CREATE TABLE / CREATE TRIGGER permissions on your schema
- Standard Postgres — not Aurora logical replication features

If you can run migrations, you can run Nizhal.

## Why this matters

WAL-tailing sync engines (Electric, Zero, etc.) often cannot run on managed tiers you do not control. Nizhal trades their hosted convenience for **cursor pull on any Postgres you already have**.
