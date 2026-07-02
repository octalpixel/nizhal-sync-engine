# `@nizhal/local` — purely local apps, native Drizzle

WatermelonDB-class local database DX with the Drizzle toolkit exposed natively: you define a
Drizzle `sqliteTable` schema, generate migrations with **drizzle-kit**, apply them **on-device**,
query with the **real Drizzle query builder**, and get **live queries** — uniformly on React
Native (expo-sqlite, op-sqlite) and the browser (wa-sqlite). No server, no sync rules, no outbox.

Platform/bundler recipes (incl. Vite, Next.js, TanStack Start): [`platforms.md`](./platforms.md).

This is a separate data plane from the sync engine (`@nizhal/db-collection` stores synced rows in
its own client store). `@nizhal/local` has zero dependency on it — pick it when the app is
local-only. Working example: [`playground/local-notes`](../playground/local-notes) (Vite +
wa-sqlite, drizzle-kit-generated migrations, verified live in Chrome).

## 1. Schema + migrations — plain drizzle-kit

```ts
// src/schema.ts — the device database IS the database, so the dialect is sqlite
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
export const notes = sqliteTable("notes", {
  id: text("id").primaryKey(),
  body: text("body").notNull(),
  createdAt: integer("created_at").notNull(),
});
```

```ts
// drizzle.config.ts — driver "expo" selects the bundled-migrations output for EVERY platform here
import { defineConfig } from "drizzle-kit";
export default defineConfig({ dialect: "sqlite", driver: "expo", schema: "./src/schema.ts", out: "./drizzle" });
```

`drizzle-kit generate` emits `./drizzle/migrations.js` (`{ journal, migrations }`). Bundling the
`.sql` imports: Metro uses `babel-plugin-inline-import` (drizzle's documented Expo setup); Vite
uses the 6-line `inlineSql()` plugin in `playground/local-notes/vite.config.ts`.

## 2. Open — build the drizzle db the way the drizzle docs show, then wrap once

```ts
// React Native (expo-sqlite)
import * as SQLite from "expo-sqlite";
import { drizzle } from "drizzle-orm/expo-sqlite";
import { openLocalDb } from "@nizhal/local";
import { expoSqliteChanges } from "@nizhal/local/expo-sqlite";
import migrations from "./drizzle/migrations";
import * as schema from "./src/schema";

const expo = SQLite.openDatabaseSync("app.db", { enableChangeListener: true });
const local = await openLocalDb({
  db: drizzle(expo, { schema }),
  migrations,                                   // applied idempotently before resolve
  changes: expoSqliteChanges(SQLite),
  close: () => expo.closeAsync(),
});
```

```ts
// React Native (op-sqlite)
import { open } from "@op-engineering/op-sqlite";
import { drizzle } from "drizzle-orm/op-sqlite";
import { opSqliteChanges } from "@nizhal/local/op-sqlite";

const raw = open({ name: "app.db" });
const local = await openLocalDb({ db: drizzle(raw, { schema }), migrations, changes: opSqliteChanges(raw) });
```

```ts
// Browser (wa-sqlite — drizzle has no official browser driver; this is ours)
import { waSqliteChanges, waSqliteDrizzle } from "@nizhal/local/wa-sqlite";

const local = await openLocalDb({
  db: waSqliteDrizzle({ sqlite3, database, config: { schema } }),   // sqlite-proxy under the hood
  migrations,
  changes: waSqliteChanges(sqlite3, database),                      // sqlite3_update_hook
  close: () => sqlite3.close(database),
});
```

## 3. Query — it's just drizzle

```ts
await local.db.insert(notes).values({ id, body, createdAt: Date.now() });
await local.db.select().from(notes).orderBy(desc(notes.createdAt));
await local.db.query.notes.findFirst({ where: eq(notes.id, id) });
await local.db.transaction(async (tx) => { /* … */ });
```

Anything that wraps a drizzle instance composes on top — e.g. better-drizzle:
`const client = better(local.db, { schema })`.

Gotcha: drizzle builders are **lazy** — they execute on `await`/`.then`. `void db.delete(…)`
never runs.

## 4. Live queries — every platform, not just expo

```ts
// framework-agnostic
const stop = local.watch(local.db.select().from(notes), ({ data, error, updatedAt }) => { … });

// React — same shape as drizzle's expo-only useLiveQuery, but cross-platform
import { useLiveQuery } from "@nizhal/local/react";
const { data } = useLiveQuery(local, local.db.select().from(notes));
```

Invalidation is table-granular from each platform's SQLite update hook (expo change listener,
op-sqlite `updateHook`, wa-sqlite `update_hook`), coalesced per microtask. The watched table is
derived from the query's primary table (same rule as drizzle's own hook); queries with joins
should pass `{ tables: ["a", "b"] }`.

## Guarantees & limits (v1)

- `applyBundledMigrations` delegates to drizzle's own dialect migrator — identical
  `__drizzle_migrations` bookkeeping to the official expo/op-sqlite migrators, idempotent across
  restarts, applies only new journal entries.
- The wa-sqlite driver serializes statements on one queue (wa-sqlite connections are not
  re-entrant). Interleaving *other* statements inside an explicit `db.transaction` from
  concurrent code is not isolated — single-flow usage, same as every browser SQLite wrapper.
- One `…Changes()` adapter per connection (SQLite exposes a single update-hook slot; the adapter
  owns it and fans out).
- Verified by `packages/local/test/`: core semantics on better-sqlite3 and a full end-to-end
  suite on the **real wa-sqlite wasm** (migrations, transactions + rollback, update_hook-driven
  watch, 25-way write burst).
