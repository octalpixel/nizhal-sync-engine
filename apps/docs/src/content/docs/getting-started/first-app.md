---
title: First app
description: Walk through the credit-ledger reference app — append-only entries, balance as fold.
---

The `apps/credit-ledger` reference app demonstrates Nizhal's recommended domain shape: **append-only movement ledgers** where balances are **folds**, not stored mutable columns.

## Why movement ledgers

Offline merge is conflict-free when every write appends an immutable fact (`+500 credit`, `-200 payment`) and totals are derived. Two devices recording payments offline both append rows; the fold sums them — no lost update on a shared `balance` column.

## Schema sketch

- `shops` — tenant root
- `shop_members` — who can access which shop (membership drives buckets)
- `customers` — per-shop contacts
- `ledger_entries` — append-only movements (`amount` signed: credit positive, payment negative)

Balances are computed client-side:

```ts
function balance(entries: { amount: string }[]): number {
  return entries.reduce((sum, e) => sum + Number(e.amount), 0);
}
```

## Sync rules — membership buckets

```ts
import { defineSyncRules } from "@nizhal/kernel";

export const creditLedgerSyncRules = defineSyncRules((b) => ({
  myShops: b.bucket({
    parameters: (actor) =>
      b.membership({
        table: "shop_members",
        where: { user_id: actor.userId },
        select: { shopId: "shop_id" },
      }),
    data: (bucket) => [
      b.table("customers").where(b.eq("shop_id", bucket.shopId)),
      b.table("ledger_entries").where(b.eq("shop_id", bucket.shopId)),
      b.table("reminders").where(b.eq("shop_id", bucket.shopId)),
    ],
  }),
}));
```

`b.membership` resolves bucket parameters from a membership table with bound `where` values — no hand-escaped SQL. When a user is removed from `shop_members`, the next pull emits remove-ops and the client **purges** that shop's rows locally (REQ-14).

## Mutators

`recordCredit` and `recordPayment` insert into `ledger_entries` inside one transaction. `addCustomer` returns `{ serverId, affectedBuckets }` for client-id reconciliation.

```ts
recordCredit: defineMutator(recordCreditInput, async ({ tx, actor, newId }, args) => {
  const shopId = requireShopId(actor);
  const entryId = args.clientId || newId();
  await tx.insert(ledgerEntries).values({
    id: entryId,
    shop_id: shopId,
    customer_id: args.customerId,
    amount: String(args.amount),
    // ...
  });
  return { serverId: entryId, affectedBuckets: [shopId] };
}),
```

Jobs (SMS reminders) enqueue from mutators via `jobs.schedule` — see [Jobs](/server/jobs/).

## Client wiring

Collections per table, scoped to `myShops`:

```ts
const echo = createNizhalClient({
  server: API_URL,
  auth: { getHeaders: () => ({ Authorization: `Bearer ${token}` }) },
  bucketsForSyncRule: (rule) =>
    rule === "myShops" ? memberships.map((m) => ({ shopId: m.shop_id })) : [],
});
```

`createNizhalMutators` wraps kernel mutators with TanStack `offline-transactions` — optimistic UI, durable outbox, poison dead-letter on deterministic failures.

## Run it

```bash
pnpm --filter credit-ledger dev          # local PGlite smoke
pnpm --filter credit-ledger example:live # TCP server + real WS client
pnpm --filter credit-ledger example:neon # managed Postgres smoke (NEON_URL)
```

## What this proves

- Multi-table mutator in one transaction (customer + entry + job)
- Membership-scoped sync with revocation eviction
- Offline write → reconnect → second device converges
- Balance = fold invariant holds under concurrent appends

## Next

- [Build an offline-first app](/guides/build-offline-first-app/)
- [Sync rules & buckets](/concepts/sync-rules-and-buckets/)
