---
title: Scaling on Cloudflare (Hyperdrive + Durable Objects)
description: Run the whole Nizhal stack on Cloudflare — Workers + Durable Object realtime + Postgres accelerated by Hyperdrive — and what's first-party today.
---

The Cloudflare topology puts every layer at the edge: **Workers** serve the HTTP sync surface, **Durable Objects** are the per-bucket realtime hubs, and **Hyperdrive** accelerates your existing Postgres so the read-heavy pull path stays fast globally. This is the highest-concurrency, lowest-latency way to run Nizhal — see [when to reach for it](/concepts/realtime/#choosing-a-realtime-adapter) first; for most apps a Node server is simpler.

## The shape

```
Browser / RN ──HTTP (pull/push)──▶ Worker ──Hyperdrive──▶ Postgres (Neon/RDS/…)
        └──────WebSocket───────▶ NizhalBucket Durable Object (one per bucket)
                                        ▲ repull poke
              server commit ───────────┘  (cloudflareRealtime, direct DO RPC)
```

- **Compute** — `createNizhalServer` runs inside the Worker (Hono is Workers-native).
- **Realtime** — `cloudflareRealtime` RPCs one `NizhalBucket` Durable Object per bucket; clients hold a standard WebSocket to `/parties/nizhal-bucket/<bucket>`. Verified on real `workerd` by `run-cf-e2e.sh`.
- **Database** — your Postgres, reached through **Hyperdrive** (pooling + caching) instead of a raw connection.

## Why Hyperdrive matters here

Workers are stateless and globally distributed, so a naive Postgres connection pays full setup latency on every isolate and can exhaust your database's connection slots. Hyperdrive fixes both: it **pools connections near your database**, **sets up connections near your Worker**, and **caches read query results** — exactly the profile of Nizhal's hot path, where most traffic is `/sync/pull` → `getChanges` (reads) and writes go through `/sync/push`.

### Wiring it

`postgresStorage` takes any `postgres.js` client, so point it at the Hyperdrive binding:

```ts
import postgres from "postgres";
import { createNizhalServer } from "@nizhal/server";
import { postgresStorage } from "@nizhal/server/adapters";
import { cloudflareRealtime } from "@nizhal/server/adapters/cloudflare";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const sql = postgres(env.HYPERDRIVE.connectionString, {
      max: 5,            // Workers cap concurrent external connections at ~6
      fetch_types: false, // skip a round-trip if you don't use array types
    });
    const server = createNizhalServer({
      storage: postgresStorage({ client: sql }),
      secret: env.NIZHAL_JWT_SECRET,
      realtime: cloudflareRealtime(env), // direct DO RPC
      cors: { origin: ["https://app.example.com"] },
    });
    return server.app.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
```

Bind Hyperdrive and the DO in `wrangler.jsonc` (alongside the `NizhalBucket` binding the realtime worker already declares).

### The caching caveat (read this)

Hyperdrive caches **read** query results for a short TTL. Nizhal's `getChanges` is parameterized by the client **cursor**, so each advancing cursor is a *distinct* query — caching mostly helps when **many devices sit at the same cursor** (e.g. a bucket that just settled), and never caches writes (`/sync/push`). Two things make this safe:

- A briefly-stale pull is **not** a correctness problem — Nizhal is offline-first, the **cursor pull is authoritative**, and the realtime poke plus the next pull converge within the TTL. Worst case is "syncs a TTL later," never "wrong data."
- If you want zero staleness on the sync path, scope Hyperdrive caching (shorter `max_age`, or disable caching for the sync queries) and keep pooling — pooling is the bigger win anyway.

Keep `max` small (≤5) per the Workers concurrent-connection limit; Hyperdrive multiplexes those onto its own larger pool.

## Cloudflare stack — what Nizhal supports today

You asked whether the full CF stack is first-party. Honest map:

| CF service | Status | Notes |
|-----------|--------|-------|
| **Workers** (compute) | ✅ First-party | `createNizhalServer` (Hono) runs on Workers; `cloudflareRealtime` + `worker.entry.ts` ship today. |
| **Hyperdrive** (DB acceleration) | ✅ Works now, no code change | `postgresStorage` takes the Hyperdrive `connectionString`/client. Transparent pooling + caching. |
| **WAF & DDoS** | ✅ Automatic (infra) | Sits in front of Workers/Pages; nothing to wire in Nizhal. |
| **R2** (object storage) | ⚠️ Seam-ready | `BlobStore` is an **S3-style presign** seam; R2 is S3-compatible, so an R2 adapter is a thin wrapper — but only `memoryBlobStore` ships first-party today. |
| **Queues** (background jobs) | ⚠️ Different model | Nizhal ships a **Postgres-backed durable job scheduler/worker** (`createJobScheduler`/`createJobWorker`), not CF Queues. A Queues-backed `JobScheduler` adapter isn't shipped. |
| **D1** (SQLite) + **better-auth** | ❌ Not first-party | Storage is **Postgres-first** (columns + triggers, no WAL) via the `StorageAdapter` seam; the audit log already has a **libSQL** adapter, so a D1/SQLite storage adapter is feasible but unbuilt. Auth is bearer-token (`bearerTokenAuth`); better-auth would be a custom integration. |
| **KV** (cache) | ❌ Not used | Hyperdrive already covers DB-read caching; a KV layer for contract/session caching isn't wired. |

**Recommendation.** The high-value, low-effort CF-first-party work, in order: (1) **Hyperdrive** — already works, just document/bless it (done here); (2) an **R2 `BlobStore` adapter** (small, the presign seam exists); (3) a **D1/SQLite `StorageAdapter`** if you want a no-external-Postgres edge deployment (largest effort — the trigger-based change-tracking has to be reworked for SQLite, and the libSQL audit adapter is the starting point). KV/Queues/better-auth are nice-to-haves, not blockers.

## See also

- [Choosing a realtime adapter](/concepts/realtime/#choosing-a-realtime-adapter)
- [Cloudflare self-hosting](/self-hosting/cloudflare/) · [Production deployment](/production/deployment/) · [Scaling & concurrency](/production/scaling/)
