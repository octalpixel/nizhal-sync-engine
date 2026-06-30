---
title: Build an offline-first web app
description: You've got an idea for an app that keeps working when the network doesn't. Here's how to build it with Nizhal, end to end.
---

Say you've got an idea: a little notes app. Nothing fancy — type a note, see it instantly, and it
should keep working on a train, on a plane, in a lift with no signal. When you're back online it just
catches up, and the same notes show up on your other devices. That "works offline, syncs quietly" feel
is the whole point of Nizhal, and this guide builds exactly that app.

There's a finished, runnable version of everything below at
[`apps/notes`](https://github.com/octalpixel/nizhal/tree/main/apps/notes) — clone it, run it, poke at it.

## The one idea to hold onto

A normal web app talks to the server for every read and write, so when the network goes, the app goes.
Nizhal flips that around: **your UI talks to a local store that lives on the device**, and a background
process syncs that store with the server whenever it can. Writes go into a durable outbox and replay
later; reads are always instant because they never leave the device.

So you're not really "calling an API." You're **describing your data and the actions on it once**, and
that same description runs in two places — optimistically on the device the moment the user taps, and
authoritatively on the server a moment later. They agree because it's literally the same function.

Four small pieces. Let's build them.

## 1. What you store — a table

Plain Drizzle. A note has an owner, a title, a body:

```ts
// src/schema.ts
import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const notes = pgTable("notes", {
  id: text("id").primaryKey(),
  owner_id: text("owner_id").notNull(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
```

You don't add `updated_at`/`deleted_at` or any triggers by hand — `nizhal migrate` provisions the
sync machinery for you later. You just describe your app's tables.

## 2. The actions — mutators

Here's the part that feels different. Instead of REST endpoints, you write **mutators**: the verbs of
your app. "Add a note." "Edit a note." Each is a small function over a portable `tx`:

```ts
// src/mutators.ts
import { type MutatorFn, defineMutator, defineMutators, z } from "@nizhal/kernel";
import { notes } from "./schema.js";

export const addNote: MutatorFn<{ clientId: string; title: string; body: string }> = async (
  { tx, ownerId, newId },
  args,
) => {
  await tx.insert(notes).values({
    id: args.clientId || newId(),
    owner_id: ownerId,
    title: args.title,
    body: args.body,
  });
};

export const notesMutators = defineMutators({
  addNote: defineMutator(
    z.object({ clientId: z.string(), title: z.string().min(1), body: z.string() }),
    addNote,
  ),
});
```

Notice `addNote` is just a function — you can keep it in your own service file and pass it in. When the
user taps "save", this runs **on the device immediately** (so the note appears at once) and then **on
the server** when it syncs. That's why the body uses `tx.insert` and `ctx.newId()` instead of raw SQL
and `crypto.randomUUID()` — so both runs produce the identical result.

## 3. Who sees what — sync rules

A user should only sync *their* notes. Sync rules express that as a bucket scoped to the owner:

```ts
// src/sync-rules.ts
import { defineSyncRules } from "@nizhal/kernel";

export const notesSyncRules = defineSyncRules((b) => ({
  myNotes: b.bucket({
    parameters: () => b.params({ ownerId: "owner_id" }),
    data: (bucket) => [b.table("notes").where(b.eq("owner_id", bucket.ownerId))],
  }),
}));
```

Nizhal lints this at boot: every synced query has to be scoped to the actor's bucket, so you can't
accidentally leak everyone's notes to everyone.

## 4. The server

Your backend is a few lines — point it at any Postgres, hand it the three things above:

```ts
// src/server.ts
import { createNizhalServer, bearerTokenAuth } from "@nizhal/server";
import { notesSchema } from "./schema.js";
import { notesMutators } from "./mutators.js";
import { notesSyncRules } from "./sync-rules.js";

export const server = createNizhalServer({
  db: process.env.DATABASE_URL!,
  schema: notesSchema,
  mutators: notesMutators,
  syncRules: notesSyncRules,
  auth: bearerTokenAuth({ secret: process.env.JWT_SECRET! }),
});
// server.listen(4000)  — or mount server.app into an existing Hono API
```

Run `npx nizhal migrate` once and your Postgres is ready (sync columns, tombstones, change-tracking —
no logical replication, no WAL config).

## See it actually work — before you build any UI

This is the satisfying part. The `apps/notes` example ships a tiny end-to-end script that boots the real
server and two real clients, then proves the behaviour you care about. Run it:

```bash
pnpm --filter @nizhal/example-notes example:e2e
```

```
✅ device B converges: sees note-1
✅ offline note not visible on B yet
✅ offline mutation delivered: B converges
✅ idempotent replay: no duplicate note-1

NOTES E2E PASSED ✅
```

That's a note written on one device showing up on another, a note written **while offline** staying
queued and then converging once it's delivered, and a replayed write **not** creating a duplicate — the
three things that make or break an offline app, proven before you've styled a single button. The script
is [`apps/notes/examples/e2e.ts`](https://github.com/octalpixel/nizhal/tree/main/apps/notes/examples/e2e.ts);
read it top to bottom, it's short.

## Wire it into your UI

Your components read and write through a local collection. This is the whole client:

```ts
// src/web-client.ts
import { createNizhalClient, createNizhalMutators, nizhalCollectionOptions } from "@nizhal/db-collection";
import { createCollection } from "@tanstack/db";
import { notesMutators } from "./mutators.js";

const echo = createNizhalClient({
  server: API_URL,
  auth: { getHeaders: () => ({ Authorization: `Bearer ${token}` }) },
  bucketsForSyncRule: () => [ownerId],
});

const notes = createCollection(
  nizhalCollectionOptions({ name: "notes", syncRule: "myNotes", echo, bucketField: "owner_id", getKey: (r) => r.id }),
);

const { mutate } = createNizhalMutators({ collections: { notes }, echo, actor: { userId, ownerId }, mutators: notesMutators });

// in a component: read live, write optimistically
await mutate.addNote({ clientId: crypto.randomUUID(), title: "Groceries", body: "milk, eggs" });
```

`notes` is a live [TanStack DB](https://tanstack.com/db) collection — query it in your components and the
UI updates the instant `addNote` runs, before the server has heard a thing.

### Surviving a page reload

One more line makes the local store durable across reloads (and full offline restarts), using wa-sqlite
over the browser's OPFS:

```ts
import { waSqlitePersistence } from "@nizhal/db-collection";

nizhalCollectionOptions({ name: "notes", /* … */, persistence: waSqlitePersistence({ /* … */ }) });
```

## Where to go next

- Open [`apps/notes`](https://github.com/octalpixel/nizhal/tree/main/apps/notes) and run the e2e.
- Same idea on a phone? → [Build an offline-first React Native app](/guides/build-an-offline-rn-app/).
- The why behind the magic: [How sync works](/concepts/how-sync-works/) and
  [Conflict resolution](/concepts/conflict-resolution/).
