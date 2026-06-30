---
title: React Native
description: Native WebSocket, nitro-fetch, NetInfo reconnect, and op-sqlite persistence.
---

`@nizhal/react-native` wires Nizhal for Expo/React Native: realtime over native WebSockets and HTTP over nitro-fetch.

## Install

```bash
npm i @nizhal/react-native @nizhal/db-collection \
  react-native-nitro-fetch react-native-nitro-websockets \
  react-native-nitro-text-decoder react-native-nitro-modules
npx expo install @react-native-community/netinfo
cd ios && pod install && cd ..
```

## One-call setup

```ts
import { createNizhalNitroClient } from "@nizhal/react-native";

const echo = createNizhalNitroClient({
  server: "https://api.myshop.lk",
  token: session.accessToken,
  bucketsForSyncRule: (rule) => myBuckets(rule),
});
```

Installs native polyfills (`installNizhalNativePolyfills`), global `fetch` via `installNitroFetch`, and `nitroWebSocketSource` for realtime with `Authorization` on the WS upgrade.

## À la carte

```ts
import {
  installNitroFetch,
  nitroWebSocketSource,
  installNizhalNativePolyfills,
  reactNativeOnlineDetector,
} from "@nizhal/react-native";
import { createNizhalClient, createNizhalMutators, opSqlitePersistence } from "@nizhal/db-collection";

installNizhalNativePolyfills();
installNitroFetch();

const echo = createNizhalClient({
  server: "https://api.myshop.lk",
  subscribeSource: nitroWebSocketSource({ server: "https://api.myshop.lk", token }),
  bucketsForSyncRule,
});

const { mutate } = createNizhalMutators({
  ...,
  onlineDetector: reactNativeOnlineDetector(),
});
```

## Why native transport

RN's JS `WebSocket` cannot set upgrade headers — bearer tokens would leak in query strings. NitroWebSocket sends `Authorization` properly (with `?token=` fallback).

## Realtime model (RFC-005)

- **Local reactivity** — TanStack DB `useLiveQuery` on device
- **NetInfo** — `reactNativeOnlineDetector` flushes outbox on reconnect
- **WS** — optional instant push; missed ping → catch-up pull on reconnect

The cursor pull is authoritative; WS is a hint.

## Persistence

```ts
nizhalCollectionOptions({
  ...,
  persistence: opSqlitePersistence({ name: "shop", location: "default" }),
});
```

Verified: `apps/op-sqlite-probe` — offline write + app restart on iOS simulator.

## Exports

`nitroWebSocketSource`, `installNitroFetch`, `nitroFetch`, `createNizhalNitroClient`, `reactNativeOnlineDetector`, `installNizhalNativePolyfills`
