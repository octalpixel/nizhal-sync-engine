---
title: Sync rules & buckets
description: Parameters, buckets, data queries, membership, and the no-leak lint.
---

Sync rules declaratively scope **which rows each authenticated client may sync**. They are evaluated **server-side**; the client never receives out-of-scope data.

## Shape

```ts
defineSyncRules((b) => ({
  ruleName: b.bucket({
    parameters: (actor) => /* how to discover bucket keys */,
    data: (bucket) => [ /* scoped queries per bucket */ ],
  }),
}));
```

Each rule has:

- **parameters** — yields bucket column bindings for this actor (from JWT, membership table, or static mapping)
- **data** — one or more table queries, each constrained to bucket keys

## Bucket parameters

### Static column mapping

```ts
parameters: () => b.params({ ownerId: "owner_id" }),
```

The client supplies concrete bucket values via `bucketsForSyncRule` on `createNizhalClient`.

### Membership table

```ts
parameters: (actor) =>
  b.membership({
    table: "shop_members",
    where: { user_id: actor.userId },
    select: { shopId: "shop_id" },
  }),
```

The server resolves membership with bound parameters — no raw SQL in app code. When membership shrinks, pull returns `removedBuckets` and the client purges local rows (REQ-14).

## Data queries

```ts
data: (bucket) => [
  b.table("notes").where(b.eq("owner_id", bucket.ownerId)),
  b.table("tags")
    .where(b.eq("owner_id", bucket.ownerId))
    .related([b.table("tag_links").where(b.eq("owner_id", bucket.ownerId))]),
],
```

Every query must include at least one `b.eq(column, bucket.key)` predicate. The builder rejects raw SQL in data queries.

## No-leak lint

`defineSyncRules` calls `assertSyncRulesNoLeak` at registration time. Violations throw `SyncRuleLintError` with rule name and query index.

This is not middleware — it is a **typed, linted language** for subset sync. If a predicate forgets to scope by bucket, the rule fails at build time (or test time), not in production with a data leak.

## Server evaluation

On pull, the server:

1. Resolves parameters for the authenticated actor
2. Intersects with client-requested buckets
3. Runs each `data` query with bucket bindings
4. Returns changed rows + tombstones + `removedBuckets`

## Next

- [How sync works](/concepts/how-sync-works/)
- [Realtime](/concepts/realtime/)
