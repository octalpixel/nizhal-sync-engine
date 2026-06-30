---
title: createNizhalClient
description: HTTP pull/push, WebSocket subscribe, cursors, and reconnect.
---

```ts
import { createNizhalClient } from "@nizhal/db-collection";

const echo = createNizhalClient({
  server: "http://localhost:4000",
  deviceId: persistence.clientId,
  auth: {
    getHeaders: () => ({ Authorization: `Bearer ${token}` }),
    refresh: async () => { /* optional token rotation */ },
  },
  bucketsForSyncRule: (rule) => {
    if (rule === "myNotes") return [{ ownerId: session.ownerId }];
    return [];
  },
  subscribeSource,  // optional — defaults to a reconnecting WebSocket source
  reconnect,        // jitter + catch-up pull on reconnect
  ttl,              // evict out-of-scope bucket rows locally
  pull: { intervalMs: 30_000 }, // optional fallback pull
  presence,         // heartbeat interval
  status,           // SyncStatus + outbox inspection
});
```

`deviceId` must be stable per installation so access-revocation removals are delivered independently
to every device. Passing the persistence `clientId` to `createNizhalMutators` also wires this value.

## Methods

- `pull`, `push` — direct HTTP (collections use these via `SyncConfig`)
- `subscribe` — WS bucket pings
- `track` / `untrack`, `presenceState`, `onPresence` — presence v2
- Cursor and scope helpers for advanced wiring

## Reconnect

On WS reconnect, the client runs a catch-up pull. Combined with `pull.intervalMs`, convergence does not depend on every ping arriving.

## Cloudflare client

```ts
import { createCloudflareSubscribeSource } from "@nizhal/db-collection";
```

Use when the server exposes the Cloudflare DO WebSocket URL shape.

## React Native

Prefer `createNizhalNitroClient` from `@nizhal/react-native` — see [React Native](/react-native/).
