# Nizhal Sync Engine — Code-Smell / Band-Aid Audit

Read-only adversarial audit for hacks, workarounds, swallowed errors, type escapes, and "for now"
shortcuts. Scope: `packages/{kernel,server,db-collection,cli,react-native}`, `apps/*`,
`playground/*`. Excluded: `research/`, `node_modules`, `dist`, build output, and test files (only
flagged where a production type-escape leaks through them). Method: ripgrep sweep → read surrounding
code → judge each. Date: 2026-06-30.

**Bottom line:** the engine is unusually clean. Most marker hits are false positives (`cleanup` is a
real API method, `todo` is an enum value, "Revisit" is doc copy). The genuine concerns are few. There
is **one** real silent-data-loss path (HIGH), a pervasive type-safety hole on the security-critical
sync-rules surface (MED), and a handful of documented pragmatic tradeoffs (LOW) that are *not* hacks.

---

## Summary table (count by category × severity)

| Category | HIGH | MED | LOW | Notes |
|---|---|---|---|---|
| Silent give-up / data loss | 1 | 1 | — | CRDT merge drop (HIGH); base64 dead-catch (MED) |
| Type escapes (`as unknown as`) | — | 2 | — | SyncRules ×10; drizzle column internals ×1 |
| Dual-shape / compat residue | — | 2 | 1 | `legacy` mutationID read; `mode` flag wording; deprecated presence APIs |
| Stubs / not-implemented | — | 1 | — | CLI `gen`/`introspect` advertised but throw |
| Swallowed errors | — | 1 | 2 | RN NetInfo `.catch(()=>{})`; ws/persistence empty catches (sound) |
| Timing / spin-wait | — | 1 | — | `setTimeout(resolve,0)` idle polling |
| "For now" / in-memory | — | 1 | — | tabkeep-expo web persistence returns `undefined` |
| **Total** | **1** | **9** | **3** | |

## The worst 5 band-aids

1. **Silent CRDT write loss after 5 merge attempts** — `packages/server/src/index.ts:1110` (caller
   `:1064`). A CRDT row that loses the optimistic-concurrency CAS 5× returns `undefined`; the caller
   does `if (row) merged.push(row)` and drops it with **no log, no throw, no retry-queue**. Silent
   data loss under sustained contention.
2. **`as unknown as SyncRules` on every sync-rule definition** — 10 files. The double-cast defeats the
   compiler on the one surface that defines per-client row-level data-access boundaries (a security
   boundary). A typo'd column in a `where()` is not type-checked.
3. **"legacy" outbox mutationID read-fallback** — `packages/db-collection/src/mutators.ts:285-288`.
   Dual-shape compat: reads a mutation ID out of envelope metadata for outbox txns persisted before
   the allocated-id store existed. Migration residue with no end-state cleanup.
4. **CLI advertises commands it can't run** — `packages/cli/src/index.ts:8,36,39`. Usage string says
   `nizhal <migrate|gen|introspect>` but `gen` and `introspect` `throw notImplemented(...)`.
5. **Web persistence is in-memory "for now"** — `apps/tabkeep-expo/src/persistence.ts:7` returns
   `undefined`, so web records sync but do not survive a reload. Documented, but it is silent data
   loss on the web target of a shipped demo app.

---

## HIGH

### H1 — CRDT merge silently drops the row on attempt exhaustion
- **File:** `packages/server/src/index.ts:1110-1111`, caller `:1054-1066`
- **Category:** silent give-up / data loss
- **Smell:**
  ```ts
  if (updated.length > 0) return updated[0];
  if (attempt >= MAX_CRDT_MERGE_ATTEMPTS) return undefined;   // give up
  return mergeCrdtRow(..., attempt + 1);
  ```
  Caller: `if (row) merged.push(row);` — an `undefined` return is dropped with no diagnostics.
- **Why it's a band-aid:** `MAX_CRDT_MERGE_ATTEMPTS = 5` is a magic cap that, when hit, abandons the
  Yjs merge **silently**. The incoming CRDT update is neither applied nor surfaced as an error. Even
  if rare (the `for update` lock at `:1052` makes a same-tx CAS failure unlikely, so the path is
  largely defensive), a silent `return undefined` on a write path is exactly the shape that hides a
  correctness bug. Should at minimum log/throw so exhaustion is observable, not a black hole.
- **Severity:** HIGH (silent write loss path, no observability).

---

## MED

