---
title: createNizhalMutators
description: Optimistic writes, durable outbox, and poison dead-letter.
---

```ts
import { createNizhalMutators } from "@nizhal/db-collection";

const { mutate } = createNizhalMutators({
  collections: { notes: notesCollection },
  echo,
  mutators: kernelMutators,
  outboxStorage: persistence.outboxStorage,
  mutationIdStorage: persistence.metaStorage,
  onlineDetector, // optional — reactNativeOnlineDetector on RN
});
```

Wraps kernel `defineMutators` with TanStack `offline-transactions`:

- Optimistic local apply via TanStack DB
- `mutationFn` allocates the per-client `mutationID` after initialization, then POSTs to `/sync/push`
- The allocation is persisted per transaction before the local high-water; server pull/push responses
  seed and reconcile the authoritative sequence across crashes and upgrades
- Bounded retries; deterministic failures → **poison quarantine** (REQ-13)
- Dependent mutations **cascade-cancel** so the queue keeps draining

## Poison handling

Surface quarantined entries via `createNizhalStatus` — show the user a fix/retry path instead of a silent stuck sync.

## Online detection

Web: browser online events. RN: `reactNativeOnlineDetector()` from `@nizhal/react-native` (NetInfo peer).
