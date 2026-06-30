---
title: Scaling & concurrency
description: The four scaling axes, proposed setups per usage tier, and the knobs that hold under load.
---

Nizhal is offline-first, which changes the scaling math: **the client's local SQLite is the source of truth, and the realtime ping is only a hint — the cursor pull is always authoritative.** A dropped socket, a missed ping, or a briefly-overloaded server degrades to "syncs a moment later," not "data lost." That property is what lets you scale each piece independently.

## The four axes

| Axis | What it is | How it scales | First bottleneck |
|------|-----------|---------------|------------------|
| **HTTP pull/push** | Stateless `/sync/pull` + `/sync/push` | Horizontally — add stateless instances behind a load balancer | The database behind it |
| **Database (Postgres)** | `postgresStorage` — columns + triggers, no logical replication | Vertical first, then read replicas / partition by tenant | Write throughput on `getChanges` + push |
| **Realtime fan-out** | The contentless `repull` poke per bucket | In-process → `LISTEN/NOTIFY` (multi-instance) → edge DO (per-bucket) | Process count, then NOTIFY volume |
| **WebSocket connections** | Live sockets held open per device | One process caps out; Cloudflare DOs spread connections globally | Open-FD / memory on a single Node process |

Because pull is authoritative, you can **always** shed realtime load: drop the ping cadence and lean on `pull.intervalMs` (a periodic safety pull). Correctness never depends on socket liveness.

## Proposed setups by tier

These are starting points, not hard limits — measure against your own write rate and concurrent-device count.

### Tier 1 — single region, up to ~a few thousand devices

- **1 Node process** (`createNizhalServer`) + **1 managed Postgres** (Neon/RDS/Supabase).
- `inProcessRealtime` (default).
- Durable client persistence on both platforms.
- This is the [Node topology](/production/deployment/#1-single-node--postgres-start-here). Scale the box vertically before adding instances.

### Tier 2 — multi-instance, one region, tens of thousands of devices

- **N stateless Node instances** behind a load balancer (sticky sessions **not** required — pull/push are stateless; WS reconnects rebalance naturally).
- `listenNotifyRealtime` so every instance hears every commit through Postgres — no Redis/NATS needed.
- Postgres is now the ceiling: move to a larger instance, add **read replicas** for `/sync/pull`, and consider **partitioning by tenant** (`ownerId`) if one tenant is hot.
- Watch `NOTIFY` volume; if commit rate is very high, batch or move realtime to the edge (Tier 3).

### Tier 3 — global / very high concurrency (100k+ live sockets)

- **Cloudflare for realtime**: one Durable Object per bucket holds that room's sockets, at the edge, close to users. Connection count scales with DO count, not a single process's FD limit. Hibernation keeps idle rooms cheap.
- HTTP can stay on Node/serverless with Postgres, driving the edge via `cloudflareHttpRealtime`; or go full-Workers with `cloudflareRealtime`. See [deployment topologies](/production/deployment/#topologies).
- Keep the cursor pull authoritative — even at this scale a missed edge poke self-heals on the next pull.

## Concurrency knobs (server)

All on `createNizhalServer({ limits, presence })` — safe defaults shown:

| Knob | Default | Tune when |
|------|---------|-----------|
| `limits.rateLimit` | 120 sync requests / actor / minute (sliding window, keyed `ownerId:userId`) | Raise for chatty clients; lower to protect Postgres under abuse. Returns `429` when exceeded. `false` disables. |
| `limits.maxBodyBytes` | 1 MiB | Raise for large batched pushes; keep tight to bound memory. Returns `413`. |
| `presence.heartbeatTimeoutMs` | 30s | Lower to evict dead presence faster; raise to tolerate flaky networks. |

## Concurrency knobs (client)

- **`pull.intervalMs`** — a periodic safety pull. Lower = faster convergence if realtime is dropped, but more load. This is your realtime-load relief valve.
- **`reconnect`** (`minDelayMs`/`maxDelayMs`) — the WebSocket source already does exponential backoff + **full jitter**, so thousands of clients reconnecting after a deploy don't thunder-herd the server. Widen the cap to spread reconnect storms further.
- **Heartbeat** — the client pings idle sockets and reconnects on a missed pong, so half-open connections (mobile NAT timeouts, proxy idle-kills) are detected instead of silently stalling.

## Capacity planning rules of thumb

- **Reads dominate.** Most traffic is `/sync/pull` (bootstrap + catch-up). Add read replicas and cache-friendly cursors before scaling writes.
- **Buckets are the unit of fan-out.** A `repull` wakes everyone in a bucket. Keep buckets scoped (per shop / per workspace), not global — a global bucket re-pulls every device on every write.
- **Offline writes batch on reconnect.** A device offline for an hour flushes its whole outbox at once; size `maxBodyBytes` and rate limits so a reconnect burst doesn't 413/429 itself into the dead-letter queue.
- **Measure `getChanges`.** It's the hot server path; the load benchmark (`apps/emulation`) and [validation](/production/validation/) suite exercise it under partition/restart/poison conditions.
