import type { NizhalCollection } from "@nizhal/db-collection";
import {
  createNizhalClient,
  createNizhalMutators,
  nizhalCollectionOptions,
} from "@nizhal/db-collection";
import { createCollection } from "@tanstack/db";
import { creditLedgerMutators } from "./mutators.js";
import type { CustomerRow, LedgerEntryRow, ReminderRow } from "./schema.js";

export interface CreditLedgerClientOptions {
  server: string;
  shopId: string;
  userId: string;
  subscribeSource?: Parameters<typeof createNizhalClient>[0]["subscribeSource"];
}

export function createCreditLedgerClient(opts: CreditLedgerClientOptions) {
  const echo = createNizhalClient({
    server: opts.server,
    subscribeSource: opts.subscribeSource,
    bucketsForSyncRule: () => [opts.shopId],
  });

  const customers = createCollection(
    nizhalCollectionOptions<CustomerRow>({
      name: "customers",
      syncRule: "myShops",
      echo,
      bucketField: "shop_id",
      getKey: (row) => row.client_id ?? row.id,
    }),
  ) as NizhalCollection<CustomerRow>;

  const ledgerEntries = createCollection(
    nizhalCollectionOptions<LedgerEntryRow>({
      name: "ledger_entries",
      syncRule: "myShops",
      echo,
      bucketField: "shop_id",
      getKey: (row) => row.client_id ?? row.id,
    }),
  ) as NizhalCollection<LedgerEntryRow>;

  const reminders = createCollection(
    nizhalCollectionOptions<ReminderRow>({
      name: "reminders",
      syncRule: "myShops",
      echo,
      bucketField: "shop_id",
      getKey: (row) => row.id,
    }),
  ) as NizhalCollection<ReminderRow>;

  const { mutate, executor } = createNizhalMutators({
    collections: {
      customers,
      ledger_entries: ledgerEntries,
      reminders,
    } as Record<string, NizhalCollection<object>>,
    echo,
    actor: {
      userId: opts.userId,
      ownerId: opts.shopId,
      shopId: opts.shopId,
    },
    mutators: creditLedgerMutators,
  });

  return { customers, ledgerEntries, reminders, echo, mutate, executor };
}

export type CreditLedgerClient = ReturnType<typeof createCreditLedgerClient>;

export function foldLedgerBalance(entries: readonly LedgerEntryRow[], customerId: string): number {
  return entries
    .filter((entry) => entry.customer_id === customerId && entry.deleted_at == null)
    .reduce((sum, entry) => sum + Number(entry.amount), 0);
}

export function customerBalance(
  ledgerEntries: { toArray: readonly LedgerEntryRow[] },
  customerId: string,
): number {
  return foldLedgerBalance(ledgerEntries.toArray, customerId);
}
