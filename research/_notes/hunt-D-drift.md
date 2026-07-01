# Hunt D — Primitives Drift & Contract↔Impl Mismatch (Nizhal / echo)

Scope: cursor/version, mutationID/clientID/deviceId, MergeMode, contract vs impl, HLC, PullResult shape.
Method: read both sides, compared declared meaning vs enforced behavior. Read-only.

Severity legend: CONFIRMED = real disagreement w/ data-loss/divergence path; PLAUSIBLE = latent / config-gated;
REFUTED = checked, the two sides actually agree.

---

## D1 — CONFIRMED: one `clientID` primitive overloaded for 3 roles with conflicting uniqueness rules → silent write loss when it is not device-unique

The same string is used as **(a)** the per-client mutation-sequence key, **(b)** the HLC node identity, and
**(c)** the pull/bucket device id — but each role needs a *different* uniqueness guarantee, and nothing reconciles them.

- Client mints ONE id and fans it to all three roles:
  `packages/db-collection/src/mutators.ts:172-176`
  ```
  const clientID = opts.clientID ?? safeRandomUUID();
  opts.echo.setDeviceId(clientID);                       // role (c): pull deviceId
  const hlc = createHlcClock({ nodeId: normalizeHlcNodeId(clientID), ... }); // role (b)
  ```
  and stamps it on every push as `clientID` (role a): `mutators.ts:309`, sequenced at `mutators.ts:457-460`.

- Server mutation watermark keys on the RAW `clientID`, **not** actor-scoped:
  `packages/server/src/adapters/storage.ts:222-239` (`checkMutationSequence`) and `:197-204` (`readLastMutationId`).
  Sequence rule (`mutationID <= last → "alreadyApplied"`): `storage.ts:232`.
- Server **bucket** reconciliation keys on an ACTOR-scoped device id:
  `storage.ts:852` → `actorScopedDeviceId(actor, deviceId)` = `JSON(["actor-device", ownerId, userId, deviceId])`
  (`storage.ts:886-888`).

