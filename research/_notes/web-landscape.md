# The Local-First / Sync-Engine Landscape — A Design-Rationale Map

> Goal: capture the **WHY** and the hard-won design lessons behind the leading sync engines — the reasoning, the tradeoffs the authors *admit*, and the "the hard part is X" statements that aren't visible in code alone. Primary sources (author blog posts, official docs, conference talks) are prioritized; canonical URLs are inline and collected at the end.

**Sourcing honesty note (applies throughout):** Quotes were gathered by fetching/scraping the cited primary sources. Where a quote came through a summarizing fetch rather than a byte-exact scrape, it is faithful wording rather than guaranteed character-exact; specific caveats are flagged per section. Two attributions to *avoid*: the Ink & Switch essay contains **no** literal "CRDTs are not a silver bullet" line, and "The Web's Next Transition" did not surface as a discrete titled essay — its thesis is cited via Kyle Mathews below.

---

## The one-paragraph map

The field splits on a single question: **where does authority live?** Pure **local-first** (Ink & Switch, Automerge/Yjs) puts the primary copy on the device and uses **CRDTs** so peers converge with no central authority — at the cost of metadata/history growth and an unsolved networking story. The **production winners that *feel* local-first** (Figma, Linear) are actually **centralized and server-authoritative**, using **per-property Last-Writer-Wins** and deliberately *refusing* the full CRDT/OT machinery because a central server removes the need for it. The **general-purpose sync engines** (Replicache → Zero, Electric, PowerSync, Convex, InstantDB) try to package "instant local-read UX over an authoritative server" as reusable infrastructure, and diverge mainly on three axes: **how you specify partial sync** (hand-written endpoints vs queries vs shapes vs buckets), **whether they keep queries fresh via IVM**, and **whether they punt writes/conflicts to your backend or own them**. The recurring lesson, stated by nearly everyone, is that **the hard part of sync is not merging data — it is partial sync + permissions + keeping a query result live, and doing it simply enough to be reliable in production.**

---

# 1. Replicache (Rocicorp / Aaron Boodman)

**Canonical:** "How Replicache Works" — https://doc.replicache.dev/concepts/how-it-works · Rocicorp blog — https://rocicorp.dev/blog

