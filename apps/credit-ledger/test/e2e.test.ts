import { afterEach, describe, expect, it } from "vitest";
import { createCreditLedgerClient, customerBalance, foldLedgerBalance } from "../src/client.js";
import {
  TEST_CUSTOMER_ID,
  TEST_SHOP_ID,
  TEST_USER_ID,
  createCreditLedgerHarness,
  waitFor,
} from "./harness.js";

const openHarnesses: Array<{ close: () => void; db: { close: () => Promise<void> } }> = [];

describe("A-E2E-shopbook", () => {
  afterEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    await Promise.all(
      openHarnesses.splice(0).map(async (harness) => {
        harness.close();
        await harness.db.close();
      }),
    );
  });

  it("offline recordCredit → reconnect/push → converge → balance = fold(ledger); sms-reminder enqueued", async () => {
    const harness = await createCreditLedgerHarness();
    openHarnesses.push(harness);

    let online = false;
    const clientA = createCreditLedgerClient({
      server: harness.baseUrl,
      shopId: TEST_SHOP_ID,
      userId: TEST_USER_ID,
      subscribeSource: {
        subscribe: (buckets, onMessage) => harness.realtime.subscribe(buckets, { send: onMessage }),
      },
    });

    const basePush = clientA.echo.push.bind(clientA.echo);
    clientA.echo.push = async (mutation) => {
      await waitFor(() => online);
      await basePush(mutation);
    };

    await Promise.all([clientA.customers.preload(), clientA.ledgerEntries.preload()]);
    await clientA.executor.waitForInit();

    const creditClientId = "credit-entry-1";
    const creditAmount = 2500;
    const dueDate = new Date(Date.now() + 7 * 86_400_000).toISOString();

    clientA.mutate.recordCredit({
      clientId: creditClientId,
      customerId: TEST_CUSTOMER_ID,
      amount: creditAmount,
      dueDate,
      reason: "goods on credit",
    });

    expect(clientA.ledgerEntries.toArray.some((entry) => entry.client_id === creditClientId)).toBe(
      true,
    );
    expect(customerBalance(clientA.ledgerEntries, TEST_CUSTOMER_ID)).toBe(creditAmount);

    const serverBeforeReconnect = await harness.db.query(
      "select * from ledger_entries where client_id = $1",
      [creditClientId],
    );
    expect(serverBeforeReconnect.rows).toEqual([]);

    online = true;

    await waitFor(async () => {
      const rows = await harness.db.query(
        "select amount::numeric as amount from ledger_entries where client_id = $1",
        [creditClientId],
      );
      return rows.rows.length === 1 && Number(rows.rows[0]?.amount) === creditAmount;
    });

    const jobs = await harness.db.query<{ task_slug: string; input: unknown }>(
      "select task_slug, input from _nizhal_jobs where task_slug = 'sms-reminder'",
    );
    expect(jobs.rows.length).toBeGreaterThanOrEqual(1);
    expect(
      jobs.rows.some((job) => {
        const input = job.input as { entryId?: string };
        return input.entryId === creditClientId;
      }),
    ).toBe(true);

    const clientB = createCreditLedgerClient({
      server: harness.baseUrl,
      shopId: TEST_SHOP_ID,
      userId: TEST_USER_ID,
      subscribeSource: {
        subscribe: (buckets, onMessage) => harness.realtime.subscribe(buckets, { send: onMessage }),
      },
    });

    await Promise.all([clientB.customers.preload(), clientB.ledgerEntries.preload()]);
    await clientB.executor.waitForInit();

    const started = Date.now();
    await waitFor(
      () => clientB.ledgerEntries.toArray.some((entry) => entry.client_id === creditClientId),
      5_000,
    );
    expect(Date.now() - started).toBeLessThan(5_000);

    const folded = foldLedgerBalance(clientB.ledgerEntries.toArray, TEST_CUSTOMER_ID);
    const balance = customerBalance(clientB.ledgerEntries, TEST_CUSTOMER_ID);
    expect(balance).toBe(creditAmount);
    expect(balance).toBe(folded);

    clientA.mutate.recordPayment({
      clientId: "payment-entry-1",
      customerId: TEST_CUSTOMER_ID,
      amount: 500,
    });

    await waitFor(async () => {
      const rows = await harness.db.query(
        "select count(*)::int as count from ledger_entries where client_id = $1",
        ["payment-entry-1"],
      );
      return (rows.rows[0]?.count ?? 0) === 1;
    });

    await waitFor(
      () =>
        customerBalance(clientB.ledgerEntries, TEST_CUSTOMER_ID) === creditAmount - 500 ||
        foldLedgerBalance(clientB.ledgerEntries.toArray, TEST_CUSTOMER_ID) === creditAmount - 500,
      5_000,
    );

    harness.realtime.publish(TEST_SHOP_ID);
    await waitFor(() => customerBalance(clientB.ledgerEntries, TEST_CUSTOMER_ID) === 2000, 5_000);
    expect(foldLedgerBalance(clientB.ledgerEntries.toArray, TEST_CUSTOMER_ID)).toBe(2000);
  });
});
