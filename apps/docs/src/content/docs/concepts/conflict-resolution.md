---
title: Conflict resolution
description: Commit-order LWW, field-level HLC merge, and opt-in CRDT columns.
---

Nizhal's default is **commit-order last-write-wins** at the row level. The mutator body is the merge function — business logic runs in one server transaction, not in a hidden resolver.

## Merge modes

Set per table via schema metadata:

```ts
import { pgTable, text } from "@nizhal/kernel";

// Default: whole-row LWW by server commit order
const notes = pgTable("notes", { id: text("id").primaryKey(), body: text("body") });

// Field-level merge: each column resolves independently
const docs = {
  table: pgTable("docs", { id: text("id").primaryKey(), title: text("title") }),
  merge: "field" as const,
};
```

| `merge` | Behavior |
|---------|----------|
| `"lww"` | Whole-row LWW by server commit order (default) |
| `"field"` | Per-column merge; scalars use HLC timestamps, CRDT columns merge structurally |
| `"crdt"` | Column-level Yjs-backed map/text inside a field-merge table |

Helpers: `schemaMergeMode`, `schemaMergePolicy`, `crdtText`, `crdtMap` from `@nizhal/kernel`.

## LWW (default)

Two offline edits to the same row converge to whichever mutator commits last on the server. Design domains to avoid this:

- **Append-only ledgers** — conflicts become additive entries (see [First app](/getting-started/first-app/))
- **Single-writer fields** — partition by actor or use field merge

## Field merge

With `merge: "field"`, scalar columns compare **HLC-ordered** timestamps (`createHlcClock` in kernel). Each column wins independently — useful for profile fields edited on different devices.

## CRDT columns

```ts
import { pgTable, text, crdtText, crdtMap } from "@nizhal/kernel";

const collab = {
  table: pgTable("collab_docs", {
    id: text("id").primaryKey(),
    title: text("title"),
    body: crdtText("body"),
    meta: crdtMap("meta"),
  }),
  merge: "field" as const,
};
```

Client helpers in `@nizhal/db-collection`: `createCrdtText`, `createCrdtMap`, `applyCrdtUpdate`, `encodeCrdtUpdate`.

## Observability

`NizhalObserver.onConflict` fires when merge policies resolve competing writes — wire metrics or logs there.

## Choosing a strategy

See [Choosing a conflict strategy](/guides/choosing-conflict-strategy/).
