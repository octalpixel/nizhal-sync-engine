import type { JobTaskHandler, NizhalDb } from "@nizhal/server";
import { and, eq, isNull, sql } from "drizzle-orm";
import { ledgerEntries } from "./schema.js";

export const smsReminderHandler: JobTaskHandler = async ({ input, id }) => {
  const payload = input as {
    entryId?: string;
    customerId?: string;
    shopId?: string;
    kind?: string;
  };
  if (!payload.entryId || !payload.customerId || !payload.shopId) {
    throw new Error("sms-reminder missing required fields");
  }
  // Phase 0: durable enqueue + no-op send; production wires an SMS gateway here.
  void id;
  void payload.kind;
};

export async function outstandingFor(db: NizhalDb, entryId: string): Promise<number> {
  const entry = await db
    .select({ customer_id: ledgerEntries.customer_id })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.id, entryId))
    .limit(1);
  const customerId = entry[0]?.customer_id;
  if (!customerId) return 0;
  const rows = await db
    .select({ balance: sql<string>`coalesce(sum(${ledgerEntries.amount}::numeric), 0)` })
    .from(ledgerEntries)
    .where(and(eq(ledgerEntries.customer_id, customerId), isNull(ledgerEntries.deleted_at)));
  return Number(rows[0]?.balance ?? 0);
}
