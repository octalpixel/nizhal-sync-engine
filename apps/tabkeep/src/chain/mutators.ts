import { type MutatorCtx, defineMutator, defineMutators } from "@nizhal/kernel";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { type ChainRole, products, receipts, sales } from "./schema.js";

const id = z.string().min(1);
const minorUnits = z.number().int().nonnegative();

const addProductInput = z.object({
  id,
  name: z.string().trim().min(1),
  price: minorUnits,
  stock: z.number().int().nonnegative(),
});
const setPriceInput = z.object({ id, price: minorUnits });
const adjustStockInput = z.object({ id, stock: z.number().int().nonnegative() });
const recordSaleInput = z.object({
  id,
  productId: id,
  qty: z.number().int().positive(),
  amount: minorUnits,
});
const attachReceiptInput = z.object({
  id, // content-hash blob key
  saleId: id,
  mime: z.string().min(1),
  size: z.number().int().nonnegative(),
  status: z.enum(["pending", "synced"]),
});

function role(ctx: MutatorCtx): ChainRole | undefined {
  return typeof ctx.actor.role === "string" ? (ctx.actor.role as ChainRole) : undefined;
}

// Writes set branch_id = ctx.ownerId (the actor's active branch). The cross-tenant write guard
// validates that branch against the actor's server-side membership, so a write to a branch the actor
// doesn't belong to is rejected regardless of what the client claims.
export const chainMutators = defineMutators({
  addProduct: defineMutator(addProductInput, async (ctx, args) => {
    if (role(ctx) === "cashier") throw new Error("forbidden: cashiers cannot add products");
    await ctx.tx.insert(products).values({
      id: args.id,
      branch_id: ctx.ownerId,
      name: args.name,
      price: args.price,
      stock: args.stock,
    });
    return { serverId: args.id, affectedBuckets: [ctx.ownerId] };
  }),

  // Owner/manager only — the action-level role gate (rides the signed, tamper-proof actor.role).
  setPrice: defineMutator(setPriceInput, async (ctx, args) => {
    if (role(ctx) !== "owner" && role(ctx) !== "manager") {
      throw new Error("forbidden: only owner/manager can set price");
    }
    await ctx.tx.update(products, { id: args.id }).set({ price: args.price });
    return { serverId: args.id, affectedBuckets: [ctx.ownerId] };
  }),

  // Any role (a cashier adjusts stock as they sell). Field-merges with a concurrent setPrice.
  adjustStock: defineMutator(adjustStockInput, async (ctx, args) => {
    await ctx.tx.update(products, { id: args.id }).set({ stock: args.stock });
    return { serverId: args.id, affectedBuckets: [ctx.ownerId] };
  }),

  recordSale: defineMutator(recordSaleInput, async (ctx, args) => {
    await ctx.tx.insert(sales).values({
      id: args.id,
      branch_id: ctx.ownerId,
      product_id: args.productId,
      qty: args.qty,
      amount: args.amount,
      created_at: new Date(ctx.now()),
    });
    return { serverId: args.id, affectedBuckets: [ctx.ownerId] };
  }),

  // The synced metadata for a receipt attachment. Bytes are uploaded out-of-band (presigned PUT);
  // this row carries the blob key (id) + branch bucket so download authz is branch-scoped.
  attachReceipt: defineMutator(attachReceiptInput, async (ctx, args) => {
    await ctx.tx.insert(receipts).values({
      id: args.id,
      branch_id: ctx.ownerId,
      sale_id: args.saleId,
      mime: args.mime,
      size: args.size,
      status: args.status,
    });
    return { serverId: args.id, affectedBuckets: [ctx.ownerId] };
  }),
});
