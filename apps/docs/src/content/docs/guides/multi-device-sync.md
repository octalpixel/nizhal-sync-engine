---
title: Multi-device sync
description: Web and mobile sharing one backend with scoped buckets and convergence.
---

Multi-device sync is **scoped bucket convergence** — not full-database replication.

## Shared tenancy model

1. Authenticate each device with the same user (or shared shop membership)
2. Resolve buckets from sync-rule `parameters` (membership table or JWT claims)
3. Each device calls `bucketsForSyncRule` with the buckets it cares about
4. All devices pull/push against the same server Postgres

## Web + mobile

| Layer | Web | React Native |
|-------|-----|--------------|
| Persistence | `waSqlitePersistence` | `opSqlitePersistence` |
| HTTP | `fetch` | `installNitroFetch` / `createNizhalNitroClient` |
| Realtime | native `WebSocket` (default) | `nitroWebSocketSource` |
| Online detection | `navigator.onLine` | `reactNativeOnlineDetector` (NetInfo) |

Use the same `syncRules` and `mutators` on server; generated contract types on both clients.

## Convergence expectations

- Local write &lt; 50ms with network down (TanStack optimistic path)
- After reconnect, remote device sees changes in &lt; 5s with realtime (ping → pull)
- Without realtime, `pull.intervalMs` or manual `echo.pull()` still converges

## Client ID reconciliation

When the server assigns a different PK than the client's optimistic ID, push ack returns the mapping. Collections rebase local rows via TanStack DB.

## Testing multi-device

- `apps/credit-ledger/examples/multi-device-host.ts` — scripted two-client check
- `apps/emulation` chaos harness — N clients with partition/restart injectors
- `apps/op-sqlite-probe` — real device persistence smoke

## Revocation

Removing a device user's membership must shrink their buckets. Verify pull returns `removedBuckets` and local purge — not just 403 on push.
