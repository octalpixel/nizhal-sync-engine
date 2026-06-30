---
title: Vercel
description: Fluid compute and listenNotifyRealtime — honest deployment notes.
---

Vercel can host the **HTTP** surface (`/sync/pull`, `/sync/push`, `/nizhal/contract`) on Fluid/serverless functions with an external Postgres (Neon).

:::tip[Looking for the full recipe?]
For a verified end-to-end walkthrough — Neon + Vercel serverless + a Cloudflare Worker for **instant**
realtime, with copy-paste commands — see [Local → production](/guides/deploy-to-production/). The notes
below cover the serverless realtime *tradeoffs*; that guide is the happy path.
:::

## Realtime gap

Serverless instances are ephemeral. `inProcessRealtime` does not fan pings across instances. Use **`listenNotifyRealtime`** with a shared Postgres so any instance's commit NOTIFY reaches all subscribers.

WebSocket on Vercel depends on platform support and connection limits — treat WS as best-effort; **`pull.intervalMs`** on clients remains the convergence backstop.

## Honest verdict

| Concern | Status |
|---------|--------|
| Pull/push API on Fluid | Viable with Neon + Hyperdrive-style pooling |
| Multi-instance NOTIFY | Required for cross-instance pings |
| Long-lived WS | Platform-constrained — verify current Vercel WS docs before betting product UX on instant push |
| Offline convergence | Still holds — cursor pull is authoritative |

For production realtime-heavy apps, a always-on Node/Bun VM or Cloudflare DO hub is simpler than fighting serverless WS limits.

## Managed Postgres

Pair with any [managed Postgres](/self-hosting/managed-postgres/) — Nizhal's no-WAL machinery runs without replication slots.