### M1 — `as unknown as SyncRules` defeats type-checking on the access-control surface
- **Files (10):** `apps/notes/src/sync-rules.ts:9`, `apps/tabkeep/src/sync-rules.ts:12`,
  `apps/tabkeep/src/chain/sync-rules.ts:23`, `apps/credit-ledger/src/sync-rules.ts:18`,
  `apps/tabkeep-expo/src/domain.ts:76`, `apps/tabkeep-expo/src/chat/domain.ts:206`,
  `apps/emulation/src/pos/sync-rules.ts:13`, `playground/chat-nizhal/src/domain.ts:206`,
  `playground/chat-nizhal/examples/relgraph-neon.ts:120`, `playground/linear-nizhal/src/domain.ts:161`
- **Category:** type escape
- **Why it's a band-aid:** The kernel's `defineSyncRules<R extends SyncRules>` (`packages/kernel/
  src/sync-rules.ts:145`) plus the `b.bucket()` builder produce an object that doesn't structurally
  satisfy `SyncRules = Record<string, SyncRuleDef>` (`kernel/src/types.ts:115`), so **every** consumer
  double-casts. That surface defines which rows each client may read — losing type safety there is the
  worst place to lose it. The runtime `assertSyncRulesNoLeak` guard partially compensates, but a
  mistyped column/param is not caught at compile time. This is a kernel API-ergonomics defect, not an
  app problem: fix the builder return types so the cast disappears everywhere.
- **Severity:** MED (no data loss today; latent correctness/security risk + pervasive debt).

### M2 — Reaching into drizzle column internals via double cast
- **File:** `packages/kernel/src/schema.ts:79`
- **Category:** type escape
- **Smell:** `(column as unknown as { config?: { fieldConfig?: { merge?: MergeMode } } }).config?.fieldConfig`
- **Why it's a band-aid:** Reads the custom-type merge mode out of drizzle's *non-public* column
  internals. Works today, but silently breaks (returns no merge modes → CRDT/LWW policy lost) if
  drizzle reshapes `column.config`. No version pin or guard around the assumption.
- **Severity:** MED (fragile to a dependency bump; failure mode is silent loss of merge policy).

### M3 — "legacy" outbox mutationID read-fallback (dual-shape compat)
- **File:** `packages/db-collection/src/mutators.ts:285-288`
- **Category:** compat residue
- **Smell:** `const legacy = readEnvelopeMetadata(tx.metadata)?.mutation.mutationID; ... await writeAllocatedMutationId(...)`
- **Why it's a band-aid:** Back-fills the allocated-id store from an older envelope shape for outbox
  txns persisted before the allocated-id mechanism. A read-time migration branch kept alive
  indefinitely with no "end state" that removes it. Sound today, but it is exactly the dual-shape
  residue that accretes.
- **Severity:** MED (latent debt; correct but unbounded compat lifetime).

### M4 — `mode` flag framed as "legacy server-owned base"
- **Files:** `packages/db-collection/src/types.ts:70-71` (`NizhalMode = "local-first" | "server-authoritative"`),
  branched in `packages/db-collection/src/sync.ts:64,89,100,106,166` and `collection.ts:55`
- **Category:** dual-shape / mode flag
- **Why it's a band-aid (mild):** Two real, live sync modes — this is a legitimate product feature,
  **not** dead code. The smell is only the doc wording ("opt into the *legacy* server-owned base"),
  which frames one supported mode as legacy without an ADR/deprecation plan. Either it's a first-class
  mode (drop "legacy") or it's on a sunset path (record it). Right now it's ambiguous.
- **Severity:** MED (terminology/intent debt; behaviorally sound).

### M5 — CLI advertises `gen` / `introspect` but throws
- **File:** `packages/cli/src/index.ts:8-9, 36, 39` (usage string `:43`)
- **Category:** stub / not-implemented
- **Smell:** `notImplemented("gen", ...)` throws; usage prints `nizhal <migrate|gen|introspect>`.
- **Why it's a band-aid:** The error is honest and points at RFC-001, but the help text promises two
  commands that fail on invocation. Usage string should not list unbuilt commands.
- **Severity:** MED (advertised surface lies; honest failure mitigates).

### M6 — tabkeep-expo web persistence is in-memory "for now"
- **File:** `apps/tabkeep-expo/src/persistence.ts:3-7`
- **Category:** "for now" / data loss
- **Smell:** `return undefined;` (no SQLite persistence on web) with comment "records sync but don't
  survive a reload … next increment."
- **Why it's a band-aid:** On the web target, all local data is lost on reload. Documented and scoped
  to a demo app (native uses op-sqlite, which is durable), so not a core-engine defect — but it is
  real, silent data loss on one shipped surface.
- **Severity:** MED (data loss, but bounded to demo web target and documented).

