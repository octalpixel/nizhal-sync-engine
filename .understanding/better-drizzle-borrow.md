# Borrowing better-drizzle's DX for Nizhal productization

**Sources:** https://better-drizzle.com · https://github.com/almeidazs/better-drizzle

## What better-drizzle is
A Prisma-style **repository wrapper** over drizzle-orm. `better(db, { schema })` yields a per-table
client with structured, object-based operations:
```ts
const client = better(db, { schema });
await client.users.findFirst({ where: { id: 1 } });
await client.posts.findMany({ where: { published: true, author: { is: { active: true } } }, include: { author: true } });
await client.users.update({ where: { id: 123 }, data: { name: "updated" } });
await client.users.exists({ where: { id: 123 } });
await client.users.paginate({ ... }); // { data, pagination }
```
- **Structured `where`/`include`** replace composed SQL (`eq`, `and`, joins).
- **Wraps** drizzle (keeps type-safety); does **not** replace the query builder.
- Lifecycle hooks (audit/trace/authz) + plugins (timestamps, soft-delete).
- **Explicitly out of scope:** schema definition and **migrations** — those stay drizzle's domain.
- Perf: "−85% heap on reads vs raw drizzle, <4% write overhead."

## Relevance to our two gaps
- **Deployability / migrations (Item 3):** better-drizzle helps **not at all** — it stays out of
  schema/migrations. Item 3 (engine `_nizhal_meta` versioning + `nizhal migrate` + bigint→xid8) stands
  on its own.
- **Productization (Item 1) + the drizzle-coupling bug:** high-value, and it names the real root cause.

## The real root cause it exposes
The on-device rename bug was patched with `brand || encoder`, but the *disease* is deeper: our
`MutatorTx` expresses edits as **raw drizzle predicates** —
`tx.update(t).set(p).where(eq(t.id, id))` — so the client optimistic path must **reverse-engineer the
row key out of drizzle's private `queryChunks`** (`extractSimpleIdEquality`). That reflection is
inherently engine/bundler-fragile (it broke under Metro/Hermes because drizzle's phantom `brand`
field is stripped). better-drizzle's structured `where` is the fix: **the id is given directly**, so
no introspection is ever needed.

## What to borrow (pattern, not dependency)
better-drizzle wraps a *real drizzle db* (server-side). Our mutators run on **both** the client (over
TanStack DB collections) **and** the server, so we can't adopt it wholesale — we borrow the DX into our
own `MutatorTx`:

1. **Structured-`where` MutatorTx (root-cause fix).** Replace the drizzle-predicate `.where(eq(...))`
   with a structured key/filter:
   `tx.update(table, { id }).set(patch)` and `tx.delete(table, { id })`.
   - Client: reads `{ id }` directly → the collection key. **`extractSimpleIdEquality` is deleted, not
     patched** — no more `queryChunks`/`brand`/`encoder` reflection, engine-agnostic.
   - Server: maps `{ id }` → `eq(pk, id)` for the SQL update.
   - Mutators get simpler (the "20% you write" shrinks); breaking, but alpha.
2. **Repository-per-table `openNizhalStore` (Item 1).** Keep the `better(db, {schema})` shape: the app
   declares `{ schema, syncRules, mutators }` and gets `{ collections, mutate, onlineDetector }` — the
   framework derives one collection per synced table, wires outbox/meta/deadletter, preloads.

## Net effect on the plan
- **New foundational task (1a):** structured-`where` MutatorTx → deletes the fragile key extraction,
  simplifies mutators, and is the correct base for `openNizhalStore`.
- **Item 1** adopts the repository-per-table derivation (validated by better-drizzle).
- **Item 3** unchanged (better-drizzle doesn't do migrations).
- We do **not** add better-drizzle as a dependency (server-only wrapper; our dual client/server mutator
  model needs the DX in our own tx).
