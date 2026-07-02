// Native transport (iOS + Android): HTTP over the native nitro-fetch stack; realtime over the
// standard Nizhal Cloudflare subscribe source (RN's built-in WebSocket, token on the `?token=`
// query — RN can't set upgrade headers). Connectivity from NetInfo, wrapped for manual override.
import {
  createCloudflareSubscribeSource,
  createNizhalClient,
  manualOnlineDetector,
} from "@nizhal/db-collection";
import { installNitroFetch, reactNativeOnlineDetector } from "@nizhal/db-collection/react-native";
import { type EchoOptions, buildAuth } from "./echo-types";

export function createEcho(opts: EchoOptions) {
  // Route Nizhal's HTTP pull/push through the native networking stack.
  installNitroFetch();
  return createNizhalClient({
    server: opts.server,
    auth: buildAuth(opts),
    bucketsForSyncRule: opts.bucketsForSyncRule,
    subscribeSource: opts.realtimeHost
      ? createCloudflareSubscribeSource(opts.realtimeHost, async () => opts.token ?? "")
      : undefined,
    // Realtime pokes are the fast path; the authoritative interval pull is the fallback that
    // guarantees convergence when a poke is missed or no realtime worker is reachable.
    pull: { intervalMs: 2000 },
  });
}

export function createOnlineDetector() {
  return manualOnlineDetector(reactNativeOnlineDetector());
}
