import { nizhalCollectionOptions } from "@nizhal/db-collection";
import { defineMutator, defineMutators } from "@nizhal/kernel";
import type { MutatorDef, MutatorRegistry } from "@nizhal/kernel";
import { bearerTokenAuth, signHs256Jwt } from "@nizhal/server";
import type { NizhalAuth } from "@nizhal/server";
import { createCollection } from "@tanstack/db";
import { CREDIT_LEDGER_DDL, creditLedgerSchema } from "credit-ledger";
import { creditLedgerMutators } from "credit-ledger";
import { creditLedgerSyncRules } from "credit-ledger";
import { smsReminderHandler } from "credit-ledger";
import type { CustomerRow, LedgerEntryRow, ReminderRow } from "credit-ledger";
import { type ChaosHarness, createChaosHarness } from "../harness/chaos-harness.js";

export const CHAOS_AUTH_SECRET = "chaos-test-secret";
export const SHOP_A = "shop-a";
export const SHOP_B = "shop-b";
export const USER_A = "user-a";
export const USER_B = "user-b";
export const CUSTOMER_A = "customer-a";

export function createCreditChaosMutators(poisoned: Set<string>): MutatorRegistry {
  const wrapped: Record<string, MutatorDef<unknown>> = {};
  for (const [name, def] of Object.entries(creditLedgerMutators) as [
    string,
    MutatorDef<unknown>,
  ][]) {
    wrapped[name] = defineMutator(def.schema, async (ctx, args) => {
      if (ctx.location === "server" && poisoned.has(name)) {
        throw new Error(`deterministic poison failure: ${name}`);
      }
      return def.fn(ctx, args);
    });
  }
  return defineMutators(wrapped) as MutatorRegistry;
}

export function creditChaosAuth(): NizhalAuth {
  return bearerTokenAuth({ secret: CHAOS_AUTH_SECRET });
}

export function mintCreditToken(input: {
  userId: string;
  ownerId: string;
  shopId: string;
  expiresInSec?: number;
}): string {
  const exp = Math.floor(Date.now() / 1000) + (input.expiresInSec ?? 3600);
  return signHs256Jwt(
    {
      userId: input.userId,
      ownerId: input.ownerId,
      shopId: input.shopId,
      exp,
    },
    CHAOS_AUTH_SECRET,
  );
}

export const CREDIT_SEED_SQL = `
  insert into shops (id, name, owner_id) values
    ('${SHOP_A}', 'Shop A', 'owner-a'),
    ('${SHOP_B}', 'Shop B', 'owner-b');
  insert into shop_members (shop_id, user_id, role) values
    ('${SHOP_A}', '${USER_A}', 'owner'),
    ('${SHOP_A}', '${USER_B}', 'member'),
    ('${SHOP_B}', 'user-b-other', 'owner');
  insert into customers (id, shop_id, name, phone, client_id)
    values ('${CUSTOMER_A}', '${SHOP_A}', 'Amara', '+94770000001', '${CUSTOMER_A}');
  insert into customers (id, shop_id, name, phone, client_id)
    values ('customer-b', '${SHOP_B}', 'Shop B Customer', '+94770000002', 'customer-b');
`;

export async function createCreditChaosHarness(): Promise<ChaosHarness> {
  return createChaosHarness({
    schema: creditLedgerSchema,
    syncRules: creditLedgerSyncRules,
    mutatorsFactory: createCreditChaosMutators,
    ddl: CREDIT_LEDGER_DDL,
    auth: creditChaosAuth(),
    seedSql: CREDIT_SEED_SQL,
    jobs: { "sms-reminder": smsReminderHandler },
    bucketKey: SHOP_A,
  });
}

export function buildCreditCollections(input: {
  echo: Parameters<typeof nizhalCollectionOptions>[0]["echo"];
  persistence?: Parameters<typeof nizhalCollectionOptions>[0]["persistence"];
}) {
  const customers = createCollection(
    nizhalCollectionOptions<CustomerRow>({
      name: "customers",
      syncRule: "myShops",
      echo: input.echo,
      bucketField: "shop_id",
      getKey: (row) => row.client_id ?? row.id,
      persistence: input.persistence,
    }),
  );
  const ledger_entries = createCollection(
    nizhalCollectionOptions<LedgerEntryRow>({
      name: "ledger_entries",
      syncRule: "myShops",
      echo: input.echo,
      bucketField: "shop_id",
      getKey: (row) => row.client_id ?? row.id,
      persistence: input.persistence,
    }),
  );
  const reminders = createCollection(
    nizhalCollectionOptions<ReminderRow>({
      name: "reminders",
      syncRule: "myShops",
      echo: input.echo,
      bucketField: "shop_id",
      getKey: (row) => row.id,
      persistence: input.persistence,
    }),
  );
  return { customers, ledger_entries, reminders };
}

export function foldCreditBalance(
  entries: readonly Pick<LedgerEntryRow, "customer_id" | "amount" | "deleted_at">[],
  customerId: string,
): number {
  return entries
    .filter((entry) => entry.customer_id === customerId && entry.deleted_at == null)
    .reduce((sum, entry) => sum + Number(entry.amount), 0);
}
