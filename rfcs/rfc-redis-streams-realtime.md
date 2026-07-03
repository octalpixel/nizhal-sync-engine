# RFC: `redisStreamsRealtime` — a pooler-agnostic realtime adapter

**Status:** PROPOSED (post-1.0, non-blocking) · **Slug:** `redis-streams-realtime` · authored 2026-07-03
**Parent:** `rfc-production-readiness.md` (the release this would follow) · adapter seam defined in
`packages/server/src/adapters/realtime.ts` (`RealtimeAdapter`).

A fourth `RealtimeAdapter` beside `inProcessRealtime` (dev), `listenNotifyRealtime` (Postgres
LISTEN/NOTIFY), and `cloudflareRealtime` (Worker Durable Object). It fans out the `repull:<bucket>`
poke over a **Redis Stream**, for teams that run behind a transaction-mode Postgres pooler or already
operate Redis and don't want to add a Cloudflare Worker.

Prior art: Mastra's event system ships the same idea — a pluggable pub/sub with a `RedisStreamsPubSub`
transport for distributed fan-out — while keeping durable state in the database, not Redis. This RFC
takes the transport, not the philosophy shift: **the outbox stays in Postgres** (see Non-goals).

## Why — the gap this closes

`listenNotifyRealtime` is the production default, but it holds a persistent `LISTEN` connection, which a
**transaction-mode pooler recycles out from under it** (PgBouncer `transaction`, Supabase pooled, Neon
pooled). Our own `deploy.md` documents the mitigation: give the server a *direct/session-mode* URL. Not
every team can — some platforms only expose the pooled endpoint, and a serverless fleet that opens one
direct `LISTEN` connection per warm instance can exhaust a small Postgres's connection budget fast.

`cloudflareRealtime` solves multi-instance fan-out cleanly but requires adopting Workers + a Durable
Object. A team already running Redis (cache, sessions, BullMQ) wants the same fan-out with infra they
already have and no Postgres connection-mode constraint. That's this adapter.

|  | connection needs | infra | catches out-of-band DB writes | replay |
|---|---|---|---|---|
| `listenNotifyRealtime` | **direct/session-mode** PG | none (uses your PG) | **yes** (DB triggers) | no |
| `cloudflareRealtime` | any | Cloudflare Worker + DO | no (app-level) | no |
| `redisStreamsRealtime` *(this)* | any (pooler-safe) | Redis | no (app-level) | optional (Streams) |

## Design

Mirror `listenNotifyRealtime`'s structure exactly: wrap `inProcessRealtime()` as the per-instance
socket registry, and add a cross-instance transport around it.

```ts
export function redisStreamsRealtime(opts: {
  url: string;              // redis:// — any endpoint, pooled or not; no session-mode requirement
  client?: RedisClient;     // inject an existing ioredis/node-redis client (tests, shared pool)
  streamKey?: string;       // default "nizhal:bucket"
  maxLen?: number;          // default ~5_000 — pokes are ephemeral hints, trim aggressively
}): RealtimeAdapter {
  const local = inProcessRealtime();
  // one XADD per poke; one background XREAD BLOCK consumer per instance
  return {
    publish(bucket) {
      local.publish(bucket);                             // same-instance sockets, synchronously
      void xadd(streamKey, bucket, { maxLen });          // fan out to every other instance
    },
    subscribe(buckets, socket) {
      void ensureConsuming();                            // idempotent: start the XREAD loop once
      return local.subscribe(buckets, socket);
    },
    presence: local.presence,
    stats: () => local.stats(),
    async stop() { await stopConsuming(); await client.quit(); },
    // NOTE: no provision() — nothing to install in Postgres. This is the pooler-agnostic win.
  };
}
```

**Transport = Stream, not plain pub/sub.** Redis `PUBLISH`/`SUBSCRIBE` drops a message if no subscriber
is attached at that instant; a Stream (`XADD`/`XREAD BLOCK`) survives a momentary consumer gap during a
reconnect. Every instance is a fan-out reader, not a work-queue worker, so **no consumer groups** — each
instance does `XREAD BLOCK 0 STREAMS nizhal:bucket $` (only entries after it connected) and calls
`local.publish(bucket)` for each. `MAXLEN ~ 5000` keeps the stream bounded; the poke is a hint, so trimmed
history is not data loss.

**Poke stays best-effort by contract.** A dropped/duplicated poke self-heals: the client's cursor pull is
authoritative (`rfc-local-sync-convergence.md` §4.6; `websocket-source.ts`). So this adapter inherits the
same "at-least-once-ish, order-independent, loss-tolerant" guarantee the other adapters have — Redis
durability is a bonus, not a correctness dependency.

## The one honest semantic difference

`listenNotifyRealtime` installs **DB triggers** (`provision()`), so it fans out **every** write to a synced
table — including out-of-band SQL, admin scripts, or a background job that writes a synced row directly.
`redisStreamsRealtime` (like `cloudflareRealtime`) fans out only writes that pass through the mutator
commit chokepoint where `realtime.publish(bucket)` is called (`index.ts` `handlePush`).

For the common case — **all writes go through mutators** — the two are identical. For apps that also write
synced tables out-of-band, those writes won't emit an instant poke under this adapter; clients converge on
their next periodic pull (correct, just not sub-second). Documented as a known property; a later change
could thread `realtime.publish` through the job-commit path to narrow it.

## Non-goals

- **Not the outbox.** The server's transactional outbox (`_nizhal_jobs`) stays in Postgres — a job is
  enqueued in the *same transaction* as its mutation, and no external queue holds that atomicity without a
  distributed transaction. Redis here is **ephemeral fan-out only**, exactly the boundary Mastra draws
  (Redis for pub/sub + stream cache; durable record in the DB). This RFC does not touch jobs.
- **Not presence truth.** Presence v2 state stays per-instance in `inProcessRealtime` (as it is for
  `listenNotifyRealtime` today); cross-instance presence is a separate, larger question.
- **Not a default.** `listenNotifyRealtime` remains the documented production default; this is an opt-in
  for the pooler/Redis-shaped deployment.

## Plan

1. `packages/server/src/adapters/redis-realtime.ts` — the adapter above. Redis client as an **optional peer
   dependency** (`ioredis` or `node-redis`) so non-users don't pull it; `client?` injection for tests.
2. Export `redisStreamsRealtime` from `packages/server/src/adapters/index.ts`. → verify: `check-types`.
3. `packages/server/test/redis-streams-realtime.test.ts` — cross-instance test gated on
   `NIZHAL_TEST_REDIS_URL` (mirrors the `NIZHAL_TEST_DATABASE_URL`-gated `listen-notify-realtime.test.ts`):
   two adapters over one Redis, `publish(bucket)` on A → poke observed on B's subscribed socket.
   → verify: green with a real Redis, skipped without.
4. Wire that test into the CI real-services job beside the real-Postgres leg. → verify: CI green.
5. Docs: a matrix row in `docs/deploy.md` + the adapter table in `docs/api.md` + a line in `platforms.md`'s
   realtime section noting the pooler-agnostic tradeoff. → verify: links resolve.

**Estimate:** ~1 adapter file + 1 gated test + docs. No protocol change, no client change, no migration.

## Verification bar

Same as `listenNotifyRealtime` earned in P-hardening: a **real, two-instance** cross-process delivery test
on real Redis (not a mock) proving a `publish` on one adapter reaches a socket subscribed on another —
because multi-instance fan-out is exactly the property single-process tests cannot catch.
