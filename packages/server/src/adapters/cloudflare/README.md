# Cloudflare realtime adapter

Opt-in adapter for deploying Nizhal's realtime fan-out on Cloudflare Workers + Durable Objects.
The default `inProcessRealtime` is unchanged; use this only when you need edge fan-out across
stateless Worker isolates.

## Pieces

- `server.ts` — `NizhalBucket` PartyServer DO. One DO instance per bucket room. Exposes `repull(bucket)` RPC.
- `realtime.ts` — `cloudflareRealtime(env)` adapter. `publish(bucket)` calls the bucket DO via RPC; `subscribe` is a no-op because the DO owns the connections.
- `worker.ts` — `createNizhalWorkerFetchHandler` wires `routePartykitRequest` for WS upgrades and falls through to the Hono app for `/sync/pull`, `/sync/push`, `/nizhal/contract`.
- `wrangler.jsonc` — example Wrangler config with the `NizhalBucket` DO binding and SQLite migration.

## Deploy

1. Add `@nizhal/server` as a dependency in your Worker project.
2. Copy/adapt `wrangler.jsonc` into your Worker root.
3. Create a Worker entry that builds the Hono app with `createNizhalServer({ realtime: cloudflareRealtime(env) })` and exports `createNizhalWorkerFetchHandler({ app, verifyToken, actorMaySeeBucket })`.
4. Deploy with `wrangler deploy`.

## Client

Use `createCloudflareSubscribeSource(host, getToken)` from `@nizhal/db-collection`, then pass it as
`subscribeSource` to `createNizhalClient`. The client opens one standard WebSocket per visible bucket
room (built on `createWebSocketSource` — no partysocket client dependency); the auth token is resolved
fresh on every (re)connect and sent as `?token=`.

## Presence

The in-process/Node WS path tracks presence in `RealtimeAdapter.presence()` (implemented by
`inProcessRealtime`). The Cloudflare DO also exposes a separate ephemeral relay for `presence:`,
`typing:`, `cursor:`, and `whisper:` frames. It relays frames verbatim, rate-limits each socket,
re-authorizes room membership, and never reads or writes Durable Object storage or the sync
change-tracking pipeline.

## Deploying the realtime worker

Deployable entry: `worker.entry.ts` (module-worker `export default { fetch }` + exported `NizhalBucket` DO).
Config: `wrangler.jsonc` (DO binding + `new_sqlite_classes` migration).

```bash
pnpm --filter @nizhal/server build           # emits dist/adapters/cloudflare/worker.entry.js
cd packages/server
wrangler deploy --dry-run -c src/adapters/cloudflare/wrangler.jsonc   # validate (DO binding accepted)
wrangler dev      -c src/adapters/cloudflare/wrangler.jsonc           # run on local workerd (real DO)
wrangler deploy   -c src/adapters/cloudflare/wrangler.jsonc           # ship it
# set the auth secret: wrangler secret put NIZHAL_JWT_SECRET
```

Clients connect with a standard WebSocket to `wss://<worker>/parties/nizhal-bucket/<bucket>?token=<jwt>`
(partyserver routes the upgrade by URL path; no partysocket client required)
(token = the same HS256 bearer the Node `/sync/stream` path uses; verified here via Web Crypto).
Configure either `NIZHAL_AUTHORIZATION_SERVICE` as a service binding to the Nizhal HTTP server or
`NIZHAL_AUTHORIZATION_URL` as its base URL. The Worker calls `/sync/realtime/authorize` through that
binding on connect, and the Durable Object repeats the check before every ping; missing authorization
configuration fails closed.

**Scope (honest):** this worker serves the per-bucket DO + client (standard WebSocket) fan-out. The Node Nizhal
server reaching the DO to `publish` (server commit → DO broadcast) needs the server running on Workers
or a small HTTP bridge — Phase 2. Verified here: `wrangler deploy --dry-run` passes (DO binding OK) +
the mock-DO unit test; a full live WebSocket↔DO broadcast is a `wrangler dev` manual step.

## Server → DO publish bridge (Node server driving Cloudflare realtime)

A self-hosted **Node** Nizhal server can't RPC a Durable Object directly (cross-process). The worker
exposes `POST /_nizhal/publish?bucket=<b>` (authorized by the `NIZHAL_PUBLISH_SECRET` bearer); it RPCs the
bucket DO's `repull`, which broadcasts to connected clients. Wire it with `cloudflareHttpRealtime`:

```ts
import { cloudflareHttpRealtime } from "@nizhal/server/adapters";

const realtime = cloudflareHttpRealtime({
  publishUrl: "https://nizhal-realtime.acme.workers.dev/_nizhal/publish",
  publishSecret: process.env.NIZHAL_PUBLISH_SECRET!,   // = wrangler secret put NIZHAL_PUBLISH_SECRET
});
// createNizhalServer({ ..., realtime })  → every commit fans out through Cloudflare.
```

Full path: **server commit → `POST /_nizhal/publish` → `getServerByName` → `DO.repull` → client (standard WebSocket)**.
Verified end-to-end on real `workerd` + DO: `examples/run-cf-e2e.sh` (boots `wrangler dev`, runs the
client↔DO↔bridge smoke). When the server itself runs on Workers, use `cloudflareRealtime` (direct RPC) instead.
