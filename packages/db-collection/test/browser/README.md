# Cross-tab browser QA (Argent-driven, no bundler)

Proves the multi-tab `NizhalClientGroup` coordination in a **real browser** using the actual coordinator
source — real **Web Locks** (leader election) + **BroadcastChannel** (write signal) + a shared
`localStorage` outbox. No Playwright, no bundler: `index.html` loads `harness.js`, which imports the
**tsc build** (`../../dist/*.js`) as native ES modules.

## Run it

```bash
pnpm --filter @nizhal/db-collection build          # produce dist/*.js
pnpm --filter @nizhal/db-collection serve:browser-harness   # serves http://127.0.0.1:5178
```

Then drive two tabs at the same origin with Argent (the agent-as-first-tester tooling):

1. `chromium-tabs new url=http://127.0.0.1:5178/?tab=A` and `…/?tab=B` — two tabs, one origin.
2. `debugger-evaluate` in each: `window.cgIsLeader()` — Web Locks must elect **exactly one** leader.
3. In the **follower** tab: `window.cgEnqueue('from-follower','follower-lost')` (the `follower-lost` body
   fails once, exercising transient retry). In the **leader** tab: `window.cgEnqueue('from-leader','leader-kept')`.
4. Read the shared applied log from either tab: `JSON.stringify(window.cgApplied())`.

## Expected (verified)

```json
[
  { "cmid": "from-follower", "byTab": "A", "mutationID": 1 },
  { "cmid": "from-leader",   "byTab": "A", "mutationID": 2 }
]
```

`byTab: "A"` on `from-follower` is the proof: the write **enqueued in the follower tab was flushed by the
leader tab**, past a transient 503, over the shared outbox — and the outbox drains to empty. The fake
"server" lives in `localStorage` (shared across tabs) and records which tab pushed each write, so a single
`cgApplied()` read from any tab shows who flushed what.

Note: this harness uses `localStorage` as the shared store to exercise the coordination directly; the
production shared store is wa-sqlite/OPFS (a later chunk). The coordination logic (`src/client-group.ts`)
and the browser adapter (`src/client-group-browser.ts`) are the real, shipped source.
