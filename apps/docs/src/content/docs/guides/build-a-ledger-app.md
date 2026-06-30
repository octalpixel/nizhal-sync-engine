---
title: Build a ledger app
description: Model an offline-first customer credit ledger with append-only movements and derived balances.
---

[Tabkeep](https://github.com/octalpixel/nizhal/tree/main/apps/tabkeep) is the complete runnable app for
this guide. It demonstrates the financially safe shape for an offline ledger without adding a custom
client store, outbox, or reactivity layer.

## Keep facts, derive balances

Use one customer table and one append-only movement table. Store money as integer minor units:

```ts
export const ledgerEntries = pgTable("ledger_entries", {
  id: text("id").primaryKey(),
  shop_id: text("shop_id").notNull(),
  customer_id: text("customer_id").notNull(),
  kind: text("kind", { enum: ["credit", "payment"] }).notNull(),
  amount: integer("amount").notNull(),
  note: text("note"),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
```

Do not store a mutable balance. Fold the synced entries whenever the UI needs it:

```ts
const balance = entries.reduce(
  (sum, entry) => sum + (entry.kind === "credit" ? entry.amount : -entry.amount),
  0,
);
```

This makes credits and payments durable facts. Reconciliation and audit work from the same history.

## Express the business verbs

Tabkeep has three mutators: `addCustomer`, `recordCredit`, and `recordPayment`. Every input carries a
client-generated `id`; the durable outbox supplies the `clientMutationId` used for idempotent replay.
Both ledger mutators only insert:

```ts
recordCredit: defineMutator(input, async ({ tx, ownerId }, args) => {
  await tx.insert(ledgerEntries).values({
    id: args.id,
    shop_id: ownerId,
    customer_id: args.customerId,
    kind: "credit",
    amount: args.amount,
  });
  return { affectedBuckets: [ownerId] };
})
```

The same mutator updates the local collection immediately and runs authoritatively inside one server
transaction when the outbox drains.

## Scope one shop

A narrow single-shop app needs one bucket:

```ts
export const tabkeepSyncRules = defineSyncRules((b) => ({
  myShop: b.bucket({
    parameters: () => b.params({ ownerId: "shop_id" }),
    data: (bucket) => [
      b.table("customers").where(b.eq("shop_id", bucket.ownerId)),
      b.table("ledger_entries").where(b.eq("shop_id", bucket.ownerId)),
    ],
  }),
}));
```

The rule is evaluated on the server and linted at startup so a row cannot escape its shop bucket.

## Choose local-first

A ledger entry is an append-only fact, so Tabkeep uses Nizhal's default `local-first` mode. The web
client gives both collections the same wa-sqlite persistence and durable outbox. React reads them with
`useLiveQuery`; forms invoke the mutators. There is no network request in a component.

Run the end-to-end proof:

```bash
pnpm --filter @nizhal/example-tabkeep example:e2e
```

It proves offline credit, two-device convergence, idempotent replay, default-on audit, and the exact
integer balance fold. Then run the app from [`apps/tabkeep`](https://github.com/octalpixel/nizhal/tree/main/apps/tabkeep)
and inspect each file—the small amount of application code is the point.
