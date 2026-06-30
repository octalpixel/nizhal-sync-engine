---
title: Build an offline-first React Native app
description: The same offline-first app, on a phone. What carries over from web, what changes, and the on-device proof that it works.
---

Phones are offline more than laptops — tunnels, lifts, spotty cell, airplane mode. So a local-first app
feels even better on mobile: every tap is instant because it hits a database *on the phone*, and sync
happens in the background when there's signal. This guide takes the same notes idea from the
[web guide](/guides/build-an-offline-web-app/) onto React Native (Expo).

The good news: **most of it is identical.** There's a real, on-device-verified version of the mobile
data layer at [`apps/op-sqlite-probe`](https://github.com/octalpixel/nizhal/tree/main/apps/op-sqlite-probe)
— it runs on an actual iOS/Android device and prints `OP-SQLITE-DEVICE: PASS`.

## What carries over unchanged

Your `schema`, your `mutators`, and your `syncRules` are **the same code** as the web app — they live in
`@nizhal/kernel`, which is platform-agnostic. The server is the same too. You do not rewrite your domain
for mobile; you reuse it. The only thing that changes is the **client**: where it stores data locally,
and how it talks to the network.

## What changes: the storage engine

On web the local store is wa-sqlite over OPFS. On React Native it's
[op-sqlite](https://github.com/OP-Engineering/op-sqlite) — a fast native SQLite. You open a database file
on the device and hand it to `opSqlitePersistence`:

```ts
import { open, IOS_DOCUMENT_PATH } from "@op-engineering/op-sqlite";
import {
  createNizhalMutators,
  nizhalCollectionOptions,
  opSqlitePersistence,
} from "@nizhal/db-collection";
import { createCollection } from "@tanstack/db";
import { notesMutators } from "./mutators"; // ← the SAME mutators as web

const db = open({ name: "notes.db", location: IOS_DOCUMENT_PATH });
const store = await opSqlitePersistence({ database: db });

const notes = createCollection(
  nizhalCollectionOptions({
    name: "notes",
    syncRule: "myNotes",
    echo,
    getKey: (row) => row.id,
    persistence: store.persistence, // ← the device's SQLite file
  }),
);
await notes.preload(); // load what's already on the phone, instantly

const { mutate, executor } = createNizhalMutators({
  collections: { notes },
  echo,
  actor: { userId, ownerId },
  mutators: notesMutators,
  outboxStorage: store.outboxStorage, // ← the offline write queue, on disk
  mutationIdStorage: store.metaStorage, // ← crash-safe per-transaction sequence allocations
});
await executor.waitForInit();
```

Two things to notice. `store.persistence` is what makes the notes survive the app being killed —
`notes.preload()` reads them straight off the device on next launch. And `store.outboxStorage` is the
durable queue: a note written in airplane mode is persisted to disk and replayed when the phone
reconnects, even if the user force-quits in between. `store.metaStorage` durably records each
transaction's allocated sequence before it is pushed; the server's pull response supplies the
authoritative high-water after an upgrade, reinstall, or interrupted write.

## What changes: talking to the network

React Native isn't a browser — `fetch` and WebSocket behave differently. `@nizhal/react-native` provides
native-grade transports and the small polyfills RN needs:

```ts
import {
  installNizhalNativePolyfills,
  reactNativeOnlineDetector,
  nitroWebSocketSource,
} from "@nizhal/react-native";

installNizhalNativePolyfills(); // crypto.randomUUID for Hermes, once at startup

const echo = createNizhalClient({
  server: API_URL,
  auth: { getHeaders: () => ({ Authorization: `Bearer ${token}` }) },
  bucketsForSyncRule: () => [ownerId],
  onlineDetector: reactNativeOnlineDetector(), // NetInfo: pull the moment signal returns
});
```

The mental model for realtime on mobile is the honest one: your UI is already reactive off the local
store, and when connectivity returns NetInfo triggers a pull, so you converge without anything fancy. If
you want *instant* server-pushed updates, add the native `nitroWebSocketSource` as the `subscribeSource`
— but it's a latency optimisation, never a correctness requirement (the pull is authoritative). See
[RFC-005](https://github.com/octalpixel/nizhal/blob/main/rfcs/RFC-005-rn-realtime.md) for the full story.

## See it actually work — on a real device

Before building screens, prove the data layer on hardware. `apps/op-sqlite-probe` is an Expo app that, on
launch, writes through op-sqlite, closes the database, reopens it, and asserts the data survived — then
runs a cross-device sync against a host server:

```bash
cd apps/op-sqlite-probe
pnpm expo run:ios      # or run:android — on a simulator or a real device
```

On screen you'll see **`OP-SQLITE-DEVICE: PASS`** (op-sqlite persistence survives a restart) and
**`SYNC-DEVICE: PASS`** (a credit made on the web device shows up on the phone, and a payment made on the
phone converges back). The wiring is in
[`apps/op-sqlite-probe/src/ledger-probe.ts`](https://github.com/octalpixel/nizhal/tree/main/apps/op-sqlite-probe/src/ledger-probe.ts)
(persistence) and
[`sync-probe.ts`](https://github.com/octalpixel/nizhal/tree/main/apps/op-sqlite-probe/src/sync-probe.ts)
(cross-device) — read those two files and you've seen the entire mobile data layer.

## Install

```bash
pnpm add @nizhal/kernel @nizhal/db-collection @nizhal/react-native
pnpm add @op-engineering/op-sqlite @react-native-community/netinfo @tanstack/db
```

## Where to go next

- Run the probe in [`apps/op-sqlite-probe`](https://github.com/octalpixel/nizhal/tree/main/apps/op-sqlite-probe).
- Start from the shared half: [Build an offline-first web app](/guides/build-an-offline-web-app/) (same schema/mutators/sync-rules).
- The realtime model in depth: [React Native](/react-native/) and [Realtime](/concepts/realtime/).
