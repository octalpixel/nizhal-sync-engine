import type { CustomerRow } from "credit-ledger";
import {
  CUSTOMER_A,
  SHOP_A,
  USER_A,
  USER_B,
  buildCreditCollections,
  createCreditChaosHarness,
  createCreditChaosMutators,
  mintCreditToken,
} from "../credit/setup.js";
import { waitFor } from "../harness/chaos-harness.js";
import type { ChaosClientHandle } from "../harness/chaos-harness.js";

const SYNC_PULL_INTERVAL_MS = 400;
const GARBAGE_CURSOR = "not-a-valid-nizhal-cursor";

async function bootSyncClient(
  harness: Awaited<ReturnType<typeof createCreditChaosHarness>>,
  input: {
    id: string;
    userId: string;
    pullIntervalMs?: number;
  },
): Promise<ChaosClientHandle> {
  const token = mintCreditToken({
    userId: input.userId,
    ownerId: "owner-a",
    shopId: SHOP_A,
  });
  const client = await harness.createClient({
    id: input.id,
    userId: input.userId,
    ownerId: "owner-a",
    bucket: SHOP_A,
    actorExtras: { shopId: SHOP_A },
    authHeaders: { authorization: `Bearer ${token}` },
    persist: true,
    pullIntervalMs: input.pullIntervalMs,
    mutators: createCreditChaosMutators(harness.poisoned),
    buildCollections: ({ echo, persistence }) => buildCreditCollections({ echo, persistence }),
  });
  await Promise.all(Object.values(client.collections).map((c) => c.preload()));
  await client.executor.waitForInit();
  return client;
}

function creditMutate(client: ChaosClientHandle) {
  return client.mutate as {
    deleteCustomer: (args: { customerId: string }) => void;
    updateCustomerName: (args: { customerId: string; value: string }) => void;
    updateCustomerPhone: (args: { customerId: string; value: string }) => void;
    recordPayment: (args: { clientId: string; customerId: string; amount: number }) => void;
  };
}

function hasCustomer(client: ChaosClientHandle, customerId: string): boolean {
  return (client.collections.customers?.toArray ?? []).some(
    (row) => (row as CustomerRow).id === customerId,
  );
}

async function pushSequenced(
  harness: Awaited<ReturnType<typeof createCreditChaosHarness>>,
  mutation: {
    name: string;
    args: unknown;
    clientID: string;
    mutationID: number;
    clientMutationId: string;
  },
): Promise<Response> {
  const token = mintCreditToken({ userId: USER_A, ownerId: "owner-a", shopId: SHOP_A });
  return fetch(`${harness.baseUrl}/sync/push`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ mutations: [mutation] }),
  });
}

export async function runSync1(): Promise<void> {
  const harness = await createCreditChaosHarness();
  try {
    const a = await bootSyncClient(harness, { id: "sync1-a", userId: USER_A });
    const b = await bootSyncClient(harness, { id: "sync1-b", userId: USER_B });
    harness.partition(a.id);
    harness.partition(b.id);

    creditMutate(a).deleteCustomer({ customerId: CUSTOMER_A });
    creditMutate(b).updateCustomerName({ customerId: CUSTOMER_A, value: "Should Not Survive" });

    harness.heal(a.id);
    harness.heal(b.id);
    await harness.converge();

    const serverRows = await harness.db.query<{ id: string }>(
      "select id from customers where shop_id = $1 and deleted_at is null",
      [SHOP_A],
    );
    if (serverRows.rows.some((row) => row.id === CUSTOMER_A)) {
      throw new Error("SYNC-1: tombstone policy failed — deleted customer still active on server");
    }
    if (hasCustomer(a, CUSTOMER_A) || hasCustomer(b, CUSTOMER_A)) {
      throw new Error("SYNC-1: tombstone wins — customer resurrected on a replica");
    }
    await harness.assertInvariants({ tables: ["customers"], bucket: SHOP_A });
  } finally {
    await harness.close();
  }
}

