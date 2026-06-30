# @nizhal/react-native

Native transport for an Nizhal client on React Native / Expo — realtime over
[`react-native-nitro-websockets`](https://github.com/margelo/react-native-nitro-fetch) (native
libwebsockets) and HTTP over [`react-native-nitro-fetch`](https://github.com/margelo/react-native-nitro-fetch).

Why: RN's default `fetch`/`WebSocket` are slower and — crucially — the JS `WebSocket` **can't set
upgrade headers**, forcing the bearer token into the query string. NitroWebSocket **can** send the
`Authorization` header on the WS upgrade, so this package authenticates realtime the proper way (with
a `?token=` fallback), and runs HTTP on the native stack.

## Install
```sh
npm i @nizhal/react-native @nizhal/db-collection \
  react-native-nitro-fetch react-native-nitro-websockets \
  react-native-nitro-text-decoder react-native-nitro-modules
cd ios && pod install && cd ..
```

## Use (one call)
```ts
import { createNizhalNitroClient } from "@nizhal/react-native";

const echo = createNizhalNitroClient({
  server: "https://api.myshop.lk",
  token: session.accessToken,        // sent as the Authorization header on the WS upgrade
  bucketsForSyncRule: (rule) => myBuckets(rule),
});
// then nizhalCollectionOptions({ ..., echo }) + createNizhalMutators({ ..., echo }) as usual.
```

This installs nitro-fetch as the global `fetch` and wires the native WebSocket realtime source.

## Use (à la carte)
```ts
import { installNitroFetch, nitroWebSocketSource, nitroFetch } from "@nizhal/react-native";
import { createNizhalClient } from "@nizhal/db-collection";

installNitroFetch();                                  // or pass nitroFetch where you need fetch
const echo = createNizhalClient({
  server: "https://api.myshop.lk",
  subscribeSource: nitroWebSocketSource({ server: "https://api.myshop.lk", token }),
});
```

`nitroWebSocketSource` reconnects with jittered backoff and triggers Nizhal's catch-up pull on
re-connect (a ping missed while offline still converges — the cursor pull is authoritative).

> Native module — runs on a device/simulator, not headless Node. Persistence pairs with op-sqlite
> via `@nizhal/db-collection`'s `op-sqlite` persistence.

## Connectivity (auto-resync on reconnect)

RN has no `window`/`navigator.onLine` events, so Nizhal's default detector is inert on device. Use the
NetInfo-based detector so the outbox auto-flushes when the network returns:

```ts
import { reactNativeOnlineDetector, installNizhalNativePolyfills } from "@nizhal/react-native";
import { createNizhalMutators } from "@nizhal/db-collection";

installNizhalNativePolyfills();   // crypto.randomUUID for Hermes (createNizhalNitroClient calls this too)

const { mutate } = createNizhalMutators({
  ...,
  onlineDetector: reactNativeOnlineDetector(),   // NetInfo: flush outbox on reconnect
});
```

Requires the `@react-native-community/netinfo` peer dep (`npx expo install @react-native-community/netinfo`).
Verified on a real iOS simulator: a complex domain row survives offline write + app restart via op-sqlite
(`apps/op-sqlite-probe`).
