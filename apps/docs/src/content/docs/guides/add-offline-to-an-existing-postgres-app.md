---
title: Add offline sync to an existing Postgres app
description: You already have an app on Postgres with a working backend. Point Nizhal at the same database, add offline sync to a new frontend, and don't touch the backend you already have.
---

Here's a common situation: you've got a working app — say a POS — already running on Postgres, with a
backend and APIs a vendor built. It was never designed for offline. Now you want an offline-capable
frontend, and the last thing you want is to rewrite the backend.

You don't have to. **Nizhal doesn't need its own database — point it at the one you already have.** Its
change-tracking lives in Postgres triggers, not in your application code, so your existing backend keeps
reading and writing exactly as it does today, and those writes *still sync* to the new offline clients.

Everything below is proven by a script you can run:
[`apps/notes/examples/brownfield.ts`](https://github.com/octalpixel/nizhal/tree/main/apps/notes/examples/brownfield.ts).

```bash
pnpm --filter @nizhal/example-notes example:brownfield
```
```
✅ legacy rows intact after provision (2 rows)
✅ updated_at backfilled on pre-existing rows
✅ change-tracking triggers installed on the existing table
✅ client syncs the PRE-EXISTING legacy rows (2)
✅ direct vendor INSERT syncs to the client
✅ direct vendor UPDATE syncs to the client
✅ direct vendor hard DELETE propagates as a tombstone
✅ Nizhal mutator write coexists on the same table

BROWNFIELD COEXIST PASSED ✅
```

That script stands up a table with pre-existing data (your "vendor" system), runs Nizhal's
`provision()` on it, then makes **direct raw-SQL writes** — exactly what your existing backend does — and
shows each one reaching a Nizhal client.

## The one idea

`provision()` is **additive and non-destructive**. On your existing tables it runs:

```sql
alter table notes add column if not exists updated_at  timestamptz not null default now();
alter table notes add column if not exists deleted_at  timestamptz;
alter table notes add column if not exists _nizhal_row_version bigint not null default nextval(...);
-- + triggers that issue a total-order row version
-- + UPDATE/DELETE triggers that record tombstones and bucket exits
-- + the _nizhal_* bookkeeping tables (mutations, clients, tombstones, …)
```

No table is dropped or recreated; `default now()` backfills `updated_at` on the rows that are already
there. Because the tracking is in **triggers**, *any* write to the table is captured — including writes
your existing backend makes directly, with no `clientMutationId`, no Nizhal client, no code change:

- **INSERT** → `_nizhal_row_version` gets the next storage sequence value → picked up by the next pull.
- **UPDATE** → the trigger bumps `_nizhal_row_version` → picked up in total order.
- **Soft delete** (`deleted_at` changes from `NULL`) → the update trigger writes a tombstone → the
  client removes the row.
- **DELETE** (even a plain hard `DELETE`) → the delete trigger writes a tombstone → the client removes
  the row.
- **Bucket move** (for example, `owner_id` changes) → the old bucket receives a per-row removal, so it
  does not retain a stale copy.

That's the whole trick: your backend stays a black box, and the database tells Nizhal what changed.

## Step by step

### 1. Provision your existing database

Aim Nizhal's storage at your real connection string and provision once (it's idempotent — safe to re-run):

```ts
import { postgresStorage } from "@nizhal/server/adapters";
import { notesSchema } from "./schema";     // a Drizzle description of your EXISTING tables
import { notesSyncRules } from "./sync-rules";

const storage = postgresStorage({ connectionString: process.env.DATABASE_URL! });
await storage.provision({ schema: notesSchema, syncRules: notesSyncRules });
// or: npx nizhal migrate
```

You describe your existing tables to Nizhal with a Drizzle schema (just the columns you already have —
Nizhal adds the sync columns). Existing data and existing indexes are untouched.

### 2. Declare who syncs what

Sync rules scope rows to a user via a bucket — here, the owner of the notes. The bucket column
(`owner_id`) is a column your tables already have:

```ts
import { defineSyncRules } from "@nizhal/kernel";

export const notesSyncRules = defineSyncRules((b) => ({
  myNotes: b.bucket({
    parameters: () => b.params({ ownerId: "owner_id" }),
    data: (bucket) => [b.table("notes").where(b.eq("owner_id", bucket.ownerId))],
  }),
}));
```

### 3. Run the sync server next to your existing API

`createNizhalServer(...)` returns a Hono `app` you can mount alongside whatever you already run — or
stand up on its own. It reads and writes the *same* Postgres:

```ts
import { createNizhalServer, bearerTokenAuth } from "@nizhal/server";

const server = createNizhalServer({
  db: process.env.DATABASE_URL!,
  schema: notesSchema,
  mutators: notesMutators,       // optimistic writes from the new frontend
  syncRules: notesSyncRules,
  auth: bearerTokenAuth({ secret: process.env.JWT_SECRET! }),
  storage,
});
server.listen(4000); // or: yourExistingHono.route("/", server.app)
```

### 4. The new frontend uses the Nizhal client

The offline frontend talks to Nizhal (local store + sync) exactly as in the
[web](/guides/build-an-offline-web-app/) or [React Native](/guides/build-an-offline-rn-app/) guides. It
sees your pre-existing data on first sync, and every later change — whoever made it.

### 5. Your existing backend? Leave it alone

This is the part that surprises people: **you don't route the old system's writes through Nizhal.** It
keeps doing `INSERT`/`UPDATE`/`DELETE` against the same tables, and the triggers make those changes flow
to the offline clients automatically. Two write paths — your vendor backend and Nizhal mutators —
coexist on one source of truth.

## Honest caveats

- **Co-location is the requirement.** This works because Nizhal and your backend share *one* Postgres. If
  some writes go to a *different* datastore or only through an API you can't co-locate with, this guide
  doesn't apply — you'd implement a remote storage adapter instead (see
  [libSQL / Turso](/self-hosting/turso-libsql/)).
- **Conflict model for direct writes is last-writer-wins by commit order.** A direct vendor `UPDATE` and a
  Nizhal mutator editing the same row resolve in commit order. That's right for most data; if a specific
  table needs per-field merge or CRDT, those edits should go through mutators. See
  [Conflict resolution](/concepts/conflict-resolution/).
- **Rows need the bucket column.** Your sync rule scopes by a column (e.g. `owner_id`); rows must carry it
  to be syncable to the right user. Existing tables usually already have an owner/tenant column.
- **Hard and soft deletes are both tracked.** You don't have to convert your backend to one deletion
  style: hard deletes and `deleted_at` transitions both emit tombstones. Changing a bucket column also
  emits a removal for the old bucket.

## Where to go next

- Run [`apps/notes/examples/brownfield.ts`](https://github.com/octalpixel/nizhal/tree/main/apps/notes/examples/brownfield.ts) and read it — it's short and proves every claim above.
- New frontend: [offline web app](/guides/build-an-offline-web-app/) or [React Native](/guides/build-an-offline-rn-app/).
- Can't co-locate on the database? [libSQL / Turso (non-Postgres)](/self-hosting/turso-libsql/) and the storage-adapter seam.
