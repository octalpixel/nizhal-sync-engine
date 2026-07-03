# Deploying the Nizhal sync server

The server is a plain [Hono](https://hono.dev) app. Its `app.fetch` handler runs on **any**
fetch-based host; realtime rides one WebSocket route, `/sync/stream`. That means there is no
Nizhal-specific host — if a platform runs Node (or Bun/Deno/Workers) and Postgres, it runs Nizhal.

The worked reference is **[`playground/deploy`](../playground/deploy)**: one shared domain
(`domain.mjs` — schema, mutators, sync rules, bearer auth, Postgres storage, realtime) behind
three interchangeable entrypoints, plus a `smoke.mjs` you can point at any running URL.

## The three deploy classes

| Class | Hosts | Entrypoint | Realtime adapter | Outbox drain (jobs + tombstone GC) |
|---|---|---|---|---|
| **Long-running process** | Docker · Fly.io · Railway · Render · AWS (ECS/EC2/App Runner) · SST · bare Node/Bun | `createNizhalServer(cfg).listen(port)` | `listenNotifyRealtime` (direct PG) | **automatic** — a poll loop starts in `listen()` |
| **Serverless functions** | Vercel (Fluid compute WebSockets) · Lambda | `const s = serve({ fetch: app.fetch }); injectWebSocket(s); export default s` + `provisionRealtime()` at cold start | `listenNotifyRealtime` (the socket pins to one instance, whose `LISTEN` stays live) — or offload to `cloudflareRealtime` | **you schedule it** — a Cron function calls `runJobsOnce()` |
| **Edge** | Cloudflare Workers | Worker `fetch` handler over `app.fetch` | `cloudflareRealtime` (realtime in a stateful Durable Object beside the stateless data plane) | Cron Trigger → `runJobsOnce()` |

`listen()` (class 1) does three things a serverless entry must do itself: bind the HTTP server,
attach the WebSocket upgrade handler (`injectWebSocket`), install the realtime triggers
(`provisionRealtime`), and run the outbox poll loop. On serverless there is no persistent process,
so you call `provisionRealtime()` once at cold start and drain the outbox from a scheduled function.

## Every host needs one Postgres

There is no deployment without Postgres. It holds the sync state **and** the server's transactional
outbox (`_nizhal_jobs`): a job is enqueued in the *same* transaction as the mutation that triggers
it. That atomicity is the design — a mutation and its side-effect commit or roll back together, with
no window where one happened and the other didn't. A separate queue (Redis, SQS) cannot hold that
guarantee without a distributed transaction, so the outbox stays in Postgres regardless of scale.
Redis is still useful *beside* it (e.g. Vercel's shared state for presence) — just not as the outbox.

**Connection mode matters for realtime.** `listenNotifyRealtime` holds a persistent `LISTEN`
connection; a transaction-mode pooler (PgBouncer `transaction`, Neon's *pooled* endpoint) recycles
connections and silently drops it. Give the server a **direct / session-mode** URL. HTTP push/pull
alone are fine through a pooler; only `LISTEN/NOTIFY` needs the direct connection.

## Realtime: an explicit choice, not magic

`pg_notify` is **not** a default and is never auto-enabled. You pick a `RealtimeAdapter`:

| Adapter | Use it for |
|---|---|
| `inProcessRealtime` | **Dev/test only.** In-memory pub/sub inside one process — an antipattern in production: with ≥2 instances (every autoscaler), a socket on instance A never hears a write on instance B. The server logs a warning if this is left as the default under `NODE_ENV=production`. |
| `listenNotifyRealtime` | **The production default.** Cross-instance via Postgres `LISTEN/NOTIFY`. Needs a direct connection (above). Its `NOTIFY` triggers are installed by `provisionRealtime()` — a base `nizhal migrate` does not add them, so without provisioning a server would `LISTEN` but never receive, and realtime would be silently dead. |
| `cloudflareRealtime` | **Edge/serverless topology.** Realtime lives in a stateful Cloudflare Worker Durable Object next to a stateless data plane. This is a *realtime adapter*, not "a Cloudflare server" — the sync server is still the Hono app; only the poke fan-out moves to the Worker. |

The poke is only ever a hint (`repull:<bucket>`); the client's cursor pull is authoritative, so a
missed or duplicated poke self-heals on the next pull. This is why a dropped socket is not data loss.

## Auth: `resolve()` is the seam

Every request resolves an actor before any sync work:

```ts
interface NizhalAuth {
  resolve(req: Request): Promise<{ userId: string; ownerId: string } | null>; // null → 401
}
```

`bearerTokenAuth({ secret })` is the batteries-included JWT implementation (verify a `Bearer` token
carrying `{ userId, ownerId }`). To wire your own identity — a session store, Clerk/Auth0/Supabase,
an internal IdP — pass a custom `auth` whose `resolve()` does the lookup and returns the actor. On
the WebSocket upgrade the token rides the `?token=` query (browsers and Node cannot set headers on an
upgrade request); everywhere else it is the `Authorization` header.

`ownerId` is the tenant boundary — sync rules scope every bucket by it, so a correct `resolve()` is
what keeps one tenant's rows out of another's pull. Treat it as security-critical, not plumbing.

## The reference deploy

[`playground/deploy`](../playground/deploy) — one `domain.mjs`, four entrypoints:

- **`node-server.mjs`** — `.listen()`, the long-running class (Docker/Fly/Railway/Render/AWS/SST).
- **`bun-server.mjs`** — `Bun.serve` via the injectable WS factory (`createWebSocket`), same domain.
- **`api/server.mjs` + `api/drain.mjs` + `vercel.json`** — the serverless class: `export default serve()`
  with `injectWebSocket`, and a `CRON_SECRET`-guarded drain that calls `runJobsOnce()`.
- **`Dockerfile`** — a `node:22-slim` image for any container host.

`smoke.mjs` is host-agnostic (raw HTTP + WebSocket, no client SQLite) — set `SERVER_URL` and it
exercises auth (401/200), HTTP push/pull, and the WS `/sync/stream` poke against any running server.

```bash
# container class
DATABASE_URL=postgres://…direct… JWT_SECRET=… pnpm --filter nizhal-deploy start
SERVER_URL=http://127.0.0.1:4700 node playground/deploy/smoke.mjs   # → 5/5
```

## What's verified

- **Long-running / container:** Node smoke 5/5; cross-instance `listenNotifyRealtime` confirmed
  delivering on real Neon (a two-instance `NOTIFY` from one process reaching a `LISTEN` on another).
- **Bun runtime:** smoke 5/5 via the injectable WS factory.
- **Serverless entrypoint:** smoke 5/5 running the exact `export default serve() + injectWebSocket`
  entry locally (`@hono/node-server`'s `serve()` self-listens); drain handler verified for no-secret,
  wrong-secret (403), and correct-secret. A live Vercel deploy needs the WebSocket public-beta
  permission + a hosted Postgres and is validated per project.
