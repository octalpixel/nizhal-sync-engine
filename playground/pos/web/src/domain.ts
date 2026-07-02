import {
  type SyncRuleBuilder,
  type SyncRules,
  defineMutator,
  defineMutators,
  defineSyncRules,
  z,
} from "@nizhal/kernel";
import { integer, pgTable, text } from "drizzle-orm/pg-core";

// The client's view of the EXISTING backend's data. pgTable is Nizhal's schema IR — there is no
// Postgres anywhere in this demo; the client sqlite tables are derived from these definitions.
export const products = pgTable("products", {
  id: text("id").primaryKey(),
  shop_id: text("shop_id").notNull(),
  name: text("name").notNull(),
  price_cents: integer("price_cents").notNull(),
  stock: integer("stock").notNull(),
});

export const orders = pgTable("orders", {
  id: text("id").primaryKey(),
  shop_id: text("shop_id").notNull(),
  product_id: text("product_id").notNull(),
  quantity: integer("quantity").notNull(),
  total_cents: integer("total_cents").notNull(),
  created_at: integer("created_at").notNull(),
});

export const posSyncRules = defineSyncRules(
  (b: SyncRuleBuilder): SyncRules =>
    ({
      shop: b.bucket({
        parameters: () => b.params({ ownerId: "shop_id" }),
        data: (bucket) => [
          b.table("products").where(b.eq("shop_id", bucket.ownerId)),
          b.table("orders").where(b.eq("shop_id", bucket.ownerId)),
        ],
      }),
    }) as unknown as SyncRules,
);

const id = z.string().min(1);
export const posMutators = defineMutators({
  // The optimistic half runs on-device against the derived tables; the authoritative half is
  // the EXISTING POST /orders endpoint (mapped in adapter.ts — there is no Nizhal server).
  // Stock stays server-authoritative (the backend's own business rule); pull refreshes it.
  recordSale: defineMutator(
    z.object({
      id,
      productId: id,
      quantity: z.number().int().positive(),
      priceCents: z.number().int().nonnegative(),
    }),
    async ({ tx, actor, now }, args) => {
      await tx.insert(orders).values({
        id: args.id,
        shop_id: actor.ownerId,
        product_id: args.productId,
        quantity: args.quantity,
        total_cents: args.quantity * args.priceCents,
        created_at: now(),
      });
      return { serverId: args.id, affectedBuckets: [actor.ownerId] };
    },
  ),
});
