import { defineMutator, defineMutators } from "@nizhal/kernel";
import type { NizhalClient, NizhalCollection } from "@nizhal/db-collection";
import {
  createNizhalMutators,
  nizhalCollectionOptions,
  opSqlitePersistence,
} from "@nizhal/db-collection";
import { IOS_DOCUMENT_PATH, open } from "@op-engineering/op-sqlite";
import { createCollection } from "@tanstack/db";
import { pgTable, text } from "drizzle-orm/pg-core";

export interface LedgerEntryRow {
  id: string;
  shop_id: string;
  customer_id: string;
  amount: string;
  reason: string | null;
  ref: string | null;
  at: string;
  created_by: string;
  client_id: string;
}

const ledger_entries = pgTable("ledger_entries", {
  id: text("id").primaryKey(),
  shop_id: text("shop_id").notNull(),
  customer_id: text("customer_id").notNull(),
  amount: text("amount").notNull(),
  reason: text("reason"),
  ref: text("ref"),
  at: text("at").notNull(),
  created_by: text("created_by").notNull(),
  client_id: text("client_id"),
});

const ledgerMutators = defineMutators({
  recordCredit: defineMutator({ parse: parseRecordCredit }, async ({ tx, actor }, args) => {
    const at = new Date(args.at ?? Date.now()).toISOString();
    await tx.insert(ledger_entries).values({
      id: args.clientId,
      shop_id: "shop-a",
      customer_id: args.customerId,
      amount: String(args.amount),
      reason: args.reason ?? null,
      ref: args.ref ?? null,
      at,
      created_by: actor.userId,
      client_id: args.clientId,
    });
    return { affectedBuckets: ["shop-a"] };
  }),
});

function parseRecordCredit(input: unknown): {
  clientId: string;
  customerId: string;
  amount: number;
  reason?: string;
  ref?: string;
  at?: string;
} {
  if (typeof input !== "object" || input === null) {
    throw new Error("invalid recordCredit input");
  }
  const value = input as {
    clientId?: unknown;
    customerId?: unknown;
    amount?: unknown;
    reason?: unknown;
    ref?: unknown;
    at?: unknown;
  };
  if (
    typeof value.clientId !== "string" ||
    typeof value.customerId !== "string" ||
    typeof value.amount !== "number"
  ) {
    throw new Error("invalid recordCredit input");
  }
  return {
    clientId: value.clientId,
    customerId: value.customerId,
    amount: value.amount,
    ...(typeof value.reason === "string" ? { reason: value.reason } : {}),
    ...(typeof value.ref === "string" ? { ref: value.ref } : {}),
    ...(typeof value.at === "string" ? { at: value.at } : {}),
  };
}

function createOfflineEcho(): NizhalClient {
  return {
    pull: async () => ({ changed: [], tombstoned: [], cursor: "" }),
    push: () => new Promise<never>(() => {}),
    getLastMutationId: () => 0,
    subscribe: () => () => {},
    subscribePresence: () => () => {},
    onPresence: () => () => {},
    track: () => {},
    untrack: () => {},
    presenceState: () => ({}),
    presence: () => [],
    getCursor: () => "",
    setCursor: () => {},
    getScopeBuckets: () => [],
    getPullPageSize: () => undefined,
    getBucketTtlMs: () => undefined,
    getPullIntervalMs: () => undefined,
    setDeviceId: () => {},
    reportError: () => {},
    syncStatus: () => ({
      connectivity: "offline",
      pendingMutations: 0,
      deadLettered: 0,
      lastPullCursor: "",
      lastPulledAt: null,
      lastError: null,
    }),
    onSyncStatus: () => () => {},
    outbox: {
      list: async () => [],
      deadLetter: () => [],
    },
  };
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 20_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out waiting for condition");
}

async function waitForAsyncPersist() {
  await new Promise((resolve) => setTimeout(resolve, 300));
}

function openLedgerDatabase() {
  return open({
    name: "ledger.db",
    location: IOS_DOCUMENT_PATH,
  });
}

export async function runOpSqliteLedgerProbe(): Promise<void> {
  const db1 = openLedgerDatabase();
  const store1 = await opSqlitePersistence({ database: db1 });

  const echo1 = createOfflineEcho();
  const collection1 = createCollection(
    nizhalCollectionOptions<LedgerEntryRow>({
      name: "ledger_entries",
      syncRule: "shopBucket",
      echo: echo1,
      getKey: (row) => row.client_id ?? row.id,
      persistence: store1.persistence,
    }),
  ) as NizhalCollection<LedgerEntryRow>;

  await collection1.preload();

  const { mutate: mutate1, executor: executor1 } = createNizhalMutators({
    collections: { ledger_entries: collection1 } as Record<string, NizhalCollection<object>>,
    echo: echo1,
    actor: { userId: "user-a", ownerId: "owner-a", shopId: "shop-a" },
    mutators: ledgerMutators,
    outboxStorage: store1.outboxStorage,
    mutationIdStorage: store1.metaStorage,
    deadLetterStorage: store1.deadLetterStorage,
    clientID: store1.clientId,
  });
  await executor1.waitForInit();

  mutate1.recordCredit({
    clientId: "entry-1",
    customerId: "customer-a",
    amount: 150.5,
    reason: "goods on credit",
    at: "2026-06-25T12:00:00.000Z",
  });

  await waitFor(() => executor1.getPendingCount() > 0);
  if (!collection1.toArray.some((row) => row.client_id === "entry-1")) {
    throw new Error("entry-1 not in collection after mutate");
  }
  await waitForAsyncPersist();
  await store1.flushOutbox();

  executor1.dispose();
  await collection1.cleanup();
  db1.close();

  const db2 = openLedgerDatabase();
  const store2 = await opSqlitePersistence({ database: db2 });
  const echo2 = createOfflineEcho();
  const collection2 = createCollection(
    nizhalCollectionOptions<LedgerEntryRow>({
      name: "ledger_entries",
      syncRule: "shopBucket",
      echo: echo2,
      getKey: (row) => row.client_id ?? row.id,
      persistence: store2.persistence,
    }),
  ) as NizhalCollection<LedgerEntryRow>;

  const { executor: executor2 } = createNizhalMutators({
    collections: { ledger_entries: collection2 } as Record<string, NizhalCollection<object>>,
    echo: echo2,
    actor: { userId: "user-a", ownerId: "owner-a", shopId: "shop-a" },
    mutators: ledgerMutators,
    outboxStorage: store2.outboxStorage,
    mutationIdStorage: store2.metaStorage,
    deadLetterStorage: store2.deadLetterStorage,
    clientID: store2.clientId,
  });

  await collection2.preload();
  await executor2.waitForInit();
  await waitFor(() => collection2.toArray.some((row) => row.client_id === "entry-1"));

  const restored = collection2.toArray.find((row) => row.client_id === "entry-1");
  if (restored?.amount !== "150.5") {
    throw new Error(`amount mismatch: ${restored?.amount}`);
  }
  if (restored?.reason !== "goods on credit") {
    throw new Error(`reason mismatch: ${restored?.reason}`);
  }
  if (restored?.ref !== null) {
    throw new Error(`ref mismatch: ${String(restored?.ref)}`);
  }
  const expectedAt = "2026-06-25T12:00:00.000Z";
  if (restored?.at !== expectedAt) {
    throw new Error(`at mismatch: ${String(restored?.at)}`);
  }

  executor2.dispose();
  await collection2.cleanup();
  db2.close();
}
