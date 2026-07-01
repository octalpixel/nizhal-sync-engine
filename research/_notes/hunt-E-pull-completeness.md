# Hunt E — Pull data-completeness (orchestrator's own surface)

Adversarial hunt: can a row be skipped on pull so it never reaches the client? (missing ledger entry / chat message). All claims verified first-hand in source.

## CONFIRMED

### G1 (P0) — Gaining access to a new bucket never backfills its history
**Flaw:** the pull cursor is a **single global watermark** per syncRule; `buildDataQuery` filters `_nizhal_row_version > cursor` (`server/adapters/storage.ts:664`). When an actor's membership grows (added to `shop_members`, joins a chat channel), `resolveActorBucketRows` returns the new bucket, but its pre-existing rows have `_nizhal_row_version ≤ cursor` → excluded. No mechanism backfills:
- `reconcileClientBuckets` computes only **removed** buckets (`storage.ts:854`: `previous.filter(b => !current.has(b))`), never added; returns `BucketKey[]` (removed only).
- `cursorReset` is set **only** by `normalizePullCursor` on an invalid/future cursor (`storage.ts:486`), never on scope growth.
- `_nizhal_client_buckets.last_seen_cursor` is **written but NEVER read** (`storage.ts:863,868` write; 0 reads in `packages/`) — the schema has a per-bucket cursor field as if per-bucket backfill were intended, but the code uses one global cursor. **Primitives drift: unfinished per-bucket-cursor primitive.**
- Client has a single `setCursor(syncRule, cursor)` (`db-collection/src/client.ts:435`); the only reset path is `result.cursorReset → setCursor(INITIAL_CURSOR)` (`sync.ts:58-61`), server-driven.

**Consequence (ledger + chat critical):** join a chat channel → zero history, only post-join messages. Granted shop/account access → no existing ledger entries → wrong `fold(ledger)` balance. Common path, completely silent.

**Test gap:** no test adds a bucket mid-session and asserts pre-existing rows arrive. `reconnect.test.ts` covers reconnect (same buckets); `removedBuckets` covers losing access; **gaining access is untested.**

**Fix directions (pick one):**
1. **Per-bucket cursors** (finish the `last_seen_cursor` primitive): track a cursor per bucket; a newly-added bucket starts at 0 and pulls its full history; pull request carries per-bucket cursors. Cleanest; matches the schema's intent.
2. **Detect added buckets server-side** (`reconcileClientBuckets` already has `previous` vs `current`): when `current ⊋ previous`, return the added buckets and have the client pull those buckets from cursor 0 (a scoped re-bootstrap) — or set `cursorReset` (full re-bootstrap; correct but re-pulls everything, expensive).
3. At minimum, **`cursorReset` on any membership growth** as a stopgap (correctness over efficiency).

## PLAUSIBLE (performance / scaling, not data-loss)

### G2 (P1) — Pull loads the entire in-scope changeset into memory before paging
`buildDataQuery` has **no SQL `LIMIT`** (`storage.ts:668-670`); every bucket's full `> cursor` set is loaded into `candidates`, sorted in JS, then `scopedCandidates.slice(0, limit)` trims (`storage.ts:537`). So `limit`/`hasMore` bound the *response*, not server work: a client far behind (cursor 0) or a large bucket (long chat/ledger history) forces an O(all-in-scope-rows) load + sort per pull. The bootstrap "Goldilocks" problem (Convex/Linear) is unbounded here. Index `(bucketColumn, _nizhal_row_version)` exists (`:1142`) so the scan is ranged, but the row set isn't capped. **Fix:** push `ORDER BY _nizhal_row_version LIMIT` into SQL per bucket and merge-page across buckets (k-way merge), or cap per-bucket fetch to `limit`.

## REFUTED (verified safe — documented so the review doesn't re-chase)

### Version-tie page-split skip — REFUTED
The pager advances the cursor to the last included candidate's version (`nextVersion`, `storage.ts:545`) and the next pull uses `> nextVersion`; `compareCandidates` returns 0 on equal versions (`:894`), so a version tie straddling a `limit` boundary *would* skip the excluded tied row. **But versions cannot tie:** change rows get a unique `_nizhal_row_version` (per-row `DEFAULT _nizhal_next_row_version()` on insert `:1119`; BEFORE-UPDATE trigger reassigns per row `:1107`), and **every** tombstone/bucket_exit allocates a **fresh** `_nizhal_next_row_version()` (`:1157,1172,1184`) — not a copy of the row's version. All candidate versions are globally unique → no tie → no skip. The change-vs-bucket_exit same-row case is additionally filtered by `getVisibleRemovalRows` (`:528-533`). Safe.

### Equal-version cross-bucket dedup — SAFE
`seenRows` (`storage.ts:517-519`) dedups a row appearing in multiple buckets by `table:id`; the same row carries one version, so dedup keeps one candidate. No double-send, no skip.
