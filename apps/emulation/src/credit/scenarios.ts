import { createJobWorker, signHs256Jwt } from "@nizhal/server";
import type { CustomerRow } from "credit-ledger";
import { smsReminderHandler } from "credit-ledger";
import { waitFor } from "../harness/chaos-harness.js";
import type { ChaosClientHandle } from "../harness/chaos-harness.js";
import {
  CHAOS_AUTH_SECRET,
  CUSTOMER_A,
  SHOP_A,
  SHOP_B,
  USER_A,
  USER_B,
  buildCreditCollections,
  createCreditChaosHarness,
  createCreditChaosMutators,
  foldCreditBalance,
  mintCreditToken,
} from "./setup.js";

async function bootCreditClient(
  harness: Awaited<ReturnType<typeof createCreditChaosHarness>>,
  input: {
    id: string;
    userId: string;
    shopId: string;
    ownerId: string;
    token?: string;
    authRefresh?: () => Promise<Record<string, string>>;
    bucket?: string;
    persist?: boolean;
    hlcSkewMs?: number;
  },
): Promise<ChaosClientHandle> {
  const token =
    input.token ??
    mintCreditToken({
      userId: input.userId,
      ownerId: input.ownerId,
      shopId: input.shopId,
    });
  const client = await harness.createClient({
    id: input.id,
    userId: input.userId,
    ownerId: input.ownerId,
    bucket: input.bucket ?? input.shopId,
    actorExtras: { shopId: input.shopId },
    authHeaders: { authorization: `Bearer ${token}` },
    authRefresh: input.authRefresh,
    persist: input.persist ?? true,
    hlcSkewMs: input.hlcSkewMs,
    mutators: createCreditChaosMutators(harness.poisoned),
    buildCollections: ({ echo, persistence }) => buildCreditCollections({ echo, persistence }),
  });
  await Promise.all(Object.values(client.collections).map((c) => c.preload()));
  await client.executor.waitForInit();
  return client;
}

function creditMutate(client: ChaosClientHandle) {
  return client.mutate as {
    recordCredit: (args: {
      clientId: string;
      customerId: string;
      amount: number;
      dueDate?: string;
    }) => void;
    recordPayment: (args: { clientId: string; customerId: string; amount: number }) => void;
    updateCustomerName: (args: { customerId: string; value: string }) => void;
    updateCustomerPhone: (args: { customerId: string; value: string }) => void;
  };
}

export async function runCr1(): Promise<void> {
  const harness = await createCreditChaosHarness();
  try {
    const a = await bootCreditClient(harness, {
      id: "user-a-device",
      userId: USER_A,
      shopId: SHOP_A,
      ownerId: "owner-a",
    });
    const b = await bootCreditClient(harness, {
      id: "user-b-device",
      userId: USER_B,
      shopId: SHOP_A,
      ownerId: "owner-a",
    });
    harness.partition(a.id);
    harness.partition(b.id);

    creditMutate(a).recordPayment({ clientId: "pay-a", customerId: CUSTOMER_A, amount: 300 });
    creditMutate(b).recordPayment({ clientId: "pay-b", customerId: CUSTOMER_A, amount: 500 });

    harness.heal(a.id);
    harness.heal(b.id);
    await harness.converge();

    const entries = await harness.db.query<{ amount: string }>(
      "select amount::text as amount from ledger_entries where shop_id = $1 and customer_id = $2 order by client_id",
      [SHOP_A, CUSTOMER_A],
    );
    const balance = entries.rows.reduce((sum, row) => sum + Number(row.amount), 0);
    if (entries.rows.length !== 2 || balance !== -800) {
      throw new Error(
        `CR-1 INV-2/4: expected both payments and balance -800, got ${entries.rows.length} rows / ${balance}`,
      );
    }
    await harness.assertInvariants({
      tables: ["customers", "ledger_entries"],
      bucket: SHOP_A,
      fold: (rows) => {
        const folded = foldCreditBalance(rows.ledger_entries as never, CUSTOMER_A);
        if (folded !== -800) throw new Error(`CR-1 INV-4 fold mismatch: ${folded}`);
      },
    });
  } finally {
    await harness.close();
  }
}

