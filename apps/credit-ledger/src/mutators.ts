import { type Actor, defineMutator, defineMutators } from "@nizhal/kernel";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { customers, ledgerEntries } from "./schema.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export const addCustomerInput = z.object({
  clientId: z.string(),
  name: z.string().min(1),
  phone: z.string().optional(),
  note: z.string().optional(),
});

export const recordCreditInput = z.object({
  clientId: z.string(),
  customerId: z.string(),
  amount: z.number().positive(),
  reason: z.string().optional(),
  ref: z.string().optional(),
  at: z.string().datetime().optional(),
  dueDate: z.string().datetime().optional(),
});

export const recordPaymentInput = z.object({
  clientId: z.string(),
  customerId: z.string(),
  amount: z.number().positive(),
  reason: z.string().optional(),
  ref: z.string().optional(),
  at: z.string().datetime().optional(),
});

export const updateCustomerFieldInput = z.object({
  customerId: z.string(),
  value: z.string().min(1),
});

export const deleteCustomerInput = z.object({
  customerId: z.string(),
});

function requireShopId(actor: Actor): string {
  const shopId = actor.shopId;
  if (typeof shopId !== "string" || shopId.length === 0) {
    throw new Error("missing shopId on authenticated actor");
  }
  return shopId;
}

function requireAffectedRow(result: unknown, entity: string): void {
  if (!Array.isArray(result) || result.length === 0) {
    throw new Error(`${entity} not found in the actor's shop`);
  }
}

export const creditLedgerMutators = defineMutators({
  addCustomer: defineMutator(addCustomerInput, async ({ tx, actor, newId }, args) => {
    const shopId = requireShopId(actor);
    const id = args.clientId || newId();
    await tx.insert(customers).values({
      id,
      shop_id: shopId,
      name: args.name,
      phone: args.phone ?? null,
      note: args.note ?? null,
      client_id: args.clientId,
    });
    return { serverId: id, affectedBuckets: [shopId] };
  }),

  recordCredit: defineMutator(
    recordCreditInput,
    async ({ tx, actor, newId, jobs, location }, args) => {
      const shopId = requireShopId(actor);
      const entryId = args.clientId || newId();
      const at = new Date(args.at ?? Date.now());
      await tx.insert(ledgerEntries).values({
        id: entryId,
        shop_id: shopId,
        customer_id: args.customerId,
        amount: String(args.amount),
        reason: args.reason ?? null,
        ref: args.ref ?? null,
        at,
        created_by: actor.userId,
        client_id: args.clientId,
      });

      if (location === "server" && args.dueDate) {
        const dueMs = new Date(args.dueDate).getTime();
        jobs.scheduleAt(dueMs - DAY_MS, "sms-reminder", {
          entryId,
          customerId: args.customerId,
          shopId,
          kind: "before",
        });
        jobs.scheduleAt(dueMs + DAY_MS, "sms-reminder", {
          entryId,
          customerId: args.customerId,
          shopId,
          kind: "after",
        });
      } else if (location === "server") {
        jobs.scheduleAt(Date.now() + DAY_MS, "sms-reminder", {
          entryId,
          customerId: args.customerId,
          shopId,
          kind: "due",
        });
      }

      return { serverId: entryId, affectedBuckets: [shopId] };
    },
  ),

  updateCustomerName: defineMutator(
    updateCustomerFieldInput,
    async ({ tx, actor, location }, args) => {
      const shopId = requireShopId(actor);
      const rows = await tx
        .update(customers)
        .set({ name: args.value })
        .where(
          location === "server"
            ? (table) => sql`${table.id} = ${args.customerId} and ${table.shop_id} = ${shopId}`
            : eq(customers.id, args.customerId),
        );
      if (location === "server") requireAffectedRow(rows, "customer");
      return { affectedBuckets: [shopId] };
    },
  ),

  updateCustomerPhone: defineMutator(
    updateCustomerFieldInput,
    async ({ tx, actor, location }, args) => {
      const shopId = requireShopId(actor);
      const rows = await tx
        .update(customers)
        .set({ phone: args.value })
        .where(
          location === "server"
            ? (table) => sql`${table.id} = ${args.customerId} and ${table.shop_id} = ${shopId}`
            : eq(customers.id, args.customerId),
        );
      if (location === "server") requireAffectedRow(rows, "customer");
      return { affectedBuckets: [shopId] };
    },
  ),

  deleteCustomer: defineMutator(deleteCustomerInput, async ({ tx, actor, location }, args) => {
    const shopId = requireShopId(actor);
    const rows = await tx
      .delete(customers)
      .where(
        location === "server"
          ? (table) => sql`${table.id} = ${args.customerId} and ${table.shop_id} = ${shopId}`
          : eq(customers.id, args.customerId),
      );
    if (location === "server") requireAffectedRow(rows, "customer");
    return { affectedBuckets: [shopId] };
  }),

  recordPayment: defineMutator(recordPaymentInput, async ({ tx, actor, newId }, args) => {
    const shopId = requireShopId(actor);
    const entryId = args.clientId || newId();
    const at = new Date(args.at ?? Date.now());
    await tx.insert(ledgerEntries).values({
      id: entryId,
      shop_id: shopId,
      customer_id: args.customerId,
      amount: String(-Math.abs(args.amount)),
      reason: args.reason ?? null,
      ref: args.ref ?? null,
      at,
      created_by: actor.userId,
      client_id: args.clientId,
    });
    return { serverId: entryId, affectedBuckets: [shopId] };
  }),
});
