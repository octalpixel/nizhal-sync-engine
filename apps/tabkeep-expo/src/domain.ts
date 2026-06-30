import {
  type NizhalCollection,
  type NizhalSQLitePersistence,
  createNizhalMutators,
  manualOnlineDetector,
  nizhalCollectionOptions,
} from "@nizhal/db-collection";
import { createNizhalNitroClient, reactNativeOnlineDetector } from "@nizhal/react-native";
import {
  type SyncRuleBuilder,
  type SyncRules,
  defineMutator,
  defineMutators,
  defineSyncRules,
  z,
} from "@nizhal/kernel";
import { createCollection } from "@tanstack/db";
import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

// Self-contained copy of the Tabkeep domain (a future @nizhal/tabkeep-core would let web + Expo share
// this verbatim). The engine packages are the real shared dependency; this is just the table shapes,
// the three financial verbs, and the one shop-scoped sync rule.
const syncColumns = {
  updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  deleted_at: timestamp("deleted_at", { withTimezone: true }),
};
export const customers = pgTable("customers", {
  id: text("id").primaryKey(),
  shop_id: text("shop_id").notNull(),
  name: text("name").notNull(),
  phone: text("phone"),
  ...syncColumns,
});
export const ledgerEntries = pgTable("ledger_entries", {
  id: text("id").primaryKey(),
  shop_id: text("shop_id").notNull(),
  customer_id: text("customer_id").notNull(),
  kind: text("kind", { enum: ["credit", "payment"] }).notNull(),
  amount: integer("amount").notNull(),
  note: text("note"),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  ...syncColumns,
});
export type CustomerRow = typeof customers.$inferSelect;
export type LedgerEntryRow = typeof ledgerEntries.$inferSelect;

const id = z.string().min(1);
const amount = z.number().int().positive();
const ledgerInput = z.object({ id, customerId: id, amount, note: z.string().trim().optional() });
export const tabkeepMutators = defineMutators({
  addCustomer: defineMutator(
    z.object({ id, name: z.string().trim().min(1), phone: z.string().trim().optional() }),
    async ({ tx, ownerId }, args) => {
      await tx.insert(customers).values({ id: args.id, shop_id: ownerId, name: args.name, phone: args.phone || null });
      return { serverId: args.id, affectedBuckets: [ownerId] };
    },
  ),
  recordCredit: defineMutator(ledgerInput, async ({ tx, ownerId, now }, args) => {
    await tx.insert(ledgerEntries).values({ id: args.id, shop_id: ownerId, customer_id: args.customerId, kind: "credit", amount: args.amount, note: args.note || null, created_at: new Date(now()) });
    return { serverId: args.id, affectedBuckets: [ownerId] };
  }),
  recordPayment: defineMutator(ledgerInput, async ({ tx, ownerId, now }, args) => {
    await tx.insert(ledgerEntries).values({ id: args.id, shop_id: ownerId, customer_id: args.customerId, kind: "payment", amount: args.amount, note: args.note || null, created_at: new Date(now()) });
    return { serverId: args.id, affectedBuckets: [ownerId] };
  }),
});

export const tabkeepSyncRules = defineSyncRules((b: SyncRuleBuilder): SyncRules => ({
  myShop: b.bucket({
    parameters: () => b.params({ ownerId: "shop_id" }),
    data: (bucket) => [
      b.table("customers").where(b.eq("shop_id", bucket.ownerId)),
      b.table("ledger_entries").where(b.eq("shop_id", bucket.ownerId)),
    ],
  }),
}) as unknown as SyncRules);

export async function createTabkeepExpoClient(options: {
  shopId: string;
  userId: string;
  server?: string;
  token?: string;
  refreshToken?: () => Promise<string>;
  /** Dedicated CF realtime Worker host — set for a serverless server (Vercel) + CF Worker realtime. */
  realtimeHost?: string;
  persistence?: NizhalSQLitePersistence;
}) {
  if (!options.server) throw new Error("server is required");
  // Native React Native transport: realtime over native WebSockets (react-native-nitro-websockets,
  // Authorization on the upgrade) + HTTP over nitro-fetch. Installs crypto.randomUUID polyfill.
  // auth.refresh re-fetches a fresh bearer on a 401 so an expired session token is replaced and the
  // mutation retried, instead of the durable outbox dead-lettering the write (4xx park).
  const echo = createNizhalNitroClient({
    server: options.server,
    token: options.token,
    realtimeHost: options.realtimeHost,
    auth: options.token
      ? {
          headers: { authorization: `Bearer ${options.token}` },
          refresh: options.refreshToken
            ? async () => ({ authorization: `Bearer ${await options.refreshToken?.()}` })
            : undefined,
        }
      : undefined,
    bucketsForSyncRule: (rule) => (rule === "myShop" ? [options.shopId] : []),
  });
  const persistence = options.persistence?.persistence;
  const customersC = createCollection(
    nizhalCollectionOptions<CustomerRow>({ name: "customers", syncRule: "myShop", echo, bucketField: "shop_id", getKey: (r) => r.id, persistence }),
  ) as NizhalCollection<CustomerRow>;
  const ledgerC = createCollection(
    nizhalCollectionOptions<LedgerEntryRow>({ name: "ledger_entries", syncRule: "myShop", echo, bucketField: "shop_id", getKey: (r) => r.id, persistence }),
  ) as NizhalCollection<LedgerEntryRow>;
  await Promise.all([customersC.preload(), ledgerC.preload()]);
  // Real connectivity (NetInfo) wrapped in a manual override so the UI can simulate offline
  // deterministically — `setOnline(false)` holds the outbox regardless of the network.
  const onlineDetector = manualOnlineDetector(reactNativeOnlineDetector());
  const mutators = createNizhalMutators({
    collections: { customers: customersC, ledger_entries: ledgerC } as Record<string, NizhalCollection<object>>,
    echo,
    actor: { userId: options.userId, ownerId: options.shopId },
    mutators: tabkeepMutators,
    outboxStorage: options.persistence?.outboxStorage,
    mutationIdStorage: options.persistence?.metaStorage,
    deadLetterStorage: options.persistence?.deadLetterStorage,
    clientID: options.persistence?.clientId,
    onlineDetector,
  });
  await mutators.executor.waitForInit();
  return {
    customers: customersC,
    ledgerEntries: ledgerC,
    mutate: mutators.mutate,
    onlineDetector,
    dispose: mutators.dispose,
  };
}

export function foldLedgerBalance(entries: readonly LedgerEntryRow[], customerId: string): number {
  return entries.reduce((bal, e) => {
    if (e.customer_id !== customerId || e.deleted_at != null) return bal;
    return bal + (e.kind === "credit" ? e.amount : -e.amount);
  }, 0);
}
export function formatMinorUnits(value: number): string {
  const abs = Math.abs(value);
  return `${value < 0 ? "−" : ""}Rs ${Math.floor(abs / 100).toLocaleString("en-US")}.${String(abs % 100).padStart(2, "0")}`;
}
