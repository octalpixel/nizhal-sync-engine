---
title: Realtime
description: Bucket-scoped pings, authoritative pull, adapters, and presence.
---

Realtime in Nizhal is a **hint to re-pull** — not a data channel. The cursor pull is **authoritative**.

## Ping flow

```
mutator commit → RealtimeAdapter.publish(bucketKey) → WS frame → client → echo.pull()
```

- `publish` runs only from the server commit chokepoint
- Payload is the **bucket key only** — no row data on the wire (no leak surface)
- Client subscribes via `GET /sync/stream` (WebSocket) or a swappable transport

If a ping is missed (sleep, partition, DO idle), the next pull still converges. Set `pull.intervalMs` on `createNizhalClient` for a periodic fallback when realtime is unavailable.

## Adapters

| Adapter | Import | Use case |
|---------|--------|----------|
| `inProcessRealtime` | `@nizhal/server/adapters` | Default single-process pub/sub |
| `listenNotifyRealtime` | `@nizhal/server/adapters` | Multi-instance Postgres via `LISTEN/NOTIFY` |
| `cloudflareRealtime` | `@nizhal/server/adapters/cloudflare` | Server **on Workers** — direct Durable Object RPC (PartyServer) |
| `cloudflareHttpRealtime` | `@nizhal/server/adapters/cloudflare` | A **Node/serverless** server fanning out through a CF worker via the `/_nizhal/publish` bridge |

All implement `RealtimeAdapter`: `publish(bucket)` + `subscribe(onPing)`.

Default client transport is a reconnecting WebSocket (exponential backoff + full jitter, a stability gate against hot-loops, connect timeout, heartbeat, and fresh auth on every reconnect) against whichever adapter you deploy — the same engine on web (native `WebSocket`), Node (`ws`), and React Native (`NitroWebSocket`).

## Choosing a realtime adapter

Realtime is a swappable seam — start with the default and move only when the topology demands it. Because the cursor pull is authoritative, switching adapters never risks correctness.

| Your setup | Adapter | Why |
|------------|---------|-----|
| One server process | `inProcessRealtime` (default) | Zero infra. Fan-out lives in memory. Correct until you run a second instance. |
| Several server instances, one region | `listenNotifyRealtime` | Every instance hears every commit through your existing Postgres — no Redis/NATS. Postgres `LISTEN/NOTIFY` is the bus. |
| Self-hosted Node/serverless, but you want edge realtime | `cloudflareHttpRealtime` | Keep HTTP + Postgres where they are; the server pokes Cloudflare Durable Objects over the `/_nizhal/publish` bridge. Lets serverless (which can't hold WebSockets) still do realtime. |
| Server runs on Cloudflare Workers | `cloudflareRealtime` | Direct Durable Object RPC — one DO per bucket as the edge hub. |

### When to reach for Cloudflare

Choose a Cloudflare realtime topology when you need one or more of:

- **Massive concurrent connections** — a single Node process caps out on open sockets/memory; Cloudflare spreads connections across one Durable Object per bucket, with hibernation keeping idle rooms cheap.
- **Global low latency** — users far from your origin get a socket to a nearby edge DO instead of a transcontinental round-trip.
- **Serverless HTTP** — your API runs on Vercel/Lambda/Workers and can't hold long-lived WebSockets, so realtime has to live elsewhere (`cloudflareHttpRealtime`).

**Stay on `inProcessRealtime` or `listenNotifyRealtime`** when you run a normal long-lived server (one or many instances) in one or a few regions — it's simpler, has no extra moving parts, and Postgres is already your scaling axis. Don't adopt Durable Objects for a few thousand devices in one region; reach for them at the scale/geography tiers in [Scaling](/production/scaling/).

The client side is identical either way — a standard WebSocket (or `NitroWebSocket` on RN). partyserver routes the upgrade by URL path; no partysocket client is involved.

## Presence v2

`/sync/stream` supports `track` / `untrack` with heartbeat timeout. State and diffs are bucket-scoped — `presenceState`, `onPresence` on the client.

Presence is orthogonal to data sync: it does not replace pull for row convergence.

## React Native

Native WebSockets via `@nizhal/react-native` (`nitroWebSocketSource`) send `Authorization` on the upgrade header. NetInfo-based `reactNativeOnlineDetector` flushes the outbox on reconnect. See [React Native](/react-native/).

## cursorReset

If the client cursor is corrupt or far in the future, pull returns `cursorReset: true` and the collection re-bootstraps from cursor `0`.

## Next

- [How sync works](/concepts/how-sync-works/)
- [Realtime adapters](/server/realtime/)
