---
title: Quickstart
description: Install Nizhal, provision Postgres, run the server, and sync your first collection.
---

This walkthrough boots a minimal notes app end-to-end: schema, mutators, sync rules, server, and TanStack DB client.

## Install

Install only what each side needs — Nizhal bundles the rest.

```bash
# Server (Node or Bun) — the Postgres driver + Hono are bundled in @nizhal/server
pnpm add @nizhal/server @nizhal/kernel drizzle-orm
pnpm add -D @nizhal/cli

# Client — @tanstack/db + @tanstack/offline-transactions are bundled in @nizhal/db-collection;
# add ONE SQLite driver peer for offline persistence
pnpm add @nizhal/db-collection @nizhal/kernel drizzle-orm
pnpm add @journeyapps/wa-sqlite            # web (peer dependency)
# React Native instead → see React Native (op-sqlite + @nizhal/react-native)
```

You do **not** need to install `postgres`, `@tanstack/db`, or `@tanstack/offline-transactions` —
they're dependencies of the Nizhal packages. `zod` is re-exported from `@nizhal/kernel`
(`import { z } from "@nizhal/kernel"`); add it directly only if you import it elsewhere. For a React UI,
optionally add `@tanstack/react-db` for `useLiveQuery`. See [React Native](/react-native/) for mobile.

## 1. Define schema

```ts
import { pgTable, text } from "@nizhal/kernel";

export const notes = pgTable("notes", {
  id: text("id").primaryKey(),
  owner_id: text("owner_id").notNull(),
  body: text("body").notNull(),
});

export const schema = { notes };
```

## 2. Define mutators

```ts
import { defineMutator, defineMutators } from "@nizhal/kernel";
import { z } from "zod";
import { notes } from "./schema";

export const mutators = defineMutators({
  addNote: defineMutator(
    z.object({ id: z.string(), body: z.string() }),
    async ({ tx, actor, newId }, args) => {
      const id = args.id || newId();
      await tx.insert(notes).values({ id, body: args.body, owner_id: actor.ownerId });
      return { serverId: id, affectedBuckets: [`${actor.ownerId}`] };
    },
  ),
});
```

One business operation = one mutator = one server transaction. `clientMutationId` (from the offline outbox) enables idempotent replay; the server returns client-id → server-id reconciliation when IDs differ.

## 3. Define sync rules

```ts
import { defineSyncRules } from "@nizhal/kernel";

export const syncRules = defineSyncRules((b) => ({
  myNotes: b.bucket({
    parameters: () => b.params({ ownerId: "owner_id" }),
    data: (bucket) => [
      b.table("notes").where(b.eq("owner_id", bucket.ownerId)),
    ],
  }),
}));
```

`defineSyncRules` runs a **no-leak lint**: every `data` query must constrain rows to bucket keys. Rows outside the rule never reach a client.

## 4. Provision Postgres

```ts
// nizhal.config.js
import { postgresStorage } from "@nizhal/server/adapters";
import { schema } from "./schema";
import { syncRules } from "./sync-rules";

export default {
  db: process.env.DATABASE_URL,
  schema,
  syncRules,
};
```

```bash
nizhal migrate --config nizhal.config.js
```

`postgresStorage.provision` adds `updated_at` / `deleted_at` / `_nizhal_row_version`,
change-tracking triggers gated by `_nizhal_sync_control`, removal tracking, `_nizhal_mutations` for
idempotency, and indexes — **no logical replication**.

Inspect raw SQL with `buildPostgresProvisionPlan` from `@nizhal/server/adapters` if needed.

## 5. Start the server

```ts
import { createNizhalServer, bearerTokenAuth } from "@nizhal/server";

const server = createNizhalServer({
  db: process.env.DATABASE_URL!,
  schema,
  mutators,
  syncRules,
  auth: bearerTokenAuth({ secret: process.env.JWT_SECRET! }),
});

server.listen(4000);
```

Endpoints:

- `POST /sync/pull` — cursor-based delta
- `POST /sync/push` — idempotent mutator batch
- `GET /sync/stream` — WebSocket bucket pings
- `GET /nizhal/contract` — OpenAPI/JSON-Schema artifact

## 6. Wire the client

```ts
import { createNizhalClient, nizhalCollectionOptions, createNizhalMutators } from "@nizhal/db-collection";
import { createCollection } from "@tanstack/react-db";

const echo = createNizhalClient({
  server: "http://localhost:4000",
  auth: {
    getHeaders: () => ({ Authorization: `Bearer ${token}` }),
  },
  bucketsForSyncRule: (rule) => {
    if (rule === "myNotes") return [{ ownerId: session.ownerId }];
    return [];
  },
});

const notesCollection = createCollection(
  nizhalCollectionOptions({ name: "notes", syncRule: "myNotes", echo }),
);

const { mutate } = createNizhalMutators({ collections: { notes: notesCollection }, echo, mutators });

// Optimistic local write; outbox drains to /sync/push when online
await mutate.addNote({ id: crypto.randomUUID(), body: "Hello offline" });
```

On connect (and on each bucket ping), the collection pulls changes since its cursor. After reconnect, devices converge without a full refetch.

## 7. Issue a token

```ts
import { issueBearerToken } from "@nizhal/server";

const token = issueBearerToken({
  userId: "user-1",
  ownerId: "owner-1",
  secret: process.env.JWT_SECRET!,
});
```

## Verify

Run the server, open two browser tabs (or use `apps/credit-ledger/examples/live-e2e.ts` as a reference for a scripted check). Write offline in one tab, reconnect, and confirm the other tab converges via pull.

## Next

- [First app](/getting-started/first-app/) — movement-ledger domain modeling
- [How sync works](/concepts/how-sync-works/) — cursors, tombstones, idempotency