- **Core sync model.** A persisted, ordered key/value **Client View** on each client *is* the synced data; the app reads/renders directly from it. **Mutators** are named JS functions: calling one (a) optimistically mutates the Client View and (b) appends a pending mutation (name + args + sequential mutation ID) to a queue. You implement two HTTP endpoints: **push** (server runs the server-side mutator implementations against the canonical DB) and **pull** (client sends an opaque **cookie**; server returns a **patch** to canonical state + `lastMutationIDChanges`). An optional contentless **poke** tells the client "pull now."
- **Conflict resolution — git-style rebase of *intent*, not CRDT merge.** On pull the client rewinds the Client View to last-confirmed server state, applies the server patch, then **replays still-pending local mutators on top**. Because "mutators are arbitrary JavaScript code, so they can programmatically express whatever conflict resolution policy makes the most sense," a replayed mutator can reach a *different* result than it did optimistically (their canonical example: "book this room" does nothing on replay if the room is now taken). This is **server-authoritative** convergence-by-replay rather than CRDT convergence-by-commutative-merge.
- **The stated hard problem.** "It's not clear what a general strategy would be for applying the patch on top of local changes." Rebase is their answer. A deliberately elevated design choice: **"the push endpoint is not necessarily expected to compute the same result that the mutator on the client did. This is a feature."** (enables server-side permissions/validation/side-effects).
- **Client store / protocol.** Persisted Client View + a git-like version history (so it can rewind/rebase invisibly); browser persistence = IndexedDB (in-memory fallback). **Backend-agnostic by design** — Replicache is a client library + a push/pull/poke *protocol*; you bring your own DB. Data model is JSON key/value (deliberate, to exploit IndexedDB's fast native serialization).
- **Novel.** Rebase-of-intent (video-game "server reconciliation" applied to general app data) giving CRDT-like optimistic UX with arbitrary relational backends + per-mutation conflict logic; backend-agnostic protocol; "server result need not match client result" as a feature.
- **Tradeoffs the authors admit.** Server-authoritative, not P2P/local-first. **The big one (and the reason Zero exists): you must hand-write push/pull and the client-view computation, and partial sync is manual** — deciding which rows each client sees, incrementally, is left to the developer.

---

# 2. Zero (Rocicorp)

**Canonical:** "What is Sync?" — https://zero.rocicorp.dev/docs/sync · "When to Use" — https://zero.rocicorp.dev/docs/when-to-use · Mutators — https://zero.rocicorp.dev/docs/mutators · `llms.txt` — https://zero.rocicorp.dev/llms.txt · pivot: "Retiring Reflect" — https://rocicorp.dev/blog/retiring-reflect · architecture: DeepWiki `rocicorp/mono`

Lineage: Replicache (2020) → Reflect → **Zero** (2024–). *"Rocicorp is shifting development focus to Zero — a new sync engine that builds on what we've learned from Replicache and Reflect over the past four years."* Zero's **conflict engine is identical to Replicache's** (server-authoritative rebase/replay); the leap is **how you specify what to sync**.

- **The "hard problem" framing (the clearest in the field).** *"Sync engines are very hard to build. Typically, a new custom sync engine is built for each application at great expense. **Knowledge about the specific application and its data model must be built into each sync engine to correctly handle conflicts and partial sync.**"* Zero names why prior general engines (Meteor, Firebase RTDB, PouchDB, Realm, Replicache) failed to get broad adoption: *"No support for fine-grained authorization; Limited support for partial sync — users have to sync all data…; Required adoption of non-standard backend databases or data models; Limited ability to put custom business logic on read or write paths."*
- **Core sync model — query-driven sync + IVM.** You don't write push/pull or compute a client view — **you write queries** (**ZQL**, a TypeScript relational DSL). The set of active queries *is* the partial-sync spec. ZQL queries are **hybrid**: they run client-side against the local store for an instant (possibly partial) answer, then the server returns authoritative results. **End-to-end Incremental View Maintenance**: reactive operator pipelines apply incremental row deltas ("pokes") on both server and client instead of re-running queries.
- **zero-cache / view-syncer architecture.** `zero-cache` replicates Postgres into a **local SQLite replica** via logical replication and runs ZQL pipelines against it (assumes "very fast local access to this replica"). Per-connection **`ViewSyncer`** owns the WebSocket, drives IVM, and tracks each client's state via a **CVR (Client View Record)** in Postgres (notably *not* required to be durable — "if a CVR is lost, the server can send a reset patch"). **Protocol = WebSocket**: server→client "pokes" (row deltas), client→server "pushes" (mutations). Client store = **IndexedDB via `zero-client`, built on Replicache**.
- **Custom mutators (vs legacy CRUD).** Legacy auto-generated CRUD mutators (raw table writes, can't express permissions/business logic) are "discouraged." **Custom mutators** are TS functions that run optimistically on the client *and* authoritatively on the server, where "the implementations don't have to be the same, or even compute the same result" — putting validation + permissions + business logic on the write path (the exact gap "What is Sync?" named) while keeping optimistic UX. Replay constraint: *"Do not generate IDs inside mutators, since mutators run multiple times"* (use client-generated uuidv7/nanoid).
- **Self-positioning honesty.** Marketing says "the local-first sync engine," but the docs are blunt: **"Zero is not local-first. It's a client-server system with an authoritative server,"** and **"Zero doesn't support offline writes"** (offline is read-only). Local-first *UX*, not local-first *data ownership*.
- **Novel.** Query-driven partial sync (derives the client view from queries); end-to-end IVM over a SQLite replica of Postgres; standard Postgres backend (no special DB); server-side named-query resolution (`ZERO_QUERY_URL`) where fine-grained read permissions are enforced (clients send named queries, not arbitrary SQL).
- **Tradeoffs the authors admit (unusually candid).** Not local-first / no offline writes; **TypeScript clients only** (no native mobile); recommended **datasets < 100GB**; **operating zero-cache is heavy** — a persistent logical-replication connection (can yield "surprisingly high bills" on per-connection-billed Postgres like Neon), replication slots don't survive failover (forcing full resync), losing the SQLite replica forces re-replication; **queries must be indexed or they're dangerous** (a `TEMP B-TREE` plan = unoptimized; an observed "320x slowdown" on `OR` + `NULL`); read permissions still maturing; mutators can't return values on success yet and only read already-cached local data; JSON-only data types.

---

# 3. Electric SQL

**Canonical:** rewrite post-mortem "Electric Next" — https://electric.ax/blog/2024/07/17/electric-next · old CRDT framing — https://electric.ax/blog/2023/09/20/introducing-electricsql-v0.6 · shapes — https://electric-sql.com/docs/guides/shapes (`electric-sql.com` now 301s to `electric.ax`)

The **rewrite** is the design-rationale centerpiece — Electric *demolished* an ambitious CRDT local-first platform and rebuilt as a minimal read-path engine.

- **Old ElectricSQL (v0.x, "from the inventors of CRDTs").** CRDT-based bidirectional sync; a **Satellite** process in front of Postgres; an **embedded DB in the client** (SQLite + experimental Postgres-in-the-browser, PGlite); a TS client with live queries, DDLX permission rules, migrations, codegen; and **"finality of local writes"** (local writes are final, never rejected).
- **Why they threw it away (verbatim post-mortem).** *"The complexity of the stack has provided a wide surface for bugs… we've ended up fixing issues with things like docker networking, migration tooling and client-side build tools."* Root cause: *"Coming from a research background, we wanted the system to be optimal. As a result, we often picked the more complex solution from the design space."* The sharpest admission — the demo-vs-production trap: building *"a system that demos well, with magic sync APIs but that never actually scales out reliably. Because the very features and choices that make the demo magic, prevent the system from being simple enough to be bulletproof in production."* Guiding principles for the reboot: **Gall's Law** ("A complex system that works is invariably found to have evolved from a simple system that worked") and **Worse is Better**. The reframe: **"a sync engine, not a local-first software platform."** Cut: CRDTs, embedded client DB (PGlite spun out), finality of writes, DDLX auth (→ "a simpler solution, such as Postgres RLS"), reactivity, codegen, migrations.
- **Current core sync model — Shapes over HTTP.** An Elixir sync-service consumes Postgres **logical replication** and fans changes into **Shapes** — "essentially a SQL query" (table + optional `WHERE` + column projection) = **partial replication**. Syncing a shape yields a **Shape Log** ("a log of logical database operations affecting the data in your shape"). Protocol is deliberately **stateless HTTP, not WebSockets**: "minimizes state, making the sync engine more reliable and scalable, and integrates with standard HTTP tooling like proxies and CDNs." Client loop: initial sync (`offset=-1`, paginate via `electric-offset` header to an `up-to-date` message) then live mode (`live=true`).
- **Conflict resolution — they now punt on writes, deliberately.** Electric Next does **not write back to Postgres** in its core; writes are the developer's problem via their own API. They abandoned finality as a tenet, embracing **"tentativity"** ("you can choose your write pattern(s) and the guarantees you want them to provide"). Their reference write pattern even admits a "naive rollback strategy of clearing all local state on rejection." Modern pairing: **Electric (read-only HTTP streaming) + TanStack DB (optimistic writes via API)**.
- **Client store.** None mandated — Electric ships a log; you materialize it where you like (TanStack DB, a JS Map, PGlite). The deliberate inversion of the old "embedded DB is the product" model.
- **Novel.** Making sync look like **cacheable HTTP** so it rides existing web infra (the shape log = cache key + resumable cursor); decoupling a "loosely coupled set of primitives around a smaller core" vs a vertical stack.
- **Tradeoffs admitted.** Read-path only (no built-in writes/conflict resolution); "explicitly reduce short-term capability to build a more resilient system long-term"; permissions/auth/reactivity/type-safety are now your problem.

---

# 4. PowerSync

**Canonical:** consistency — https://docs.powersync.com/architecture/consistency · update conflicts — https://docs.powersync.com/handling-writes/handling-update-conflicts · bucket limits — https://docs.powersync.com/sync/streams/overview · sync-rules — https://github.com/powersync-ja/powersync-service (`packages/sync-rules/README.md`)

Mirror image of *old* Electric, same destination as *new* Electric — **started** server-authoritative, no CRDTs.

- **Core sync model — Postgres → SQLite via buckets + sync rules.** A `WalStream` consumes the Postgres **WAL** (keyed/ordered by LSN) into **bucket operations**. A **bucket** is "a logical grouping of data rows synchronized as a single unit." **Sync Rules** (SQL, but **never executed against the DB**) define exactly two operations: "1. Given a data row, compute a list of buckets that it belongs to. 2. Given an authenticated user, return a list of buckets for the user." **Checkpoints + checksums**: each bucket carries a checksum; the client diffs checksums to compute the minimal delta. Buckets support **priorities** (high-priority data can preempt).
- **Conflict resolution — server-authoritative, no CRDTs.** "Although local offline writes are supported, PowerSync does not use CRDTs as part of its protocol." The consistency trick that avoids client-side merge: **"While mutations are present in the upload queue, the client does not advance to a new checkpoint. This means the client never has to resolve conflicts locally."** (the upload queue is "a blocking FIFO queue"; target = "causal+ consistency"). Default = **last-write-wins** ("the last update… to each individual field wins"; "Deletes always win"); operations must be idempotent (per-client op IDs for dedup). No finality of local writes — backend applies writes "with any logic of the developer's choosing," then the client re-syncs to authoritative state.
- **Client store / protocol.** A real, mandated **on-device SQLite** DB; app writes go to local SQLite *and* an **upload queue** drained by a developer-supplied **`uploadData()`** that hits their backend. Read path (buckets) and write path (queue) are explicitly decoupled.
- **Novel.** Bucket-based partial replication with **dynamic/parameterized buckets** (one bucket per parameter value, e.g. `by_org["org1"]`); the checkpoint-barrier consistency trick (no client-side conflict merge ever).
- **Tradeoffs admitted.** **Bucket cardinality is the headline limit** — "default limit of 1,000 buckets per user/client" (`PSYNC_S2305` "Too Many Buckets"); each unique filter value = a bucket, so cardinality explodes; mitigation = "multiple queries per stream." **Sync-rule SQL is restricted** (no `fn(bucket.param)`, no mixing row + request data) *because* "none of these SQL queries are actually executed against any SQL database" — expressions must be statically analyzable to compute bucket assignment at replication time.

---

# 5. Convex

**Canonical:** "How Convex Works" — https://stack.convex.dev/how-convex-works · overview — https://docs.convex.dev/understanding/overview · OCC — https://docs.convex.dev/database/advanced/occ · optimistic updates — https://docs.convex.dev/client/react/optimistic-updates · object sync engine — https://stack.convex.dev/object-sync-engine · DeepWiki `get-convex/convex-backend`

> Thesis: a server-authoritative reactive database that **runs your app code as serializable transactions inside the DB**, and reuses **one mechanism — read-set overlap detection — for OCC conflict checking, realtime subscriptions, and the query cache.** Not historically local-first.

- **Core sync model — reactive queries over read sets.** "A database running in the cloud that runs client-defined API functions as transactions directly *within* the database." Three pieces: **sync worker** (WebSocket sessions), **function runner**, **database**. Storage = an **append-only transaction log** (all versions, monotonic timestamps) + derived multiversion indexes ("the log is the immutable source of truth; the index is derived data"). **Reactivity = read sets**: each query records the index ranges it scanned at a begin timestamp; subscriptions reuse "the exact same algorithm the committer uses for detecting serializability conflicts: walk the log after the query's begin timestamp and see if any entry overlaps" — if so, rerun and push the new result. Queries/mutations are **pure deterministic TS** (no network/non-determinism).
- **The "sync engine" framing.** "We call this combination of the database, transactions, subscriptions, and deterministic JavaScript functions our sync engine. It's the core of Convex and the most unique part of our system." (The term "reactor" is internal, not in this article.)
- **Conflict resolution — serializability via OCC + deterministic retry.** Why serializable and nothing weaker (explicit "we chose X because Y"): "We believe that any isolation level less than serializable is just too hard a programming model for developers." OCC: record read/write sets, check at commit; on a read-set overlap, **abort and retry**. Determinism is what makes retry automatic and merge-conflict-free: "we know the transaction is deterministic… we can simply re-run the transaction… the Git analogy stays apt… determinism is what guarantees there is never a 'merge conflict', so this rebase operation will always eventually succeed without developer intervention." The committer is the **sole writer** (server-authoritative). True serializability, not snapshot isolation. (Lineage: "similar in design to FoundationDB's and Aria's.")
- **Client store / protocol.** WebSocket; client `ModifyQuerySet` to subscribe, server `Transition`/`QueryUpdated` deltas. **Cross-query consistency guarantee**: "all queries in the client's query set are at the same timestamp" (the stock-count/cart-count example). **Optimistic updates** are client-side only via `OptimisticLocalStore` ("Server Reconciliation" in Matt Weidner's taxonomy).
- **Novel.** The integration, not the primitives (they're candid the building blocks are standard MVCC): one read-set mechanism powers OCC + subscriptions + an always-consistent query cache; serializability-by-default contrasted with mainstream DBs' weaker defaults.
- **Tradeoffs admitted.** **No side effects in mutations** (else retry would double-send, e.g. emails) — side effects go in non-reactive **actions**; **no external data in queries** (determinism — else can't know when sources change); **OCC contention** on a hot document drives repeated abort/retry; broad subscriptions cost via frequent reruns; **not local-first / offline** ("relies on a persistent connection") — local-first is a *separate, newer* object-sync-engine effort. Their stance: "serializability often implies some degree of centralization." Roadmap gaps admitted: query reruns are coarse (full JS re-execution), clients can't allocate IDs offline yet, dependent queries waterfall.

---

# 6. InstantDB

**Canonical:** "A Graph-Based Firebase" — https://www.instantdb.com/essays/next_firebase · "A backend for AI-coded apps" (architecture) — https://www.instantdb.com/essays/architecture · "Database in the Browser, a Spec" — https://www.instantdb.com/essays/db_browser · DeepWiki `instantdb/instant`

> Thesis: "a graph-based successor to Firebase" — a client-side **triple store + Datalog engine in the browser**, paired with a **Clojure sync engine that tails the Postgres WAL** and matches changes to live queries via "topics." Conflict resolution = **last-write-wins per triple** (Figma-style), an explicit "80/20." Founders: ex-Facebook/Airbnb (Stepan "Stopa" Parunashvili, Joe Averbukh).

- **Origin / motivation.** "The schleps we face as UI engineers are actually database problems in disguise." They admired Firebase's "database on the browser" but rejected it for weak queries (document-only) + weak permissions. North star: Optimistic Updates + Multiplayer + Offline ("Multiplayer is just too hard to build").
- **The "we tried X and it failed" moment — SQL → triples.** First explored SQL (sql.js/absurd-sql) and rejected it: "SQL as a language turns out to be a dealbreaker… the frontend's common case is SQL's advanced case… The spec… is over 1700 pages long. We'd have to implement reactivity for all 1700 pages." Insight: frontend queries are all graphs → **triple store** ("the first item is always an `id`, the second the `attribute`, and the third, the `value`… triples are all we need to express a graph"). Why triples won: "You can write a roughly complete implementation in less than a hundred lines of Javascript," ~90KB vs sql.js's ~400KB, and schema-optional.
- **Core sync model — InstaQL + InstaML.** **InstaQL** (GraphQL-inspired, plain JS objects, transpiles to **Datalog**) — chosen over GraphQL to avoid a build step and because "In GraphQL you define mutations as functions in the backend… then you can't do optimistic updates out of the box." **InstaML**: every mutation reduces to a triple **assertion or retraction**, so "our Local DB can apply them, and we have optimistic updates out of the box."
- **Conflict resolution — LWW per triple (Figma-style), defended as 80/20.** "Notion, Figma, and Linear all use last-write-wins." The Figma insight, generalized: "If we're creative about how we save things, there shouldn't be a conflict in the first place. How does Figma do this? They store their properties as… triples! Since they are different rows, there's no conflict." Explicit rebuttal to the CRDT objection: "I think last-write-wins is a great 80/20… when the research is more mature, integrate it down the road."
- **Client store — triple store + pending queue + Reactor.** IndexedDB persistence; an **immutable** in-browser triple store + Datalog engine (chosen over SQLite, "too heavy" at 300KB) so queries evaluate fully client-side; a **Pending Queue** for optimistic updates + undo ("If the server returns a failure, we simply remove the change from the pending queue and undo works out of the box"); the **Reactor** is the client state machine coordinating it all over WebSocket. (This *is* Instant's "reactor.")
- **Server / protocol — Clojure, WAL-tailing, topics.** A **Query Store** tracks who queried what; **Topics** (borrowed from Asana's Luna/Worldstore + Figma's LiveGraph) describe "the part of the index that the query cares about"; an **Invalidator** tails the **Postgres WAL**, generates topics from WAL entries, and matches them to query topics "to discover what's stale"; **Grouped Queues** give multi-tenant fairness (serial within an app, parallel across apps). Permissions use Google **CEL**.
- **Multi-tenant DB — Postgres as one giant triples table.** Rejected per-app VMs (RAM) and per-app Postgres tables ("after about 6000 tables, Postgres starts having issues… pg_dump and autovacuum start failing"). All apps share one `triples` table isolated by `app_id`, so "creating a new database is effectively free."
- **Novel.** Client-side Datalog engine enabling true offline + optimistic updates *with relations*; near-free multi-tenant DB creation; WAL→topics invalidation generalized into a product.
- **Tradeoffs admitted.** **EAV fights the Postgres planner** ("generally discouraged… Postgres loses information about the underlying frequencies… can't tell the difference between a column with 10 distinct values and one with 10 million") — fixed with hand-maintained **count-min sketches**; relational features (unique constraints, indexes, refs) reimplemented via partial indexes; generated SQL "can look scarily long"; **Datalog learning curve**; LWW is only an "80/20" ceiling; "reactivity is hard… it's hard to figure out *which* queries need to be updated."

---

# 7. Linear Sync Engine (LSE)

**Canonical:** Tuomas Artman, "Scaling the Linear Sync Engine," Local-First Conf 2024 — https://www.youtube.com/watch?v=Wo2m3jaJixU · "Building a synchronous experience with asynchronous data," React Helsinki 2020 — https://www.youtube.com/watch?v=WxK11RsLqp4 · localfirst.fm Ep.15 transcript — https://www.localfirst.fm/15/transcript · **endorsed** reverse-engineering — https://github.com/wzhudev/reverse-linear-sync-engine (Artman: "a pretty awesome (and correct) write-up… probably the best documentation that exists - internally or externally")

> Sourcing: Artman's own words are conceptual; protocol-level mechanics (sync IDs, delta packets, transaction queue) are from the Artman-endorsed reverse-engineering writeup + DevTools corroboration (marknotfound, fujimon).

- **Core model — a normalized in-memory object *graph*.** Models (Issue, Team, Project…) live in an in-memory **Object Pool** (`id → model`) built with **MobX** for reactivity, backed by **IndexedDB**. The DX thesis: **"You're effectively just building the front end… You modify those [objects] and that's it. Your feature is done. Everything else is handled — the synchronization, other users making the same edits… You just build the frontend."** API is literally `user.name = 'x'; user.save()`. Models use TS **decorators** (`@ClientModel`, `@Property`, `@Reference`, `@OneToMany`) registered in a `ModelRegistry`; a `@Reference` compiles to a persisted scalar `assigneeId` + a non-persisted `assignee` getter resolving against the Object Pool — making it a true graph.
- **The global monotonic sync counter.** Every successful server write **increments a global integer `lastSyncId` by 1** — "the version number of the database," spanning the **entire database across all workspaces** (so it jumps even when only your workspace changed). Writes form a **total order**, which is why the writeup calls LSE **OT-like, not CRDT-like**. **Delta packets** arrive over WebSocket as `{cmd:"sync", sync:[SyncAction...], lastSyncId:N}`; each `SyncAction` is `{id, modelName, modelId, action(I/U/D/A/…), data}`. **Catch-up after offline** = `GET /sync/delta?lastSyncId=…&toSyncId=…`. **Sync groups** scope which deltas a client receives (access control).
- **Bootstrapping — full vs partial vs lazy.** Per-model **load strategies**: `instant` (bootstrap default), `lazy`, `partial`, `explicitlyRequested`. Bootstrap = `GET /sync/bootstrap?type=full&onlyModels=…` returning **line-delimited JSON, one model per line**, ending with a `_metadata_` line carrying `lastSyncId`; a second `type=partial` bootstrap fetches deferred high-cardinality models (Comment, IssueHistory). **Lazy loading via partial indexes**: `indexed: true` references generate IndexedDB indexes whose keys become query params, so the client can fetch "all Issues assigned to user X" without knowing their IDs (`BatchModelLoader` → `POST /sync/batch`). The 2024 "Scaling" work split the single bootstrap into **multiple Cloudflare-cacheable requests** + a MongoDB cache because full bootstrap got expensive as data grew.
- **Conflict resolution — LWW per property via transaction rebasing.** Mutations become **transactions** in a **`TransactionQueue`** (persisted to a `__transactions` IndexedDB table for offline resend); the in-memory model updates optimistically immediately, the transaction carries only the diff for sync/undo/reconciliation. On a conflicting delta, LSE **rebases** the transaction (LWW: "the server processes your colleague's update first… It is similar to Operational Transformation"). **Key invariant:** "the local database is a subset of the server database (the SSOT), and it cannot contain changes that have not been approved by the server." CRDTs are used **only** for issue descriptions, added late — "conflicts are actually not that common in Linear… LWW is enough."
- **The "why a sync engine at all" hard problem.** The RPC/WebSocket race: "You send out the RPC call and wait for acknowledgement… While that's going on, you receive a packet that another user updated a certain property… What do you do?… you really don't know what to do… **you effectively need to implement another sync engine in order to make that happen. There needs to be a queue of sorts. And it becomes very, very complex.**"
- **The "coupled" argument.** By encoding the schema *into* the engine (decorators, load strategies, partial indexes), the engine itself knows how to bootstrap/index/observe/persist/sync each model — so networking, caching, optimistic updates, and offline collapse behind `save()`. The tradeoff: it is **not** a general-purpose, schema-agnostic layer. "There's starting to be tooling… that you can use out of the box. That will probably work for most cases. **It will still be hard to scale that up.**"
- **Novel.** Schema-coupled decorator-driven engine; a single global monotonic version clock; partial/lazy hydration via partial indexes; transaction-queue rebasing with optimistic UI.
- **Tradeoffs admitted.** **Bounded-data only** ("if you're building… a search engine, obviously not… you need to have that data locally"); **scaling is the hard part** (the whole talk); **DX was an afterthought**, not the goal; **offline was never meant to be long-lived** ("turn your Wi-Fi off for a second"); **non-idempotent transaction replay** can resend on tab-close ("You can't delete a model that doesn't exist"); the global `lastSyncId` is a structural single write-ordering bottleneck. Business upside: client-held data means "you don't pay for database reads as often."

---

# 8. Figma Multiplayer

**Canonical:** Evan Wallace, "How Figma's multiplayer technology works," 2019 — https://www.figma.com/blog/how-figmas-multiplayer-technology-works/ · related: fractional indexing — https://www.figma.com/blog/realtime-editing-of-ordered-sequences/

- **Core model — server-authoritative, CRDT-*inspired*, explicitly NOT OT, NOT a true CRDT.** Client/server over **WebSockets**, **one server process per document**. **Why reject OT:** "OTs were unnecessarily complex for our problem space… they are very complicated and hard to implement correctly. They result in a combinatorial explosion of possible states… Since Figma isn't a text editor, we didn't need the power of OTs and could get away with something less complicated." **Why not a true CRDT:** "CRDTs are designed for decentralized systems where there is no single central authority… Since Figma is centralized (our server is the central authority), we can simplify our system by removing this extra overhead… Figma's data structure isn't a single CRDT. Instead it's inspired by multiple separate CRDTs."
- **Document model.** A tree of objects = a two-level map `Map<ObjectID, Map<Property, Value>>`; "adding new features… usually just means adding new properties to objects."
- **Conflict resolution — per-property LWW, server defines order.** "Figma's multiplayer servers keep track of the latest value that any client has sent for a given property on a given object… A conflict happens when two clients change the same property on the same object, in which case the document will just end up with the last value that was sent to the server. **This approach is similar to a last-writer-wins register… except we don't need a timestamp because the server can define the order of events.**" Granularity tradeoff: "**This is why simultaneous editing of the same text value doesn't work** in Figma. If the text value is B and someone changes it to AB at the same time as someone else changes it to BC, the end result will be either AB or BC but never ABC. That's ok with us because Figma is a design tool, not a text editor."
- **The hard problems they name.** **Reparenting** — "the most complicated part of our multiplayer system." Parent link stored **as a property on the child** (preserves identity through concurrent edits). The **cycle/orphan problem** (A→child of B while B→child of A): server rejects cycles, but the client can transiently hit it — "**Figma's solution is to temporarily parent these objects to each other and remove them from the tree until the server rejects the client's change… This solution isn't great because the object temporarily disappears, but it's a simple solution to a very rare temporary problem.**" **Ordering** via **fractional indexing** (parent + position stored atomically as one property). **Undo** — "undo in a multiplayer environment is inherently confusing"; an undo modifies redo history at the time of the undo. **Flickering** — optimistic local changes must discard server values that conflict with unacknowledged local ones.
- **Offline / store.** In-memory object tree; on reconnect the client "downloads a fresh copy of the document, reapplies any offline edits on top… **all of the complexity… is in dealing with updates to already connected documents.**" Multiplayer is only for the document tree; comments/users/teams live in a **separate Postgres-backed system** "because of different tradeoffs." Deleted-object data is offloaded to the deleting **client's undo buffer**, not the server ("helps keep long-lived documents from continuing to grow in size"). **Client-generated IDs** because "object creation needs to be able to work offline."
- **Method.** Prototyped in a standalone 3-client simulator before touching the real codebase: "Taking time to research and prototype in the beginning really paid off."

---

# 9. Ink & Switch "Local-first software" + CRDT/Automerge context

**Canonical:** Kleppmann, Wiggins, van Hardenberg, McGranaghan (2019) — https://www.inkandswitch.com/local-first/

- **The foundational inversion.** "In cloud apps, the data on the server is treated as the primary, authoritative copy… In local-first applications we swap these roles: we treat the copy of the data on your local device… as the primary copy. Servers still exist, but they hold secondary copies." Refined definition: "the availability of another computer should never prevent you from working."
- **The seven ideals.** (1) **No spinners** — "potential to respond near-instantaneously," explicitly hedged ("does not guarantee that the software will be fast"); (2) **Your work is not trapped on one device** (sync across devices); (3) **The network is optional** (read/write offline, sync later; favors installed apps over browser tabs); (4) **Seamless collaboration** — "one of the biggest challenges in realizing local-first software"; (5) **The Long Now** (works "even after the company… is gone"); (6) **Security and privacy by default** (end-to-end encryption; the central cloud DB "is an attractive target for attackers"); (7) **You retain ultimate ownership and control** ("ownership in the sense of user agency, autonomy, and control").
- **The CRDT thesis.** "Conflict-free Replicated Data Types (CRDTs)… general-purpose data structures, like hash maps and lists, but… multi-user from the ground up… If you are building a collaborative multi-user application, you can swap out those data structures for CRDTs." The one unavoidable conflict: "The only type of change that a CRDT cannot automatically resolve is when multiple users concurrently update the same property of the same object." Load-bearing claim: "CRDTs have the potential to be a foundation for a new generation of software… as packet switching was an enabling technology for the Internet." Implementation: **Automerge** (with the caveat "We do not claim that these libraries fully realize local-first ideals").
- **The tradeoffs they admit (the richest vein).**
  - **Scorecard:** "many technologies satisfy some of the goals, but none are able to satisfy them all." Web apps = "a total loss of ownership and control"; "web apps will never be able to provide all the local-first properties… due to the fundamental thin-client nature of the platform." Mobile teams "writing their own ad-hoc diffing, merging, and conflict resolution algorithms… often unreliable and brittle."
  - **The most-cited admission — metadata/history growth:** "**CRDTs accumulate a large change history, which creates performance problems**… they store all history, including character-by-character text edits. These pile up, but can't easily be truncated because it's impossible to know when someone might reconnect… after six months away."
  - **Networking is unsolved by CRDTs:** "CRDT algorithms provide only for the merging of data, but say nothing about how different users' edits arrive on the same physical computer"; P2P/NAT traversal "nowhere near production-ready."
  - **Research-vs-production gap:** "it is not yet advisable to replace a proven product like Firebase with an experimental project like Automerge in a production setting today."
  - **Servers don't disappear, they change role** to "cloud peers… in a supporting role, not the source of truth."
  - **A surprising non-problem:** "**Conflicts are not as significant a problem as we feared**… users surprisingly rarely encounter conflicts." (This undercuts the assumption that automatic conflict resolution is the central value of CRDTs — and explains why Figma/Linear/Instant get away with LWW.)
- **Named open problems → later Ink & Switch projects.** Branching/versioning → **Upwelling** (https://www.inkandswitch.com/upwelling/); schema evolution ("no authoritative 'current' schema") → **Project Cambria** (bidirectional lenses, https://www.inkandswitch.com/cambria/); rich-text merge → **Peritext** (https://www.inkandswitch.com/peritext/). The market call: "an interesting market opportunity: 'Firebase for CRDTs.'"
- **CRDT performance context.** Kleppmann, "CRDTs: The Hard Parts" — "CRDTs are easy to implement badly… Simple implementations often have terrible performance" (https://martin.kleppmann.com/2020/07/06/crdt-hard-parts-hydra.html). Joseph Gentle's arc (2011 "Implementing OT sucks" → 2020 "I was wrong. CRDTs are the future" → 2021 "CRDTs go brrr," https://josephg.com/blog/crdts-go-brrr/): the GUID-per-character problem ("A GUID for every character? Nought but madness"), the tombstone-growth problem ("Yjs doesn't record when each item has been deleted. Only whether"), and the punchline — **~5000× faster** (5 min → 56ms) via columnar encoding + a B-tree in Rust. **Takeaway: the metadata-overhead objection to CRDTs is an engineering problem, largely solved 2021–24, not an inherent flaw.** **Yjs** (Kevin Jahns) is the canonical fast/minimal-metadata production CRDT (tldraw, BlockNote, Tiptap); **Automerge** is correctness/history-first, research lineage.

---

# 10. The general taxonomy

## 10.1 Three conflict-resolution families

| Family | Mechanism | Strengths | Costs | Who uses it |
|---|---|---|---|---|
| **CRDT** | Merge is a math property of the data type (partial order, no central authority) | P2P, offline-symmetric, no server needed | Metadata/history growth; same-property-same-object still needs app resolution; networking unsolved | Automerge, Yjs, old ElectricSQL, the I&S manifesto |
| **Server-authoritative / LWW** | Central server imposes a total order; last value per (object, property) wins | Simplest, leanest, fastest to ship — *when you already trust a central server* | Same-property concurrent edits don't merge (e.g. text) | **Figma, Linear, InstantDB, Convex, PowerSync, Replicache/Zero** |
| **OT** | Transform concurrent ops against each other to preserve intent | Precise intent capture for text | "Notoriously complex… combinatorial explosion of states"; needs central coordination anyway | Google Docs; *explicitly rejected* by Figma & routed-around by Linear |

The striking pattern: **the two most-admired "feels-instant" apps (Figma, Linear) both chose server-authoritative LWW over CRDTs and OT**, and several general engines (Convex OCC, Replicache/Zero rebase) are LWW-flavored server-authoritative too. The justification is always the same — a central server you already trust makes the decentralized machinery unnecessary overhead — backed by Ink & Switch's own field finding that real-world conflicts are rare.

## 10.2 Partial replication — "you can't sync the universe"

The central *scaling* problem: full replication doesn't scale, so every serious engine has a partial-sync primitive — and they differ mainly in **who computes the slice**:

- **Replicache:** hand-written client-view computation (manual).
- **Zero:** the slice = your **queries** (ZQL); derived automatically.
- **Electric:** **Shapes** — "a partial replica of a table that includes the subset of rows matching a user-defined WHERE clause."
- **PowerSync:** **Buckets** via sync rules (row → buckets; user → buckets), checksummed.
- **Linear:** per-model **load strategies** + partial indexes ("only sends open issues or ones closed over the last week").
- **Convex framing** of the spectrum (https://stack.convex.dev/object-sync-engine): the **Goldilocks problem** — "Preloading too little will cause spinners and waterfalls… preloading too much wastes storage and bandwidth"; and the security trap of naive over-sync — "It's typically too much state, requires error-prone access controls for protection, and leaks implementation details" (cites Arc's CVE-2024-45489 as the cautionary tale of partial-sync permissions done wrong).

Note **Zero's framing** of *why* this is the hard part: "Incrementally syncing a static block of data is easy; syncing just the slice the user wants and **has access to** is much more difficult." Partial sync and **fine-grained authorization** are the same problem.

## 10.3 IVM — incremental view maintenance (the engine inside the engine)

- **Definition** (Riffle, https://riffle.systems/essays/prelude/): "Incremental view maintenance is the problem of updating the results of a query over some data as it changes."
- **Why it matters:** a sync engine must keep a *client-side query result* fresh as rows change *without re-running the whole query*. That is exactly IVM. **Zero** is built on it (ZQL = streaming query + IVM); **Convex** does a coarser version (rerun on read-set overlap); **InstantDB** does WAL→topics matching; **Riffle** applies IVM client-side over SQLite; **Materialize / differential dataflow** is the heavy-duty server-side version (update tuples `(data, time, diff)`, work proportional to the *change* not the dataset).
- **The bridge:** partial replication decides *which rows* live on the client; IVM decides *how to keep a query over them live* as deltas stream. Zero couples both; that coupling is its headline novelty.

## 10.4 The "sync engine" definition and the coupled-vs-general axis

- **Definition** (Zero): "Sync engines enable instant UX by downloading data to the client ahead of time. Reads and writes happen locally, and changes are synced in the background." (Isaac Hagoel: the engine "acts as a persistent buffer between the frontend and the backend.")
- **Coupled** (Linear, Figma): the engine is purpose-built for **one fixed data model**; the schema *drives* sync behavior. Buys speed + rich features (partial sync, permissions, undo, offline) + ORM-like DX; costs reusability. Linear's tradeoff stated plainly: "purpose-built for Linear's fixed schema rather than generic — a design tradeoff between flexibility and implementation complexity." Figma's variant: narrow multiplayer to *just* the document tree, keep everything else in a separate Postgres system.
- **General-purpose** (Replicache→Zero, Electric, PowerSync, Convex, Instant): schema-agnostic infrastructure; any app's data model rides the same engine. This is the literal answer to Ink & Switch's "Firebase for CRDTs" call, generalized beyond CRDTs to "Firebase for sync."
- **"Local-first" vs "sync engine."** The community increasingly separates them: the local-first *manifesto* assumes P2P + CRDTs + data ownership; *sync engines* assume a full client-server world and solve practical instant-UX problems (often server-authoritative, explicitly *not* offline-write or P2P — see Zero's own "not local-first" disclaimer). Kyle Mathews' "recoupling the stack" thesis partitions the field into three: (1) **replicated data structures** (Yjs, Jazz), (2) **replicated database tables** (Postgres→SQLite: Electric, PowerSync), (3) **replication as a protocol** (Replicache/Zero) — and predicts sync engines "will replace traditional APIs in rich client apps." (Caveat: "The Web's Next Transition" as a discrete essay was not located; thesis cited via Mathews.)

## 10.5 The organizing spectrum

| | **Online-only realtime collaboration** | **Offline-capable local-first** |
|---|---|---|
| Network | Required; server on the critical path | Optional; device holds the primary copy |
| Authority | Central server (LWW/OT) | Device / no single authority (CRDT) or "cloud peer" |
| Canonical | Figma, Google Docs, Linear (mostly), Convex, Zero | Automerge, Yjs P2P, old Electric, the I&S manifesto |
| Offline failure mode | "locked out of your work mid-sentence" | Keep working; sync later |

The 2024–26 reality: the production winners (Linear, Figma) sit toward the **online-realtime, server-authoritative** end but **borrow the local-store, instant-read UX** of local-first — which is precisely why "sync engine" emerged as a category *distinct* from the purist CRDT/P2P "local-first manifesto." Ink & Switch's reconciliation: servers stay, "in a supporting role, not the source of truth."

---

# Cross-cutting: the hard problems in sync (in the authors' words)

1. **"The hard part of sync is partial sync + permissions, not merging."** Zero: "Incrementally syncing a static block of data is easy; syncing just the slice the user wants and *has access to* is much more difficult." Convex names the same danger: over-sync "requires error-prone access controls… and leaks implementation details" (Arc CVE-2024-45489).
2. **The RPC-vs-realtime race forces you to build a sync engine.** Artman: "you receive a packet that another user updated a certain property… you really don't know what to do… you effectively need to implement another sync engine… There needs to be a queue."
3. **Knowledge of the app's data model must be baked in to handle conflicts + partial sync** — so general engines are *hard*. Zero's central thesis; Linear's answer is to couple the engine to the schema; the cost (Linear) is reusability, the cost (Figma) is narrowing scope to the doc tree.
4. **CRDT metadata/history growth.** Ink & Switch: "CRDTs accumulate a large change history… can't easily be truncated." Largely an engineering problem by 2021–24 (Gentle's 5000×; Yjs's no-delete-timestamps), not an inherent flaw.
5. **CRDTs say nothing about networking.** Ink & Switch: "CRDT algorithms provide only for the merging of data, but say nothing about how different users' edits arrive."
6. **Reparenting an eventually-consistent tree.** Figma: "the most complicated part of our multiplayer system" — parent-as-property + server cycle rejection + transient client orphaning.
7. **Multiplayer undo is "inherently confusing."** Figma; also one of InstantDB's "schleps."
8. **Optimism is deceptively hard.** InstantDB: "You need a queue to maintain order. You need undo… if you have multiple changes waiting and the first one fails… you need some way to cancel the dependents." Figma's "flickering"; Replicache/Zero/Linear's rebase-on-replay (and the "don't generate IDs in mutators" / non-idempotent-replay traps).
9. **Determinism vs side effects.** Convex bans `fetch` in mutations/queries because retry-on-conflict would double-send and reactivity needs to know when sources change — side effects exiled to non-reactive actions.
10. **The demo-vs-production trap (the meta-lesson).** Electric: "a system that demos well, with magic sync APIs but that never actually scales out reliably. Because the very features and choices that make the demo magic, prevent the system from being simple enough to be bulletproof in production." → Gall's Law + Worse-is-Better. PowerSync pays the same simplicity tax as bucket cardinality + non-executable sync-rule SQL; Zero pays it as the operational weight of zero-cache.
11. **The Goldilocks bootstrap.** How much to preload? Too little = spinners/waterfalls; too much = wasted storage + the security/leak problem (Convex). Linear's "Scaling" talk is entirely about full-bootstrap cost growing with data.
12. **Surprising non-problem:** real-world conflicts are rarer than feared (Ink & Switch; echoed by Linear) — which is the empirical permission slip for everyone choosing LWW over CRDTs/OT.

---

# Comparison matrix

| Engine | Sync model | Conflict resolution | Client store | Server / protocol | Offline writes? |
|---|---|---|---|---|---|
| **Replicache** | Hand-written push/pull + client view; rebase | Server-authoritative **rebase/replay** of arbitrary mutators | IndexedDB (JSON KV) | BYO DB; HTTP push/pull + poke | Yes (queued) |
| **Zero** | **Query-driven** (ZQL) + end-to-end **IVM** | Same rebase/replay (inherited) | IndexedDB via zero-client/Replicache | Postgres→SQLite replica in zero-cache; **WebSocket** pokes/pushes | **No** (read-only offline) |
| **Electric** | Postgres logical replication → **Shapes** (read-only) | **Punted to your API** (tentative writes) | None mandated (BYO; +TanStack DB) | Elixir sync-service; **stateless HTTP** shape log (CDN-cacheable) | Via your write path |
| **PowerSync** | Postgres WAL → **buckets** (sync rules) | Server-authoritative **LWW**; no client merge (checkpoint barrier) | **Mandated SQLite** | Sync service; bucket ops + checkpoints; upload queue → `uploadData()` | Yes (upload queue) |
| **Convex** | App code as **serializable txns in the DB**; reactive read-sets | **OCC + serializability**; deterministic abort-and-retry | Query cache + `OptimisticLocalStore` | Custom DB; **WebSocket** Transition/QueryUpdated deltas | **No** (live connection) |
| **InstantDB** | **Triple store + Datalog** client; WAL→topics server | **LWW per triple** (Figma-style) | In-browser immutable triple store + Datalog (IndexedDB) | **Clojure**; multi-tenant Postgres `triples` table; WebSocket | **Yes** (founding constraint) |
| **Linear** | In-memory MobX object **graph**; global `lastSyncId` | **LWW** via transaction **rebasing**; CRDT only for descriptions | Object Pool + IndexedDB (subset of server SSOT) | `/sync/bootstrap`,`/sync/delta`,`/sync/batch`; WebSocket SyncActions | Yes, but **bounded** |
| **Figma** | Per-doc server process; object tree `Map<ID,Map<Prop,Val>>` | **Per-property LWW** (server orders, no timestamp) | In-memory tree; re-download on reconnect | **WebSocket**, one process/doc | Yes (replay on reconnect) |
| **Automerge/Yjs** | **CRDT**, P2P-capable | Automatic commutative merge | In-memory CRDT (+ persistence adapters) | Transport-agnostic | Yes (symmetric) |

---

# Sources

**Replicache / Zero**
- How Replicache Works — https://doc.replicache.dev/concepts/how-it-works
- Zero, "What is Sync?" — https://zero.rocicorp.dev/docs/sync
- Zero, "When to Use" — https://zero.rocicorp.dev/docs/when-to-use
- Zero, Mutators — https://zero.rocicorp.dev/docs/mutators
- Zero, `llms.txt` — https://zero.rocicorp.dev/llms.txt
- Retiring Reflect → Zero — https://rocicorp.dev/blog/retiring-reflect
- Architecture internals — DeepWiki `rocicorp/mono`

**Electric SQL**
- Electric Next (rewrite post-mortem) — https://electric.ax/blog/2024/07/17/electric-next
- Introducing ElectricSQL v0.6 (old CRDT framing) — https://electric.ax/blog/2023/09/20/introducing-electricsql-v0.6
- Shapes — https://electric-sql.com/docs/guides/shapes
- PowerSync's comparison — https://powersync.com/blog/electricsql-electric-next-vs-powersync

**PowerSync**
- Consistency — https://docs.powersync.com/architecture/consistency
- Handling update conflicts — https://docs.powersync.com/handling-writes/handling-update-conflicts
- Custom conflict resolution — https://docs.powersync.com/handling-writes/custom-conflict-resolution
- Bucket limits ("Too Many Buckets") — https://docs.powersync.com/sync/streams/overview
- Sync-rules design — https://github.com/powersync-ja/powersync-service (`packages/sync-rules/README.md`)

**Convex**
- How Convex Works — https://stack.convex.dev/how-convex-works
- Overview — https://docs.convex.dev/understanding/overview
- OCC — https://docs.convex.dev/database/advanced/occ
- Optimistic updates — https://docs.convex.dev/client/react/optimistic-updates
- An Object Sync Engine for Local-first Apps — https://stack.convex.dev/object-sync-engine
- Stateful Sync Platform — https://www.convex.dev/sync · DeepWiki `get-convex/convex-backend`

**InstantDB**
- A Graph-Based Firebase — https://www.instantdb.com/essays/next_firebase
- A backend for AI-coded apps (architecture) — https://www.instantdb.com/essays/architecture
- Database in the Browser, a Spec — https://www.instantdb.com/essays/db_browser · DeepWiki `instantdb/instant`

**Linear**
- Scaling the Linear Sync Engine (Local-First Conf 2024) — https://www.youtube.com/watch?v=Wo2m3jaJixU · https://linear.app/blog/scaling-the-linear-sync-engine
- Building a synchronous experience with asynchronous data (React Helsinki 2020) — https://www.youtube.com/watch?v=WxK11RsLqp4
- Unexpected benefits of going local-first — https://www.youtube.com/watch?v=VLgmjzERT08
- localfirst.fm Ep.15 transcript — https://www.localfirst.fm/15/transcript
- Endorsed reverse-engineering writeup — https://github.com/wzhudev/reverse-linear-sync-engine
- Corroboration — https://marknotfound.com/posts/reverse-engineering-linears-sync-magic/ · https://www.fujimon.com/blog/linear-sync-engine

**Figma**
- How Figma's multiplayer technology works — https://www.figma.com/blog/how-figmas-multiplayer-technology-works/
- Realtime editing of ordered sequences (fractional indexing) — https://www.figma.com/blog/realtime-editing-of-ordered-sequences/
- Making multiplayer more reliable — https://www.figma.com/blog/making-multiplayer-more-reliable/

**Ink & Switch / CRDT context**
- Local-first software — https://www.inkandswitch.com/local-first/
- Project Cambria — https://www.inkandswitch.com/cambria/ · Peritext — https://www.inkandswitch.com/peritext/ · Upwelling — https://www.inkandswitch.com/upwelling/
- Kleppmann, CRDTs: The Hard Parts — https://martin.kleppmann.com/2020/07/06/crdt-hard-parts-hydra.html
- Joseph Gentle, CRDTs go brrr — https://josephg.com/blog/crdts-go-brrr/

**Taxonomy / cross-cutting**
- Riffle — https://riffle.systems/essays/prelude/ (UIST'23: https://dl.acm.org/doi/10.1145/3586183.3606801)
- Materialize / differential dataflow — https://materialize.com/blog/self-correcting-materialized-views/
- Isaac Hagoel, Are Sync Engines the Future of Web Applications? — https://dev.to/isaachagoel/are-sync-engines-the-future-of-web-applications-1bbi

---

*Verification caveats: (1) several Electric and doc-site quotes were extracted via summarizing fetches and cross-checked against repo/DeepWiki renderings — faithful wording, not guaranteed byte-exact. (2) Linear's protocol mechanics rest on the Artman-endorsed reverse-engineering writeup + DevTools corroboration, not an official spec. (3) Do not attribute "CRDTs are not a silver bullet" to Ink & Switch (not a quote); "The Web's Next Transition" essay was not located as a discrete source.*
