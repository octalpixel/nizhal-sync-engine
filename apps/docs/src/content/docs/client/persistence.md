---
title: Persistence
description: waSqlitePersistence, opSqlitePersistence, and client store migrations.
---

```ts
import { waSqlitePersistence, opSqlitePersistence, migrateClientStore } from "@nizhal/db-collection";
```

| Export | Platform |
|--------|----------|
| `waSqlitePersistence` | Web — wa-sqlite + OPFS |
| `opSqlitePersistence` | React Native — op-sqlite |
| `migrateClientStore` | Apply `NIZHAL_CLIENT_STORE_MIGRATIONS` |
| `createSerializedWaSqliteDatabase` | Headless/test SQLite via wa-sqlite WASM |

Pass into `nizhalCollectionOptions({ persistence })`.

## Migrations

`NIZHAL_CLIENT_STORE_VERSION` and `mergeClientStoreMigrations` version the local schema. Call `migrateClientStore` on app upgrade before opening collections.

## Emulation note

`op-sqlite` is RN-native and does not run in Node. Chaos tests use wa-sqlite WASM or `node:sqlite` with the same persistence code paths — behavioral fidelity without the native binary.

Verified on device: `apps/op-sqlite-probe` — offline write + restart survives via op-sqlite.
