---
title: Bring your own backend
description: Add an offline-first frontend to an existing backend (Medusa, Convex, Supabase, your own API) without rewriting it — point Nizhal at your own sync endpoints.
---

You already have a backend. It has your business logic, your database, your auth — and you are not
about to rewrite it to adopt offline-first. Nizhal's **sync target** lets you keep that backend and
add a light local-first frontend on top: the client reads and writes a local store, and a small
adapter you write replays those writes to *your* API and pulls *your* changes back.

There's a finished, runnable version of everything below at
[`apps/notes/examples/byo-backend.ts`](https://github.com/octalpixel/nizhal/tree/main/apps/notes/examples/byo-backend.ts).
Run it: `pnpm example:byo` → it boots a non-Nizhal Hono backend and two clients, and proves the four
things that make or break a brownfield offline app:

```
BYO SYNC E2E PASSED ✅
```

(offline write stays local → replays on reconnect → the second device converges → a replayed write
does **not** duplicate → a delete propagates.)

## The one idea

Nizhal's default client talks to a Nizhal server. But the client only needs **two operations** from a
backend — *pull changes since a cursor* and *push a command idempotently*. Bundle those into a
`NizhalSyncTarget` and you can point the client at anything:

```ts
export interface NizhalSyncTarget {
  pull(request: NizhalPullRequest): Promise<NizhalPullResponse>;
  push(request: NizhalPushRequest): Promise<NizhalPushResponse>;
}
```

Pass it to `createNizhalClient({ syncTarget })`. Omit it and you get the built-in `httpSyncTarget`
(today's Nizhal-server behavior) unchanged — this is purely additive. Realtime/presence stays a
separate concern (your `subscribeSource`); the sync target is just the data plane.

## The backend contract

Your backend exposes two endpoints (names are yours — the adapter maps them). From the runnable
example:

**`push` — idempotent command apply.** The request *is* the mutation envelope; dedup on
`clientMutationId` so retries can't double-apply, then run your existing business logic in one
transaction:

```ts
app.post("/nizhal/push", async (c) => {
  const m = await c.req.json<NizhalPushRequest>();          // { name, args, clientMutationId, clientID, mutationID, hlc }
  if (appliedMutations.has(m.clientMutationId))
    return c.json<NizhalPushResponse>({ status: "duplicate" });
  // ...validate m.args, run YOUR service logic, record the change...
  appliedMutations.add(m.clientMutationId);
  return c.json<NizhalPushResponse>({ status: "applied" });  // "applied" | "duplicate" | "rejected"
});
```

**`pull` — changed-since over a monotonic cursor**, returning changed rows, tombstones, and any
buckets the actor has left:

```ts
app.post("/nizhal/pull", async (c) => {
  const req = await c.req.json<NizhalPullRequest>();         // { cursor, syncRule, buckets, clientId }
  const page = changesSince(req.cursor, req.buckets);
  return c.json<NizhalPullResponse>({
    changed: [{ table: "notes", rows: page.upserts }],
    tombstoned: page.deletes.map((id) => ({ table: "notes", id })),
    removedBuckets: [],
    cursor: page.nextCursor,                                  // opaque, monotonic — NOT a wall clock
    hasMore: false,
  });
});
```

The cursor must be a **monotonic, total-order** token (a sequence/version), never a wall-clock
timestamp — equal-millisecond rows straddling a page boundary would be skipped forever. (Nizhal's own
Postgres adapter pages by an internal `_nizhal_row_version` sequence for exactly this reason.)

## Retriable vs terminal

The adapter classifies failures so the durable outbox knows whether to retry or dead-letter — throw
`NizhalSyncTargetError` with `retriable`:

```ts
if (!response.ok)
  throw new NizhalSyncTargetError(`backend ${response.status}`, {
    retriable: response.status === 429 || response.status >= 500,  // transport/5xx/429 retry; 4xx parks
  });
```

A transport failure or 5xx stays in the outbox and replays; a deterministic 4xx (bad args, auth) is a
dead letter, surfaced — never silently dropped. The backend owns idempotency, so retries are safe.

## Optimistic approximation — don't reimplement your backend

The tempting mistake is to port your backend logic into the client so the optimistic result is
"correct." Don't. The client only needs a *prediction* good enough to feel instant; your backend stays
authoritative and the next `pull` reconciles. Pick per action:

| Pattern | When | Client does | On pull |
|---|---|---|---|
| **Full optimistic** | trivial, total logic (toggle a flag, add a note) | apply the exact result locally | confirms (usually a no-op) |
| **Light optimistic** | approximate is fine (a total, a derived field, a status) | apply a *best-guess* row | replaces with the authoritative row |
| **Pending** | money movement, server-assigned ids, anything you must not guess | show a "syncing" placeholder | fills in the real row |

This mirrors how Expensify and Linear ship: optimistic where it's safe, pending where it isn't, the
server always the source of truth. Nizhal's pull-as-merge keeps your un-acknowledged local writes
intact and reconciles per-row once the server confirms (see [Conflict
resolution](/concepts/conflict-resolution/)).

## Wiring the client

```ts
const client = createNizhalClient({
  syncTarget: backendTarget(API_URL),   // your adapter
  bucketsForSyncRule: () => [ownerId],
});
const notes = createCollection(nizhalCollectionOptions({ name: "notes", syncRule: "myNotes", echo: client, getKey: (r) => r.id }));
const { mutate } = createNizhalMutators({ collections: { notes }, echo: client, actor: { userId, ownerId }, mutators });
```

From here it's the same as any Nizhal app: components read the live collection, `mutate.*` writes
optimistically + durably, and the outbox drains to *your* backend.

## Recipes

- **Medusa** (Postgres) — local read model = a light projection (`products`, `cart`, `order`). `pull`
  via a `GET /store/sync?since=` route (or Electric shapes over Medusa's Postgres); `push` by replaying
  to Medusa's cart/order API with `clientMutationId` as the idempotency key.
- **Convex** — `pull` = a Convex query `pullChanges(cursor)` over docs with `updatedAt`/`deletedAt`;
  `push` = a Convex mutation `pushChanges` that dedups by key. (Convex has no triggers/WAL, so the
  change feed is application-level — exactly what `pull` is for.)
- **Your own API** — implement the two endpoints above over whatever DB you have. The runnable
  `example:byo` is your template.

## Where to go next

- Run [`pnpm example:byo`](https://github.com/octalpixel/nizhal/tree/main/apps/notes/examples/byo-backend.ts) and read it top to bottom — it's the whole contract in one file.
- Already on Postgres and want the *server* to do the work instead? → [Add offline to an existing
  Postgres app](/guides/add-offline-to-an-existing-postgres-app/).
- The reconciliation model → [Conflict resolution](/concepts/conflict-resolution/).