export async function runSync2(): Promise<void> {
  const harness = await createCreditChaosHarness();
  try {
    const clientId = "sync2-client";
    const outOfOrder = await pushSequenced(harness, {
      name: "updateCustomerPhone",
      args: { customerId: CUSTOMER_A, value: "+94111111111" },
      clientID: clientId,
      mutationID: 2,
      clientMutationId: "sync2-cmid-2",
    });
    if (outOfOrder.status !== 409) {
      throw new Error(`SYNC-2: expected 409 for out-of-order mutation 2, got ${outOfOrder.status}`);
    }

    const first = await pushSequenced(harness, {
      name: "updateCustomerName",
      args: { customerId: CUSTOMER_A, value: "Ordered Name" },
      clientID: clientId,
      mutationID: 1,
      clientMutationId: "sync2-cmid-1",
    });
    if (!first.ok) {
      throw new Error(`SYNC-2: mutation 1 failed: ${first.status} ${await first.text()}`);
    }

    const second = await pushSequenced(harness, {
      name: "updateCustomerPhone",
      args: { customerId: CUSTOMER_A, value: "+94111111111" },
      clientID: clientId,
      mutationID: 2,
      clientMutationId: "sync2-cmid-2",
    });
    if (!second.ok) {
      throw new Error(`SYNC-2: mutation 2 retry failed: ${second.status} ${await second.text()}`);
    }

    const row = await harness.db.query<{ name: string; phone: string | null }>(
      "select name, phone from customers where id = $1",
      [CUSTOMER_A],
    );
    const customer = row.rows[0];
    if (customer?.name !== "Ordered Name" || customer?.phone !== "+94111111111") {
      throw new Error(`SYNC-2: in-order result mismatch: ${JSON.stringify(customer)}`);
    }

    const lmid = await harness.db.query<{ last_mutation_id: number }>(
      "select last_mutation_id from _nizhal_clients where client_id = $1",
      [clientId],
    );
    if (lmid.rows[0]?.last_mutation_id !== 2) {
      throw new Error(`SYNC-2: LMID not advanced to 2: ${JSON.stringify(lmid.rows)}`);
    }

    const dup = await pushSequenced(harness, {
      name: "updateCustomerPhone",
      args: { customerId: CUSTOMER_A, value: "+94111111111" },
      clientID: clientId,
      mutationID: 2,
      clientMutationId: "sync2-cmid-2",
    });
    if (!dup.ok) {
      throw new Error(`SYNC-2: idempotent replay of mutation 2 failed: ${dup.status}`);
    }
    const applied = await harness.db.query<{ count: number }>(
      "select count(*)::int as count from _nizhal_mutations where client_mutation_id like 'sync2-%'",
    );
    if ((applied.rows[0]?.count ?? 0) !== 2) {
      throw new Error("SYNC-2: duplicate replay created extra mutation rows");
    }
  } finally {
    await harness.close();
  }
}

export async function runSync3(): Promise<void> {
  const harness = await createCreditChaosHarness();
  try {
    const a = await bootSyncClient(harness, { id: "sync3-a", userId: USER_A });
    const b = await bootSyncClient(harness, {
      id: "sync3-b",
      userId: USER_B,
      pullIntervalMs: SYNC_PULL_INTERVAL_MS,
    });

    await waitFor(() => hasCustomer(b, CUSTOMER_A));
    harness.partition(b.id);
    harness.realtime.disconnect();

    creditMutate(a).deleteCustomer({ customerId: CUSTOMER_A });
    await waitFor(async () => {
      const rows = await harness.db.query("select id from customers where id = $1", [CUSTOMER_A]);
      return rows.rows.length === 0;
    });
    await waitFor(() => a.executor.getPendingCount() === 0);

    if (!hasCustomer(b, CUSTOMER_A)) {
      throw new Error("SYNC-3 setup: lagging client lost seeded row before delete propagated");
    }

    harness.heal(b.id);
    await waitFor(() => !hasCustomer(b, CUSTOMER_A), SYNC_PULL_INTERVAL_MS * 6);

    if (hasCustomer(b, CUSTOMER_A)) {
      throw new Error("SYNC-3: tombstone not respected — lagging client resurrected deleted row");
    }
    if (harness.realtime.deliveredPublishCount() > 0) {
      throw new Error("SYNC-3: scenario must not rely on realtime pokes");
    }
    await harness.assertInvariants({ tables: ["customers"], bucket: SHOP_A });
  } finally {
    await harness.close();
  }
}

