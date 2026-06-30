---
title: Choosing a conflict strategy
description: When to use LWW, field merge, CRDT columns, or ledger patterns.
---

## Decision tree

```
Can the write be modeled as an append-only fact?
  yes → movement ledger (no merge conflict)
  no → Does each column have independent writers?
    yes → merge: "field" + HLC scalars
    no → Is the field collaborative rich text / map?
      yes → crdtText / crdtMap columns inside field-merge table
      no → accept commit-order LWW; design around last-writer semantics
```

## LWW — default

**Use when:** status toggles, single-writer records, server-serialized workflows.

**Risk:** two offline edits to the same row — last commit wins; earlier edit lost.

**Mitigation:** ledgers, row partitioning by device, or field merge.

## Field merge

**Use when:** profile fields, settings objects where different devices edit different keys concurrently.

Scalars compare HLC timestamps. Requires `merge: "field"` on the table source.

## CRDT columns

**Use when:** shared note body, metadata map with concurrent structural edits.

Not a replacement for Google Docs cursors — Nizhal targets **data sync**, not full collaborative editing UX.

## Movement ledgers

**Use when:** balances, inventory, totals — the Phase 0 sweet spot.

Offline concurrent sales become additive entries; fold is commutative.

## Server as tiebreaker

Mutators can reject invalid merges (`throw` → 400, optimistic revert) instead of silently merging garbage.

Wire `NizhalObserver.onConflict` to measure how often each path fires in production.

## Further reading

- [Conflict resolution](/concepts/conflict-resolution/)
- [First app](/getting-started/first-app/)
