# RFC: `@nizhal/server/core` — a framework-free sync core

**Status:** PROPOSED (post-1.0, non-blocking) · **Slug:** `framework-free-core` · authored 2026-07-03
**Parent:** `rfc-production-readiness.md` · builds on the H5 `createWebSocket` factory already shipped.

Extract the sync **handler logic** out of the Hono routing in `createNizhalServer` into a
framework-free core built on Web-standard `Request`/`Response`. `createNizhalServer` stays exactly as
it is — it becomes a ~40-line Hono binding over the core. No wire-protocol change, no client change.

## Why

Today `createNizhalServer` *is* a Hono app: the push/pull/stream handlers are closures inside it
(`index.ts` — `/sync/push` at :512, `/sync/pull` at :448, `/sync/stream` at :624), and nothing is
exported to drive them without Hono. That's fine for the three common cases (embed `server.app`, mount
under an existing Hono app, or call `server.app.fetch` from a Vercel/Next route). It is *not* fine for a
team that wants to wire push/pull into an existing non-fetch router (a large Express/Koa/Fastify app)
without adopting a second HTTP app or a fetch bridge, or one that wants the sync logic with zero Hono
in the dependency tree.

The handlers are **already ~90% framework-agnostic** — each takes a `Request`, resolves an actor, hits
`storage`/`config.mutators`, and returns a `Response`. Only the *routing*, CORS middleware, and the WS
`upgradeWebSocket` primitive are Hono-specific. So this is an extraction, not a rewrite.

## The core surface

```ts
// @nizhal/server/core
export function createNizhalCore(config: NizhalServerConfig): NizhalCore;

export interface NizhalCore {
  /** Web-standard handlers. Mount in ANY fetch router, or bridge Node req/res once. Each already
   *  applies auth, body limits, rate limiting, and the correct error→status mapping — a binding maps
   *  a path to a handler and does nothing else. */
  contract(): Response;                     // GET  /nizhal/contract
  push(req: Request): Promise<Response>;    // POST /sync/push
  pull(req: Request): Promise<Response>;    // POST /sync/pull
  stats(req: Request): Promise<Response>;   // GET  /nizhal/stats
  blob?: {                                  // present only when a BlobAdapter is configured
    presignUpload(req: Request): Promise<Response>;
    downloadUrl(req: Request): Promise<Response>;
  };

  /** Realtime is the one thing that is NOT pure Request→Response: it needs the runtime's socket
   *  upgrade primitive. The core owns the AUTH + subscription logic; the binding provides the socket. */
  authorizeStream(req: Request): Promise<
    | { ok: true; actor: Actor; buckets: BucketKey[] }
    | { ok: false; status: 401 | 403; body: unknown }
  >;
  openStream(input: { actor: Actor; buckets: BucketKey[]; authRequest: Request }): StreamHandlers;
  //   StreamHandlers = { onOpen(socket), onMessage(data, socket), onClose(socket), onError(socket) }
  //   — the exact closure body of today's /sync/stream (index.ts:648-728), runtime-agnostic. A binding
  //   feeds it whatever socket its runtime yields (Hono upgradeWebSocket / Bun / Deno / raw `ws`).

  /** Lifecycle — already framework-free today; moves onto the core unchanged. */
  provisionRealtime(): Promise<void>;
  runJobsOnce(): Promise<number>;
  jobs: JobWorker | null;                   // start()/stop()/runOnce()
  realtime: RealtimeAdapter;
  storage: StorageAdapter;

  /** The canonical path table the client SDK expects — exported so every binding wires the SAME
   *  routes and they can't drift from the client. */
  routes: typeof NIZHAL_ROUTES;             // { contract:"/nizhal/contract", push:"/sync/push", … }
}
```

`createNizhalServer(config)` is then, in full:

```ts
export function createNizhalServer(config: NizhalServerConfig): NizhalServer {
  const core = createNizhalCore(config);
  const app = new Hono();
  if (config.cors) app.use("*", cors(config.cors === true ? { origin: "*" } : config.cors));
  app.get(core.routes.contract, () => core.contract());
  app.post(core.routes.push, (c) => core.push(c.req.raw));
  app.post(core.routes.pull, (c) => core.pull(c.req.raw));
  app.get(core.routes.stats, (c) => core.stats(c.req.raw));
  // … blob routes when core.blob …
  const webSocket = (config.createWebSocket ?? ((a) => createNodeWebSocket({ app: a })))(app);
  app.get(core.routes.stream, streamAuthMiddleware(core), webSocket.upgradeWebSocket((c) =>
    core.openStream({ actor: c.get("actor"), buckets: c.get("buckets"), authRequest: c.get("auth") }),
  ));
  return { app, webSocket, injectWebSocket: …, provisionRealtime: core.provisionRealtime,
           runJobsOnce: core.runJobsOnce, listen: … };
}
```

