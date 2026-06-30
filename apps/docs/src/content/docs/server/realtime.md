---
title: Realtime adapters
description: inProcessRealtime, listenNotifyRealtime, and Cloudflare PartyServer.
---

Realtime adapters implement:

```ts
interface RealtimeAdapter {
  publish(bucket: string): void;
  subscribe(buckets: string[], onPing: (bucket: string) => void): Unsubscribe;
}
```

`publish` is called **only** from the mutator commit chokepoint. Payload is the bucket key — clients pull for data.

## inProcessRealtime (default)

```ts
import { inProcessRealtime } from "@nizhal/server/adapters";

createNizhalServer({ ..., realtime: inProcessRealtime() });
```

In-memory `bucket → WebSocket set` registry. Zero extra deps; correct for single-process self-host on any database.

## listenNotifyRealtime

```ts
import { listenNotifyRealtime } from "@nizhal/server/adapters";

createNizhalServer({
  ...,
  realtime: listenNotifyRealtime({ connectionString: process.env.DATABASE_URL! }),
});
```

Multi-instance Postgres via `LISTEN/NOTIFY`. `buildListenNotifyProvisionPlan` adds channel DDL.

## Cloudflare

```ts
import { cloudflareRealtime, cloudflareHttpRealtime } from "@nizhal/server/adapters/cloudflare";
import { NizhalBucket } from "@nizhal/server/adapters/cloudflare";
```

`cloudflareRealtime` — Durable Object hub (PartyServer). `createNizhalWorkerFetchHandler` wires HTTP + WS on Workers.

`cloudflareHttpRealtime` — HTTP long-poll fallback when native WS is constrained.

See [Cloudflare self-hosting](/self-hosting/cloudflare/).

## Client pairing

Default client is a reconnecting WebSocket (backoff + jitter, stability gate, connect timeout, heartbeat, fresh auth per reconnect). `@nizhal/db-collection` exports `createWebSocketSource` (the WHATWG-`WebSocket`-factory engine) plus `createPartySocketSource` (default, `/sync/stream`) and `createCloudflareSubscribeSource` (partyserver DO per bucket) built on it.

Missed pings self-heal via cursor pull; optional `pull.intervalMs` on the client.
