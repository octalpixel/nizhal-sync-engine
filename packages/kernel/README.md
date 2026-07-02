# @nizhal/kernel

Schema helpers, mutators, sync rules, and contract emission for [Nizhal](https://github.com/octalpixel/nizhal) —
a self-host, no-WAL offline-sync toolkit for Postgres. This is the transport-free core you share
between server and client: define your tables, the synced subset, and one-transaction mutators.

```bash
npm install @nizhal/kernel
```

```ts
import { defineMutator, defineMutators, defineSyncRules, z } from "@nizhal/kernel";
import { pgTable, text } from "drizzle-orm/pg-core";

export const notes = pgTable("notes", { id: text("id").primaryKey(), body: text("body"), shopId: text("shop_id") });

export const mutators = defineMutators({
  addNote: defineMutator(z.object({ id: z.string(), body: z.string() }), async ({ tx, actor }, input) => {
    await tx.insert(notes).values({ ...input, shopId: actor.ownerId }); // one op = one transaction
  }),
});

export const syncRules = defineSyncRules((b) => ({
  mine: b.bucket({
    parameters: () => b.params({ ownerId: "shop_id" }),
    data: (bucket) => [b.table("notes").where(b.eq("shop_id", bucket.ownerId))],
  }),
}));
```

Full API: [`docs/api.md`](../../docs/api.md#nizhalkernel). MIT licensed.
