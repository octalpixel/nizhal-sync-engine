# Sync Engines — Synthesis of 12 Conference Talks & Podcasts

A cross-reading of 12 transcripts on local-first sync engines. Goal: extract each speaker's thesis, design decisions, named hard problems, and admitted tradeoffs; then surface the recurring "hard problems in sync" and an exhaustive checklist of concrete primitives/techniques for downstream gap-analysis.

Engines/speakers covered: Replicache/Zero (Boodman), Zero (Syntax), Linear (Artman ×2), Convex (Cowling), Figma multiplayer/LiveGraph (Bandi), Jazz (Eickhoff), ElectricSQL/Tanstack DB (Arthur), PowerSync (Hoffmeyer), LiveStore (Schickling, via Syntax), plus the Syntax landscape survey.

---

## 1. Per-Talk Digests

### 1.1 Aaron Boodman — Replicache → Zero, Local-First Conf (`boodman-localfirst-conf.txt`)

**Core thesis.** Sync engines should fix the web's complexity, but adoption is stalling because *you usually can't sync all of a user's data onto the device*, and partial sync is too hard to configure manually. The fix is to stop thinking about "what to sync" and instead **express data needs as queries**; the engine manages the cache.

**Design decisions.**
- **Zero = "hybrid query" architecture.** Every query runs against the local cache first (instant), then falls back to the server asynchronously; results stream back reactively. "Every single query that you do in zero has this Behavior where you get local results instantly and then you get server results... asynchronously."
- Full SQL surface at the client: "joins Aggregates sub selects everything."
- Engine keeps "the most commonly used data on the device" — a managed client cache, capped at ~**100 MB**.
- Designed to run against an **empty cache**, which yields free SSR/crawler support and classic-SPA fallback performance.
- Built on Replicache; open-source, bring-your-own-Postgres.

**Hard problems named.**
- Partial replication / "what to sync" — at least half of serious customers can't fit all data on-device.
- Caches shouldn't cache everything: "you get 80% of the value from 20% of the data... every additional byte that you sync has a linear cost" and decreasing value.
- Filters/search must work over the *entire* dataset, not just the synced subset — "this whole UI is search," so syncing a subset breaks filtering (GitHub issues / kubernetes 200 MB / 45k issues example).
- Partitioning schemes are fragile: Vercel's PR-comment partitioning "went out the window" when usage and lifetime exceeded design assumptions.

**Tradeoffs admitted.**
- "1% you don't get instantly and that's actually a feature" — the deliberate fallback to server for cache misses.
- Hybrid queries are "the kind of the hardest way to build this... we avoided trying to do this for a while."
- "too good to be true" skepticism; still alpha, races on live demos.

---

### 1.2 Zero Sync — Syntax podcast review (`zero-syntax.txt`)

**Core thesis (reviewer Scott).** Zero is the local-first platform "of my dreams" — it removes the manual patch-message plumbing that Replicache required.