export async function runCr2(): Promise<void> {
  const harness = await createCreditChaosHarness();
  try {
    const client = await bootCreditClient(harness, {
      id: "revoked-device",
      userId: USER_B,
      shopId: SHOP_A,
      ownerId: "owner-a",
    });
    await waitFor(() =>
      (client.collections.customers?.toArray ?? []).some(
        (c) => (c as CustomerRow).id === CUSTOMER_A,
      ),
    );

    await harness.revoke(USER_B, SHOP_A);
    harness.realtime.publish(SHOP_A);
    await waitFor(
      () =>
        !(client.collections.customers?.toArray ?? []).some(
          (c) => (c as CustomerRow).id === CUSTOMER_A,
        ),
    );

    if ((client.collections.ledger_entries?.toArray ?? []).length > 0) {
      throw new Error("CR-2 INV-7: revoked member still has ledger rows locally");
    }
  } finally {
    await harness.close();
  }
}

export async function runCr3(): Promise<void> {
  const harness = await createCreditChaosHarness();
  try {
    const a = await bootCreditClient(harness, {
      id: "edit-a",
      userId: USER_A,
      shopId: SHOP_A,
      ownerId: "owner-a",
    });
    const b = await bootCreditClient(harness, {
      id: "edit-b",
      userId: USER_B,
      shopId: SHOP_A,
      ownerId: "owner-a",
    });
    harness.partition(a.id);
    harness.partition(b.id);

    creditMutate(a).updateCustomerName({ customerId: CUSTOMER_A, value: "Amara Updated" });
    creditMutate(b).updateCustomerPhone({ customerId: CUSTOMER_A, value: "+94779999999" });

    harness.heal(a.id);
    harness.heal(b.id);
    await harness.converge();

    const row = await harness.db.query<{ name: string; phone: string | null }>(
      "select name, phone from customers where id = $1",
      [CUSTOMER_A],
    );
    const customer = row.rows[0];
    if (customer?.name !== "Amara Updated" || customer?.phone !== "+94779999999") {
      throw new Error(`CR-3 INV-1 field merge failed: ${JSON.stringify(customer)}`);
    }
    await harness.assertInvariants({ tables: ["customers"], bucket: SHOP_A });
  } finally {
    await harness.close();
  }
}

export async function runCr4(): Promise<void> {
  const harness = await createCreditChaosHarness();
  try {
    const a = await bootCreditClient(harness, {
      id: "part-a",
      userId: USER_A,
      shopId: SHOP_A,
      ownerId: "owner-a",
    });
    const b = await bootCreditClient(harness, {
      id: "part-b",
      userId: USER_B,
      shopId: SHOP_A,
      ownerId: "owner-a",
    });
    harness.partition(a.id);
    harness.partition(b.id);

    creditMutate(a).recordCredit({ clientId: "credit-a", customerId: CUSTOMER_A, amount: 1200 });
    creditMutate(b).recordCredit({ clientId: "credit-b", customerId: CUSTOMER_A, amount: 800 });

    harness.heal(a.id);
    harness.heal(b.id);
    await harness.converge();

    await harness.assertInvariants({
      tables: ["ledger_entries", "customers"],
      bucket: SHOP_A,
    });
  } finally {
    await harness.close();
  }
}

export async function runCr5(): Promise<void> {
  const harness = await createCreditChaosHarness();
  try {
    let currentToken = signHs256Jwt(
      {
        userId: USER_A,
        ownerId: "owner-a",
        shopId: SHOP_A,
        exp: Math.floor(Date.now() / 1000) - 1,
      },
      CHAOS_AUTH_SECRET,
    );
    let refreshCalls = 0;

    const client = await bootCreditClient(harness, {
      id: "refresh-device",
      userId: USER_A,
      shopId: SHOP_A,
      ownerId: "owner-a",
      token: currentToken,
      authRefresh: async () => {
        refreshCalls += 1;
        currentToken = mintCreditToken({ userId: USER_A, ownerId: "owner-a", shopId: SHOP_A });
        return { authorization: `Bearer ${currentToken}` };
      },
    });

    await client.echo.pull({ cursor: "", syncRule: "myShops" });
    if (refreshCalls < 1) {
      throw new Error("CR-5 INV-9: token refresh was not invoked on expired token");
    }

    creditMutate(client).recordPayment({
      clientId: "refresh-pay",
      customerId: CUSTOMER_A,
      amount: 100,
    });
    await harness.converge();
    const rows = await harness.db.query("select * from ledger_entries where client_id = $1", [
      "refresh-pay",
    ]);
    if (rows.rows.length !== 1) {
      throw new Error("CR-5 INV-9: session did not continue after refresh");
    }
  } finally {
    await harness.close();
  }
}

