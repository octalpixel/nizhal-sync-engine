# Sync-Engine Research — Index

Research built to prepare a complete `/code-review` of **Nizhal** (this repo) by understanding the sync-engine landscape from first-hand code + primary-source design rationale.

## Start here
1. **[`nizhal-build-for-one.md`](./nizhal-build-for-one.md)** ← the strategic capstone: the named "1" (end state), the core primitive + the one it's missing, the coherent fix-sequence, the full landscape 0→1 reading (incl. WatermelonDB), and capitalize-vs-refuse allocation.
2. **[`nizhal-bug-hunt-findings.md`](./nizhal-bug-hunt-findings.md)** — the verified-findings register, with the **runtime-validation table** (G1/B1 confirmed on PGlite + local PG + hosted **Neon**; relationship-heavy results; the latency/chattiness root cause; the refuted list).
3. **[`nizhal-fixes.md`](./nizhal-fixes.md)** — implementable fixes for every confirmed finding (end-state shape + minimal increment + failing test), priority-ordered.
4. **[`nizhal-code-review-brief.md`](./nizhal-code-review-brief.md)** — missed-primitives register (P0/P1/P2), claimed-property verification matrix, subsystem checklist with `file:line` anchors.
5. **[`sync-engine-landscape.md`](./sync-engine-landscape.md)** — the comprehensive study: master comparison matrix (incl. lunora, Nizhal, **WatermelonDB**), the 4 axes, conflict-resolution families, the IVM spectrum, and a union-primitives catalog.

**Runtime harnesses (executable repros against real client+server):** `../playground/chat-nizhal/examples/bug-repro.ts` (G1/B1/C1 + concurrency; DB-pluggable PGlite↔Neon) · `../playground/chat-nizhal/examples/relgraph-neon.ts` (maximally-relational offline→online on real Neon). Bidirectional code map: `../.understanding/nizhal-sync-engine.md`.

## Per-engine visual models (first-hand code reverse-engineering)
- **[`lunora-sync-engine.md`](./lunora-sync-engine.md)** — Zero-class engine on Cloudflare Durable Objects. Shapes, membership-diff pokes, per-column LWW via single-threaded DO, watermark protocol. 6 Mermaid diagrams.
- **[`replicache-sync-engine.md`](./replicache-sync-engine.md)** — the git-like commit graph + prolly tree; rebase = re-run the mutator. The substrate Zero is built on.
- **[`zero-sync-engine.md`](./zero-sync-engine.md)** — query-driven sync + end-to-end IVM + zero-cache (replicator / view-syncer / CVR) + permissions by AST rewrite.

## Cloned sources (full depth)
- `lunora/` — anolilab/lunora @ `lunorash@1.0.0-alpha.43` (2026-06-30).
- `zero-mono/` — rocicorp/mono (contains both `packages/zero*` **and** `packages/replicache`).
- `replicache/` — the standalone repo (now just an issues pointer; real source is in `zero-mono`).

## Raw notes
- `_notes/lunora-A-server-do.md`, `lunora-B-client.md`, `lunora-C-wire-glue.md`
- `_notes/replicache.md`, `_notes/zero-client-protocol.md`, `_notes/zero-zql-cache.md`
- `_notes/web-landscape.md` — 10 engines, design rationale + quotes + sources.
- `_notes/nizhal-inventory.md` — first-hand inventory of Nizhal's implemented primitives + explicit gaps.
- `_notes/youtube/` — 12 conference-talk transcripts + `SYNTHESIS.md` (~90 primitives, cross-cutting themes).

## The headline finding
Nizhal's position — **buckets + real-SQLite client + three-mode merge (lww/field-HLC/crdt-Yjs) + no-WAL any-Postgres** — is genuinely differentiated. Its deliberate cost is **no server-side IVM** (realtime = repull-on-hint). The most borrowable missed primitive is **lunora's membership-diff poke**, which proves incremental deltas are achievable *without* WAL. The two highest-priority review targets: **`related` read-auth recursion** (leak risk) and **overlapping-bucket eviction correctness**.
