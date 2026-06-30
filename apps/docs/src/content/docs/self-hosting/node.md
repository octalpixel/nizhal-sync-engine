---
title: Node.js
description: Run createNizhalServer on Node with postgresStorage and inProcessRealtime.
---

The default self-host path: one Node process, one Postgres, default adapters.

```ts
import { createNizhalServer } from "@nizhal/server";
import { postgresStorage, inProcessRealtime } from "@nizhal/server/adapters";

const server = createNizhalServer({
  db: process.env.DATABASE_URL!,
  schema,
  mutators,
  syncRules,
  auth: bearerTokenAuth({ secret: process.env.JWT_SECRET! }),
  storage: postgresStorage({ connectionString: process.env.DATABASE_URL! }),
  realtime: inProcessRealtime(),
});

server.listen(Number(process.env.PORT ?? 4000));
```

## Multi-instance

Swap `inProcessRealtime()` for `listenNotifyRealtime({ connectionString })` when running multiple Node replicas behind a load balancer.

Run `buildListenNotifyProvisionPlan` + migrate for NOTIFY channel DDL.

## Requirements

- Node ≥ 20
- Postgres reachable from the process
- `nizhal migrate` applied before serving traffic

## Process model

Deliberately boring: single machine, auto-stop friendly, no embedded logical replication daemon. Your orchestrator (systemd, Fly, Railway) restarts the process; clients reconnect and cursor-pull to converge.