export async function runCr6(): Promise<void> {
  const harness = await createCreditChaosHarness();
  try {
    const client = await bootCreditClient(harness, {
      id: "jobs-device",
      userId: USER_A,
      shopId: SHOP_A,
      ownerId: "owner-a",
      persist: true,
    });

    const due = new Date(Date.now() + 86_400_000).toISOString();
    for (let i = 0; i < 12; i += 1) {
      creditMutate(client).recordCredit({
        clientId: `job-credit-${i}`,
        customerId: CUSTOMER_A,
        amount: 100 + i,
        dueDate: due,
      });
    }
    await harness.converge();

    await harness.db.exec("update _nizhal_jobs set run_at = now() where status = 'queued'");

    await harness.db.exec(
      "insert into _nizhal_jobs (task_slug, input, max_attempts, run_at) values ('fail-task', '{}'::jsonb, 2, now())",
    );

    const worker = createJobWorker({
      connectionString: process.env.NEON_URL ?? "postgres://unused",
      client: (harness.db as { raw?: unknown }).raw as never,
      tasks: {
        "sms-reminder": smsReminderHandler,
        "fail-task": () => {
          throw new Error("still broken");
        },
      },
      backoffMs: () => 0,
    });

    for (let i = 0; i < 50; i += 1) {
      const ran = await worker.runOnce();
      const pending = await harness.db.query<{ count: number }>(
        "select count(*)::int as count from _nizhal_jobs where status in ('queued', 'running') and run_at <= now()",
      );
      if (ran === 0 && (pending.rows[0]?.count ?? 0) === 0) break;
    }

    const jobs = await harness.db.query<{ status: string; task_slug: string }>(
      "select status, task_slug from _nizhal_jobs order by id",
    );
    const deadLetters = jobs.rows.filter((row) => row.status === "dead_letter");
    const succeeded = jobs.rows.filter((row) => row.status === "succeeded");
    if (succeeded.length < 12 || deadLetters.length < 1) {
      throw new Error(
        `CR-6 INV-9: expected reminders succeeded + fail dead-letter, got ${JSON.stringify(jobs.rows)}`,
      );
    }
    const queued = jobs.rows.filter((row) => row.status === "queued" || row.status === "running");
    if (queued.length > 0) {
      throw new Error("CR-6 INV-9: stuck jobs remain in queue");
    }
  } finally {
    await harness.close();
  }
}

export async function runCr7(): Promise<void> {
  const harness = await createCreditChaosHarness();
  try {
    const attacker = await bootCreditClient(harness, {
      id: "shop-a-attacker",
      userId: USER_A,
      shopId: SHOP_A,
      ownerId: "owner-a",
      bucket: SHOP_B,
    });

    const pull = await attacker.echo.pull({ cursor: "", syncRule: "myShops" });
    const leakedRows = pull.changed
      .flatMap((chunk) => chunk.rows)
      .filter((row) => (row as { shop_id?: string }).shop_id === SHOP_B);
    if (leakedRows.length > 0) {
      throw new Error("CR-7 INV-6: cross-tenant rows returned in pull");
    }

    const leaked = (attacker.collections.customers?.toArray ?? []).filter(
      (c) => (c as CustomerRow).shop_id === SHOP_B,
    );
    if (leaked.length > 0) {
      throw new Error("CR-7 INV-6: cross-tenant customer rows leaked locally");
    }

    await fetch(`${harness.baseUrl}/sync/push`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${mintCreditToken({ userId: USER_A, ownerId: "owner-a", shopId: SHOP_A })}`,
      },
      body: JSON.stringify({
        mutations: [
          {
            name: "recordPayment",
            args: { clientId: "cross-tenant", customerId: CUSTOMER_A, amount: 1 },
            clientMutationId: "cross-tenant",
          },
        ],
      }),
    });

    const shopBRows = await harness.db.query("select * from ledger_entries where shop_id = $1", [
      SHOP_B,
    ]);
    if (shopBRows.rows.length > 0) {
      throw new Error("CR-7 INV-6: cross-tenant push wrote shop-B rows");
    }
  } finally {
    await harness.close();
  }
}

export const creditScenarios = [
  { id: "CR-1", run: runCr1 },
  { id: "CR-2", run: runCr2 },
  { id: "CR-3", run: runCr3 },
  { id: "CR-4", run: runCr4 },
  { id: "CR-5", run: runCr5 },
  { id: "CR-6", run: runCr6 },
  { id: "CR-7", run: runCr7 },
] as const;
