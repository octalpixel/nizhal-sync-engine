---
title: Bun
description: Run Nizhal on Bun with Node compatibility and native WebSocket.
---

Bun is a supported runtime for `createNizhalServer().listen()` — same Hono app, same adapters.

## Proven path

```bash
bun apps/credit-ledger/examples/live-e2e.ts
# or: pnpm --filter credit-ledger example:live
```

The live E2E boots a real TCP server, uses fetch + a reconnecting WebSocket, and verifies push/pull convergence.

## Notes

- Use Bun's Node compatibility for `postgres` driver and Drizzle
- WebSocket upgrade works for `/sync/stream` with `inProcessRealtime`
- `nizhal migrate` runs under Bun when invoked via the CLI entry

No Nizhal-specific Bun APIs — if `createNizhalServer` works on Node, it works on Bun with the same config.
