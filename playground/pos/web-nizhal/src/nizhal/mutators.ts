import { type MutatorFn, defineMutator, defineMutators } from "@nizhal/kernel";
import { z } from "zod";
import { products, saleItems, sales } from "./schema";

// Mutators run optimistically on the client and (later) authoritatively on the server.
// The optimistic tx is write-only, so we record sales append-only and derive available
// stock as initial − sold in the UI (the "balance = fold" pattern), instead of reading
// current stock to decrement it.
export const addProductInput = z.object({
  clientId: z.string(),
  name: z.string().min(1),
  price: z.number().nonnegative(),
  stock: z.number().int().nonnegative(),
});

export const recordSaleInput = z.object({
  clientId: z.string(),
  items: z
    .array(
      z.object({
        itemId: z.string(),
        productId: z.string(),
        qty: z.number().int().positive(),
        unitPrice: z.number().nonnegative(),
      }),
    )
    .min(1),
});

export const addProduct: MutatorFn<z.infer<typeof addProductInput>> = async (
  { tx, ownerId, newId },
  args,
) => {
  await tx.insert(products).values({
    id: args.clientId || newId(),
    owner_id: ownerId,
    name: args.name,
    price: args.price,
    stock: args.stock,
  });
};

export const recordSale: MutatorFn<z.infer<typeof recordSaleInput>> = async (
  { tx, ownerId, newId },
  args,
) => {
  const saleId = args.clientId || newId();
  const total = args.items.reduce((sum, it) => sum + it.unitPrice * it.qty, 0);
  await tx.insert(sales).values({
    id: saleId,
    owner_id: ownerId,
    total,
    created_at: new Date().toISOString(),
  });
  for (const it of args.items) {
    await tx.insert(saleItems).values({
      id: it.itemId,
      owner_id: ownerId,
      sale_id: saleId,
      product_id: it.productId,
      qty: it.qty,
      unit_price: it.unitPrice,
    });
  }
};

export const posMutators = defineMutators({
  addProduct: defineMutator(addProductInput, addProduct),
  recordSale: defineMutator(recordSaleInput, recordSale),
});
