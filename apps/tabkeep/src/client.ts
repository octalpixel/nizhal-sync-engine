import {
  type NizhalCollection,
  type NizhalSQLitePersistence,
  createNizhalClient,
  createNizhalMutators,
  nizhalCollectionOptions,
} from "@nizhal/db-collection";
import { createCollection } from "@tanstack/db";
import { tabkeepMutators } from "./mutators.js";
import type { CustomerRow, LedgerEntryRow } from "./schema.js";

export interface TabkeepClientOptions {
  shopId: string;
  userId: string;
  server?: string;
  token?: string;
  refreshToken?: () => Promise<string>;
  persistence?: NizhalSQLitePersistence;
  subscribeSource?: Parameters<typeof createNizhalClient>[0]["subscribeSource"];
}

export async function createTabkeepClient(options: TabkeepClientOptions) {
  // auth.refresh re-fetches a fresh bearer on a 401 so an expired session token is replaced and the
  // mutation retried, instead of the durable outbox dead-lettering the write (4xx park).
  const echo = createNizhalClient({
    server: options.server,
    auth: options.token
      ? {
          headers: { authorization: `Bearer ${options.token}` },
          refresh: options.refreshToken
            ? async () => ({ authorization: `Bearer ${await options.refreshToken?.()}` })
            : undefined,
        }
      : undefined,
    subscribeSource: options.subscribeSource,
    bucketsForSyncRule: (rule) => (rule === "myShop" ? [options.shopId] : []),
  });
  const persistence = options.persistence?.persistence;

  const customers = createCollection(
    nizhalCollectionOptions<CustomerRow>({
      name: "customers",
      syncRule: "myShop",
      echo,
      bucketField: "shop_id",
      getKey: (row) => row.id,
      persistence,
    }),
  ) as NizhalCollection<CustomerRow>;

  const ledgerEntries = createCollection(
    nizhalCollectionOptions<LedgerEntryRow>({
      name: "ledger_entries",
      syncRule: "myShop",
      echo,
      bucketField: "shop_id",
      getKey: (row) => row.id,
      persistence,
    }),
  ) as NizhalCollection<LedgerEntryRow>;

  await Promise.all([customers.preload(), ledgerEntries.preload()]);

  const mutators = createNizhalMutators({
    collections: { customers, ledger_entries: ledgerEntries } as Record<
      string,
      NizhalCollection<object>
    >,
    echo,
    actor: { userId: options.userId, ownerId: options.shopId },
    mutators: tabkeepMutators,
    outboxStorage: options.persistence?.outboxStorage,
    mutationIdStorage: options.persistence?.metaStorage,
    deadLetterStorage: options.persistence?.deadLetterStorage,
    clientID: options.persistence?.clientId,
  });
  await mutators.executor.waitForInit();

  return {
    customers,
    ledgerEntries,
    echo,
    mutate: mutators.mutate,
    waitForIdle: mutators.waitForIdle,
    dispose: mutators.dispose,
    remoteSyncEnabled: options.server !== undefined,
  };
}

export type TabkeepClient = Awaited<ReturnType<typeof createTabkeepClient>>;

export function foldLedgerBalance(entries: readonly LedgerEntryRow[], customerId: string): number {
  return entries.reduce((balance, entry) => {
    if (entry.customer_id !== customerId || entry.deleted_at != null) return balance;
    return balance + (entry.kind === "credit" ? entry.amount : -entry.amount);
  }, 0);
}

export function parseMinorUnits(input: string): number {
  const match = /^\s*(\d+)(?:\.(\d{1,2}))?\s*$/.exec(input);
  if (!match) throw new Error("Enter a positive amount with at most two decimal places");
  const whole = Number(match[1]);
  const fraction = Number((match[2] ?? "").padEnd(2, "0"));
  const value = whole * 100 + fraction;
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Amount is out of range");
  return value;
}

export function formatMinorUnits(value: number): string {
  if (!Number.isSafeInteger(value)) throw new Error("Money must be an integer minor-unit value");
  const absolute = Math.abs(value);
  const major = Math.floor(absolute / 100);
  const minor = String(absolute % 100).padStart(2, "0");
  return `${value < 0 ? "−" : ""}Rs ${major.toLocaleString("en-US")}.${minor}`;
}
