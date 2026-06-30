---
title: Jobs
description: Durable background tasks from mutator enqueue to worker execution.
---

Mutators receive a `jobs` scheduler in context:

```ts
defineMutator(input, async ({ tx, jobs, actor }, args) => {
  await tx.insert(ledgerEntries).values({ ... });
  jobs.schedule("smsReminder", { entryId, at: reminderAt });
  return { affectedBuckets: [shopId] };
});
```

## Server setup

```ts
import { createJobScheduler, createJobWorker } from "@nizhal/server";

const jobs = {
  smsReminder: { handler: smsReminderHandler },
};

createNizhalServer({ ..., jobs });
```

`createJobScheduler` buffers tasks inside the mutator transaction. `createJobWorker` drains `_nizhal_jobs` durably after commit.

## Semantics

- Enqueue is atomic with the mutator write
- At-least-once delivery — handlers must be idempotent
- Failed jobs retry with backoff (see server implementation)

Credit-ledger's `smsReminderHandler` is the reference pattern for scheduled side effects that must not block the user's offline write path.