### M7 — RN NetInfo initial fetch error swallowed
- **File:** `packages/react-native/src/native-runtime.ts:23`
- **Category:** swallowed error
- **Smell:** `void NetInfo.fetch().then(...).catch(() => {});`
- **Why it's a band-aid:** If the initial connectivity probe rejects, the error vanishes and `online`
  stays at its `true` default. The `addEventListener` below self-corrects on the next change, so the
  blast radius is small, but a fully undocumented empty `.catch` on a connectivity primitive is the
  kind of swallow that hides a misconfigured NetInfo peer dep.
- **Severity:** MED-LOW (self-healing; undocumented swallow).

### M8 — base64 decode dead-catch returns `undefined` for CRDT bytes
- **File:** `packages/server/src/index.ts:1119-1123` (`asUint8Array`)
- **Category:** swallowed error / silent give-up
- **Smell:** `try { return Buffer.from(value, "base64"); } catch { return undefined; }`
- **Why it's a band-aid:** `Buffer.from(_, "base64")` does not throw on malformed input (it drops
  invalid chars), so the catch is effectively dead — and the `undefined` return makes corrupt CRDT
  state look like "no state," which would drop merge content. The defensive catch papers over the
  absence of real validation.
- **Severity:** MED (dead catch + silent-empty on bad bytes feeding H1's merge).

### M9 — `setTimeout(resolve, 0)` spin-wait for executor idle
- **Files:** `packages/db-collection/src/mutators.ts:690` (`disposeExecutor`), `:708` (`waitForIdle`)
- **Category:** timing hack
- **Smell:** `while (executor.getRunningCount() > 0) { await new Promise(r => setTimeout(r, 0)); }`
- **Why it's a band-aid:** Busy-polls the executor every macrotask instead of awaiting a completion
  signal/event. Functionally fine and bounded (dispose/idle paths), but it's a poll where an
  event-driven await would be cleaner and race-free.
- **Severity:** MED-LOW (works; not event-driven).

---

## LOW — and explicitly NOT band-aids (acceptable pragmatism)

- **Deprecated presence APIs** — `packages/db-collection/src/client.ts:42,44`,
  `presence.ts:34,45`. `@deprecated` JSDoc with a named replacement (`onPresence`/`presenceState`).
  Clean, documented migration — fine. (LOW)
- **Empty catches in websocket-source** — `packages/db-collection/src/websocket-source.ts:122-124,
  154-156`. Each is commented ("a close/error will follow and drive reconnection" / "already
  closing/closed"). Intentional and correct for socket lifecycle. **Not** a swallow. (LOW)
- **Empty catches in persistence** — `wa-sqlite.ts:84-86`, `op-sqlite.ts:138-140`: "Preserve the
  original error" — they intentionally swallow a *secondary* cleanup error to not mask the primary.
  Correct. (LOW)
- **`fetchWithTimeout`** — `packages/db-collection/src/sync-target.ts:57-85`. A `setTimeout`+abort,
  but heavily documented (RFC-011 F-C), env-overridable (`NIZHAL_FETCH_TIMEOUT_MS`), and solves a real
  wedge (a hung fetch holding the sequence lock forever). Sound design, **not** a timing hack.
- **`markJobFailed` dead-letter** — `packages/server/src/jobs.ts:213-223`. On `attempts >=
  maxAttempts` it moves the job to `dead_letter` and stores `lastError`. Correct exhaustion handling
  *with* observability — the opposite of H1.
- **Storage pagination** — `packages/server/src/adapters/storage.ts:537` slices to `limit` but sets
  `hasMore` (`:538`). Real pagination, not silent truncation.
- **`mutation sequence exhausted` throw** — `packages/db-collection/src/mutation-id.ts:34`. Throws
  loudly at 2^53 instead of silently wrapping. Correct.

---

## Coverage notes
- Marker sweep (`TODO/FIXME/HACK/XXX/for now/temporar/revisit/...`): 59 raw hits, ~3 genuine
  (the rest are `cleanup` API calls, `todo` enum members, and doc "Revisit" copy).
- Type escapes: 37 raw hits; production-surface concerns are M1 (×10) and M2. The rest are test
  doubles (`as unknown as DurableObjectStub`, fake WebSockets) — acceptable in tests.
- Swallowed-error sweep: all empty catches in package `src` are either commented-and-intentional
  (LOW, sound) or M7. No truly blind `catch {}` in shipping engine code.
- No `@ts-ignore` / `@ts-expect-error` / `eslint-disable` anywhere in scope. One `biome-ignore` in a
  playground React effect (justified: scroll-to-bottom dep). No `--no-verify`-style bypasses found.