export async function runSync4(): Promise<void> {
  const harness = await createCreditChaosHarness();
  try {
    const client = await bootSyncClient(harness, {
      id: "sync4-client",
      userId: USER_A,
      pullIntervalMs: SYNC_PULL_INTERVAL_MS,
    });
    await waitFor(() => hasCustomer(client, CUSTOMER_A));

    await harness.db.exec(
      `insert into customers (id, shop_id, name, phone, client_id)
       values ('customer-sync4', '${SHOP_A}', 'Bootstrap Row', '+94771112222', 'customer-sync4')`,
    );

    let forceGarbagePull = true;
    const basePull = client.echo.pull.bind(client.echo);
    client.echo.pull = async (input) => {
      const pullInput = forceGarbagePull ? { ...input, cursor: GARBAGE_CURSOR } : input;
      const result = await basePull(pullInput);
      if (forceGarbagePull) {
        forceGarbagePull = false;
        if (!result.cursorReset) {
          throw new Error("SYNC-4: expected cursorReset on garbage cursor pull");
        }
        const ids = result.changed
          .flatMap((batch) => batch.rows)
          .filter((row) => (row as CustomerRow).shop_id === SHOP_A)
          .map((row) => (row as CustomerRow).id);
        if (!ids.includes("customer-sync4")) {
          throw new Error(
            `SYNC-4: garbage cursor did not re-bootstrap — got ${JSON.stringify(ids)}`,
          );
        }
      }
      return result;
    };

    await waitFor(() => hasCustomer(client, "customer-sync4"), SYNC_PULL_INTERVAL_MS * 10);

    const serverCount = await harness.db.query<{ count: number }>(
      "select count(*)::int as count from customers where shop_id = $1 and deleted_at is null",
      [SHOP_A],
    );
    const localCount = (client.collections.customers?.toArray ?? []).length;
    if (localCount !== serverCount.rows[0]?.count) {
      throw new Error(
        `SYNC-4: partial state after cursor reset — client=${localCount} server=${serverCount.rows[0]?.count}`,
      );
    }
    await harness.assertInvariants({ tables: ["customers"], bucket: SHOP_A });
  } finally {
    await harness.close();
  }
}

export async function runSync5(): Promise<void> {
  const harness = await createCreditChaosHarness();
  try {
    harness.realtime.disconnect();

    const a = await bootSyncClient(harness, {
      id: "sync5-a",
      userId: USER_A,
      pullIntervalMs: SYNC_PULL_INTERVAL_MS,
    });
    const b = await bootSyncClient(harness, {
      id: "sync5-b",
      userId: USER_B,
      pullIntervalMs: SYNC_PULL_INTERVAL_MS,
    });

    await waitFor(() => hasCustomer(a, CUSTOMER_A) && hasCustomer(b, CUSTOMER_A));

    creditMutate(a).recordPayment({
      clientId: "sync5-payment",
      customerId: CUSTOMER_A,
      amount: 250,
    });
    await waitFor(() => a.executor.getPendingCount() === 0);
    await waitFor(async () => {
      const rows = await harness.db.query("select 1 from ledger_entries where client_id = $1", [
        "sync5-payment",
      ]);
      return rows.rows.length === 1;
    });

    if (harness.realtime.deliveredPublishCount() > 0) {
      throw new Error("SYNC-5: realtime pokes must be fully dropped");
    }

    await waitFor(
      () =>
        (a.collections.ledger_entries?.toArray ?? []).some(
          (row) => (row as { client_id?: string }).client_id === "sync5-payment",
        ) &&
        (b.collections.ledger_entries?.toArray ?? []).some(
          (row) => (row as { client_id?: string }).client_id === "sync5-payment",
        ),
      SYNC_PULL_INTERVAL_MS * 10,
    );

    if (harness.realtime.deliveredPublishCount() > 0) {
      throw new Error("SYNC-5: convergence must not depend on realtime delivery");
    }

    await harness.assertInvariants({
      tables: ["customers", "ledger_entries"],
      bucket: SHOP_A,
    });
  } finally {
    await harness.close();
  }
}

export const syncScenarios = [
  { id: "SYNC-1", run: runSync1 },
  { id: "SYNC-2", run: runSync2 },
  { id: "SYNC-3", run: runSync3 },
  { id: "SYNC-4", run: runSync4 },
  { id: "SYNC-5", run: runSync5 },
] as const;
