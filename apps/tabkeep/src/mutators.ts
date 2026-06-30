import { type MutatorCtx, defineMutator, defineMutators } from "@nizhal/kernel";
import { z } from "zod";
import { customers, ledgerEntries } from "./schema.js";

const id = z.string().min(1);
const amount = z.number().int().positive();

export const addCustomerInput = z.object({
  id,
  name: z.string().trim().min(1),
  phone: z.string().trim().optional(),
});

const ledgerEntryInput = z.object({
  id,
  customerId: id,
  amount,
  note: z.string().trim().optional(),
});

export const recordCreditInput = ledgerEntryInput;
export const recordPaymentInput = ledgerEntryInput;

async function appendEntry(
  ctx: MutatorCtx,
  args: z.infer<typeof ledgerEntryInput>,
  kind: "credit" | "payment",
) {
  await ctx.tx.insert(ledgerEntries).values({
    id: args.id,
    shop_id: ctx.ownerId,
    customer_id: args.customerId,
    kind,
    amount: args.amount,
    note: args.note || null,
    created_at: new Date(ctx.now()),
  });
  return { serverId: args.id, affectedBuckets: [ctx.ownerId] };
}

export const tabkeepMutators = defineMutators({
  addCustomer: defineMutator(addCustomerInput, async ({ tx, ownerId }, args) => {
    await tx.insert(customers).values({
      id: args.id,
      shop_id: ownerId,
      name: args.name,
      phone: args.phone || null,
    });
    return { serverId: args.id, affectedBuckets: [ownerId] };
  }),
  recordCredit: defineMutator(recordCreditInput, (ctx, args) => appendEntry(ctx, args, "credit")),
  recordPayment: defineMutator(recordPaymentInput, (ctx, args) =>
    appendEntry(ctx, args, "payment"),
  ),
});
