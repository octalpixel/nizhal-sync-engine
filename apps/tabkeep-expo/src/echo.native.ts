// Native transport (iOS + Android): realtime over react-native-nitro-websockets (Authorization on the
// upgrade), HTTP over nitro-fetch. Connectivity from NetInfo, wrapped for deterministic manual override.
import { manualOnlineDetector } from "@nizhal/db-collection";
import { createNizhalNitroClient, reactNativeOnlineDetector } from "@nizhal/react-native";
import { type EchoOptions, buildAuth } from "./echo-types";

export function createEcho(opts: EchoOptions) {
  return createNizhalNitroClient({
    server: opts.server,
    token: opts.token,
    realtimeHost: opts.realtimeHost,
    auth: buildAuth(opts),
    bucketsForSyncRule: opts.bucketsForSyncRule,
    // Realtime pokes are the fast path; the authoritative interval pull is the fallback that guarantees
    // convergence when a poke is missed or no realtime worker is reachable (Replicache-style).
    pull: { intervalMs: 2000 },
  });
}

export function createOnlineDetector() {
  return manualOnlineDetector(reactNativeOnlineDetector());
}