Same public `NizhalServer` API as today. The existing server test suite passing **unchanged** against
this reimplementation is the behavior-preserving proof (see Verification).

## What each binding does

| Host | Binding |
|---|---|
| **Hono** (default) | `createNizhalServer` — the reference binding above. Unchanged public API. |
| **Next.js route handler** | `export const POST = (req) => core.push(req)` in `app/sync/push/route.ts`, etc. WS via `experimental_upgradeWebSocket` feeding `core.openStream`. |
| **Bun.serve / Deno.serve** | a `fetch` switch on `url.pathname` → `core.push`/`core.pull`/…; WS via the runtime's `websocket` handler feeding `core.openStream`. |
| **Express / Fastify / Koa** | one Node-req→Web-`Request` shim (`@whatwg-node/server` or Hono's node adapter), then `res.send(await core.push(request))`. WS via the `ws` package feeding `core.openStream`. |
| **Raw Vercel function** | `const r = await core.push(req); return r;` — no Hono in the tree. |

## Design boundaries (deliberate)

- **The core owns error→status mapping.** The status codes currently live in the route bodies —
  `OutOfOrderMutationError`→409 (`index.ts:544`), `StoredMutationError`→422 (:552),
  `WriteAuthorizationError`→403 (:555), deterministic app error→422 (:558), 413 too-large, 426
  `upgrade_required` (:504), 429 rate-limit (:453). These move *into* `core.push`/`core.pull` so every
  binding returns identical responses. Centralizing this is a strict improvement even for the Hono path.
- **The core owns auth, body limits, and rate limiting** — all already framework-free logic
  (`requireActor`, `readBodyText`, `createRateLimiter`). They ride inside the handlers, not middleware.
- **CORS stays with the binding.** CORS is genuinely HTTP-header/framework territory (preflight,
  per-route). The core does not touch it; each binding uses its framework's CORS (Hono `cors()`, Express
  `cors`, Next headers). Documented as the one thing a non-Hono binding must add itself.
- **WebSocket cannot be pure `Request→Response`.** It needs the runtime's upgrade primitive, so the
  core splits it: `authorizeStream` (pure, returns the actor+buckets or a reject) + `openStream` (the
  socket handler set). This is the same seam the H5 `createWebSocket` factory already established —
  the RFC just formalizes it into the core. The per-`send` credential-expiry re-check
  (`index.ts:652`) moves into `openStream` intact.

## Non-goals

- **Not removing Hono.** It remains the default/reference binding; `createNizhalServer` is unchanged.
  The core is purely additive (a new `./core` export).
- **Not a typed no-HTTP API in v1.** A lower `push(input: PushInput, actor): PushResult` with no
  `Request` at all is possible but most consumers want the HTTP mapping. Defer to a later phase if a
  concrete embedder needs it.
- **Not a protocol or client change.** The paths in `NIZHAL_ROUTES` are the existing client contract.

## Plan

1. **Extract, behavior-preserving.** Move the four handler bodies + `authorizeStream`/`openStream` into
   `packages/server/src/core.ts` as `createNizhalCore`; reimplement `createNizhalServer` as the thin
   Hono binding over it. Export `NIZHAL_ROUTES`. → verify: **the entire existing server suite passes
   unchanged** (82 tests). That green is the proof the extraction changed no behavior.
2. **Add the `./core` export** to `package.json` `exports` + `index` re-export. → verify: `check-types`;
   a new test drives `core.push`/`core.pull` with a raw `Request` (no Hono) against PGlite and asserts
   the same responses the Hono route gives.
3. **A non-Hono smoke.** Mount the core in a bare `Bun.serve` fetch switch (no Hono import) and run the
   host-agnostic `smoke.mjs` against it → HTTP push/pull + WS + auth 5/5. Proves the core stands alone.
4. **Docs:** a "Framework bindings" section in `docs/deploy.md` with the Next / Bun / Express / raw-Vercel
   recipes from the table above.

**Estimate:** one extraction commit (no new behavior) + one export + one standalone test + docs. The risk
is entirely in *not* changing behavior during extraction — which the unchanged test suite pins down.

## Verification bar

The existing `@nizhal/server` suite (82 tests) passing byte-for-byte against the reimplemented
`createNizhalServer`, **plus** a smoke proving the core serves push/pull/stream/auth with **zero Hono in
the import graph** (a Bun `fetch` switch). If both hold, the core is genuinely framework-free and the
Hono path is provably unregressed.
