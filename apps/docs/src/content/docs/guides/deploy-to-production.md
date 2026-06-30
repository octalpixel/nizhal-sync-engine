---
title: Local → production (Neon + Vercel + Cloudflare)
description: Take a working local Nizhal app to a live serverless deployment — managed Postgres, serverless API, and edge realtime — with the exact commands and the gotchas that bite.
---

This is the end-to-end path from a working local app to a **fully serverless production deployment**:
**Neon** (managed Postgres) ← **Vercel** (serverless API + web) → **Cloudflare Worker** (edge realtime
Durable Object) ← every client. It's the recipe behind the Tabkeep reference deployment, with the
sharp edges called out so you don't rediscover them.

```
 React / Expo web ─┐                            ┌─ pull / push (HTTP) ──► Vercel serverless ──► Neon
 iOS / Android  ───┼─ realtime (WS) ──► CF Worker DO ◄── publish (commit poke) ── Vercel
```

If your app is realtime-light, you can skip the Worker entirely and rely on `pull.intervalMs` — but
the steps below give you instant cross-device sync.

## 0. Prove it locally first

Before touching the cloud, confirm sync works on your machine: run your server (e.g. an in-process
PGlite demo server) and a client, write on one, see it on another. Nizhal's local and hosted code
paths are identical, so a green local run means the only remaining variables are infrastructure.

## 1. Provision the database (Neon)

Create a database and apply your schema. Two things bite here:

- **Use the *pooled* connection string for serverless.** Serverless functions cold-start many
  instances; the direct endpoint exhausts Neon's connection limit. Grab the `-pooler` host:
  ```bash
  neonctl connection-string <branch> --project-id <id> --database-name <db> --pooled
  # postgresql://USER:PASS@ep-xxxx-pooler.REGION.aws.neon.tech/DB?sslmode=require
  ```
- **`nizhal migrate` layers the engine onto your *existing* tables — it does not create them.**
  Create your business tables first (your ORM / SQL migrations), then provision:
  ```bash
  # 1. create business tables (your migrations) — then:
  DATABASE_URL="postgresql://…/DB?sslmode=require" nizhal migrate --config nizhal.config.ts
  ```
  A `.ts` config (and its `.ts` source imports) loads directly — no build step. Run against an empty
  database and migrate stops with a message telling you to create your tables first.

Prefer **provisioning in code** for serverless? Skip the CLI and call `storage.provision({ schema,
syncRules })` once from a deploy script (after applying your business DDL). Most serverless deploys do
this — see `apps/tabkeep/scripts/provision-neon.ts`.

## 2. Deploy the realtime Worker (Cloudflare)

```bash
cd node_modules/@nizhal/server/dist/adapters/cloudflare   # or your own worker entry
wrangler deploy
wrangler secret put NIZHAL_JWT_SECRET         # = your server's bearerTokenAuth secret
wrangler secret put NIZHAL_PUBLISH_SECRET     # shared secret for the server→DO publish bridge
wrangler secret put NIZHAL_AUTHORIZATION_URL  # REQUIRED — your server origin (https://app.example.com)
```

:::danger[NIZHAL_AUTHORIZATION_URL is mandatory]
The worker does **not** authorize subscriptions itself — on every WS upgrade it calls back to
`<NIZHAL_AUTHORIZATION_URL>/sync/realtime/authorize?bucket=…` to confirm the subscriber may read the
bucket. Leave it unset and **every realtime subscription is rejected** with a `500` naming this
variable, while `POST /_nizhal/publish` still returns `204` — so the worker *looks* healthy while
realtime is silently dead. Set it to your deployed server origin.
:::

Note the worker URL (e.g. `https://nizhal-realtime.you.workers.dev`).

## 3. Deploy the server + web (Vercel)

Expose the Hono server as a serverless function. The interactive-transaction push path runs fine on
the Neon pooler; realtime fan-out is awaited in-request, so a frozen lambda never drops it.