**Design decisions described (from a user's vantage).**
- **Bring-your-own Postgres** (vs Firebase-style "be your database"); **self-hostable**; open source.
- Client writes `z.query` (ZQL) with relations; mutations via `z.mutate.<collection>.update/insert`. No server endpoints to write.
- Local IndexedDB store; "anytime you do anything the first thing it does is pull it from the local database and then behind the scenes it handles that sync... push and persistence."
- **Permissions via JWT** decode → `auth` data; read/write/update rules using a `cmp` comparing JWT user id vs row data.
- Schema defined via `createSchema`/`createTableSchema`; fully typed queries; optional Drizzle schema for migrations (two-schema friction noted).
- `preload` method; **schema versioning** supported.
- Deploy via Docker image for zero-cache server.

**Hard problems / limitations admitted.** Alpha software, APIs changing; only a subset of Postgres features supported (enum, json/jsonb, dates, timestamps listed); two-schema duplication (ZQL schema + Drizzle migrations) is a pain point.

---

### 1.3 Tuomas Artman — "Scaling the Linear Sync Engine" (`linear-scaling-syncengine.txt`) — canonical deep dive

**Core thesis.** A sync engine does only two things: **(1) get the client up to speed, (2) keep the client in sync.** The story is a multi-year game of whack-a-mole moving the performance bottleneck through every layer.

**Design decisions (the architecture).**
- **Object pool → object graph.** Raw model objects loaded into an in-memory pool, then "hoisted" into a usable reactive graph (organization → teams → issues → comments). **MobX** binds views to observable model objects; local change and remote change run the same code path.
- **Transaction queue.** Local mutations applied optimistically in-memory only (UI updates), not written to IndexedDB until confirmed; transactions persisted to a local queue, batched into GraphQL mutations, retried, rebased on in-flight changes; server can accept/reject; rejection → in-memory rollback + error toast.
- **Sync actions table + `lastSyncId` watermark.** Server writes every change as a sync action with a strictly-incrementing id; client stores last-seen id in IndexedDB metadata; sync server tails the table and fans out over WebSocket to clients (permission-filtered).
- **Full bootstrap → delta sync.** Initial load fetches everything visible; on reconnect, client sends last sync id and requests a delta "fast-forward."
- **In-memory queue during bootstrap** to resolve the race between WebSocket updates and the delta request; queue flushed after delta applied → then real-time.
- **Schema-change handling = nuke affected tables.** DB name embeds a version hash; bumping it reconstructs; per-model `persistent` flag drives partial reload of changed models. Advice: "you want to make bigger changes in one go."
- **IndexedDB layout:** `linear databases` registry DB; per-model tables hashed by model name; key paths (always UUID); JSON-serialized values; metadata + transactions tables.

**Scaling fixes (bottleneck migration — the spine of the talk).**
1. **Client bootstrap slow** (constructing 80–100k objects + making them MobX-observable is expensive) → **partial bootstrap** + make objects observable lazily, only on access.
2. **Lazy collections / lazy references.** Comments & issue history not loaded until accessed; accessing a collection returns empty then hydrates (MobX re-render); React **Suspense boundaries** + pre-hydration on hover to avoid flashes.
3. **GraphQL bootstrap OOM** — GraphQL must materialize the whole JSON response in memory (twice) before sending → replaced with a **streaming REST endpoint** that streams DB rows row-by-row to the client, spilling to disk under memory pressure.
4. **Delta syncs overwhelm the sync server** (a week's changes = tens of thousands of ops; sync server paused everyone to serve one client) → **move delta sync off the sync server to the GraphQL/REST API.**
5. **Postgres on fire from bootstraps** → read from **read replica** (handle replica lag via sync-id boundary), then add a **periodic serialized dump cache in a separate DB** (tried Bigtable, kept own; daily/conditional per-org dump tagged with last sync id; stream from dump, catch up via delta).
6. **Client still loading too much** → **batch loader**: lazy collections that miss locally issue network requests; a batch loader coalesces (50 ms window), dedupes, groups, and optimizes requests into a single streaming call. Issues/attachments no longer in full bootstrap at all.

**Hard problems named.** Bootstrap latency at every layer; race conditions on reconnect/refresh (transaction dedup by id); replica lag; GraphQL's inability to stream; relational DB is bad at "load everything for a huge org"; thundering requests when every visible row touches a lazy collection.

**Tradeoffs admitted.** "For the user it's definitely longer" when data comes from network not disk. Schema changes invalidate lots of client data. The whole thing is "a hugely complex task" — repeatedly pushed back ship dates.

---

### 1.4 Tuomas Artman — "Unexpected Benefits of Going Local-First" (`artman-unexpected-benefits.txt`)

**Core thesis.** The anticipated wins were performance, real-time multiplayer, and offline. The **unanticipated** win was *developer productivity* — sync abstracts away networking, error handling, and state management. "A local change is really the same as a remote change."

**Design decisions / API shape.**
- Same object-pool → in-memory graph + MobX binding as 1.3.
- **No network/error code in features.** Read: loop over `comment.elements`; touching it triggers hydration; ~20 ms later observation re-renders. Write: mutate property + `save()`; optimistic UI; server may reject → automatic revert + toast "without you having to write a single line of code."
- `hydrate()` + `resolvePromise` + Suspense to guarantee fresh data.
- **Prototype with no backend:** a sync-engine dev mode persists a new model only to IndexedDB (not synced) until the backend GraphQL endpoints exist.

**Hard problems named.** The rare (~200 ms) optimistic-write conflict window (e.g. status deleted concurrently while creating an issue) — Linear has only ~15 places of *manual* error management; everything else auto-handled. Bootstrap overhead acknowledged ("quite a bit of a overhead... we use caching and all kinds of layers to mitigate").

**Tradeoffs admitted.** Still requires a backend (no client-authored multiplayer yet); offline positioned as "flights / leave one comment," explicitly *not* "offline for a week" because it's collaborative. Infra upside: ~1000 concurrent (~10k total) users on the EU DC at near-idle CPU; claims all of Linear could run on ~2 CPU cores / ~$80/mo.

---

### 1.5 Tuomas Artman — Local-First Conf, "synchronous experience with asynchronous data" (`artman-localfirst-conf.txt`)

**Core thesis.** Linear wants the **synchronous in-memory programming model** (React: UI = f(state)) while the data is actually 95% asynchronous (on disk or network). The talk is how they kept a synchronous-feeling API over async data.

**Design decisions.**
- Models as **collections** (custom class, not raw arrays) with five relationship kinds: one-to-many (collection), many-to-one (plain JS reference), many-to-many (collections both ways), one-to-one, and **reference**.
- **Lazy collections:** access returns empty array synchronously, kicks off hydration, populates later via MobX reaction.
- **Empty-vs-loading problem:** an empty team should show a splash, but lazy-empty initially looks empty too → solved with **Suspense boundaries** + `hydrate()` returning a promise + `resolvePromise` (throws promise to Suspense if pending).
- **Lazy references:** intermediate object replaces direct pointers; `comment.issue` returns a lazy reference (a promise) — `await ... resolvePromise`, or `.value` (undefined or the issue) for imperative/command-menu code.
- **Type-level hydration:** `hydrate(comment)` returns a `Hydrated<Comment>` decorator type making lazy values non-optional; pushes hydration responsibility up the component tree.
- **Network fallback was free:** swapping the IndexedDB loader for a model loader that falls back to a GraphQL query required "literally nothing... on the front end side."
- **Preloading by route/intent:** React Router associates routes with models to preload; hover-intent (~5 ms) triggers preload so clicks feel instant.

**Hard problems named.** Render flashes from progressive hydration; keeping a synchronous API over async data without forcing engineers to handle promises everywhere; eventual-consistency "popping in" of 20+ objects on a page.

**Tradeoffs admitted.** "We did not want to give up on synchronous data access" — the whole design is contortion to preserve that ergonomic. Memory ceiling (~50k objects ≈ 800 ms–1 s) forced the move; 95% of data lives on the network and "still lives on the network and is not even on the local client."

---

### 1.6 James Cowling — Convex, "How to Design a Sync-First Database" (`cowling-convex-syncfirst-db.txt`)

**Core thesis.** The industry gave up on **transactions** and bolted on client-side reactivity with "no relationship to the backend state," creating "maximal race conditions." The right primitive is **transactional sync**: automatic end-to-end consistency from server to client. Three building blocks: **transactions, a reactive database, end-to-end consistency.**

**Design decisions.**
- **TypeScript stored procedures** (queries = read-only; mutations = writes), arbitrary TS, made **deterministic & side-effect-free** by remapping `random`/`time`; run in **V8 isolates inside the database**.
- **MVCC / OCC commit protocol.** Bottom is a versioned write-ahead log (Aurora/PlanetScale) with indexes; `funrun` reads a consistent snapshot as-of timestamp T, tracks all read ranges, buffers writes, commits if no read-set conflict else retries — "classic multi-version concurrency control... similar to FoundationDB."
- **Query cache (the key idea).** Every query's output is a deterministic function of its source code + input ranges; cache results until inputs change. "A query cache is a much more powerful thing than a row cache" — it caches the *result of a transaction*. **Source code stored in the DB** so uploading a new mutation auto-invalidates dependent queries.
- **Reactivity for free.** Server knows every `useQuery` hook on each client; WebSocket pushes new values when inputs change. Mutations up with timestamps, updates down — "you will only ever see a state of the world that's consistent with some data on the server."

**Hard problems named.** End-to-end consistency across many independent components (item shouldn't appear in cart while still purchasable; task before its project) — "the whole point of this is to make race conditions go away." Consistent caching is "one of the traditionally hardest problems"; cache invalidation tied to source-code versions is where emergent complexity appears. Distributed-systems talent "is plummeting"; LLMs are bad at it because good systems are *simple and maintainable over years*, with no good eval/training set.

**Tradeoffs admitted.** "I'm not talking about local first... We have two working prototypes of local first in Convex with full offline support... just haven't quite nailed it yet." Can't let a client issue `begin transaction` against the server (locks resources) — hence stored procedures instead of client-issued SQL.

---

### 1.7 Arushi Bandi — Figma, "A Tale of Two Sync Engines" (`figma-two-sync-engines.txt`)

**Core thesis.** Figma runs **two** sync engines — **Multiplayer** (the canvas) and **LiveGraph** (everything else) — because *not everything can be a CRDT*, and one model can't serve both raw-document sync and derived/ephemeral/server-driven data.

**Design decisions.**
- **Multiplayer:** CRDT-*inspired* (not a true CRDT — "centralization is faster"), syncs raw Figma file data, reads+writes over WebSocket, limited to the file and to **100 clients/file**; written in Rust (was TypeScript).
- **LiveGraph:** **read-only** (writes go through legacy REST API), GraphQL-inspired, `useSubscription` React hook auto-rerenders; tails the **Postgres replication stream**; manages permissions; runs computed fields; query cache; optimistic updates for product-engineer ergonomics. TypeScript + Golang.
- Handles ephemeral state (active file users), immutable derived/published state (library publishing — "all the other files pull in that snapshot"), and server-driven state (notifications).
- **Initial-load prioritization (recent idea):** initial view fetch over **HTTP**, then a **separate WebSocket** for updates; the two must be **linearized & merged** on the client. Spreads "whale" load across servers; enables **graceful degradation** (kill updates, still serve).
- Evolution from **stateful mutation-based** (isomorphic client/server sending minimal diffs at each layer) toward **stateless invalidation-based** (DB → query invalidations → view invalidations → rebuild) — trades isomorphism for horizontal scalability.
- **Reconnect via cursor:** client sends a cursor on reconnect (requires global ordering) so only changed state is rebuilt.

**Hard problems named.** "The original sin of LiveGraph": transforming data (arbitrary computations, refetches) while keeping it live — scaling is driven by computation cost, *not* proportional to users like Multiplayer. Strong consistency across a normal query + a computation watched by the same client is hard. **Thundering herd** on deploy/reconnect (clients refetch all state) — mitigated first by 2-hour slow deploys, then by cursors. Stateful layers can't safely replay/reorder mutations after a mid-stream drop.

**Tradeoffs admitted.** "Do we even need LiveGraph?" — % of live-updating traffic *fell* as product engineers used it off-label for non-live features; now adding **schema guardrails** because shared schemas are hard. Figma is "designed to be fully online... very limited support for offline."

---

### 1.8 Anselm Eickhoff — Jazz, "Oops, my sync engine became a database" (`jazz-syncengine-database.txt`)

**Core thesis.** Go all-in on **CRDTs as the one abstraction** ("git for JSON"): co-values that are local-first, reactive, permissioned, and synced as encrypted diffs by an app-oblivious server. The thing turned out to be a *database that syncs*.

**Design decisions.**
- **Co-values (CRDTs):** CoMap, CoList, plain/rich text, vectors (vector search), blobs. Each = immutable header + append-only history + derived current state. **Last-writer-wins** by edit timestamp — "this is actually what you want 99% of the time."
- Reactive like `useState` but also re-renders on remote edits; usable server-side (load once, or subscribe).
- **References between co-values** form an infinite JSON tree/graph; **granular sync/subscribe to sub-trees**; blobs stored directly (no S3).
- **Decentralized permissions via crypto:** rolling hash + signatures over each user's edits → independently verifiable history; a write-allow-list stored in another co-value (the "group"/owner); read access via per-operation encryption with keys shared in the group. → **server only syncs encrypted diffs → trust-free component → trivial E2E-encrypted apps.**
- **Architecture:** app-oblivious sync+storage servers everywhere syncing tiny bits; lightweight serverless compute becomes *itself a client* to the sync server; RPC that also helps sync data; SSR hydrating real-time data alongside UI.
- Moving toward DB-style **storage-layer sharding** + CDN-style **IP anycast** routing and fast failover.

**Hard problems named.** **Indices & complex queries** are the most-requested missing table-stakes — currently "brute force filter over it... sort it or paginate it on the client." Proposed: a dedicated **index worker** building a search index *as a co-value* that fits on-device; clients run a query engine locally and fetch matches from the sync server. **Strong/global consistency** for purchase/booking flows: simplest is a single worker with exclusive write access (a "tiny sync engine with strong consistency"); doesn't scale past one worker → exploring **dynamic transaction authority** that migrates like a durable object, with per-data-granularity consistency/latency tradeoff.

**Tradeoffs admitted.** "We've basically made a pact with the devil, which is that we just went all in on **eventual consistency**." Critique of durable objects: force chunking into "rooms," not granular enough, still no offline, duplicate state management.

---

### 1.9 James Arthur — ElectricSQL / Tanstack DB (`electricsql-james-arthur.txt`)

**Core thesis.** Sync's hard part is getting the network off the interaction path *at scale* with **partial replication** over plain HTTP, with an **incremental adoption pathway** into mainstream frameworks. Electric is a **Postgres sync engine** (Elixir) that filters logical replication and fans out subsets ("shapes") to any HTTP/JSON stack.

**Design decisions.**
- **Shapes = partial replication.** "A shape is like a filtered view on a database table"; create as many as you like with different subsets; works with any Postgres ≥14, any data model, any data type/constraint.
- **Tanstack DB** (added to Tanstack): **collection** primitive + **live queries across collections** + **transactional optimistic mutators**. ~20 KB; "a database without the database."
- **Live queries via a TypeScript implementation of differential dataflow** → incremental view maintenance → "literally sub-millisecond," everything within a single animation frame.
- **Server-authoritative optimistic writes:** local transaction posts mutations to a generic ingest endpoint; on success server returns the **Postgres transaction id**; client **monitors the replication stream for that txid** before discarding optimistic state; errors → rollback. Matching on **txid (not row id)** lets you **rebase** local optimistic state on concurrent changes.
- **Auth without RLS:** because sync is over HTTP, reuse existing backend auth/middleware to authorize read & write sync — "you don't need to codify your existing auth logic into some kind of database rule system like RLS." (Phoenix.Sync reference impl: sync shapes through your router, controllers as proxies, dynamic shapes, declarative ingest pipeline.)
- **PGlite:** full Postgres compiled to Wasm (~3–4 MB), browser storage, reactive live queries + sync plugin; positioned for dev/test/CI/web-containers (now Prisma's default local DB), vs Tanstack DB for app development.

**Hard problems named.** The "easy bit" of consuming a logical-replication publication is already complex: getting the right data in the publication, connection drops, schema/DDL migrations, a bug that stops consuming → **WAL backs up, DB runs out of storage or drops data**. **Broadcast ≠ sync:** "you can't miss a message... exactly once message delivery across the public internet." Server-side buffering trades client-failure backpressure for backend bloat → "serious engineering trade-offs... exploding resource use on one side, latency or inconsistency on the other." Can't query Postgres at the same snapshot as a logical-replication transaction (snapshot only internal). Routing/permissions (secondary index vs query-back) and centralized on-write rule logic that's hard to scale. **Sharded Postgres:** Electric doesn't join shards back — sync into separate collections and join in the client via D2/differential dataflow.

**Tradeoffs admitted.** AAI-apps framing: streaming model tokens *through Postgres* then syncing gives resilient delivery/resumability vs direct token streaming that breaks on a glitch. Multiple stacks (Phoenix.Sync+Tanstack DB, Zero, PowerSync+TinyBase/Legend) all "just run on top of Postgres."

---

### 1.10 Conrad Hoffmeyer — PowerSync, Postgres Conf (`powersync-postgres-conf.txt`)

**Core thesis.** Build a high-scale sync engine with **dynamic partial replication** that treats Postgres as **sacred** (non-invasive), syncing Postgres ⇄ SQLite for local-first apps.

**Design decisions.**
- **Separate read/download path from write/upload path.** Reads via PowerSync middleware ("the bearing/Sync service") off **logical replication**; **writes routed through the developer's existing backend** to reuse business logic/validation — "we didn't want to bypass the developers existing business logic authorization and validation."
- **Buckets + declarative sync rules.** Developer defines buckets via a YAML-ish syntax grouping data; buckets reference client params (JWT payload, parameter queries); buckets are **shared between users where applicable**. On each replication change, compute affected buckets and append to that bucket's **operation history**.
- **Rebuildable persistent cache outside Postgres** (pluggable storage); rows as JSON; ops indexed by a **strictly-incrementing operation id** for efficient ordered queries; **compaction** so history doesn't grow unbounded. Initial **snapshot via SQL queries**, then incremental logical replication; own **checkpoint system tracking Postgres LSNs**.
- **Client:** schema-less replicated data in SQLite; **SQLite views** apply the typed schema on top → schema migrations "hardly affect the client side database"; reactive query hooks (e.g. React).
- **Conflict handling: no CRDTs at protocol level.** A single **authoritative global operation order** in the middleware (derived from the replication stream) → all clients converge to **server-authoritative state**. Developer backend accepts/rejects; **custom conflict resolution** allowed, *including* storing a CRDT (e.g. Yjs) as **blob data** in Postgres.
- **Consistency:** server write checkpoints (op id + LSN); local writes applied atop last checkpoint; **upload queue** drains, then client pulls the latest checkpoint → converges. **Data integrity: per-bucket checksums**; mismatch → redownload bucket.

**Hard problems named (Postgres-specific).** (1) **DDL/schema changes** not published to logical replication — 7 scenarios, 4 auto-detected (2 of those force full-table resync), 3 need manual intervention; generated/stored values not published. (2) **LSNs are not monotonic** (intra-transaction ranges overlap) → use a separate auto-incrementing op-id sequence (also enables sharded-DB multiplexing and reprocessing). (3) **TOAST** oversize values only published if changed → keep a stateful copy of current field values (stateful stream processing). (4) **Replica identity permutations** (default/full/using index/nothing) → generate ids appropriately; random id for `nothing` to support truncation.

**Tradeoffs admitted.** No protocol-level CRDT means losing deterministic merge semantics, in exchange for simplicity + customizability. SQLite's type system is "very very limited"; pluggable to swap SQLite but started there for ubiquity/battle-testing.

---

### 1.11 LiveStore — Johannes Schickling, via Syntax (`livestore-prisma.txt`)

**Core thesis.** A "next generation state management framework based on reactive SQLite and git-inspired syncing"; **event sourcing** is the core — events are the source of truth, SQLite state is a projection.

**Design decisions.**
- **Event log as source of truth.** "All of our data modifications are captured as an immutable ordered sequence of events... reliably reconstruct your state from this history log. Think of it like git commits." Reactive SQLite state is a **projection** of the event log.
- **Schema file** defines derived state (SQLite tables) + **client documents** for **local-only state** (e.g. an input field) — optionally synced across a client's own sessions without persisting to the DB.
- **Events** (`events.synced`, named/versioned e.g. `v1.TodoCreated`, with a payload schema) describe changes; **materializers** map events → DB writes (≈ Redux action + reducer).
- **Sync loop like git:** commit event → push to sync backend → pull new events. Last-write-wins.
- No optimistic-update bookkeeping needed: "We don't need that idea of optimism as that server sync comes in later."
- **Undo/redo + time-travel:** can go back, change/delete an event N steps back, replay forward (Fusion-360-style parametric analogy); DevTools show state changes.
- BYO auth (verify JWT). Runs on Cloudflare: sync engine as a Worker, event log in **D1** SQLite, durable objects for WebSockets.

**Hard problems named (via discussion).** Event-sourcing edge case: editing a past event whose downstream depends on something "that doesn't exist in the future" can get you "into trouble" on replay. Cross-platform support (web/iOS/Android, many adapters) still maturing (e.g. Svelte adapter a draft PR).

**Tradeoffs admitted (reviewers').** "Living on the edge... trying something new"; takes over your whole state/backend/ORM stack; LWW conflict model.

---

### 1.12 Syntax — "Sync Engines and Local Data" landscape survey (`syntax-sync-engines.txt`)

**Core thesis.** Map the landscape; classify tools by how much of the stack they own. The future "React" may be a **local-data-first sync engine baked in** rather than bolted on. Most developers still don't grasp "just how transformative it is."

**Taxonomy / decisions surfaced (per tool):**
- **Full-stack takeovers:** **LiveStore** (event-sourced, SQLite-in-Wasm client + SQLite server, Cloudflare-friendly), **Instant DB** (Firebase alternative, baked-in auth/Magic-Link, easiest 0→app, but new company / hosted), **Convex** (sync + backend + 80+ auth integrations, self-hostable via Docker, paid; local-first parts *not shipped yet* — explicit correction).
- **BYO-Postgres, manages sync+cache:** **Zero** (most mature "do-everything while keeping your Postgres"; patch messages; IndexedDB; ZQL feels like a client ORM; still needs Drizzle for migrations).
- **Sync-in-cache, keep your backend/endpoints:** **ElectricSQL** (PGlite/Wasm-Postgres client; keep API endpoints; good for *adding* local-first to one part of an existing app).
- **Sync-server-only:** **PowerSync** (just the sync server, you do the rest), **PartyKit** (realtime/multiplayer — now pivoting to AI agents).
- **Client cache + sync, you resolve on server:** **Replicache** (versioning + push/pull patch endpoints by hand), **Live Blocks** (presence/multiplayer — pivoting to AI agents).
- Low-fi alternatives named: IndexedDB, **Dexie**, Evolu.

**Hard problems / recurring themes named.** Network on the interaction path = slow; 300–600 ms feels like a lifetime vs 10 ms. Hosting the sync server (SST "a giant pain") and DB migrations are the biggest barriers to entry. Two-schema duplication (Drizzle + engine schema). Conflict resolution / CRDTs recur. Observation: many sync companies (Live Blocks, PartyKit, StackBlitz/Bolt, Airtable) are pivoting to *building AI products on their own tech*.

---

## 2. Cross-Cutting Themes — Recurring Hard Problems in Sync

### Theme A — Partial replication / "what to sync" (and auth on the boundary)
The most universally named hard problem.
- **Boodman/Zero:** can't sync all data; partial sync too hard to configure → solve with **queries + managed hybrid cache**; filters must run over the whole dataset.
- **PowerSync:** **buckets + declarative sync rules** (params from JWT); the "lynchpin capability."
- **Electric:** **shapes** (filtered views on tables); auth on the HTTP sync request, **explicitly avoiding RLS**.
- **Linear:** partial bootstrap + lazy collections + batch loader; permission-filtered fan-out at the sync server.
- **Figma LiveGraph:** permissions managed in the server/view layer; later adding schema **guardrails**.
- **Jazz:** sync sub-trees granularly; permissions via **crypto allow-lists**, server only sees encrypted diffs.
- **Convex:** queries define the synced set; client-side security rules avoided in favor of server stored procedures.
- **Consensus:** everyone agrees you cannot sync everything and partial replication is *the* defining capability. **Disagreement on mechanism:** declarative rules/buckets (PowerSync) vs filtered shapes (Electric) vs query-driven managed cache (Zero/Convex) vs granular CRDT sub-trees + crypto (Jazz). **Auth split:** HTTP/middleware reuse (Electric) vs DB rules/JWT-compare (Zero) vs decentralized crypto (Jazz) vs server stored-procedure authorization (Convex).

### Theme B — Conflict handling: server-authority vs CRDT
- **CRDT camp:** **Jazz** (all-in, LWW per property), **Figma Multiplayer** (CRDT-*inspired*, centralized for speed). LiveStore is event-sourced LWW (CRDT-adjacent).
- **Server-authority camp:** **Linear** (server accepts/rejects, client rolls back/rebases), **PowerSync** (single global op order, no protocol CRDT; CRDT only as opt-in blob), **Electric** (server-authoritative, explicit rollback, rebase on txid), **Convex** (transactional OCC, server is truth).
- **Consensus:** *most* production engines are **server-authoritative**; even Figma chose centralization over a "true CRDT" because "centralization is faster." **Disagreement:** CRDT advocates (Jazz) argue LWW "is what you want 99% of the time" and enables decentralization/offline/E2E-encryption; server-authority advocates argue it gives simplicity, customizable conflict resolution, and validation. PowerSync bridges: server order by default, CRDT-as-blob when needed.

### Theme C — Bootstrapping / initial load
- **Linear:** the central saga — full bootstrap → partial bootstrap → delayed bootstrap → streaming REST → dump cache → batch loader.
- **Figma:** **initial-load prioritization** (HTTP fetch + separate WebSocket for updates); graceful degradation; **thundering herd** on reconnect/deploy mitigated by **cursors**.
- **Boodman/Zero:** designed to render against an **empty cache** (instant page loads, SSR).
- **Electric:** initial shape sync over HTTP; **broadcast≠sync** (exactly-once delivery) is the framing of the bootstrap+catch-up problem.
- **Convex:** initial state via reactive query subscriptions + query cache.
- **Consensus:** initial load is a first-class scaling problem, not an afterthought; separating initial fetch (HTTP, scalable, cacheable) from the live update channel (WebSocket) recurs (Figma, Electric, Boodman's empty-cache idea). **Thundering herd** specifically named by Figma and implied by Linear's replica/dump work.

### Theme D — Ordering / causality / watermarks
- **Linear:** strictly-incrementing **sync-id**; client stores `lastSyncId`; delta sync from a watermark; dedup transactions by id.
- **PowerSync:** strictly-incrementing **operation id** (deliberately decoupled from non-monotonic **LSNs**); checkpoints = op-id + LSN.
- **Electric:** match optimistic state on **Postgres transaction id** (not row id) to rebase.
- **Figma:** **global ordering** needed for reconnect **cursors**; stateful mutations "can't be reordered" without correctness bugs.
- **Convex:** MVCC snapshots as-of timestamp T; mutations carry timestamps.
- **Consensus:** a monotonic server-assigned sequence/watermark is near-universal for catch-up and dedup. **Insight (PowerSync):** Postgres LSNs are *not* safe as that sequence (intra-txn overlap) — use a separate counter. **Insight (Electric):** txid is the right key for rebasing optimistic writes.

### Theme E — Optimistic updates & rollback
- **Linear:** optimistic in-memory only; server reject → auto revert + toast; rare ~200 ms conflict window; ~15 manual-handling sites.
- **Electric:** optimistic local txn; discard when matching txid observed on replication stream; rollback on error; rebase on concurrent changes.
- **Figma LiveGraph:** optimistic updates for product-engineer ergonomics (read-only system, writes via REST).
- **Convex:** consistency-first; client always sees a server-consistent snapshot.
- **LiveStore:** **no optimism needed** — local event is already the truth; server sync reconciles later.
- **Consensus:** optimistic-apply-then-reconcile is standard; **disagreement on bookkeeping:** explicit rollback/rebase keyed on txid/version (Electric, Linear) vs event-sourced model where "optimism" is moot (LiveStore) vs strict consistency that avoids divergence (Convex).

### Theme F — Schema migration / evolution
- **Linear:** schema change = **nuke affected client tables** (DB version hash, `persistent` flag, partial reload); "make bigger changes in one go."
- **PowerSync:** **schema-less client storage + SQLite views** so migrations "hardly affect" the client; sync rules can transform for backward compat; 7 DDL scenarios (4 auto, 3 manual).
- **Electric:** DDL/schema & DB-version migrations explicitly named as a hard part of consuming logical replication.
- **Zero/LiveStore:** **schema versioning** / versioned events (`v1.TodoCreated`) as first-class.
- **Figma:** shared-schema **guardrails** because "shared schemas are really hard to maintain."
- **Consensus:** schema evolution is hard and under-discussed; **two strategies diverge:** invalidate-and-reload (Linear) vs decouple-via-views/transforms for backward compat (PowerSync). Versioned events/schemas (LiveStore, Zero) is a third path.

### Theme G — Reactivity / view maintenance / caching
- **Convex:** **query cache** (caches transaction results, invalidated by read-set/source-code changes) — "more powerful than a row cache"; reactivity falls out for free.
- **Electric/Tanstack DB:** **differential dataflow** live queries (incremental view maintenance), sub-millisecond.
- **Linear:** **MobX** observable graph; UI = f(graph); local==remote change path.
- **Figma:** query cache + view cache; evolving stateful→stateless **invalidation-based** rebuild.
- **Jazz/LiveStore/Zero:** reactive hooks (`useQuery`/`useSubscription`) auto-rerender.
- **Consensus:** fine-grained reactivity that auto-rerenders on data change is table stakes. **Disagreement on engine:** observable object graph (MobX/Linear) vs incremental-view-maintenance/differential-dataflow (Electric, and Felderá/DBSP referenced) vs consistent query cache (Convex) vs event-projection materialization (LiveStore).

### Theme H — Developer ergonomics as the real product
- Named explicitly by **Artman** ("developer productivity... a cheat code"), **Bandi** (LiveGraph built for product-engineer ergonomics — to the point of off-label overuse), **Cowling** (write TS not SQL/RLS), **Boodman** (just write queries, business logic in components), **Electric/Syntax** (incremental adoption, "ORM on the client").
- **Consensus:** the deepest payoff is collapsing data-fetching + state-management + error-handling into "render the local graph." **Tension surfaced by Bandi:** great ergonomics → engineers misuse the engine for things that don't need sync → you must add guardrails.

### Theme I — Strong/global consistency vs eventual consistency
- **Eventual:** Jazz ("pact with the devil"), LiveStore (LWW), PowerSync (eventual converge to server state).
- **Strong/transactional:** Convex (the whole thesis — transactions as the building block).
- **Hybrid aspirations:** Jazz exploring **dynamic transaction authority** (migratable like a durable object) for the small slice (purchases/bookings) that needs it.
- **Consensus:** most local-first engines accept eventual consistency; **Convex dissents**, arguing transactional end-to-end consistency is the missing primitive. Jazz concedes some state genuinely needs global consistency and is retrofitting it granularly.

### Theme J — Infra cost / scaling shape
- **Linear:** near-idle CPU; "~2 cores / $80/mo"; local-first slashes server load (only mutations hit the network).
- **PowerSync/Electric:** scaling tradeoffs of buffering (storage/memory/compute vs latency/consistency); fan-out & routing cost.
- **Figma:** scaling LiveGraph is driven by **computation cost**, not user count — the asymmetry vs Multiplayer.
- **Consensus:** read-path locality dramatically cuts backend cost (Linear), but **fan-out, buffering, and computed views reintroduce cost** (Figma, Electric) — the bill moves, it doesn't vanish.

---

## 3. Primitives & Techniques Checklist (tagged by engine/speaker)

Read/initial-load & bootstrapping
- **Full bootstrap** (load all visible data into client) — Linear; Zero (empty-cache variant).
- **Partial bootstrap** (load only first-screen-critical models: org/teams/users) — Linear.
- **Delayed bootstrap** (defer plentiful models: comments, issue history) — Linear.
- **Delta sync / fast-forward from a watermark** (`lastSyncId`) — Linear; PowerSync (op-id checkpoints).
- **Snapshot via plain SQL then incremental logical replication** — PowerSync.
- **Streaming REST endpoint** (row-by-row stream, spill-to-disk under memory pressure) — Linear.
- **Serialized periodic dump cache in a side DB** (per-org, tagged with last sync id) — Linear.
- **Read-replica reads with sync-id boundary to tolerate replica lag** — Linear.
- **Render against an empty cache** (free SSR / SPA fallback / crawler support) — Boodman/Zero.
- **Initial fetch over HTTP + separate WebSocket for updates (linearized & merged on client)** — Figma LiveGraph.
- **Reconnect via cursor (requires global ordering)** to rebuild only changed state — Figma.
- **Hover/route intent preloading** (React Router routes ↔ models; ~5 ms hover trigger) — Linear (artman-localfirst).

Partial replication / scoping
- **Hybrid query architecture** (local cache first, async server fallback, streamed reactively) — Zero/Boodman.
- **Managed client cache with size cap (~100 MB), LRU-style most-used retention** — Zero/Boodman.
- **Shapes** (filtered view on a table; many subsets) — Electric.
- **Buckets + declarative sync rules** (params from JWT / parameter queries; shared buckets) — PowerSync.
- **Granular sync/subscribe to CRDT sub-trees of a JSON graph** — Jazz.
- **Query-defined sync set** (server stored procedures decide visibility) — Convex.

Lazy loading / hydration
- **Lazy collections** (return empty synchronously, hydrate async, MobX re-render) — Linear.
- **Lazy references** (intermediate promise object replacing direct pointers; `.value` or `await resolvePromise`) — Linear.
- **Type-level hydration** (`Hydrated<T>` decorator making lazy fields non-optional) — Linear.
- **React Suspense boundaries to gate async hydration & avoid flashes** — Linear.
- **Pre-hydration on hover/visibility** — Linear.
- **Batch loader** (coalesce requests in a ~50 ms window; dedupe/group/optimize into one streaming call) — Linear.
- **Partial index values** (track whether a collection has been fully loaded, persisted to disk) — Linear.
- **Lazy MobX observability** (make objects observable only on access, not at bootstrap) — Linear.

Local store & client DB
- **IndexedDB JSON-blob store, per-model tables hashed by model name, UUID key paths** — Linear; Zero (IndexedDB patch messages).
- **SQLite (Wasm) client DB** — PowerSync, LiveStore, Electric(PGlite).
- **Schema-less client storage + SQLite views applying typed schema** (migration insulation) — PowerSync.
- **PGlite — full Postgres compiled to Wasm in the browser** — Electric.
- **Tanstack DB "collection" primitive — a database without the database (~20 KB)** — Electric.
- **Client documents for local-only state (optionally synced across own sessions, not to DB)** — LiveStore.
- **Local-only / UI-state collections queried alongside synced ones** — Electric (Tanstack DB).

Write path, transactions, consistency
- **Transaction queue** (persisted locally, batched into GraphQL mutations, retried, rebased) — Linear.
- **Optimistic in-memory apply + server accept/reject + auto rollback + error toast** — Linear.
- **TypeScript stored procedures (queries/mutations) run in V8 isolates inside the DB** — Convex.
- **Determinism enforcement** (remap `random`/`time`; side-effect-free) — Convex.
- **MVCC / optimistic concurrency control** (snapshot as-of T, track read ranges, buffer writes, commit-or-retry) — Convex (FoundationDB-like).
- **Versioned write-ahead log + indexes as the storage substrate** — Convex.
- **Server-authoritative writes through existing backend/business logic** — PowerSync; Figma (REST); Linear.
- **Generic ingest endpoint + rollback on error** — Electric (Tanstack DB).
- **Discard optimistic state by observing the write's txid on the replication stream** — Electric.
- **Rebase optimistic state on concurrent changes by matching txid (not row id)** — Electric.
- **Write checkpoints (op-id + LSN); upload queue drains then pull latest checkpoint to converge** — PowerSync.
- **Dynamic/migratable transaction authority for the slice needing global consistency** — Jazz (aspirational); durable-object analogy.
- **Single exclusive-writer worker = "tiny sync engine with strong consistency"** — Jazz.

Conflict resolution
- **Last-writer-wins by edit timestamp (per property)** — Jazz; LiveStore (event LWW).
- **CRDT (true)** co-values: CoMap/CoList/text/vector/blob = header + append-only history + derived state — Jazz.
- **CRDT-inspired but centralized (not a true CRDT, for speed)** — Figma Multiplayer.
- **Global authoritative operation order (no protocol-level CRDT); converge to server state** — PowerSync; Linear.
- **CRDT stored as opt-in blob (e.g. Yjs) inside Postgres** — PowerSync.
- **Custom developer-defined conflict resolution at the backend** — PowerSync.

Reactivity / view maintenance / caching
- **Observable object graph (MobX); UI = f(graph); local==remote change path** — Linear.
- **Consistent server-side query cache (caches transaction results; invalidated by read-set or source-code change)** — Convex.
- **Source code stored in DB as part of the query read-set (auto-invalidate on deploy)** — Convex.
- **Incremental view maintenance via differential dataflow (TS impl); sub-ms live queries** — Electric/Tanstack DB; (DBSP/Felderá, differential dataflow referenced).
- **Live queries across multiple heterogeneous collections (joins/aggregates) in the client** — Electric.
- **Stateful mutation-based diffs at each layer (isomorphic client/server)** — Figma (legacy).
- **Stateless invalidation-based rebuild (DB→query-invalidation→view-invalidation→rebuild)** — Figma (current direction).
- **Computed fields / arbitrary computations in the sync layer** — Figma LiveGraph.
- **Reactive hooks: `useQuery`/`useSubscription`/`useShape` auto-rerender** — Convex, Figma, Electric, Zero, Jazz.

Transport, fan-out, integrity
- **WebSocket live update channel; server tracks each client's subscribed queries** — Convex, Linear, Figma.
- **Tail Postgres logical replication stream and fan out** — Electric, PowerSync, Figma LiveGraph.
- **Sync-action table tailed by sync server, permission-filtered fan-out** — Linear.
- **Sync over plain HTTP/JSON (works with existing libs/auth middleware)** — Electric.
- **Exactly-once message delivery framing (broadcast≠sync)** — Electric.
- **In-memory queue during bootstrap to resolve WebSocket-vs-delta race** — Linear.
- **Per-bucket checksums; redownload on mismatch** — PowerSync.
- **App-oblivious sync server that only syncs (encrypted) diffs** — Jazz.
- **Encrypted-diff sync → trust-free server → trivial E2E encryption** — Jazz.

Ordering / identity
- **Strictly-incrementing sync-id / operation-id watermark** — Linear, PowerSync.
- **Decouple op-id from non-monotonic Postgres LSNs** (and multiplex sharded LSNs into one op-id) — PowerSync.
- **Transaction deduplication by transaction id on reconnect/refresh** — Linear.
- **Global ordering to support reconnect cursors** — Figma.
- **Replica-identity handling (default/full/using-index/nothing); generated ids; random id for `nothing`** — PowerSync.
- **TOAST handling via stateful copy of current field values** — PowerSync.

Permissions / auth
- **JWT-decode → row-level read/write `cmp` rules** — Zero.
- **Authorize sync requests with existing backend auth/middleware (no RLS)** — Electric (Phoenix.Sync).
- **Decentralized permissions via signatures + encryption; write-allow-list and read-keys stored in a "group" co-value; composable groups** — Jazz.
- **Permissions enforced in the view/server layer + schema guardrails** — Figma LiveGraph.
- **Server stored procedures as the authorization boundary (avoid client SQL + RLS)** — Convex.

Schema evolution
- **Invalidate-and-reload affected client tables on schema change (DB version hash + `persistent` flag + partial reload)** — Linear.
- **Schema-less storage + views + sync-rule transforms for backward compat** — PowerSync.
- **Versioned events (`v1.TodoCreated`) / schema versioning** — LiveStore, Zero.
- **Shared-schema guardrails / static front-end checks** — Figma.

Event sourcing / history
- **Immutable ordered event log as source of truth; SQLite state = projection (materializers ≈ reducers)** — LiveStore.
- **Append-only edit history per object; current state derived (git-for-JSON)** — Jazz; LiveStore.
- **Time-travel / undo-redo / edit-and-replay past events** — LiveStore.
- **Git-style branching flows from history** — Jazz.
- **Operation-history compaction to bound growth** — PowerSync.
- **Rebuildable persistent cache outside Postgres (pluggable storage)** — PowerSync.

Architecture patterns
- **Two specialized sync engines for different data shapes (document CRDT vs derived/ephemeral/server-driven)** — Figma.
- **Separate read/download path from write/upload path** — PowerSync.
- **Object pool → hoisted object graph** — Linear.
- **Serverless compute as itself a client of the sync server; RPC that also syncs; SSR hydrating real-time data** — Jazz.
- **Index worker building a search index as a co-value, runnable on-device; heavy device builds, weak device queries** — Jazz (proposed).
- **Stream model tokens through Postgres then sync to client (resilient AI token streaming)** — Electric.
- **Edge/durable-object placement, IP anycast routing, storage-layer sharding, fast failover** — Jazz; (durable objects referenced by Jazz & LiveStore).

---

*Sources: all 12 files in `/Users/mithushancj/Documents/personal/echo/research/_notes/youtube/`. Quotes are short and verbatim from the cited transcripts; transcripts are auto-generated captions, so minor transcription artifacts in quotes are from the source.*
