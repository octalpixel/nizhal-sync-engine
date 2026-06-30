# Tabkeep

Tabkeep is Nizhal's flagship offline-first credit ledger. It is deliberately small: two tables,
three mutators, one shop-scoped sync rule, and a React UI backed by a durable local wa-sqlite store.

Balances are never stored. Each credit or payment is an append-only integer minor-unit movement, and
the balance is always `Σcredit − Σpayment` over the live local collection.

## Run the app

From the repository root, start the in-memory PGlite server and the web client in separate terminals:

```bash
pnpm --filter @nizhal/example-tabkeep dev:server
pnpm --filter @nizhal/example-tabkeep dev
```

Open `http://localhost:5175`. The Vite development proxy obtains a short-lived demo session from the
server. Stop the server, add credit, and reload: the local wa-sqlite ledger remains available. Restart
the server and reload to drain the durable outbox.

## Realtime & multi-device demos

The same UI runs in three realtime modes, selected by route. All three share one component
(`src/web/App.tsx`); the route only swaps the realtime **transport** (the data path — pull/push — is
always the Node server). Realtime is a `repull` *ping*, not the data: a device that misses a ping
(offline, asleep) still converges on its next pull, so the modes differ only in how fast a peer is
nudged, never in correctness.

| Route | Entry | Realtime transport | What to run |
| --- | --- | --- | --- |
| `/` | `App.tsx` | Node server (in-process), same-origin WS | `dev:server` + `dev` |
| `/realtime` | `App.Realtime.tsx` | Node server (in-process), same-origin WS | `dev:server` + `dev` |
| `/cf` | `App.CF.tsx` | Cloudflare **Durable Object** | worker + `dev:server:cf` + `dev` |

### Realtime (self-hosted Node)

```bash
pnpm --filter @nizhal/example-tabkeep dev:server
pnpm --filter @nizhal/example-tabkeep dev
```

Open `http://localhost:5175/realtime` in **two windows** (or two browser profiles — separate
profiles are separate devices with separate local stores). Record a credit in one; it appears in the
other within tens of milliseconds. Kill one window, record on the other, reopen the killed one: it
catches up from its cursor on reconnect.

### Cloudflare realtime

Routes the live ping through a real Cloudflare Durable Object (`wrangler dev` → workerd). Pull/push
still go to the Node data server; only the ping travels server → worker → DO → browser. Three
processes:

```bash
# 1. the realtime worker (Durable Object) on :8787
cd packages/server
pnpm build
npx wrangler dev -c src/adapters/cloudflare/wrangler.jsonc --port 8787 \
  --var NIZHAL_JWT_SECRET:dev-secret \
  --var NIZHAL_PUBLISH_SECRET:pub-secret \
  --var NIZHAL_AUTHORIZATION_URL:http://127.0.0.1:4521

# 2. the Node data server, publishing to the worker on commit
NIZHAL_JWT_SECRET=dev-secret NIZHAL_PUBLISH_SECRET=pub-secret NIZHAL_WORKER_URL=http://127.0.0.1:8787 \
  pnpm --filter @nizhal/example-tabkeep dev:server:cf

# 3. the web client
pnpm --filter @nizhal/example-tabkeep dev
```

Open `http://localhost:5175/cf` in two windows. The browser subscribes to the DO at
`/parties/nizhal-bucket/<shop>`; the worker authorizes the socket by calling the data server's
`/sync/realtime/authorize` (shop membership), then broadcasts `repull` when the server publishes.
Override the worker host with `VITE_NIZHAL_REALTIME_HOST` (default `127.0.0.1:8787`).

### Headless realtime proof

```bash
pnpm --filter @nizhal/example-tabkeep example:realtime
```

Two devices, one shop: measures ping-driven convergence latency and proves concurrent bidirectional
reconciliation (a credit on A + a payment on B merge into one append-only ledger, integer-exact).

```bash
pnpm --filter @nizhal/example-tabkeep example:divergence
```

Proves the two devices hold **separate** local stores (not one shared database): with the sync path
cut, a write on A is invisible to B (they diverge); restore the path and B converges. If they shared
one DB, B would mirror A with no server at all — so this is what makes the "they converge" claim mean
real sync rather than a shared-storage illusion.

## Tabkeep Chain — multi-branch (`src/chain/`)

The single-shop ledger above is deliberately simple: one bucket, append-only, one role. **Tabkeep
Chain** is the multi-branch increment that proves the four primitives a real POS chain / financial app
(Expensify-class) actually needs — all on the same engine.

```bash
pnpm --filter @nizhal/example-tabkeep example:chain
```

| Primitive | How it's built | What the proof shows |
| --- | --- | --- |
| **Multi-bucket isolation** | sync rule resolves buckets from a `branch_members` **membership** query (`SELECT branch_id WHERE user_id = …`) | a cashier sees only their branch; never another branch's products/sales |
| **HQ cross-branch rollup** | an owner has a membership row per branch → subscribes to every branch bucket | owner sees all branches and rolls up Σ sales across them |
| **Mutable per-field merge** | the `products` table is declared `merge: "field"` | a manager editing price and a cashier editing stock on the *same product at once* both survive (table-level LWW would lose one) |
| **Roles** | (a) membership gates bucket access; (b) a signed, tamper-proof `role` claim gates actions in the mutator | a cashier can't write to another branch (server rejects, membership is the source of truth) and can't `setPrice` (action gate); a manager can |

The membership and the action-gate are **server-enforced** — the client's claims are never trusted —
so the role boundary is a real security guarantee, not UI convenience.

### Receipts — attachments / blob sync

```bash
pnpm --filter @nizhal/example-tabkeep example:chain-receipts
```

Attachments (receipt photos for a sale) ride the same engine. A receipt is a **branch-scoped ref row**
that syncs like any other row; the **bytes** live in a blob store (S3 / R2 / local FS) and move via
presigned upload/download — they never pass through the sync stream. The proof shows:

- upload bytes (presigned PUT) → the ref row syncs to another device of the **same branch**, which
  downloads the **exact bytes** back;
- a device of **another branch** can neither see the ref (bucket isolation) nor obtain a download URL
  (`findBlobRef` authorizes the download against the actor's branch — **server-enforced**).

> Note: download authz resolves the actor's *active* branch, so an owner viewing a different branch's
> receipt must act in that branch. Expanding blob authz to full membership is a small future follow-up.

For a real Postgres deployment, create the two business tables from `TABKEEP_DDL`, then provision the
Nizhal sync and audit machinery:

```bash
DATABASE_URL=postgres://... pnpm --filter @nizhal/example-tabkeep migrate
```

Set `VITE_NIZHAL_SERVER`, `VITE_NIZHAL_TOKEN`, `VITE_TABKEEP_SHOP_ID`, and
`VITE_TABKEEP_USER_ID` when running the web client against that deployment.

## Run the proof

```bash
pnpm --filter @nizhal/example-tabkeep example:e2e
```

The proof boots PGlite, Postgres storage, the real Nizhal server, and two clients. It records a credit
offline, converges both clients, replays the same mutation without a duplicate, verifies an audit row,
and compares the integer-exact client and server balance folds.
