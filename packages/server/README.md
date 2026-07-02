# @nizhal/server

The [Nizhal](https://github.com/octalpixel/nizhal) sync server — a Hono app with `POST /sync/pull`,
`POST /sync/push`, and `GET /sync/stream` (WebSocket), backed by no-WAL Postgres provisioning
(plain columns + triggers, no replication slot). Ships storage, realtime, auth, and durable-job
adapters.

```bash
npm install @nizhal/server
```

```ts
import { bearerTokenAuth, createNizhalServer } from "@nizhal/server";
import { mutators, notes, syncRules } from "./domain"; // your @nizhal/kernel domain

createNizhalServer({
  db: process.env.DATABASE_URL!,
  schema: { notes },
  mutators,
  syncRules,
  auth: bearerTokenAuth({ secret: process.env.JWT_SECRET! }),
}).listen(4000);
```

Provision the engine onto your Postgres with [`@nizhal/cli`](../cli) (`nizhal migrate`).
Full API — storage, realtime, auth, blobs, jobs, observability: [`docs/api.md`](../../docs/api.md#nizhalserver). MIT licensed.
