---
title: Cloudflare (Workers + Durable Objects + WebSocket)
description: Use a Cloudflare Durable Object as the WebSocket realtime hub for a Node/Bun server, or run the whole server on Workers.
---

Cloudflare gives Nizhal a globally-distributed **WebSocket realtime hub**: each sync bucket maps to a
`NizhalBucket` **Durable Object** (a PartyServer `Server` subclass), and each client holds a standard
WebSocket to its bucket's DO (`/parties/nizhal-bucket/<bucket>` — no partysocket client needed). A commit becomes a contentless **poke** broadcast to that bucket's
sockets; the client then pulls. As everywhere in Nizhal, **the ping is only a latency hint — the cursor
pull is authoritative**, so a dropped socket self-heals on the next pull.

:::tip[When to use this]
Reach for Cloudflare realtime for **massive concurrent connections**, **global low-latency**, or when your **HTTP runs on serverless** (which can't hold WebSockets). For a normal server in one or a few regions, `inProcessRealtime` or `listenNotifyRealtime` is simpler — see [choosing a realtime adapter](/concepts/realtime/#choosing-a-realtime-adapter) and [Scaling](/production/scaling/).
:::

Pick a topology by where your **storage** lives.

## Topology B — Node/Bun server + Cloudflare realtime hub (recommended)

Your sync server stays on Node/Bun with Postgres storage; you deploy **only** the realtime DO to
Cloudflare. `@nizhal/server` ships the deployable worker entry — point `wrangler` at it:

```jsonc
// wrangler.jsonc
{
  "name": "nizhal-realtime",
  "main": "node_modules/@nizhal/server/dist/adapters/cloudflare/worker.entry.js",
  "compatibility_date": "2025-01-01",
  "durable_objects": {
    "bindings": [{ "class_name": "NizhalBucket", "name": "NizhalBucket" }]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["NizhalBucket"] }]
}
```

```bash
wrangler secret put NIZHAL_JWT_SECRET         # verifies the WS ?token= (your bearerTokenAuth secret)
wrangler secret put NIZHAL_PUBLISH_SECRET     # authorizes the server→DO bridge
wrangler secret put NIZHAL_AUTHORIZATION_URL  # REQUIRED: your Nizhal server origin (e.g. https://app.example.com)
wrangler deploy
```

`NIZHAL_AUTHORIZATION_URL` is **mandatory**: on every WS upgrade the worker calls back to
`<that origin>/sync/realtime/authorize?bucket=…` to confirm the subscriber may read the bucket (it
does not authorize on its own). Leave it unset and the worker can't authorize anyone — every
subscription is rejected with a `500` that names this variable, while `POST /_nizhal/publish` still
returns `204`, so the worker looks healthy while realtime is dead. `NIZHAL_JWT_SECRET` and
`NIZHAL_PUBLISH_SECRET` must match the values your server signs tokens / pokes the bridge with.

On the Node server, use `cloudflareHttpRealtime` — on every commit it `POST`s a poke to the worker's
bridge, which fans it out over WebSocket:

```ts
import { createNizhalServer, bearerTokenAuth } from "@nizhal/server";
import { cloudflareHttpRealtime } from "@nizhal/server/adapters/cloudflare";

createNizhalServer({
  schema, mutators, syncRules,
  auth: bearerTokenAuth({ secret: process.env.JWT_SECRET! }),
  realtime: cloudflareHttpRealtime({
    publishUrl: "https://nizhal-realtime.<you>.workers.dev/_nizhal/publish",
    publishSecret: process.env.NIZHAL_PUBLISH_SECRET!,
  }),
}).listen(8787);
```

### The server→DO publish bridge

`cloudflareHttpRealtime` does `POST <publishUrl>?bucket=<b>` with `Authorization: Bearer
<NIZHAL_PUBLISH_SECRET>`. The worker authenticates the shared secret and RPCs the bucket DO's `repull`,
which broadcasts the poke to connected sockets. That HTTP bridge is the **only** server→Cloudflare
coupling — storage and mutation handling never leave your Node server.

## Topology A — everything on Workers

Run the HTTP sync surface on a Worker too. `createNizhalWorkerFetchHandler` wraps **your** Worker app's
`fetch` and adds the DO WebSocket routing + per-bucket auth; pair it with `cloudflareRealtime(env)`
(which RPCs the DO directly, only valid when the server itself runs on Workers). Storage is Postgres over
Hyperdrive.

```ts
import { createNizhalWorkerFetchHandler } from "@nizhal/server/adapters/cloudflare";

const handler = createNizhalWorkerFetchHandler({
  app: yourWorkerSyncApp,              // your /sync/* fetch handler (createNizhalServer-on-Workers)
  verifyToken: async (token, env) => verifyHs256(token, env.NIZHAL_JWT_SECRET),
  actorMaySeeBucket: (actor, bucket) => bucketsFor(actor).includes(bucket),
});
export default { fetch: handler };
export { NizhalBucket } from "@nizhal/server/adapters/cloudflare";
```

## WebSocket auth on Workers

Workers has no `node:crypto`, so the entry verifies the bearer JWT with **Web Crypto** (`crypto.subtle`,
HS256) — the same token `bearerTokenAuth` issues. The client passes it as `?token=<jwt>` on upgrade;
`onBeforeConnect` rejects an invalid/expired token with `401`/`403` before the socket opens.

## Client

Identical to the in-process WS server — just point the subscribe source at the worker:

```ts
import { createNizhalClient, createCloudflareSubscribeSource } from "@nizhal/db-collection";

const client = createNizhalClient({
  server: SERVER_URL,
  auth,
  bucketsForSyncRule,
  subscribeSource: createCloudflareSubscribeSource(
    "nizhal-realtime.<you>.workers.dev",
    async () => currentToken,            // getToken
  ),
});
```

The reconnect semantics match the Node WS server (same `createWebSocketSource` engine). On React Native, use the native
[`nitroWebSocketSource`](/react-native/) — same protocol.

## Caveats

- A Durable Object's connections idle out after ~15 minutes — fine for poke-and-repull; clients
  reconnect and the cursor pull catches up. Realtime is never the system of record.
- The DO holds **no** durable app data — only the live socket set per bucket. Storage stays Postgres
  (Hyperdrive → Neon/RDS/your DB).
- One DO per bucket = one realtime room per sync-rule bucket; fan-out is per-bucket, not global.

## Verified

The Workers path is exercised end-to-end on `workerd` (via `wrangler dev`):
`packages/server/examples/cf-e2e-smoke.ts` + `run-cf-e2e.sh`, and
`packages/server/test/cloudflare-realtime.test.ts`. See [Production / validation](/production/validation/).
