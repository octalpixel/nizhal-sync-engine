// Web transport (react-native-web): browser fetch + WebSocket via the standard Nizhal client. Realtime
// through the Cloudflare Worker subscribe source when a realtimeHost is set; otherwise interval pull.
import {
  createCloudflareSubscribeSource,
  createNizhalClient,
  manualOnlineDetector,
} from "@nizhal/db-collection";
import { type EchoOptions, buildAuth } from "./echo-types";

export function createEcho(opts: EchoOptions) {
  return createNizhalClient({
    server: opts.server,
    auth: buildAuth(opts),
    bucketsForSyncRule: opts.bucketsForSyncRule,
    subscribeSource: opts.realtimeHost
      ? createCloudflareSubscribeSource(opts.realtimeHost, async () => opts.token ?? "")
      : undefined,
    // No dedicated realtime host in the local demo → the authoritative interval pull keeps web in sync.
    pull: { intervalMs: 2000 },
  });
}

export function createOnlineDetector() {
  return manualOnlineDetector();
}
