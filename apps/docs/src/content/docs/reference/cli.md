---
title: CLI
description: nizhal migrate, gen, and introspect.
---

```bash
nizhal migrate   # provision no-WAL DDL from schema + sync rules
nizhal gen       # (planned) generate client types from /nizhal/contract
nizhal introspect # (planned) brownfield schema introspection
```

## migrate

```bash
nizhal migrate --config nizhal.config.js
nizhal migrate --db "$DATABASE_URL" --config ./nizhal.config.js
```

Config must export `schema` and `syncRules`:

```js
// nizhal.config.js
import { schema } from "./src/schema.js";
import { syncRules } from "./src/sync-rules.js";

export default {
  db: process.env.DATABASE_URL,
  schema,
  syncRules,
};
```

Optional `storage` override; otherwise `postgresStorage({ connectionString })` is used.

`NizhalMigrateConfig`: `{ db?, schema, syncRules, storage? }`.

## gen (planned)

Will generate client types from `GET /nizhal/contract` — chunk C4 in RFC-001.

## introspect (planned)

Brownfield schema introspection — backlog B9.
