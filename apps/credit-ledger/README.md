# Credit Ledger (Shopbook reference app)

Nizhal Phase 0 reference app — movement-ledger credit book. Balance is always derived; never stored.

## Client usage

```tsx
import { useLiveQuery } from "@tanstack/react-db";
import { createCreditLedgerClient, customerBalance } from "credit-ledger";

const client = createCreditLedgerClient({
  server: "https://api.example.com",
  shopId: activeShopId,
  userId: session.userId,
});

await client.customers.preload();
await client.ledgerEntries.preload();
await client.executor.waitForInit();

function CustomerBalance({ customerId }: { customerId: string }) {
  const entries = useLiveQuery(client.ledgerEntries);
  const balance = customerBalance({ toArray: entries }, customerId);
  return <Text>{balance}</Text>;
}

function RecordCreditButton({ customerId }: { customerId: string }) {
  return (
    <Button
      onPress={() =>
        client.mutate.recordCredit({
          clientId: crypto.randomUUID(),
          customerId,
          amount: 1500,
          dueDate: new Date(Date.now() + 7 * 864e5).toISOString(),
        })
      }
    />
  );
}
```

Every read is offline via `useLiveQuery`; every write goes through a mutator → outbox → `/sync/push`.

## Server

```ts
import { createCreditLedgerServer } from "credit-ledger";

const { listen } = createCreditLedgerServer({
  db: process.env.DATABASE_URL!,
  secret: process.env.NIZHAL_AUTH_SECRET!,
});

listen(Number(process.env.PORT ?? 3000));
```

## Domain model

- `ledger_entries`: append-only signed movements (`amount` > 0 credit, < 0 payment)
- `customerBalance(customerId)` = `sum(amount)` over synced ledger rows for that customer
- `recordCredit` enqueues `sms-reminder` jobs server-side when pushed

See `blueprints/shopbook.md` and RFC §8 C13 / §9 `A-E2E-shopbook`.