Disagreement: buckets treat identity as **(actor, device)**; the mutation watermark treats it as a bare
device-global `clientID`. The codebase's own note assumes per-device persistence
(`packages/db-collection/src/mutation-id.ts:1-5`: "The clientID is persisted … a counter that reset … server
treats as 'alreadyApplied' and the client clears from the outbox, silently losing the write"), but nothing
*enforces* that `clientID` is unique per physical device.

Consequence (data loss): if an app derives `clientID` from anything non-device-unique (e.g. `userId`, or a fixed
build constant) — plausible because every *other* identity in the engine is actor-scoped — then two devices for the
same user share one `_nizhal_clients` row. Device A reaches `mutationID=5` (`last=5`); Device B independently emits
`mutationID=5`; server hits `5 <= 5 → "alreadyApplied"` (`storage.ts:232`), returns acknowledged-without-apply
(`packages/server/src/index.ts:665-672`), and the client clears it from the outbox. **B's write is silently dropped.**
The actor-scoped bucket layer hides the misconfig because sync still appears to work.

Fix direction: actor-scope `_nizhal_clients` the same way buckets are (`actorScopedDeviceId`), or hard-validate
device-uniqueness of `clientID`.

---

## D2 — CONFIRMED: HLC `nodeId` is truncated from 128-bit (UUID) to 64-bit (16 hex), and that truncation is the SOLE field-merge tiebreaker

- Client node identity is a v4 UUID (32 hex): `mutators.ts:172` → `normalizeHlcNodeId(clientID)`.
- `normalizeHlcNodeId` strips non-hex, lowercases, and keeps only the **last 16 hex chars**:
  `packages/kernel/src/hlc.ts:82-85` (`hex.padStart(16,"0").slice(-16)`).
- Field-merge winner selection compares the **whole HLC string** lexicographically, with `nodeId` as the final
  tiebreaker after wallTime+counter: `packages/server/src/index.ts:1170-1175`
  (`coalesce(_meta ->> col,'') < ${hlc}` — strict `<`).

Disagreement: the client carries 128 bits of node entropy, but the HLC contract (`formatHlc`/`parseHlc`,
`hlc.ts:60-76`) defines `nodeId` as exactly 16 hex = 64 bits. Two devices whose UUIDs share their last 16 hex
collide to the same `nodeId`.

Consequence (lost edit): when two devices produce the *same* `wallTime` (ms) and *same* `counter`, the nodeId is the
only differentiator. If the truncated nodeIds also collide, the two HLC strings are byte-equal, the strict `<` is
false, and the second writer's field update is rejected (existing value kept) → a concurrent edit is silently lost.
Probability is low (birthday over 2^64 + simultaneous ms/counter), but the truncation deliberately discards exactly
the entropy meant to break these ties. The narrowing is real and on the financial-ledger field-merge path.

---

## D3 — PLAUSIBLE: table-level `merge:"crdt"` is advertised in the contract but NOT enforced (scalar columns silently fall to LWW)

- Contract emits whatever table-level mode was declared: `packages/kernel/src/contract.ts:31`
  (`merge[tableName] = schemaMergePolicy(source)`); `schemaMergePolicy` returns `"crdt"` for a
  `{ table, merge: "crdt" }` source (`packages/kernel/src/schema.ts:44-66`).
- Server enforcement only special-cases **column-level** `crdt` and **table-level** `field`:
  `packages/server/src/index.ts:997` (`policy.columns.get(columnName) === "crdt"`) and
  `:1008` (`if (policy.table === "field")`). A table whose `policy.table === "crdt"` with plain scalar columns hits
  the `else` at `index.ts:1021` → plain `tx.update(...).set(scalarPatch)` = last-writer-wins.

Disagreement: the published OpenAPI `x-echo.merge[table] = "crdt"` tells a client the table is CRDT-merged; the
server LWW-merges its scalar columns. Consequence: silent lost concurrent edits for any consumer who trusts the
contract. Marked PLAUSIBLE (not CONFIRMED) because no current schema declares table-level `crdt` — every real
declaration is `merge:"field"` (`apps/credit-ledger/src/schema.ts:63`, `apps/tabkeep/src/chain/schema.ts:46`,
`apps/emulation/src/pos/schema.ts:54`) and CRDT is only ever applied per-column via `crdtText`/`crdtMap`
(`schema.ts:99-105`). It is a latent contract lie with no live caller.

Related (REFUTED as a live bug): a per-column `field` mode would also be ignored unless the table is `field`
(`index.ts:1008` is table-scoped), but there is no public API to set a column's merge to `field` — only
`crdtText`/`crdtMap` set `fieldConfig.merge`, always to `"crdt"` (`schema.ts:88-105`). So per-column `field` is not
constructible today.

---

## D4 — PLAUSIBLE: pull-watermark vs push-watermark agree ONLY because `setDeviceId` forcibly aliases two independent config knobs

- Pull reads the watermark keyed by `body.deviceId`: `packages/server/src/index.ts:372-375`
  (`storage.readLastMutationId(body.deviceId)`), where the body's `deviceId` is the client's `deviceId`
  (`packages/db-collection/src/sync-target.ts:124` `deviceId: request.clientId`;
  `packages/db-collection/src/client.ts:289` `clientId: deviceId`).
- Push writes the watermark keyed by `mutation.clientID`: `index.ts:469`, `storage.ts:222-237`.

These match **only** because `createNizhalMutators` overrides the client's deviceId to equal `clientID`
(`mutators.ts:173` `opts.echo.setDeviceId(clientID)`). But `createNizhalClient` independently accepts
`config.deviceId` (`client.ts:101`). The two are separate inputs with no invariant linking them; correctness rests on
a side-effecting `setDeviceId` call that silently wins. If a client pulls before mutators are wired, or uses the
client transport without `createNizhalMutators` while pushing with a different `clientID`, pull reads the wrong
`_nizhal_clients` row → `serverHighWater` is wrong → `allocateMutationId` (`mutators.ts:379-387`) can re-issue an id
the server already has → `alreadyApplied` → outbox clears → silent loss. Fragile coupling of a primitive across two
modules; PLAUSIBLE rather than CONFIRMED because the default wiring keeps them equal.

---

## D5 — REFUTED: cursor encode/decode round-trip and the `> cursor` boundary are correct

- `encodeCursor`/`decodeCursor` are exact inverses (base64url of the decimal bigint, digit-validated):
  `storage.ts:458-473`. `INITIAL_CURSOR=""` ↔ `0n` both directions (`types.ts:119`, `storage.ts:463`).
- Data query is strict `>`: `storage.ts:664` (`_nizhal_row_version > ${cursor}::bigint`); removal scan likewise
  `storage.ts:764`. All versions come from one global sequence `_nizhal_row_version_seq`
  (`storage.ts:1047,1057`, tombstones `:1067`), so versions are globally unique → no two candidates share a version.
- Pagination advances `nextVersion` to the **last included** candidate's version (`storage.ts:543-545,561`); next page
  queries `> nextVersion`. Unique versions + strict `>` ⇒ no skipped and no duplicated rows across page boundaries.
- Filtered bucket_exit candidates are removed *before* paging (`storage.ts:529-533`) so they never consume a page slot
  or wrongly advance the cursor.
- Client never persists a cursor it didn't apply: in local-first it advances the stored cursor only when not
  `blocked` (`sync.ts:100-105`); on `cursorReset` it resets to `INITIAL_CURSOR` (`sync.ts:58-62`); server-authoritative
  sets the cursor inside the same begin/commit as the writes (`sync.ts:82-87,427-428`). Re-pulls are idempotent upserts.

No off-by-one, no stale/duplicate-cursor skip found.

---

## D6 — REFUTED: PullResult shape matches across kernel ↔ server ↔ client

`PullResult` declares `changed / tombstoned / removed? / removedBuckets? / cursor / cursorReset? / hasMore? /
lastMutationId?` (`packages/kernel/src/types.ts:126-140`).

- Server emits all of them: `storage.ts:568-576` (+ `lastMutationId` spliced in at `index.ts:376-379`,
  CRDT bytea columns base64-encoded at `index.ts:363` / `:1129-1149`).
- Client consumes every field: `removedBuckets` (`sync.ts:244-252,404-405`), `changed` (`:254-257,408-415`),
  `tombstoned` (`:258-260,417-420`), `removed` (`:261-263,422-425`), `cursorReset` (`:58-62`),
  `hasMore` (`:130`), `lastMutationId` (`client.ts:292-294`). `removed` and `tombstoned` are both treated as deletes
  keyed by `key ?? id` — consistent with the server's `client_key`/`id` split (`storage.ts:552-559`,
  tombstone `client_key` provenance `storage.ts:1154,1168`).
