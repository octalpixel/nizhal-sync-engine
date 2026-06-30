---
title: Observability
description: NizhalObserver hooks and GET /nizhal/stats.
---

```ts
import type { NizhalObserver } from "@nizhal/server";

const observer: NizhalObserver = {
  onPull: (event) => metrics.histogram("nizhal.pull.rows", event.rowCount),
  onPush: (event) => metrics.increment("nizhal.push.mutations", event.count),
  onConflict: (event) => log.warn("merge", event),
  onError: (error, context) => log.error(error, context),
};

createNizhalServer({ ..., observer });
```

`noopObserver` is the default. `safeObserver` wraps user hooks so observer throws never break sync.

## Stats endpoint

`gatherStats(db, realtime)` powers `GET /nizhal/stats`:

- Mutation throughput
- Active realtime subscriptions
- Queue depth signals

Protect with `adminPassword()` + bearer token in production.

## Client status

`createNizhalStatus` on the client exposes sync phase and poison-quarantine outbox entries for UI/debug panels.
