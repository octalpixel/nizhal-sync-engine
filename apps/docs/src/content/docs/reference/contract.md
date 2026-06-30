---
title: The contract
description: GET /nizhal/contract and decoupled client types.
---

The client does **not** import server Drizzle schema by default. Types come from a generated artifact — REQ-12.

## Endpoint

```
GET /nizhal/contract
```

Returns OpenAPI/JSON-Schema derived from:

- `schema` — entity row shapes + per-table merge policy
- `mutators` — Zod input schemas per mutator name
- `syncRules` — collection/sync-rule names

ORM-agnostic by construction — the server's Drizzle types never cross the wire.

## Server emission

```ts
import { emitNizhalContract } from "@nizhal/kernel";

const contract = emitNizhalContract({ schema, mutators, syncRules });
```

`createNizhalServer` serves this at runtime from the same inputs passed to the server config.

## Client consumption (planned)

```bash
nizhal gen --url https://api.example.com/nizhal/contract -o src/nizhal.gen.ts
```

Generated file provides `Row` types and `Mutators` input types for `nizhalCollectionOptions` and `createNizhalMutators`.

## Monorepo fast path (opt-in)

Type-import from a shared package is possible in monorepos but couples client to server ORM — not the default integration path.

## Why it matters

- Independent client deploys
- Language-agnostic consumers
- No accidental import of server-only invariants into UI bundles

See [API reference](/reference/api/) for `emitNizhalContract` and endpoint list.