- `NizhalPullResponse` defaults the optionals (`sync-target.ts:132-136`). No ignored/misread field.

Minor (not data loss): `NizhalPullRequest.buckets` and `.clientId` (`sync-target.ts:4-10`) are partly vestigial —
the HTTP body sends only `cursor/syncRule/deviceId/limit` (`sync-target.ts:121-126`) and the server recomputes
buckets from the actor; `buckets` is never transmitted.

---

## D7 — REFUTED (with note): HLC `parseHlc` strictness matches `formatHlc` output

`formatHlc` = `${ISO(24)}-${counter hex(4)}-${nodeId hex(16)}` (`hlc.ts:60-64`); `parseHlc` regex
`^(.{24})-([0-9a-fA-F]{4})-([0-9a-fA-F]{16})$` (`hlc.ts:67`). `Date.toISOString()` is 24 chars for all in-range
timestamps, counter is width-4 and overflow-guarded at `0xffff` (`hlc.ts:96`), nodeId normalized to 16 on both
emit and parse. Round-trips. (Field-merge SQL compares raw strings and never calls `parseHlc`, so format drift
there is moot.) The only edge is years >9999 / negative (27-char ISO) breaking the regex — not reachable in
practice.

---

## Quick verdict table

| ID | Status | Primitive | Both-sides anchor |
|----|--------|-----------|-------------------|
| D1 | CONFIRMED | clientID scope (mutation vs bucket) | `storage.ts:222/852` vs `mutators.ts:172` |
| D2 | CONFIRMED | HLC nodeId entropy / tiebreaker | `hlc.ts:82-85` vs `index.ts:1170-1175` |
| D3 | PLAUSIBLE | table-level `crdt` contract lie | `contract.ts:31` vs `index.ts:997-1021` |
| D4 | PLAUSIBLE | pull/push watermark key aliasing | `index.ts:372` vs `index.ts:469` / `mutators.ts:173` |
| D5 | REFUTED | cursor encode/decode + `>` boundary | `storage.ts:458-488,664` / `sync.ts:100-130` |
| D6 | REFUTED | PullResult shape | `types.ts:126` / `storage.ts:568` / `sync.ts:244-425` |
| D7 | REFUTED | HLC parse/format strictness | `hlc.ts:60-76` |
