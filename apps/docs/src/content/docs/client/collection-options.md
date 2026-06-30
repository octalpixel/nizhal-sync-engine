---
title: nizhalCollectionOptions
description: TanStack DB CollectionConfig wired to Nizhal pull/push.
---

```ts
import { nizhalCollectionOptions } from "@nizhal/db-collection";
import { createCollection } from "@tanstack/react-db";

const notes = createCollection(
  nizhalCollectionOptions({
    name: "notes",
    syncRule: "myNotes",
    echo,
    persistence: waSqlitePersistence({ /* driver */ }),
  }),
);
```

Returns a TanStack DB `CollectionConfig` whose `SyncConfig.sync`:

1. Calls `echo.pull` with cursor + buckets for `syncRule`
2. Applies `begin` / `write` / `commit` for each changed row
3. Handles `cursorReset` by re-bootstrapping from cursor 0
4. Maps sync-rule subset to `loadSubset` / `unloadSubset`

## Types

`name` is the collection/table name. Row types should come from generated contract (`nizhal gen`) — not server Drizzle imports.

## Lower-level

`buildNizhalSyncConfig` and `applyPullResult` are exported for custom collection wiring.
