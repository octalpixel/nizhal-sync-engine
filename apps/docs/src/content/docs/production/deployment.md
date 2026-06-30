---
title: Production deployment
description: Taking Nizhal from a local demo to real users — the checklist, topologies, and the things that bite.
---

The demo apps run on PGlite + an in-process realtime hub + a long-lived demo token. That's perfect for a laptop and wrong for production. This page is the gap: what to change, how to deploy, and the failure modes that only show up with real users.

## Demo → production checklist

| Concern | Demo | Production |
|---------|------|-----------|
| **Database** | PGlite (in-memory, single process, lost on restart) | A real Postgres (Neon / RDS / Supabase / self-hosted). See [Managed Postgres](/self-hosting/managed-postgres/). |
| **Auth tokens** | One long-lived token from `/demo/session`, never refreshed | Short-lived bearer tokens **+ a refresh path** (see below) |
| **Realtime** | `inProcessRealtime` (single process only) | Pick by topology — `listenNotifyRealtime` (multi-instance) or Cloudflare (edge). See [Realtime](/concepts/realtime/). |
| **Secrets** | Hard-coded `SECRET` in the demo server | `NIZHAL_JWT_SECRET` (and CF `NIZHAL_PUBLISH_SECRET`) from the environment / secret store |
| **CORS** | `cors: true` (any origin) | An explicit allow-list of your app origins |
| **Limits** | Defaults (1 MiB body, 120 req/actor/min) | Tune per your traffic — see [Scaling](/production/scaling/) |
| **Persistence (client)** | Web in-memory / op-sqlite | Durable on both: `waSqlitePersistence` (web, OPFS) + `opSqlitePersistence` (RN) so writes survive reload/restart |

### The token-expiry trap (read this one)

`issueBearerToken` defaults to a **1-hour** TTL. The realtime/HTTP transports send that token on every pull/push. When it expires:

1. `/sync/push` and `/sync/pull` return **401**.
2. A 401 is a `4xx` → the durable outbox treats it as a **deterministic client error and parks the write in the dead-letter queue** (poison-quarantine, by design — it does not blindly retry 4xx).
3. The write is now stuck locally and will *not* auto-flush, even after the user gets a fresh token.

So a long-open tab or a backgrounded app silently stops syncing. **Fix it two ways, together:**

- Wire `auth.refresh` on the client so a 401 transparently rotates the token and retries:

  ```ts
  createNizhalClient({
    server,
    auth: {
      getHeaders: () => ({ Authorization: `Bearer ${currentToken}` }),
      refresh: async () => {
        currentToken = await fetchFreshToken(); // your endpoint
        return { Authorization: `Bearer ${currentToken}` };
      },
    },
    // ...
  });
  ```

  The HTTP transport calls `refresh()` on a 401 and retries; the WebSocket source re-reads auth on every reconnect, and runs `refresh` on a connect that fails before opening (the upgrade-time auth failure mode).

- Set a token TTL comfortably longer than your worst-case reconnect window (`issueBearerToken({ ..., expiresInSec })`). With backoff capped at ~10s, a few-minute TTL has plenty of headroom; pair it with refresh for sessions longer than the TTL.

## Topologies

Nizhal splits into two independent surfaces — **HTTP** (`/sync/pull`, `/sync/push`, `/nizhal/contract`) and **realtime** (a contentless `repull` poke; the cursor pull is always authoritative). You can scale and host them separately.

### 1. Single Node + Postgres (start here)

One `createNizhalServer` process, `postgresStorage`, `inProcessRealtime`. Simplest correct setup; handles real traffic for a single region. See [Node.js](/self-hosting/node/).

```ts
const server = createNizhalServer({
  storage: postgresStorage({ connectionString: process.env.DATABASE_URL }),
  secret: process.env.NIZHAL_JWT_SECRET,
  cors: { origin: ["https://app.example.com"] },
  // realtime defaults to inProcessRealtime
});
```

### 2. Multi-instance Node + Postgres `LISTEN/NOTIFY`

`inProcessRealtime` only fans out within one process — a second instance won't see the first's commits. Swap in `listenNotifyRealtime` so every instance hears every commit through Postgres. No extra infra (no Redis), just your existing database.

```ts
createNizhalServer({
  storage: postgresStorage({ connectionString: DATABASE_URL }),
  realtime: listenNotifyRealtime({ connectionString: DATABASE_URL }),
  secret: process.env.NIZHAL_JWT_SECRET,
});
```

### 3. Serverless HTTP (Vercel) + Cloudflare realtime

Serverless functions can't hold WebSockets, so split: host the **HTTP** surface on [Vercel](/self-hosting/vercel/) (Fluid/serverless + external Postgres) and run **realtime** on a Cloudflare worker. The Node/serverless server drives the edge DOs over the publish bridge with `cloudflareHttpRealtime`:

```ts
createNizhalServer({
  storage: postgresStorage({ connectionString: DATABASE_URL }),
  realtime: cloudflareHttpRealtime({
    publishUrl: "https://nizhal-realtime.acme.workers.dev/_nizhal/publish",
    publishSecret: process.env.NIZHAL_PUBLISH_SECRET,
  }),
});
```

### 4. Full Cloudflare (edge, global)

Server-on-Workers + `cloudflareRealtime` (direct Durable Object RPC). One DO per bucket is the realtime hub; clients hold a standard WebSocket to `/parties/nizhal-bucket/<bucket>`. Best for global low-latency and very high connection counts. See [Cloudflare](/self-hosting/cloudflare/) and [when to use it](/concepts/realtime/#choosing-a-realtime-adapter).

## Deploying the Cloudflare realtime worker

```bash
pnpm --filter @nizhal/server build
cd packages/server
wrangler deploy -c src/adapters/cloudflare/wrangler.jsonc
wrangler secret put NIZHAL_JWT_SECRET      # verifies the WS upgrade ?token=
wrangler secret put NIZHAL_PUBLISH_SECRET  # authorizes the server→DO publish bridge
```

Configure `NIZHAL_AUTHORIZATION_URL` (or a service binding) so the worker authorizes each room join against your server, and the DO re-checks before every ping (fails closed if unset). The full path is verified end-to-end on real `workerd` + DOs by `packages/server/examples/run-cf-e2e.sh`.

## Pre-launch verification

- Run the **chaos suite** (`pnpm chaos`) against your real Postgres (`NEON_URL=...`) — 19 adversarial scenarios incl. server restart mid-outbox, dropped realtime, poison dead-letter, revocation. See [Validation](/production/validation/).
- Exercise **offline → online** on a real device: write while offline, confirm the outbox flushes on reconnect; take a device down, add data elsewhere, bring it up and confirm catch-up.
- Confirm **token refresh** works: let a token expire (or shorten TTL) and verify writes still flush instead of dead-lettering.

Then size it: [Scaling & concurrency](/production/scaling/).