```ts
// api/index.ts — serverless handler
import { getRequestListener } from "@hono/node-server";
import { postgresStorage } from "@nizhal/server/adapters";
import { cloudflareHttpRealtime } from "@nizhal/server/adapters/cloudflare/realtime";
import { createMyServer } from "../src/server.js";

const storage = postgresStorage({ connectionString: process.env.DATABASE_URL! });
const realtime = cloudflareHttpRealtime({
  publishUrl: `${process.env.NIZHAL_WORKER_URL}/_nizhal/publish`,
  publishSecret: process.env.NIZHAL_PUBLISH_SECRET!,
});
const server = createMyServer({ db: process.env.DATABASE_URL!, secret: process.env.NIZHAL_JWT_SECRET!, storage, realtime, cors: true });
export default getRequestListener(server.app.fetch);
```

Set the project env vars (production): `DATABASE_URL` (the **pooled** URL), `NIZHAL_JWT_SECRET`,
`NIZHAL_PUBLISH_SECRET`, and `NIZHAL_WORKER_URL` — the same secret values you gave the worker.

Hosting the web app **same-origin** with the API (one Vercel project, with the SPA static + the
function) keeps `/sync/*` and your session endpoint as relative paths — no CORS to configure.

:::tip[Monorepo bundling]
If your server imports workspace packages, pre-bundle the function (e.g. `esbuild --bundle
--platform=node`, marking the Worker-only `cloudflare:workers` import as external) and ship it via
Vercel's Build Output API. That sidesteps Vercel-side workspace resolution entirely. See
`apps/tabkeep/api/index.ts` for the reference handler.
:::

:::note[Deployment Protection]
On a team plan, the immutable `*-<hash>-<team>.vercel.app` deploy URL is gated behind Vercel
Authentication (302 to login). The clean production alias (`<project>.vercel.app`) is public — use
that for clients.
:::

## 4. Point the clients at the deployment

- **Web** — build with the Worker host injected, and use the Cloudflare realtime route
  (`createCloudflareSubscribeSource`):
  ```bash
  VITE_NIZHAL_REALTIME_HOST="nizhal-realtime.you.workers.dev" pnpm build
  ```
- **React Native** — set `realtimeHost` so realtime connects to the Worker instead of the (nonexistent)
  serverless `/sync/stream`:
  ```ts
  createNizhalNitroClient({
    server: "https://app.example.com",
    realtimeHost: "nizhal-realtime.you.workers.dev", // → nitroCloudflareSubscribeSource
    token,
  });
  ```

## 5. Verify the deployment

Don't trust a `200` — exercise the engine end-to-end:

1. **Push → durable commit**: a real client `addCustomer` → confirm the row in Neon (`psql`).
2. **Pull**: a second client pulls and sees it (cursor advances).
3. **Realtime**: with a subscriber connected, a push triggers `repull:<bucket>` within ~1s.
4. **Cross-device**: write on web, watch it land on mobile (and vice-versa).

Reusable probes that do exactly this live in `apps/tabkeep/examples/`:
`hosted-push-test.ts` (push→pull), `hosted-realtime-test.ts` (publish→subscriber repull).

## Gotchas, ranked (all fixable, most now loud)

| # | Symptom | Cause | Fix |
|---|---------|-------|-----|
| 1 | Realtime silently dead; publish still `204`s | `NIZHAL_AUTHORIZATION_URL` unset on the worker | set it to your server origin (step 2) |
| 2 | `nizhal migrate` errors on a fresh DB | business tables don't exist yet | create them first; migrate layers the engine on top |
| 3 | Writes 401 → dead-letter mid-session | session token expired, no refresh | wire `auth.refresh` to re-fetch a token on 401 |
| 4 | Connection storms / pool errors | direct Neon endpoint on serverless | use the `-pooler` (pgbouncer) connection string |
| 5 | RN realtime won't connect | nitro WS points at the server's `/sync/stream` | set `realtimeHost` to the Worker (`nitroCloudflareSubscribeSource`) |

## Where this leaves you

Infrastructure and the sync engine are production-grade with this setup — durable, idempotent,
realtime, across web + native. The remaining step to a production *app* is **real auth**: replace any
open demo session endpoint with your auth provider issuing scoped bearer tokens; Nizhal's token and
realtime-authz seams already support it.
