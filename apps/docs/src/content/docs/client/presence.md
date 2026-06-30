---
title: Presence
description: track, untrack, and bucket-scoped presence diffs.
---

Presence v2 runs over `/sync/stream` alongside bucket pings.

```ts
import { track, untrack, presenceState, onPresence, subscribePresence } from "@nizhal/db-collection";

echo.track("myNotes", { ownerId }, { status: "online", device: "ipad" });

const off = onPresence("myNotes", { ownerId }, (diff) => {
  // diff.joins / diff.leaves with presence_ref
});

echo.untrack("myNotes", { ownerId });
```

Server enforces heartbeat timeout via `presence` config on `createNizhalServer`. State and diffs are **bucket-scoped** — same scope rules as data sync.

Presence does not carry row data and is not authoritative for convergence — cursor pull is.

## React Native

Same API on `createNizhalNitroClient`. WS reconnect re-establishes presence after catch-up pull.
